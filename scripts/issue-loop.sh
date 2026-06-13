#!/usr/bin/env bash
# issue-loop.sh — autonomous build loop, one FRESH Claude Code agent per issue.
#
# Each iteration spawns a brand-new non-interactive agent (`claude -p`) whose
# contract is .claude/commands/next-issue.md: catch up on PLAN.md, the PRD,
# every closed issue and the code, then work exactly ONE unblocked
# ready-for-agent issue to completion, then report a LOOP_STATUS line this
# runner parses. Fresh context per issue by design — nothing accumulates
# across iterations except what is on GitHub and in git.
#
# Usage-limit + crash survival: every agent is spawned with a pre-assigned
# --session-id, recorded in .loop-state BEFORE launch. Headless agents have no
# interactive "wait for limit to reset" option — when the subscription window
# fills they just die (observed 2.1.175: is_error:true, result "You've hit
# your session limit · resets 3pm (Europe/London)"). The runner detects that,
# sleeps until the advertised reset (+ buffer), then `--resume`s the SAME
# session: the agent continues its issue with claim, branch and partial work
# intact. Pauses are quiet and do not consume loop iterations. If the runner
# itself dies (Ctrl-C, reboot, kill), rerunning the script finds .loop-state
# and resumes the in-flight agent instead of spawning a fresh one — a fresh
# agent would skip the half-finished claimed issue for 24 h.
#
# Missing-status survival: a headless agent that ends WITHOUT its LOOP_STATUS
# line — e.g. it tried to "wait" for background work, which a one-shot `claude
# -p` run never resumes — is not fatal. The runner --resumes it up to
# ISSUE_LOOP_NOSTATUS_MAX times (default 2), each time asking it to finish or
# report a status, then stops loudly for review. Unlike a usage-limit pause
# (free, unbounded) each no-status retry is a full, paid agent run.
#
# Output discipline: one start line and the agent's completion report per
# iteration; limit pauses/resumes are quiet (no operator action needed); loud
# (terminal bell + notify-send) only when the loop needs the operator: an
# hitl gate, a permission block, an error, or an anomaly.
#
# Usage:        ./scripts/issue-loop.sh
# Stop:         touch .loop-stop   (graceful: exits before the next agent;
#                                   also honoured during a usage-limit pause)
#               Ctrl-C             (in-flight session survives in .loop-state;
#                                   rerun the script to resume it)
# Env knobs:    ISSUE_LOOP_MAX=35       iteration cap (limit pauses don't count)
#               ISSUE_LOOP_EFFORT=max   effort level (low|medium|high|xhigh|max)
#               ISSUE_LOOP_MODEL=       optional --model override
#               CLAUDE_BIN=claude       agent binary (mockable for tests)
#               ISSUE_LOOP_RESET_BUFFER_SECS=120  extra wait past advertised reset
#               ISSUE_LOOP_PROBE_SECS=1800        retry cadence when no reset time
#                                                 is parseable (rejected probes
#                                                 are free while limited)
#               ISSUE_LOOP_NOSTATUS_MAX=2  auto-resume budget when an agent ends
#                                          with no LOOP_STATUS line (each retry
#                                          is a full, paid agent run)
# Test hook:    ./scripts/issue-loop.sh --parse-reset "<limit message>"
#               prints the computed reset epoch; exit 1 if unparseable

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
MAX_ITERATIONS="${ISSUE_LOOP_MAX:-35}"
EFFORT="${ISSUE_LOOP_EFFORT:-max}"
MODEL="${ISSUE_LOOP_MODEL:-}"
RESET_BUFFER="${ISSUE_LOOP_RESET_BUFFER_SECS:-120}"
PROBE_SECS="${ISSUE_LOOP_PROBE_SECS:-1800}"
NOSTATUS_MAX="${ISSUE_LOOP_NOSTATUS_MAX:-2}"
PROMPT_FILE=".claude/commands/next-issue.md"
LOG_DIR=".loop-logs"
STOP_FILE=".loop-stop"
STATE_FILE=".loop-state"

say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }

loud() {
    printf '\a'
    say "$*"
    if command -v notify-send >/dev/null 2>&1; then
        notify-send "watchthedrift-dev issue loop" "$*" || true
    fi
}

new_uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen; }

