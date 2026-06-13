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
- **Learned corners for the rectification, not classical quad detection.**
  Classical contour/quad detection leans on crisp bezel edges that the reflective
  F-91W *loses* under the low-light/glare conditions v2 exists to fix; a small
  keypoint net is robust there. (The original "we already ship a model runtime, so
  classical-needs-no-model is moot" argument is now **retired** — the runtime is a
  bespoke kernel we write either way, see decision #2 — but the
  robustness-in-glare argument carries the decision on its own.) Synthetic-free
  corner labels come from the same photos (below).
- **Cross-check, not replace (decision #6).** Rectification removes the v1
  decoder's *only* weakness (perspective), so on the rectified crop it is a
  near-free *independent second opinion* — the cheapest route to the precision
  gate below. It also doubles as the **offline degradation path**. Crucially we
  do **not require agreement** (that would cap the system at the heuristic's
  ceiling on the exact hard cases the model exists to win). **Tesseract is
  dropped** — its 1.4 MB + wasm doesn't fit the budget and is redundant.

## On-device budget (decision #2)

**Tight: ≤ ~5 MB total first-load** (both models ≤ ~1.5 MB int8-quantized + the
inference runtime), **≥ 5 FPS** on a ~3–4-year-old mid-range Android, enforced by
a **CI byte-gate** (`scripts/check-bundle-size.mjs`; `BUDGET_BYTES = 5 MiB`,
measured on raw file size).

**The runtime is a bespoke tiny-CNN kernel in TypeScript, not a general ML
runtime — decided by measurement, not assumption.** The original plan assumed
"the byte sink is the runtime" but that a *lean* wasm-SIMD runtime would fit the
~3.5 MB left after weights. Measured (2026-06-13), that is false: onnxruntime-web
1.26.0's leanest SIMD baseline `ort-wasm-simd-threaded.wasm` is **13,022,405 B
(~12.4 MB)** — **~2.5× the entire 5 MB gate**, before a single byte of weights
(the WebGPU/jsep build is ~25 MB; even brotli'd the runtime alone is ~4 MB). Stock
onnxruntime-web / TF.js cannot ship under this budget; the only shrink path is a
custom emscripten ORT build, its own C++ toolchain sub-project. So we **drop the
general runtime** and hand-write a minimal inference kernel (conv / relu / pool /
dense) for our two *known, tiny* nets — a few KB of code + int8 weights, i.e.
**well under 0.5 MB total**, vs 12.4 MB. This **does not touch decision #1's
"learned-over-classical"**: it runs the *same learned weights*, only the runtime
changes. Kernel + weights-blob spec in **ML engineering**, below.

**Latency still isn't binding:** v1 already does live scan with
*lock-on-agreement*, which hides per-frame cost, and two tiny CNNs run in tens of
ms; the residual risk moves from *bytes* to whether a pure-TS conv kernel holds
≥ 5 FPS (carried in Top risks). WebGPU is dropped as an enhancement — its runtime
is *bigger*, not smaller.

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
- **Collection is agent-doable (decision, per build-out 2026-06-13).** A harvester
  collects real F-91W photos from across the open web (Wikimedia Commons +
  Openverse APIs; Flickr; image search) into gitignored `tools/local/` (the harness
  already scans it) with the filename time convention, recording
  `url` / `license` / `credit` as **provenance** for every image. It does **not**
  filter to CC-only — for a gitignored, never-redistributed *training* corpus that
  constraint isn't required and needlessly starves the make-or-break data risk (see
  Rights). The agent stratifies each real photo (easy / moderate / hard) by eye.
  *Residual reality, not an agent limitation:* the open web skews easy, so
  genuinely-hard reals stay scarce — augmentation fills the **training** hard
  strata, but **eval-gold hard reals cannot be manufactured** (top-risk #1).
- **Annotation is agent-assisted + human spot-check.** The 4-corner sidecar is
  written by a vision-capable agent eyeballing the LCD corners (via the existing
  `buildCornerLabel`), with a **human spot-check on a sample** — corners are the
  pipeline bottleneck (top-risk #3), so agent-estimated corners are validated, not
  trusted blind. Augmented variants need no annotation: corners follow the warp
  for free (already built, `warpCorners`).
- **Corpus targets (sharpen in grill).** Training = collected-clean + augmented
  across all strata (augmentation multiplies a handful of clean reals into
  hundreds of hard training variants). Eval gold = real-only, held out, weighted
  hard — target enough hard reals to lift the precision gate out of *advisory*
  (`metrics.ts` enforces only at ≥ 200 pooled samples; the hard *stratum* needs
  its own sufficiency call). If the web yields too few, the gate stays advisory and
  **we say so** rather than fabricate confidence.
- **Rights — the line is *redistribution*, not training (revised 2026-06-13).**
  Two tiers, because they carry different risk:
  - **Local training corpus (gitignored):** *any* source. Training a tiny,
    non-generative net (a corner regressor / per-digit classifier that provably
    cannot reconstruct its inputs) on web images that **never leave the machine and
    are never shipped** is low-risk, with a reasonable fair-use / research-TDM
    footing. The law here is unsettled, not settled-against; this is a deliberate,
    eyes-open call (not legal advice) — and **only trained weights ship**, which is
    what keeps it clean.
  - **Anything committed / redistributed** (the example fixtures, and any
    CI-reproducible slice of the eval gold): **CC-BY / CC-BY-SA / CC0 / PD only**,
    with attribution in the sidecar `source`. This is the bright line — a
    copyrighted image *in the repo* is redistribution.
  - *Consequence for eval:* commit a CC/PD eval subset so CI and others reproduce
    the gate; keep a larger non-CC eval set local-only for the operator's own
    stronger validation (documented as not-reproducible-in-CI).
  - Filename time convention `*_HH-MM-SS_24h.jpg` (per the v1 harness). Respect site
    ToS / robots when harvesting — a contract layer separate from copyright.

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

## ML engineering — the buildable ML work

The sections above decide the *architecture*; this one is the **engineering work
breakdown** so the ML is buildable, sliceable, and — per the operator's direction
— **agent-doable end-to-end** (data collection + training included), with human
spot-checks only where quality is safety-critical. It exists because the original
plan black-boxed "train + integrate," which is why issue #9 fused an agent-doable
half with a human-only half and stalled.

### The runtime: a bespoke tiny-CNN kernel (TS)

A hand-written, pure-TypeScript inference kernel — the same module the browser app
and the Node harness import. Op set is deliberately minimal: **conv2d, ReLU,
max/avg-pool, dense (matmul + bias), softmax**; int8 weights, float accumulate.
Both models share the one kernel. Pure functions over typed arrays, so it
unit-tests deterministically and carries no dependency. Perf plan: pure TS first
(tens of ms at this size; lock-on-agreement hides per-frame cost), a WASM-SIMD
port held in reserve **only if** a measured FPS shortfall demands it — not before.

### The weights-blob contract — the seam that decouples train from integrate

One versioned asset per model: a binary weight blob + a small JSON manifest
(architecture id, ordered layer shapes, int8 scale / zero-point per tensor-or-
channel, input normalisation). **The TS kernel reads exactly this; the trainer
writes exactly this.** Consequences:

- The runtime + integration can be built and **unit-tested against a *dummy*
  blob** (random or analytic weights) **before any model is trained** — this is
  what makes the integration half agent-doable now, and unblocks it permanently.
- Real weights drop in with **no code change**; the model is a **same-origin build
  asset**, cache-busted by build hash (atomic app+model versioning, per Infra) and
  declared in the byte-gate's `EAGER_RUNTIME_ASSETS`.
- A **reference test vector** (one input → expected output) is exported at train
  time and asserted by the TS kernel, so trainer and runtime forward passes are
  *proven* to agree (guards the hand-rolled-math parity risk).

### Model specs (concrete starting points; open forks in "decisions to grill")

- **Corner detector** — input: whole (downscaled) frame, grayscale, fixed small
  square (≈128×128 — the alignment box is being dropped, so it must find the LCD
  anywhere in frame). ~4 conv blocks (8→16→32→64 ch, 3×3, stride-2 / pool) →
  global avg-pool → dense → **8 outputs = 4 corners (x,y) in normalised frame
  coords, TL/TR/BR/BL** (drops straight into `rectify`'s `Quad`). Tens-of-K params
  → ~30–150 KB int8. Loss: smooth-L1 on normalised coords. *Regression vs heatmaps
  is a grill fork* (heatmaps are more accurate but bigger / slower).
- **Reader** — operates on the **rectified frontal crop** (fixed canonical size),
  whose digit-cell layout is therefore known. A **per-digit-cell classifier**
  (small grayscale patch → 11-way: 0–9 + blank) keeps it tiny and makes per-digit
  calibration tractable (PLAN's reason for rectify→read over end-to-end). The small
  seconds digit is just another known cell on the canonical crop. *Per-cell vs
  whole-row-sequence is a grill fork.*
- **Calibration (mandatory).** Temperature-scale each model's confidence on a
  held-out calibration split; the abstain threshold is then chosen to hold the
  confident-wrong ceiling. Replaces v1's Hamming-distance proxy. The corner-error
  metric (mean per-corner displacement normalised by LCD diagonal) gates the corner
  stage **in isolation** (top-risk #3).

### Training is agent-doable — numpy-first, no heavy toolchain

The make-or-break constraint is that this AppVM has **no torch / tf / ONNX and no
GPU** (numpy + PIL only). Rather than treat that as a block, the plan **chooses an
architecture that needs none of it**:

- **Primary: a pure-numpy tiny-CNN trainer.** Forward + hand-written backprop for
  exactly the kernel's op set (the same conv / relu / pool / dense), seeded and
  deterministic, run as a **background task**. The nets and corpus are tiny by
  design, so CPU training is feasible; numpy is already present, so this route has
  **zero external dependency and needs no network**. It also pins train/infer
  parity — the numpy ops mirror the TS ops one-to-one.
- **Optional accelerator: torch-CPU** (or an operator-supplied GPU) behind the
  **same export contract**, adopted only if a connectivity / speed spike shows
  it's needed and `pip install` is reachable. Numpy-only is the guaranteed floor.
- **Pipeline (all agent steps):** load corpus + sidecars → augment (reuse
  `augment.ts` ops) → train / val / calibration split → train → quantise to int8 →
  export blob + manifest + reference vector → run the TS-runtime eval harness
  (corner-error / precision gate) → **commit only the weights** (images stay
  gitignored). Reproducible: seed + dataset manifest + train config committed
  alongside the weights' build hash.

### What still wants a human (spot-check, not blocker)

Sampling agent-annotated corners (bottleneck risk), sanity-checking license calls,
eyeballing augmentation realism, and providing a GPU **iff** numpy-CPU training
proves too slow. None of these gate the agent from making progress; they are
quality checks layered on agent-produced artifacts.

## Build order (tracer-bullet slices for `/to-issues`)

Each slice is a thin vertical, independently shippable to the preview site, and
**re-sequenced (2026-06-13)** so the agent-doable ML work lands in dependency
order. Slices 1–3 are the spine already in `main`; the rest are all agent-doable
(human spot-checks noted, never blocking).

1. **Baseline port** — ✅ done. v1 app + Node eval harness, working preview deploy.
2. **Rectification wiring** — ✅ done. `corners → homography → frontal crop → v1
   decoder` behind `Recognizer`, fed by a stub `CornerSource` (`?corners=`); the
   learned detector drops in at that one seam.
3. **Eval + data tooling** — ✅ done. Corner-label sidecar schema, annotation
   tool, augmentation pipeline, precision-first metric + byte-gate in CI.
4. **Inference runtime kernel + weights contract** — bespoke TS conv-net kernel,
   weights-blob loader, a real `CornerSource` that runs it, byte-gate registers the
   model+runtime asset. Unit-tested against a **dummy blob** → **proves the ≤ 5 MB
   budget with no trained model**. [agent; needs no data] *(the prototype already
   greenlit.)*
5. **Data collection — web harvester + corpus** — broad harvester (any source for
   the gitignored training corpus; licence recorded as provenance, CC/PD flagged
   for the committed / eval subset), agent-assisted corner annotation + human
   spot-check, stratified real eval-gold. [agent + spot-check] *(parallel with 4.)*
6. **Corner detector — train · export · integrate · isolation-eval** — numpy
   trainer → int8 blob; drop weights into slice-4's `CornerSource`; corner-error
   metric in isolation on the eval gold. [agent; needs 4 + 5] *(the honest split of
   old #9: integration in 4, model here.)*
7. **Learned reader — train · export · integrate · calibrate** — per-digit
   classifier on the rectified crop, same kernel; temperature-scaling calibration;
   behind `Recognizer`. [agent; needs 4 + 5 + 6] *(old #10.)*
8. **Cross-check arbitration + drop Tesseract** — agree / clash / lone-reader
   logic, calibrated abstain threshold, remove `tesseract.js`. [agent; needs 7]
   *(old #11.)*
9. **Capture UX + offline** — drop the alignment box, live feedback, too-dark
   abstain; service-worker model caching, require-network-to-measure. [agent;
   needs 7] *(old #12 / #13.)*
10. **Trust polish** — better-than-1 s time source, sync resilience, visible ±
    band. [agent] *(old slice 6.)*

## Top risks (carry into the PRD)

1. **Hard-case eval data is make-or-break** — without enough credible *real*
   hard-stratum photos, the precision-first gate stays advisory. Relaxing
   collection to any-source (Rights) widens the pool — including a larger
   local-only eval set — but the open web still skews easy, so genuinely-hard reals
   stay scarce; augmentation fills *training* only, never eval, and the committed
   CI-reproducible eval slice is further bounded to CC/PD. Mitigated by honest
   advisory-gating, not by manufacturing data. Highest risk.
2. **Annotation precision** — agent-estimated corners are lower-precision than
   human clicks, and corners are the bottleneck (#3). Guard: human spot-check on a
   sample + the in-isolation corner-error metric.
3. **Corner stage is the bottleneck** — wrong corners → wrong homography → garbage
   to the reader; eval the rectification stage *in isolation*, especially in glare.
4. **Hand-rolled inference parity & perf** — the TS kernel must match the numpy
   trainer's forward pass (guard: exported reference vector asserted in TS) and
   hold ≥ 5 FPS in pure TS (fallback: WASM-SIMD port). This is the cost of dropping
   a general runtime to make the byte budget — a *tested* trade (ort-web is ~2.5×
   over the gate), not an assumed one.
5. **Tiny-corpus overfit** — few reals risks a model that memorises; augment for
   training, eval on real-only, watch the train/val gap.
6. **Augmentation realism** — distorted clean photos may not match real
   low-light/glare physics; eval-on-real-only is the guard against self-deception.
7. **Calibration** — precision-first lives or dies on calibrated confidence + a
   sound abstain threshold; needs a real calibration split and ongoing validation.

## Open ML decisions to grill

The forks `/grill-me` should resolve before `/to-prd` → `/to-issues`:

1. **Corner output:** direct 8-coord regression vs heatmap + argmax (accuracy vs
   size / speed — feeds bottleneck risk #3).
2. **Reader head:** per-digit-cell classifier vs whole-row sequence model.
3. **Training toolchain:** commit to **pure-numpy** as the floor, or spike
   torch-CPU / an operator GPU first? (network reachability + CPU speed decide.)
4. **Corpus sufficiency:** how many real hard eval images make the gate *enforce*
   rather than stay advisory — and the fallback if the web yields fewer?
5. **Annotation:** is agent-eyeballed-corners + spot-check accurate enough for the
   bottleneck stage, or is human clicking required for the eval gold?
6. **Quantisation:** per-tensor vs per-channel int8; what calibration set fixes the
   activation ranges?
7. **Weights format:** bespoke binary + manifest vs a *minimal ONNX subset* read by
   our own micro-reader (trainer interop vs simplicity).
8. **Data-rights policy:** ratify "train-local on any source, redistribute CC/PD
   only" (and your jurisdiction's stance) — or tighten to CC-only if you'd rather
   be conservative than maximise the hard-data pool.
