# watchthedrift — v1 progress & decoder notes (ported reference)

_Carried over from production [SilentKinfolk/watchthedrift](https://github.com/SilentKinfolk/watchthedrift) (live: https://silentkinfolk.github.io/watchthedrift/) as the v1 baseline reference for this v2 repo. It documents the **v1 recognition engine and capture flow as ported here unchanged**. For the v2 **direction and committed design**, the authority is [`PLAN.md`](PLAN.md) (and [`SPEC.md`](SPEC.md)); where this v1 snapshot and PLAN.md differ on v2 intent, PLAN.md wins._

## What this is
A single-screen web app: point a phone's rear camera at a Casio F-91W, read the
time off the face **on-device**, compare it to internet (NTP-style) time at the
moment of capture, and show how many seconds the watch is off — e.g. `+6 s (fast)`.
Ephemeral (no storage/history/logging), plain black-and-white UI, installable
later as a PWA.

## Status at a glance
| Piece | State |
| --- | --- |
| Hosting (GitHub Pages + Actions auto-deploy) | ✅ done |
| UI / single-screen state machine (B&W) | ✅ done |
| Capture flow | ✅ **live scan** (point-and-catch; locks when two reads agree) |
| Camera capture (rear cam, 1080p, timestamped) | ✅ done |
| NTP-style time sync (timeapi.io + fallbacks, RTT-compensated) | ✅ done, unit-tested |
| Drift maths (nearest-mod-period, 12h/24h, wrap) | ✅ done, unit-tested |
| Recognition (reading the digits) | 🟡 **reads the time row framed in a box; clean shots, live on-device** — see below |
| PWA install/offline | ⏸ on hold (deliberately) |

**Status of reading:** the custom F-91W segment decoder is the engine, and it reads
the **alignment box** (`TIME_CROP`). The app crops to the on-screen box; within that
crop the decoder locates the bright LCD, re-thresholds it with a local Otsu, and
decodes `HH:MM:SS` (candidate patches that aren't the display fail to yield a valid
time and are dropped). **We went back to the box** after a brief whole-frame
"auto-detect anywhere, no box" version: with no crop, a slightly off-angle or
off-centre watch let the bright background dominate the global threshold so the LCD
binarised to all-black — nothing to read. Cropping tight to the time row keeps the
binarisation LCD-dominated and robust; teaching it to find the watch anywhere again
is a job for a future ML model, not the hand-written detector. Reads clean front-on
shots (e.g. `15:53:08`, `14:37:51`, conf ~0.71); leftover misses are pre-existing —
faint/degraded segments, the small seconds-units digit, and angled/perspective shots
(see "Known limits") — all failing *safe* (retake) except a genuinely-faint segment
that can read as a confident off-by-one. `?debug=1` shows the detected LCD (cropped +
locally binarised, with its band/cell boxes) plus the colour scene, so failures are
easy to read off.

**Capture is now a live scan, not a single tap** (`Screen.ts`). Tap *Scan* and it
decodes frames continuously (self-paced loop, ~6/s, no overlap) and **locks the
moment two reads taken ≥0.4 s apart agree on the drift** — point-and-catch, like a
QR scanner. This is *more* reliable than one tap (it tries many frames until one is
sharp/head-on) and *more* trustworthy (the agree-twice check rejects random
misreads: an honest watch ticks in step with real time, so two true reads match).
**Timing is unaffected**: every frame is timestamped at the grab, and the winning
frame's timestamp is what's compared to NTP — same precision as a single shot.
Tuning constants (`SCAN_*` in `Screen.ts`) are first guesses to refine on-device.
Caveat: the decode runs on the main thread; if the preview stutters on slower
phones, move it to a Web Worker (the obvious next optimisation). A systematic
per-watch misread (e.g. a stuck-faint segment biasing every frame the same way)
can still slip the agree-twice check — that's the ML-reader's job, not this.

Tesseract is **removed** (v2, issue #9) — the `tesseract.js` dependency, the
`TesseractRecognizer`, and the `traineddata` are gone. It never earned its place:
it can't read the rigid seven-segment font, and as a fallback only added a
wasm-load delay before an inevitable retake. v2's on-device intelligence is the
**bespoke tiny-CNN inference kernel** instead (PLAN decision #2 — a general
runtime measured ~12.4 MB, ~2.5× the whole 5 MB budget). The generic
`CascadeRecognizer` primitive stays, with no engines wired today.

## How to run
```sh
npm install
npm run dev      # http://localhost:5173 — secure context, so the camera works
npm test         # Vitest (drift + time-sync + parser)
npm run build    # typecheck + production build → dist/
npm run harness  # run the segment decoder over tools/ images, save overlays to tools/out/
npm run augment  # (v2) clean labelled photos → hard training variants in tools/training/
npm run size     # (v2) first-load byte-budget gate (≤5 MB) over dist/
npm run gen:dummy # (v2) regenerate the placeholder corner model in public/models/
```
Deploy: push to `main` → GitHub Actions builds and publishes to Pages.

## Key files
- `src/ui/Screen.ts` — the single-screen state machine (idle/preview/measuring/result/retake/errors), `?debug=1` view, live `W/H` box controls.
- `src/camera/Camera.ts` — getUserMedia rear camera + frame capture/timestamp.
- `src/time/TimeSync.ts`, `src/time/sources.ts` — RTT-compensated offset; timeapi.io → Cloudflare → Date-header → device-clock chain.
- `src/drift/Drift.ts` (+ `.test.ts`) — signed offset, nearest difference mod 12h/24h.
- `src/recognize/`
  - `Recognizer.ts` — engine interface (swappable).
  - **`segments.ts` — the custom F-91W 7-segment decoder (the algorithm; primary).**
    Pure, shared with the harness; takes the raw crop and owns binarisation.
  - **`SegmentDecoderRecognizer.ts` — wraps `segments.ts` as a `Recognizer`.**
  - **`RectifyingSegmentRecognizer.ts` — the app's v2 engine: learned corners →
    homography → frontal crop → `segments.ts`. Abstains to the raw decode.**
  - `corners.ts` / `KernelCornerSource.ts` — the `CornerSource` seam + the learned
    detector that runs the bespoke kernel (`src/ml/`); ships a dummy that abstains
    until trained weights land (#11).
  - `rectify.ts` — the deterministic homography (corners → frontal crop).
  - `CascadeRecognizer.ts` — a generic priority-cascade primitive, no engines wired
    today (Tesseract dropped).
  - `binarize.ts` — `toGray` + histogram + Otsu (shared by the decoder).
  - `overlay.ts` — shared decode-overlay renderer (harness PNGs + app `?debug=1`).
  - `preprocess.ts` — crop + scale (down to ≤1600 px longest side); the decoder
    owns binarisation.
  - `geometry.ts` — the alignment box (`TIME_CROP`): a small, tight box around the
    time row; the decoder reads + locally re-thresholds the LCD it finds within it.
  - `parse.ts` — text → HH:MM:SS parser; idle in v2 (Tesseract removed), retained
    for the deferred learned reader (#21).
- `src/ml/` — the bespoke inference runtime (issue #9): `kernel.ts` (conv/relu/
  pool/dense/softmax, pure typed-array ops), `blob.ts` (weights-blob contract +
  loader), `model.ts` (forward runner + reference-vector parity).
- `tools/ocr-harness.ts` — headless harness; reads `tools/fixtures/` + `tools/local/` (both gitignored images), decodes, scores vs filename labels, writes annotated overlays to `tools/out/`.
- `.github/workflows/deploy.yml` — Pages deploy.

## The recognition engine (what + how)
**It is a hand-written, pure-TypeScript algorithm — no ML, no cloud, no API.** It
implements the classic seven-segment-OCR approach (à la `ssocr`), tailored to the
F-91W's fixed layout. `decodeSegments(rgba, w, h)` takes whatever pixels it's handed
— the **boxed crop** in the app, a full frame in the harness — and owns all binarisation:
1. **Global Otsu** over the crop → a coarse ink mask used *only to locate* bright
   regions (dark digits AND dark case/bezel become ink).
2. **Auto-detect candidate LCDs** = the largest connected *bright* (non-ink)
   regions. The bezel and digits are both dark, so we anchor on the bright LCD
   background, not a "black frame"; bright things elsewhere just become extra
   candidates. **Crop to each candidate and re-binarise that crop with its own
   local Otsu** — so the digits separate cleanly from the LCD background, free of
   the dark watch body that skews a whole-frame threshold — then run steps 3–6.
3. **Find the digit band** — the tallest horizontal band of ink = the big `HH:MM`.
4. **Split into cells** by column gaps → individual digits + the colon.
5. **Read each digit** by sampling its seven segment regions (each on/off by ink
   fraction) and mapping the 7-bit pattern to a digit via a lookup table.
6. **Assemble & verify** `HH:MM:SS` (colon as anchor). Keep the candidate with the
   highest-confidence valid in-range time — only the real display produces one, so
   non-LCD candidates are rejected here. So the box only has to *contain* the time
   row — a stray bright patch that creeps into it is dropped, not misread.

(We also tried OR-ing an adaptive local threshold into step 1 to recover faint
segments, but the F-91W LCD's faint background mottling reads as speckle under any
setting aggressive enough to help — global Otsu is simpler and more reliable.)

**Current result:** reads clean front-on shots in good light — frame the time row in
the box and the live scan catches it in a moment (e.g. `15:53:08`, `14:37:51`, conf
~0.71). The harness still feeds **full-frame** photos to exercise candidate detection;
the app crops to the box first, which keeps the binarisation LCD-dominated. Known misses:
- **dim / low-contrast light (the current real-world blocker, on hold).** The F-91W's
  reflective LCD has no backlight, so in dim light it barely out-shines the dark
  case — and detection finds the LCD precisely *by* it being a bright patch, so it
  can't isolate it, even when the screen is clearly legible to the eye (eyes adapt
  locally + use colour; our grayscale brightness test doesn't). Symptom: `?debug=1`
  shows a mostly-black crop / watch outline. See "Next steps #1".
- a **genuinely faint/degraded segment** (`19:45:08`→`09`): no ink there to read —
  unrecoverable by thresholding; on a real watch this is a retake.
- the **small seconds-units digit** under tight 12h framing (`5051`): column-gap
  splitting sizes the tiny seconds cell inconsistently → returns *no reading* (safe
  retake), not a wrong one.
- **angled / perspective** shots (`cand-1`): the segment sample regions don't align
  on a skewed glyph.

### Next steps
1. **Low-light / contrast robustness — HELD, next real-world priority.** In dim light
   the reflective LCD doesn't register as a bright blob, so detection misses it.
   Options, easiest→hardest: (a) press the watch's own **LIGHT** backlight while
   scanning — zero code, instant contrast, also confirms the diagnosis; (b) a
   **phone-torch toggle** while scanning (`track.applyConstraints({advanced:[{torch:true}]})`
   — Android Chrome only; **iOS Safari can't**); (c) **widen detection** to multiple
   brightness levels and/or a contrast-normalise (auto-levels) pass so a dim LCD
   still surfaces. Best tuned against a **real failing frame** — capture one via
   `?debug=1` → "copy scene" — rather than blind (no low-light fixtures yet).
2. **Seconds robustness** (the main accuracy gap for drift): make the small
   seconds cells robust — e.g. snap them to a consistent height/baseline, or the
   originally-planned **colon-anchored fixed-pitch** layout for the whole row.
3. **Angled shots** → **OpenCV.js** deskew/perspective-correct before decode.
4. **Bulletproof** → an **ML model** (Blender-rendered + real, varied
   angles/lighting) — would also handle faint/degraded segments by context.

Ongoing tuning: `?debug=1` overlays the auto-detected LCD/cells + decode string on
each scan; the live-scan dials are the `SCAN_*` constants in `Screen.ts` (lock speed
vs. robustness). Decode runs on the main thread (~6/s); if the preview stutters on
slower phones, move it to a **Web Worker**.

### Why custom (build-vs-adapt, settled)
No browser-ready seven-segment OCR tool exists to adapt: `ssocr` is C with no WASM
port (and is generic — doesn't know the F-91W); the npm `seven-segment-display` only
*renders* a display; general OCR (Tesseract) fails because the segments aren't
connected. Our decoder is the standard approach, focused on one known device — the
lightest, most on-device-friendly option. OpenCV.js / ML are the escalation rungs.

## The harness & how the test images are labelled (important nuance)
- The **boxes + digit labels in `tools/out/*-decode.png` are drawn by *our code*** —
  the harness renders what `decodeSegments` detected (cell boxes, the digit it read).
  These are **not** produced by any AI/Claude model; they're the deterministic
  algorithm's output, visualised so we can see where it goes wrong.
- The **ground-truth labels** (the correct time baked into each filename, e.g.
  `..._19-45-08_24h.jpg`) were established by a human/Claude *reading* the photo once,
  purely to score the algorithm. That reading is **not part of the product** and never
  runs in the app — the app must do it all locally with the segment decoder.

## Deliberately out of scope
Storing history, logging, charts, drift-rate-over-time, manual digit entry, and
sub-second "tick detection" — this answers one ephemeral, whole-second question.