# --- usage-limit machinery ------------------------------------------------------------
# Observed limit-death shape (claude 2.1.175, headless): non-zero exit AND/OR a result
# JSON with is_error:true and result "You've hit your session limit · resets 3pm
# (Europe/London)" (weekly/Opus variants share the sentence shape). Older CLIs said
# "Claude AI usage limit reached|<unix-epoch>". Match both. Callers must also require
# a failed run (non-zero exit or is_error) so a healthy agent merely *talking* about
# limits is never mistaken for a limited one.

limit_text_of() {  # $1=result-json file  $2=stderr file → combined text on stdout
    jq -r '.result // empty' "$1" 2>/dev/null || cat "$1" 2>/dev/null || true
    cat "$2" 2>/dev/null || true
}

hit_usage_limit() {  # $1 = combined text
    grep -qiE "hit your [a-z0-9 -]{0,30}limit|usage limit reached" <<<"$1"
}

parse_reset_epoch() {  # $1 = limit message → echoes reset epoch; exit 1 if unparseable
    local txt="$1" epoch raw tz timestr now target guard=0
    # v1 format: "Claude AI usage limit reached|1718193600"
    epoch="$(grep -oiE 'limit reached\|[0-9]{9,12}' <<<"$txt" | grep -oE '[0-9]{9,12}' | head -1 || true)"
    if [[ -n "$epoch" ]]; then
        printf '%s\n' "$epoch"
        return 0
    fi
    # v2 format: "… · resets 3pm (Europe/London)" / "… · resets Mon 12:00am (TZ)"
    raw="$(grep -oiE 'resets[[:space:]]+[^()",]+(\([^)",]+\))?' <<<"$txt" | head -1 || true)"
    [[ -n "$raw" ]] || return 1
    tz="$(grep -oE '\([A-Za-z]+(/[A-Za-z_+-]+)+\)' <<<"$raw" | head -1 | tr -d '()' || true)"
    timestr="$(sed -E 's/^[Rr]esets[[:space:]]+//; s/\([^)]*\)//; s/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$raw")"
    [[ -n "$timestr" ]] || return 1
    now="$(date +%s)"
    if [[ -n "$tz" ]]; then
        target="$(TZ="$tz" date -d "$timestr" +%s 2>/dev/null || true)"
    else
        target="$(date -d "$timestr" +%s 2>/dev/null || true)"
    fi
    [[ "$target" =~ ^[0-9]+$ ]] || return 1
    # a bare time-of-day already past today means tomorrow ("3pm" parsed at 4pm);
    # GNU date resolves weekday names ("Mon") to the next occurrence on its own
    while ((target <= now && guard < 8)); do
        target=$((target + 86400))
        guard=$((guard + 1))
    done
    printf '%s\n' "$target"
}

wait_for_reset() {  # $1 = reset epoch ("" if unknown) → rc 0: resume now, rc 1: stop requested
    local now target chunk
    now="$(date +%s)"
    if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
        target=$(($1 + RESET_BUFFER))
        if ((target < now)); then target="$now"; fi
        say "usage limit hit — pausing until $(date -d "@$target" '+%a %H:%M %Z') (advertised reset + ${RESET_BUFFER}s), then auto-resuming the same agent. touch $STOP_FILE to stop instead — state survives."
    else
        target=$((now + PROBE_SECS))
        say "usage limit hit, no parseable reset time — re-probing every $((PROBE_SECS / 60)) min (rejected probes are free). touch $STOP_FILE to stop — state survives."
    fi
    while now="$(date +%s)"; ((now < target)); do
        [[ -e "$STOP_FILE" ]] && return 1
        chunk=$((target - now))
        if ((chunk > 60)); then chunk=60; fi
        sleep "$chunk"
    done
    [[ -e "$STOP_FILE" ]] && return 1
    return 0
}

# --- in-flight state (.loop-state) ----------------------------------------------------
# Present ⇔ an agent session may be mid-issue. Written before every spawn, updated on
# every resume, removed only when an agent ends with a parsed terminal status. On
# startup an existing file means: resume that session, don't spawn fresh (and don't
# demand a clean tree — the tree IS the interrupted agent's working state).

write_state() {
    printf 'run_id=%s\nsession_id=%s\nspawn_iso=%s\nresumes=%s\n' \
        "$run_id" "$session_id" "$spawn_iso" "$resumes" >"$STATE_FILE"
}
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null | head -1; }

# --- test hook -------------------------------------------------------------------------
if [[ "${1:-}" == "--parse-reset" ]]; then
    parse_reset_epoch "${2:-}"
    exit $?
fi

