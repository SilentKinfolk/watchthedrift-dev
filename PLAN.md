# watchthedrift v2 — PLAN (design authority)

> The **decided** counterpart to [`SPEC.md`](SPEC.md). SPEC is the directional
> north star; this PLAN closes its open decisions (#1–#6) and the track questions
> into a committed design **with the rationale**, so future agents don't
> re-derive it. Where the two conflict, **PLAN wins** — SPEC's "Open decisions"
> section is now resolved here. Sharpened via `/grill-me` on 2026-06-13; next
> steps `/to-prd` → `/to-issues` → `/loop`.

## Thesis

Point your phone at a Casio F-91W, in real conditions, **without lining anything
up**, and get a trustworthy **nearest-second** drift reading — on-device,
private, ephemeral, zero-install.

**Scope cut from SPEC's thesis (decision #3 — depth, not breadth):** "almost any
digital watch" is **deferred**. v2 is depth-first on the **F-91W only**. The wall
v1 hit was *robustness*, not breadth; breadth adds a disambiguation sub-project
(field roles, 12/24h, date) orthogonal to the robustness we actually need, and
multiplies the eval/data burden before the core is proven. The architecture
below happens to generalize (a digit *detector/reader*, not an F-91W *template*),
so breadth stays a later data problem, not a rewrite — but it is not a v2 goal.

## Invariants

On-device · zero-install · honest (fail-to-retake, always show uncertainty) ·
minimal black-and-white single-screen — all **retained**.

**Ephemeral is now permanent (decision #4).** watchthedrift is a **stateless
snapshot instrument, forever** — no accounts, no storage, no logging, no history.
The namesake "drift-over-time", plus multi-watch and any tracker/charting
ideas, are **killed, not deferred**. Rationale: drift-rate needs cross-session
persistence (a watch drifts seconds *per day*, so in-session rate is noise), and
that is a one-way identity door ("are we a tracker now?") entirely off v2's
recognition critical path. Killing it permanently retires the temptation and
keeps the clean "nothing is ever stored" promise.

## The pipeline (decisions #1, #6)

```
phone frame
  → learned corner detector  (4 LCD corners)
  → deterministic homography → frontal, normalized crop
  → [ learned reader  ‖  v1 heuristic segment decoder ]   ← run together (cross-check)
  → arbitration:
        both agree           → lock, high confidence          (easy/moderate majority)
        clash (read ≠ read)  → abstain → retake               (the confident-wrong danger zone)
        lone reader read     → trust the reader's CALIBRATED confidence
                               (heuristic abstains on faint / small-seconds — where the model earns its keep)
  → decode-to-verify (valid HH:MM:SS only) → drift vs network time → nearest-second ± band
```

**Why this shape.** Reading v1's decoder settled decision #1. Its reading logic
is structurally *perspective-naive*: it splits digit cells by vertical column
gaps and samples seven *fixed normalized rectangles* per cell — both assume an
upright, axis-aligned, frontal digit, so rotation/skew breaks it and it cannot be
patched into perspective-robustness. Something upstream must hand it a frontal
crop. Two failures rectification *cannot* fix — faint/aged segments (the team
already tried and abandoned adaptive thresholding: LCD mottling reads as speckle)
and the small offset seconds digit — are exactly what justify a **learned
reader** over a pure ML-front-end/heuristic-reader hybrid.

Decisions inside #1:

- **Learned reader, not better-heuristics.** Escapes the threshold ceiling on
  faint/small-seconds that v1's own code concedes.
- **Rectify → read, not end-to-end.** A frontal normalized crop keeps the reader
  *tiny* (fixed small input, canonical layout), keeps a debuggable intermediate
  crop for the honesty/overlay story, and makes per-digit calibration tractable.
  End-to-end is the worst fit on-device for one known watch (biggest/slowest,
  hardest to calibrate, needs full-scene labels).
- **Learned corners for the rectification, not classical quad detection.** We're
  already shipping a model runtime, so "classical needs no model" is moot; and
  classical contour/quad detection leans on crisp edges that the reflective F-91W
  bezel *loses* in the low-light/glare conditions v2 exists to fix. A small
  keypoint net is robust there, and synthetic-free corner labels come from the
  same photos (below).
- **Cross-check, not replace (decision #6).** Rectification removes the v1
  decoder's *only* weakness (perspective), so on the rectified crop it is a
  near-free *independent second opinion* — the cheapest route to the precision
  gate below. It also doubles as the **offline degradation path**. Crucially we
  do **not require agreement** (that would cap the system at the heuristic's
  ceiling on the exact hard cases the model exists to win). **Tesseract is
  dropped** — its 1.4 MB + wasm doesn't fit the budget and is redundant.

## On-device budget (decision #2)

**Tight: ≤ ~5 MB total first-load** (both models ≤ ~1.5 MB int8-quantized + a
lean wasm-SIMD runtime), **≥ 5 FPS** on a ~3–4-year-old mid-range Android,
WebGPU as optional progressive enhancement, enforced by a **CI byte-gate**.

Two reframes from reading v1 justify "tight": **latency isn't binding** — v1
already does live scan with *lock-on-agreement*, which hides per-frame cost, and
two tiny CNNs run in tens of ms on wasm-SIMD; and the **byte sink is the runtime,
not the weights** — a corner regressor + a crop reader are ~1–1.5 MB combined,
while the ML runtime is the multi-MB download (v1 already tolerates ~1.4 MB of
Tesseract data). Two models share one runtime, so the second is nearly free.

## Training data (decision #5)

**Web-collected real F-91W photos. No renders.** (A faithful PBR render of a
reflective LCD is its own sub-project with its own sim-to-real gap; collecting
real photos gives true LCD photoreality for free.)

- **Coverage — hunt + augment.** The internet skews to the *easy* case (clean,
  frontal, well-lit, often the same marketing time → skewed digit distribution),
  which is precisely v1's comfort zone. So: *collect* genuine hard-condition
  shots where they exist **and** *augment* the clean ones into the hard
  conditions — perspective warps, low-light gamma, synthetic glare, blur,
  segment-fade. Augmentation distorts **real pixels** (not rendering), so the LCD
  stays photoreal, and labels transform automatically (digits unchanged; corners
  follow the warp — which also *solves corner labelling* for augmented data).
- **Eval discipline.** Training = collected clean + augmented + found-hard. **Eval
  (held out, never augmented) = real photos only, weighted to the genuinely hard
  ones.** Grading on your own augmentations flatters the model; the hunted hard
  reals are most valuable as the **eval gold set**.
- **Labelling & rights.** Filename convention for time (`*_HH-MM-SS_24h.jpg`, per
  the v1 harness) + a small **4-point corner-annotation sidecar tool** for real
  photos. Collected images stay **gitignored / un-redistributed** (repo is
  scrupulously CC-only); **only trained weights ship**.

## Success metric (acceptance gate)

**Precision-first**, because "honest — fail to a retake rather than guess" is an
invariant. A read has three outcomes, not two: *correct*, *honest abstain →
retake*, and *confident-but-wrong*. The last is the cardinal sin (a silently
wrong drift number), so the gate **leads with a confident-wrong ceiling**, not a
headline accuracy:

- **Primary gate:** confident-wrong ≤ **~0.5%** (target near-zero) across **all**
  strata including hard, measured on the **post-agreement locked answer**.
- **Secondary (stratified read-success):** ≈ **≥95% easy / ≥80% moderate /
  best-effort hard**, the rest falling honestly to retake.
- **Calibration is mandatory:** the reader's confidence must be calibrated (e.g.
  temperature scaling on a held-out set) so the abstain threshold means
  something. v1's confidence is a Hamming-distance proxy — not good enough.

## Precision & trust (Track 4)

**Nearest-second stays the honest ceiling.** v1's own band is ±0.5 s quantisation
(a whole-second display read from a *static* frame is only known to ±0.5 s) ⊕ the
time-source floor (the HTTPS `Date`-header source has 1 s resolution → floored at
±500 ms), so the honest band is ≈ **±0.7–1.0 s**. Sub-second would require **two**
orthogonal upgrades — rollover-transition detection *and* a sub-second time source
— so it's out of scope.

The in-scope v2 win is a **better-than-1s time source** (tightens the band toward
the ±0.5 s quantisation floor; also the prerequisite if sub-second is ever
revisited) plus sync resilience / offline behaviour. `TimeSync.trueUtcAt(perfNow)`
already maps a **frame-grab** instant to true UTC, so the new pipeline's added
latency (corners → homography → reader) is a **UX** concern, not an accuracy one —
keep timestamping at frame-grab.

## Experience & platform (Track 3)

- **Drop the alignment box.** The corner detector finds the LCD anywhere in frame
  — that *is* "without lining anything up." Keep minimal honest live feedback
  (too dark / glare / hold steady / found it).
- **Ambient-light only — no active illumination.** Torch is a non-starter
  (Android won't enable the `torch` constraint during a live `getUserMedia`
  stream) and the watch's own backlight needs a third hand while aiming. So:
  **try hardest, abstain honestly when too dark** ("too dark — find more light").
  Adequate ambient light is an accepted precondition.
  - **Scope consequence (deliberate, not silent):** *true low light is handled by
    honest failure, not by adding photons.* Augmented low-light data lets the
    model cope with *moderate* dimness; below threshold → retake. This is what
    keeps the model small — it was never required to be a low-light hero. Glare,
    angle, off-centre, faint-in-adequate-light and small-seconds remain in scope.
- **Offline.** Reading works offline (model cached); the **time check requires
  network**, so offline we say **"connect to measure"** — and **never** fall back
  to the device clock (circular: the phone clock is exactly the thing that might
  be wrong).

## Infra & dev loop (Track 5)

Bundle the model as a **versioned same-origin build asset** (cache-busted by build
hash → **atomic app+model versioning**), service-worker caches app + model for
offline reading, the **CI byte-gate** guards ≤ 5 MB, and this dev repo's preview
Pages deploy is the experimentation ground. Same-origin over a separate CDN:
offline-friendly, no third-party dependency, versioning stays atomic.

## Build order (tracer-bullet slices for `/to-issues`)

Each slice is a thin vertical through capture → read → result, independently
shippable to the preview site. The ordering front-loads robustness and de-risks
the pipeline *before* any model is trained.

1. **Baseline port** — stand up the v1 app in this repo (camera, v1 heuristic
   decoder, time-sync, drift, B&W UI) + the Node eval harness → a working preview
   deploy. Establishes the end-to-end spine here.
2. **Rectification stage** — corner detector + homography feeding the **existing
   v1 decoder** on the rectified crop. First model; first byte-gate. This alone
   should lift angle / off-centre / all-black — measurable on the harness, with
   no learned reader yet (a waypoint toward the learned-reader end state, not the
   end state).
3. **Data + eval** — collection tooling, corner-annotation sidecar, augmentation
   pipeline, stratified real eval set (easy/moderate/hard), precision-first metric
   wired into CI.
4. **Learned reader** — train + integrate on the rectified crop, wire the
   cross-check arbitration (agree / clash / lone), calibrate confidence. The
   reader now earns faint / small-seconds.
5. **Capture UX + offline** — drop the alignment box, live feedback, too-dark
   abstain, require-network offline behaviour, service-worker model caching.
6. **Trust polish** — sub-second time source, sync resilience, visible ± band.

## Top risks (carry into the PRD)

1. **Hard-case data is make-or-break** — without a credible *real* hard eval set,
   the precision-first gate can't be trusted. Highest risk.
2. **Augmentation realism** — distorted clean photos may not match real
   low-light/glare physics; eval-on-real-only is the guard against self-deception.
3. **Corner stage is the bottleneck** — wrong corners → wrong homography → garbage
   to the reader; eval the rectification stage *in isolation*, especially in glare.
4. **Calibration** — precision-first lives or dies on calibrated confidence + a
   sound abstain threshold; needs a real calibration set and ongoing validation.
5. **Budget vs accuracy** — with the budget fixed and low-light descoped, the only
   levers left if accuracy falls short are more/better data and capture
   preconditions.
