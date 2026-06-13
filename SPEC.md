# watchthedrift v2 — directional spec

> A **directional** spec, deliberately rough: the north star, the tracks, and the
> open decisions — not an implementation plan. Meant to be sharpened with
> `/grill-me`, turned into a PRD with `/to-prd`, sliced into issues with
> `/to-issues`, and built in a `/loop`. This is the experimentation repo;
> production lives at
> [SilentKinfolk/watchthedrift](https://github.com/SilentKinfolk/watchthedrift)
> (live: <https://silentkinfolk.github.io/watchthedrift/>).

## Where we are (v1)

watchthedrift answers one question — _how many seconds is your watch off from
real time, right now?_ — by pointing a phone camera at a Casio F-91W. Today:

- **Reading**: a hand-written, pure-TypeScript seven-segment decoder, on-device,
  no ML/cloud. Live scan (decode frames continuously, lock when two reads agree).
  Reads clean, front-on, well-lit shots reliably.
- **Time**: NTP-style HTTPS sync, round-trip compensated, with an honest
  uncertainty band; answer is to the nearest second (the watch shows whole seconds).
- **UX**: single-screen, black-and-white, zero-install, ephemeral (no
  storage/logging). A small alignment box you frame the time row in.
- **Infra**: GitHub Pages, auto-deploy on push, Dependabot auto-merge.

**The wall we hit:** the decoder is brittle outside its comfort zone. Angled or
off-centre shots can binarise to all-black; low light (the LCD is reflective, no
backlight) defeats detection; the small seconds digit and faint/aged segments
mis-split. v1 leans on the user to frame a clean, head-on, well-lit shot. That
ceiling is what v2 is about.

## v2 thesis (north star)

**Point your phone at (almost) any digital watch, in real conditions, and get a
trustworthy drift reading — without lining anything up.** Robust enough that
framing, angle, and lighting stop mattering; broad enough to read beyond the
F-91W; still on-device, private, ephemeral, and zero-install.

## Invariants (don't break these without a deliberate decision)

These are what make watchthedrift _itself_. An experiment that violates one
should say so loudly and justify it.

- **On-device.** No image leaves the phone. The only network call is the time check.
- **Ephemeral.** No accounts, no storage, no logging, no history. Every
  measurement stands alone.
- **Zero-install.** Works from a URL in a browser; PWA install is optional, never
  required.
- **Honest.** Always show uncertainty; fail to a retake rather than guess.
- **Minimal.** Black-and-white, single-screen, close-to-raw aesthetic.

> Tension to resolve, not assume: "ephemeral / no history" directly blocks a few
> tempting v2 ideas (drift-over-time, multi-watch). See open decision #4.

## Tracks

Independent enough to slice and build in parallel; each can be a tracer-bullet
vertical (thin slice through capture → read → result).

### 1. Recognition v2 — the core

Make reading robust to the real world.

- **Approach.** Move from hand-written segments to a learned reader, _or_ a hybrid
  (ML locates + deskews the LCD, the existing decoder reads the rectified crop).
  Decide the split — it sets the whole effort.
- **Robustness targets.** Angle/perspective, off-centre, low light / glare on the
  reflective LCD, faint/aged segments, the small seconds digit.
- **Runtime.** Must run on-device in a browser (ONNX Runtime Web / TF.js / WASM),
  fast enough for live scan (~several FPS) within a hard model-size + latency budget.
- **Training data.** Synthetic-first (rendered F-91W faces across angle/lighting)
  plus some real; labelling, and avoiding overfitting to one unit/one watch.
- **Fallback.** Keep the v1 decoder as a fast path / when the model is unsure?

### 2. Device reach

- How far past the F-91W? (Other Casio digitals → generic 7-segment digitals →
  LCD/LED clocks?)
- Layout-agnostic (find HH:MM:SS wherever it sits) vs per-model layout knowledge.
- 12h/24h, AM/PM, date and day-of-week fields — disambiguation when the reader
  doesn't know the specific watch.

### 3. Experience & platform

- **Capture guidance** that survives dropping the alignment box: live feedback
  (too dark, hold steady, found it), phone-torch toggle for low light (Android),
  a "press the watch's backlight" prompt.
- **PWA / offline.** Installable, offline reading (model + app cached). The time
  check still needs network — define offline behaviour honestly.
- Keep the B&W minimal line and accessibility.

### 4. Trust & precision

- Tighten the uncertainty story end-to-end (capture instant → model latency →
  time sync).
- Is sub-second ever meaningful, or is "nearest second" the honest ceiling?
  (Currently nearest-second, deliberately.)
- Time-sync resilience (more sources; behaviour when offline).

### 5. Infra & dev loop

- This dev/preview repo + its own Pages deploy as the experimentation ground.
- Model hosting/versioning, on-device caching, and a bundle-size budget enforced
  in CI.

## Open decisions (grill these)

The forks that change everything downstream:

1. **ML vs hybrid vs better-heuristics.** Full learned reader, or ML-for-detection
   + heuristic-for-digits? Sets scope, data needs, and runtime.
2. **On-device model budget.** What size/latency is acceptable for live scan on a
   mid-range phone? This bounds the model before anything else.
3. **Breadth vs depth.** Nail the F-91W in _all_ conditions first, or go
   layout-agnostic across watches from the start?
4. **The ephemeral invariant.** Do we _ever_ allow opt-in local history /
   drift-over-time (currently an explicit non-goal)? If yes, how without betraying
   "ephemeral"? If no, kill those ideas now.
5. **Training-data strategy.** Synthetic-first (renders) vs real-photo collection
   — and how to collect given the on-device / no-upload privacy stance?
6. **Fallback policy.** Keep the v1 decoder in the bundle as a fast/second path,
   or replace it outright?

## Non-goals (unless a decision above flips them)

Storing history, accounts, charts, drift-rate-over-time, server-side processing,
notifications. v2 raises the recognition ceiling and the device reach — it does
not turn watchthedrift into a tracker or a service.

## How this doc gets used next

1. **`/grill-me`** this spec — resolve the open decisions, especially #1–#4.
2. **`/to-prd`** the sharpened direction into a PRD on the tracker.
3. **`/to-issues`** → tracer-bullet vertical slices, per track.
4. **`/loop`** to build over them, deploying experiments to this repo's preview
   site.