# --- pre-flight ------------------------------------------------------------------------
for bin in "$CLAUDE_BIN" jq gh git; do
    command -v "$bin" >/dev/null 2>&1 || { echo "missing: $bin" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated (run: gh auth login)" >&2; exit 1; }
[[ -f "$PROMPT_FILE" ]] || { echo "missing prompt file: $PROMPT_FILE" >&2; exit 1; }

pending_session=""
pending_run_id=""
pending_spawn_iso=""
pending_resumes=0
if [[ -f "$STATE_FILE" ]]; then
    pending_session="$(state_get session_id)"
    pending_run_id="$(state_get run_id)"
    pending_spawn_iso="$(state_get spawn_iso)"
    pending_resumes="$(state_get resumes)"
    [[ "$pending_resumes" =~ ^[0-9]+$ ]] || pending_resumes=0
    if [[ -z "$pending_session" || -z "$pending_run_id" ]]; then
        echo "found $STATE_FILE but cannot read run_id/session_id from it — inspect or delete it (plus any stale claim comment) and rerun" >&2
        exit 1
    fi
    say "in-flight agent found ($pending_run_id, ${pending_resumes} resume(s) so far) — resuming it; tree left exactly as it stood"
elif [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree is dirty and no $STATE_FILE explains it — commit/stash before starting the loop" >&2
    exit 1
fi

mkdir -p "$LOG_DIR"
if [[ -e "$STOP_FILE" ]]; then
    say "clearing stale $STOP_FILE from a previous run (it stops a RUNNING loop, not a new one)"
    rm -f "$STOP_FILE"
fi

trap 'echo; loud "Loop interrupted — if an agent was mid-issue its session lives on in $STATE_FILE: rerun ./scripts/issue-loop.sh to resume it."; exit 130' INT

# strip the YAML frontmatter from the slash-command file: the body is the contract
worker_contract="$(awk 'NR==1 && $0=="---" {infm=1; next} infm && $0=="---" {infm=0; next} !infm {print}' "$PROMPT_FILE")"

resume_prompt() {  # $1 = run id
    printf 'RUN_ID: %s\n\n%s' "$1" \
"You are resuming YOUR OWN earlier run, interrupted by a usage-limit pause or a
process restart — your conversation context is intact. Re-orient cheaply first:
git status, git log --oneline -5, and the comments on the issue you claimed.
Then continue exactly where you left off and finish that issue per your
original instructions; do not pick a different issue. You are headless: your
turn ends when you stop calling tools and nothing wakes you for background
work, so finish in this turn rather than waiting on async tasks. If it turns
out the issue is already fully landed (PR merged, issue closed), verify that
and report. End with the LOOP_STATUS line exactly as originally instructed."
}

nostatus_prompt() {  # $1 = run id — used after an agent returned with no LOOP_STATUS line
    printf 'RUN_ID: %s\n\n%s' "$1" \
"You are resuming YOUR OWN earlier run — your context is intact. Your previous
turn ended WITHOUT the required LOOP_STATUS line as its last line, so the loop
could not tell what happened. You are headless (claude -p): your turn ends the
moment you stop calling tools, and any run_in_background task is abandoned when
the process exits — nothing wakes you when background work finishes, so do NOT
end a turn waiting on async work. Re-orient cheaply (git status, git log
--oneline -5, the issue's comments), then either finish the issue now — blocking
or polling on any work you started rather than waiting for it across turns — or,
if it genuinely cannot finish, explain why. End your message with exactly ONE
LOOP_STATUS line as instructed (use 'LOOP_STATUS: blocked … reason=other' if you
truly cannot proceed)."
}

say "issue loop starting: fresh agent per issue, effort=$EFFORT, cap=$MAX_ITERATIONS, logs in $LOG_DIR/"

for ((i = 1; i <= MAX_ITERATIONS; i++)); do
    if [[ -e "$STOP_FILE" ]]; then
        rm -f "$STOP_FILE"
        say "stop file found — exiting cleanly before agent $i"
        exit 0
    fi

    resuming=0
    resume_kind=""
    if [[ -n "$pending_session" ]]; then
        # restart-resume: continue the interrupted agent. Its branch + dirty tree ARE
        # the working state, so no checkout main, no pull, no clean-tree demand.
        session_id="$pending_session"
        run_id="$pending_run_id"
        spawn_iso="$pending_spawn_iso"
        resumes="$pending_resumes"
        pending_session=""
        resuming=1
        resume_kind="restart"
    else
        # every fresh agent starts from up-to-date main, never from a leftover branch
        git checkout main --quiet
        git pull --ff-only --quiet
        spawn_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        run_id="loop-$(date -u +%Y%m%dT%H%M%SZ)"
        session_id="$(new_uuid)"
        resumes=0
        write_state
    fi
    mkdir -p "$LOG_DIR"

    model_args=()
    [[ -n "$MODEL" ]] && model_args=(--model "$MODEL")

    nostatus_resumes=0
    total_ms=0
    total_turns=0
    total_cost=0

    while :; do
        if ((resuming)); then
            resumes=$((resumes + 1))
            write_state
            log_json="$LOG_DIR/${run_id}-r${resumes}.json"
            log_err="$LOG_DIR/${run_id}-r${resumes}.stderr"
            cli_args=(--resume "$session_id")
            if [[ "$resume_kind" == "nostatus" ]]; then
                prompt="$(nostatus_prompt "$run_id")"
                say "agent $i/$MAX_ITERATIONS resuming after a no-status return (${run_id}, resume #${resumes}) — asking it to finish or report…"
            else
                prompt="$(resume_prompt "$run_id")"
                say "agent $i/$MAX_ITERATIONS resuming (${run_id}, resume #${resumes}, session ${session_id:0:8}…) — quiet until it completes…"
            fi
        else
            log_json="$LOG_DIR/${run_id}.json"
            log_err="$LOG_DIR/${run_id}.stderr"
            cli_args=(--session-id "$session_id")
            prompt="$(printf 'RUN_ID: %s\n\n%s' "$run_id" "$worker_contract")"
            say "agent $i/$MAX_ITERATIONS spawning (${run_id}) — quiet until it completes…"
        fi

        set +e
        "$CLAUDE_BIN" -p "$prompt" \
            --permission-mode auto \
            --effort "$EFFORT" \
            --output-format json \
            "${model_args[@]}" \
            "${cli_args[@]}" \
            >"$log_json" 2>"$log_err"
        agent_exit=$?
        set -e

        ms="$(jq -r '.duration_ms // 0' "$log_json" 2>/dev/null || echo 0)"
        tn="$(jq -r '.num_turns // 0' "$log_json" 2>/dev/null || echo 0)"
        cs="$(jq -r '.total_cost_usd // 0' "$log_json" 2>/dev/null || echo 0)"
        total_ms="$(awk -v a="$total_ms" -v b="$ms" 'BEGIN{print a + b}')"
        total_turns="$(awk -v a="$total_turns" -v b="$tn" 'BEGIN{print a + b}')"
        total_cost="$(awk -v a="$total_cost" -v b="$cs" 'BEGIN{print a + b}')"

        is_error="$(jq -r '.is_error // false' "$log_json" 2>/dev/null || echo unparseable)"
        if [[ "$agent_exit" -ne 0 || "$is_error" != "false" ]]; then
            limit_text="$(limit_text_of "$log_json" "$log_err")"
            if hit_usage_limit "$limit_text"; then
                if ! wait_for_reset "$(parse_reset_epoch "$limit_text" || true)"; then
                    rm -f "$STOP_FILE"
                    say "stop requested during usage-limit pause — exiting; rerun ./scripts/issue-loop.sh to resume the in-flight agent (it pauses again if still limited)."
                    exit 0
                fi
                resuming=1
                resume_kind="limit"
                continue
            fi
        fi

        if [[ "$agent_exit" -ne 0 ]]; then
            loud "agent $i exited non-zero ($agent_exit), not a usage limit — see $log_json / $log_err. Stopping; state kept: rerun to resume, or rm $STATE_FILE (+ stale claim comment) to spawn fresh."
            exit 1
        fi

        result="$(jq -r '.result // empty' "$log_json")"
        if [[ "$is_error" != "false" || -z "$result" ]]; then
            loud "agent $i returned an error or empty result — see $log_json. Stopping; state kept: rerun to resume, or rm $STATE_FILE to spawn fresh."
            exit 1
        fi

        mins="$(awk -v ms="$total_ms" 'BEGIN{printf "%.1f", ms / 60000}')"
        turns="$total_turns"
        cost="$(awk -v c="$total_cost" 'BEGIN{printf "%.2f", c}')"

        resumed_note=""
        limit_resumes=$((resumes - nostatus_resumes))
        if ((limit_resumes > 0)); then resumed_note+=", ${limit_resumes} limit-resume(s)"; fi
        if ((nostatus_resumes > 0)); then resumed_note+=", ${nostatus_resumes} no-status-retry(s)"; fi

        echo
        echo "──────── agent $i report (${mins} min, ${turns} turns, \$${cost}${resumed_note}) ────────"
        printf '%s\n' "$result"
        echo "────────────────────────────────────────────────────────────"
        echo

        status_line="$(printf '%s\n' "$result" | grep -E '^LOOP_STATUS:' | tail -1 || true)"
        issue_num="$(printf '%s\n' "$status_line" | sed -n 's/.*issue=#\{0,1\}\([0-9][0-9]*\).*/\1/p')"

        case "$status_line" in
            "LOOP_STATUS: completed"*)
                # trust but verify: the claimed issue must actually be closed, and closed
                # DURING this agent's run — a false "completed" against a long-closed issue
                # would otherwise spin the loop forever
                state="$(gh issue view "$issue_num" --json state -q .state 2>/dev/null || echo UNKNOWN)"
                if [[ "$state" != "CLOSED" ]]; then
                    sleep 10
                    state="$(gh issue view "$issue_num" --json state -q .state 2>/dev/null || echo UNKNOWN)"
                fi
                if [[ "$state" != "CLOSED" ]]; then
                    loud "agent $i reported issue #$issue_num completed but it is $state — stopping for review. State kept: rerun resumes the session to reconcile, or rm $STATE_FILE to drop it."
                    exit 1
                fi
                closed_at="$(gh issue view "$issue_num" --json closedAt -q .closedAt 2>/dev/null || echo "")"
                if [[ -z "$closed_at" || ! "$closed_at" > "$spawn_iso" ]]; then
                    loud "agent $i reported issue #$issue_num completed but it closed at '${closed_at:-?}', before this agent spawned ($spawn_iso) — stopping for review. rm $STATE_FILE if you conclude the session is dead."
                    exit 1
                fi
                rm -f "$STATE_FILE"
                say "issue #$issue_num closed ✓ — next agent shortly"
                sleep 3
                ;;
            "LOOP_STATUS: no-work"*)
                rm -f "$STATE_FILE"
                say "no unblocked work remains — loop done."
                exit 0
                ;;
            "LOOP_STATUS: gate"*)
                rm -f "$STATE_FILE"
                loud "HITL gate reached (issue #${issue_num:-?}) — operator action required; see the report above."
                exit 0
                ;;
            *"reason=permission"*)
                rm -f "$STATE_FILE"
                loud "agent $i STUCK NEEDING PERMISSIONS on issue #${issue_num:-?} — see the report above. Stopping."
                exit 1
                ;;
            "LOOP_STATUS: blocked"*)
                rm -f "$STATE_FILE"
                loud "agent $i blocked on issue #${issue_num:-?} (${status_line#LOOP_STATUS: }) — stopping."
                exit 1
                ;;
            *)
                # no parseable status: the agent ended mid-thought (often it tried to
                # "wait" for background work that a one-shot `claude -p` never resumes).
                # Nudge it to finish-or-report up to NOSTATUS_MAX times before stopping
                # loudly. Each retry is a full, paid run, so the budget stays small —
                # and unlike a usage-limit pause it is NOT free.
                if ((nostatus_resumes >= NOSTATUS_MAX)); then
                    loud "agent $i still produced no LOOP_STATUS line after ${NOSTATUS_MAX} nudge(s) — stopping for review ($log_json). State kept: rerun resumes this session, or rm $STATE_FILE to spawn fresh."
                    exit 1
                fi
                if [[ -e "$STOP_FILE" ]]; then
                    rm -f "$STOP_FILE"
                    say "stop file found — exiting before re-nudging agent $i; its session is in $STATE_FILE, rerun ./scripts/issue-loop.sh to resume it."
                    exit 0
                fi
                nostatus_resumes=$((nostatus_resumes + 1))
                resuming=1
                resume_kind="nostatus"
                total_ms=0
                total_turns=0
                total_cost=0
                say "agent $i ended without a LOOP_STATUS line — auto-resuming to ask it to finish or report (retry ${nostatus_resumes}/${NOSTATUS_MAX}; state kept). touch $STOP_FILE to stop instead."
                continue
                ;;
        esac
        break
    done
done

loud "iteration cap ($MAX_ITERATIONS) reached — restart the loop to continue."
