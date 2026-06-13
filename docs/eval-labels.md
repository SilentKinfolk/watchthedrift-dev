# Eval labels — the corner-label sidecar schema & precision-first metric

This is the **shared label contract** for watchthedrift v2's recognition data. It
is defined once, in code, at [`src/eval/label.ts`](../src/eval/label.ts) (schema +
parsing) and [`src/eval/metrics.ts`](../src/eval/metrics.ts) (scoring), and targeted
by three pieces of the pipeline:

- the **corner-annotation tool** (#8) *writes* sidecars — a browser page (click the
  4 LCD corners + enter the time) and a `npm run annotate` CLI, both over one
  validated core ([`src/eval/annotate.ts`](../src/eval/annotate.ts)),
- the **augmentation pipeline** (#7) *reads* corners + time and *transforms* them
  through each warp (corners follow the homography; the digits are unchanged),
- the **harness** (#5, [`tools/ocr-harness.ts`](../tools/ocr-harness.ts)) *reads*
  time + stratum and scores the **precision-first acceptance gate**.

Treat `label.ts` as the source of truth; this doc is the prose around it.

## The sidecar

One JSON file sits beside each image, named **`<image-filename>.json`** — the full
filename plus `.json`, so `foo.jpg` and `foo.png` never collide:

```
tools/fixtures/f91w-front-closeup_19-45-08_24h.jpg        ← image (gitignored)
tools/fixtures/f91w-front-closeup_19-45-08_24h.jpg.json   ← sidecar (committed)
```

### Schema (`CornerLabel`, version 1)

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `version` | `1` | tolerated if absent (→ 1) | Schema version, for migration. |
| `time` | `{hh,mm,ss}` \| `null` | optional | Ground-truth display time. **Absent → falls back to the filename `HH-MM-SS` label.** |
| `is24h` | `boolean` | optional | Display mode. **Absent → falls back to the filename `12h` token (else 24h).** |
| `corners` | `[{x,y}×4]` \| `null` | optional | The 4 LCD corners in **TL, TR, BR, BL** order, image pixel coords. Absent until annotated (#8) / augmented (#7). Same order/meaning as rectify's `Quad`, so it drops straight into the homography. |
| `stratum` | `"easy"` \| `"moderate"` \| `"hard"` \| `null` | optional | Difficulty bucket. **Absent → counted under `unstratified`.** |
| `eval` | `boolean` | optional | Part of the held-out eval gold set (never augmented). |
| `source` | `{url?,license?,credit?}` | optional | Provenance. **Required before committing any redistributable fixture.** |
| `note` | `string` | optional | Free-form (e.g. why it's hard / what v1 does). |

Fields fill in over the data's life — a record may carry only a `stratum` today and
gain `corners` once annotated — so almost everything is optional. A malformed
sidecar (bad version, out-of-range time, wrong corner count, unknown stratum) is
**rejected** by `parseCornerLabel` with a field-specific error; the harness warns
and falls back to the filename rather than silently mis-scoring.

### Label resolution (precedence)

`resolveLabel(filename, sidecar)` combines the two sources: **the sidecar wins
where present; the filename is the fallback** for `time`/`is24h`. So a fixture whose
time is already in its filename needs a sidecar only to add `stratum` / `corners` /
`source` — no time duplication. A real photo with no time in its name carries the
time in the sidecar instead.

## Strata

The eval set is stratified so we can see exactly where the pipeline holds and
breaks (PLAN "Success metric"). The secondary read-success targets are per-stratum;
the **primary gate (confidently-wrong) applies across all strata, hard included.**

| Stratum | Conditions | Read-success target |
| --- | --- | --- |
| **easy** | Clean, front-on, well-lit, sharp — v1's comfort zone. | ≈ ≥95% |
| **moderate** | Mild angle / off-centre / mild dimness / minor glare — recoverable by rectification, still clearly legible. | ≈ ≥80% |
| **hard** | Strong angle, near-threshold dimness, significant glare, **faint/aged segments**, the **small seconds digit** — the cases that justify the learned reader. Weighted heaviest in eval. | best-effort |

"Best-effort" on hard means a low *read-success* is acceptable (abstaining is
honest), but a **confidently-wrong** read on a hard image is **not** — it still
counts against the gate. The eval gold set is **weighted toward hard** and is held
out **un-augmented** (grading on our own distortions would flatter the model).

## Eval gold vs training seed

Each labelled real is one or the other, by its `eval` flag:

- **Eval gold (`eval: true`)** — the held-out truth set the precision gate scores.
  Weighted to **hard** (the hunted hard reals are the highest-value eval images, and
  a precision-first gate is most honest measured on them, not flattered by easy
  reals). **Never augmented** (the augmentation pipeline skips them).
- **Training seed (`eval: false`)** — clean reals the augmentation pipeline (#7)
  expands into hard training variants for the corner detector (#9) and reader (#10).

With the four committed CC fixtures this lands as: `front-closeup` + `5051` = eval
gold (both hard); `time-noretouch` (clean, timed) = the augmentation seed;
`all-segments` (no real time) = a corner/detection card. There is exactly **one**
clean+timed CC real, so it must be EITHER easy-eval OR the augment seed — seed wins,
because augmentation is load-bearing for #9 and a precision gate is more honest on
the hard gold. The easy/moderate **eval** gap (no CC moderate-angle real to hand) is
filled by collecting reals into `tools/local/` and annotating them; the harness
buckets by stratum, so new strata light up as they are added.

## The precision-first metric

Every scored read is one of three outcomes:

- **correct** — the locked answer equals ground truth;
- **abstain → retake** — the pipeline declined to lock (no reading, or below the
  abstain threshold). Honest. This is "fail to a retake rather than guess";
- **wrong** — it locked a confident answer that is wrong. **The cardinal sin**: a
  silently-wrong drift number the user would trust.

The gate therefore **leads with a confidently-wrong ceiling**, not a headline
accuracy:

- **Primary gate:** confidently-wrong ≤ **~0.5%** (target near-zero) over the
  pooled (all-strata) locked answers.
- **Secondary:** stratified read-success (the table above).

### Tolerant while the set is tiny

`evaluateGate` is **advisory** (reports but never fails) below `minSamples`
(default **200**). A 0.5% rate is unobservable below ~200 samples — a single
confidently-wrong read is already 0.5% at N=200, and 33% at N=3 — so enforcing it on
a tiny set is statistically meaningless. The gate activates automatically once the
sample count crosses the floor. This is the "wired but tolerant" knob.

### Where it runs

- **`evaluateGate` is unit-tested in Vitest** ([`metrics.test.ts`](../src/eval/metrics.test.ts)),
  which runs in CI — so the gate *logic* (it fails above the ceiling once there are
  enough samples) is guaranteed by CI today, deterministically, with no images or
  model loaded.
- **The harness** prints two precision-first tables — **all labelled** (context) and
  the **held-out eval gold** — and runs the gate on the **eval gold**, exiting
  non-zero on a (non-advisory) FAIL. CI runs `npm run harness`, so the gate fires
  over the *committed* eval gold the moment enough of it exists.

> **CI vs local coverage.** Only redistributable (CC/PD) fixtures are committed, so
> CI gates on that committable subset. Collected, non-redistributable hard reals
> stay gitignored (#8) and are scored **locally** — the full eval set is not
> available in CI by design (the repo stays image-free). The Vitest gate test is
> the CI-resident guarantee; the harness is the over-real-data gate.

## Licensing

The repo stays **scrupulously CC-only / image-free**: fixture images are gitignored
and re-fetched from the URLs in [`tools/fixtures/CREDITS.md`](../tools/fixtures/CREDITS.md).
**Sidecars are committed** (they are labels/metadata, like CREDITS.md — no pixels).
Any image you *do* commit must be clearly CC/PD with `source` recorded; collected
non-redistributable photos stay in `tools/local/` or gitignored under
`tools/fixtures/`.
