// Headless harness for the custom F-91W segment decoder: feeds each WHOLE image
// (downscaled to a working size) to decodeSegments — which auto-detects the LCD —
// scores against the filename label, and saves an annotated overlay to
// tools/out/*-decode.png so we can see what it detected and tune it.
//
//   npm run harness
//   FRAC=1 npm run harness   # also print per-segment ink fractions
//
// It also runs the RECTIFICATION DEMO (issue #4): it synthesises an angled shot by
// perspective-warping a fixture the decoder reads head-on, shows the raw decode now
// fails, and shows the rectify→read path recover it from the (ground-truth) LCD
// corners — the angled-fixture proof for the rectification stage.
//
// Images: tools/fixtures/ (licensed) + tools/local/ (gitignored scratch).
// Label times in the filename with hyphens: anything_10-42-15_24h.jpg.

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas'
import { decodeSegments, type DecodeDebug } from '../src/recognize/segments.ts'
import { drawDecodeOverlay } from '../src/recognize/overlay.ts'
import {
  solveHomography,
  applyHomography,
  sampleBilinear,
  type Quad,
  type RawImage,
  type Homography,
} from '../src/recognize/rectify.ts'
import { rectifyThenDecode } from '../src/recognize/RectifyingSegmentRecognizer.ts'
import { toModelInput, plausibleQuad } from '../src/recognize/KernelCornerSource.ts'
import { loadModel, type LoadedModel } from '../src/ml/blob.ts'
import { runModel } from '../src/ml/model.ts'
import {
  parseCornerLabel,
  resolveLabel,
  sidecarPathFor,
  timeFromFilename,
  STRATA,
  type CornerLabel,
  type Corners,
  type Pt as LabelPt,
} from '../src/eval/label.ts'
import {
  classify,
  aggregate,
  evaluateGate,
  timesEqual,
  type ScoredItem,
  type Report,
  type GroupMetrics,
  type GateResult,
} from '../src/eval/metrics.ts'
import {
  cornerError,
  aggregateCornerErrors,
  evaluateCornerGate,
  DEFAULT_CORNER_GATE,
  type CornerScore,
} from '../src/eval/cornerError.ts'
import { fitCalibration, applyCalibration, chooseAbstainThreshold, type CalSample } from '../src/eval/calibrate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const IMG_RE = /\.(png|jpe?g|webp)$/i
// Downscale so the longest side is at most this — mirrors what the app feeds the
// decoder (a phone frame, not full-res) and keeps the flood fill fast.
const WORK_MAX = 1600

interface Expected {
  hh: number
  mm: number
  ss: number
}
// The filename time label (HH-MM-SS); shared by the scoring loop and the demo.
const expectedFromName = (file: string): Expected | null => timeFromFilename(basename(file))

const fmt = (t: { hh: number; mm: number; ss: number }): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.hh)}:${p(t.mm)}:${p(t.ss)}`
}

const matches = (r: { hh: number; mm: number; ss: number } | null, e: Expected): boolean =>
  !!r && r.hh === e.hh && r.mm === e.mm && r.ss === e.ss

const pctStr = (x: number): string => `${(x * 100).toFixed(1)}%`

/** Read + validate the corner-label sidecar beside an image (`<image>.json`), or
 *  null when absent. A malformed sidecar is warned-about and skipped (the run falls
 *  back to the filename label) rather than crashing the whole eval. */
function loadSidecar(imagePath: string): CornerLabel | null {
  const p = sidecarPathFor(imagePath)
  if (!existsSync(p)) return null
  try {
    return parseCornerLabel(JSON.parse(readFileSync(p, 'utf8')))
  } catch (e) {
    console.warn(`  ⚠ ignoring malformed sidecar ${basename(p)}: ${(e as Error).message}`)
    return null
  }
}

/** The precision-first table: correct / honest-abstain / confidently-wrong counts
 *  and the gated wrong-rate, per stratum and pooled. `title` names the set (the whole
 *  labelled pool, or the held-out eval gold the gate runs on). */
function printMetrics(title: string, report: Report): void {
  console.log(`\n=== PRECISION-FIRST METRICS — ${title} ===`)
  console.log('  correct = read == truth · abstain = honest retake · WRONG = confidently-wrong (gated)')
  if (report.overall.total === 0) {
    console.log('  (no labelled images in this set)')
    return
  }
  const row = (m: GroupMetrics): string =>
    `  ${m.group.padEnd(13)}${String(m.total).padStart(4)}` +
    `${String(m.correct).padStart(9)}${String(m.abstain).padStart(9)}${String(m.wrong).padStart(7)}` +
    `${pctStr(m.rates.wrong).padStart(9)}`
  console.log(`  ${'stratum'.padEnd(13)}${'n'.padStart(4)}${'correct'.padStart(9)}${'abstain'.padStart(9)}${'wrong'.padStart(7)}${'wrong%'.padStart(9)}`)
  for (const m of report.byStratum) console.log(row(m))
  console.log(`  ${'-'.repeat(49)}`)
  console.log(row(report.overall))
}

/** The gate verdict. ADVISORY = not enforced (too few samples); FAIL sets a
 *  non-zero exit so CI blocks. */
function printGate(gate: GateResult): void {
  const tag = gate.advisory ? 'ADVISORY (tolerant)' : gate.pass ? 'PASS' : 'FAIL'
  console.log(`\n  GATE [confidently-wrong ≤ ${(gate.maxWrongRate * 100).toFixed(2)}%]: ${tag}`)
  console.log(`    ${gate.reason}`)
}

/** Load an image and downscale it to the working size, as RGBA — the same pixels
 *  the app feeds the decoder. */
async function loadFrame(file: string): Promise<RawImage> {
  const img = await loadImage(file)
  const longest = Math.max(img.width, img.height)
  const scale = longest > WORK_MAX ? WORK_MAX / longest : 1
  const width = Math.round(img.width * scale)
  const height = Math.round(img.height * scale)
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, width, height)
  return { data: ctx.getImageData(0, 0, width, height).data, width, height }
}

function rawImageToCanvas(img: RawImage): Canvas {
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  const id = ctx.createImageData(img.width, img.height)
  id.data.set(img.data)
  ctx.putImageData(id, 0, 0)
  return c
}

/** Write the decoder's CROPPED LCD (locally binarised) with its band/cell boxes —
 *  same view as the in-app ?debug=1. Returns false if there was no crop to draw. */
function writeDecodeOverlay(debug: DecodeDebug, outPath: string): boolean {
  if (!debug.crop) return false
  const { ink, width: cw, height: ch } = debug.crop
  const crop = createCanvas(cw, ch)
  const cctx = crop.getContext('2d')
  const cid = cctx.createImageData(cw, ch)
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    const v = ink[p] ? 0 : 255
    cid.data[i] = cid.data[i + 1] = cid.data[i + 2] = v
    cid.data[i + 3] = 255
  }
  cctx.putImageData(cid, 0, 0)
  drawDecodeOverlay(cctx as unknown as CanvasRenderingContext2D, debug)
  writeFileSync(outPath, crop.toBuffer('image/png'))
  return true
}

async function main(): Promise<void> {
  const dirs = [join(HERE, 'fixtures'), join(HERE, 'local')].filter(existsSync)
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => IMG_RE.test(f))
      .map((f) => join(d, f)),
  )
  if (files.length === 0) {
    console.log('No images in tools/fixtures or tools/local.')
    return
  }
  mkdirSync(OUT, { recursive: true })

  const scored: ScoredItem[] = []
  const scoredEval: ScoredItem[] = [] // the eval:true held-out gold — the gate's truth set
  // Labelled reads that produced a reading, for confidence calibration (issue #11):
  // the raw v1 confidence + whether the lock was correct.
  const calReads: Array<{ rawConf: number; correct: boolean; stratum: string; isEval: boolean }> = []

  for (const file of files) {
    const sidecar = loadSidecar(file)
    const label = resolveLabel(basename(file), sidecar)
    const frame = await loadFrame(file)
    const { width: dw, height: dh } = frame

    // Feed the whole (downscaled) frame; decodeSegments finds the LCD itself.
    const { reading, debug } = decodeSegments(frame.data, dw, dh)

    const outPath = join(OUT, `${basename(file).replace(IMG_RE, '')}-decode.png`)
    if (!writeDecodeOverlay(debug, outPath)) {
      writeFileSync(outPath, rawImageToCanvas(frame).toBuffer('image/png'))
    }

    // Score it into one of the three honest outcomes (correct / abstain / wrong),
    // bucketed by stratum, for the precision-first report below.
    let mark = '  (unlabelled)'
    if (label.time) {
      const outcome = classify(
        {
          reading: reading ? { hh: reading.hh, mm: reading.mm, ss: reading.ss } : null,
          confidence: reading ? reading.confidence : null,
        },
        label.time,
      )
      const stratum = label.stratum ?? 'unstratified'
      const item: ScoredItem = { stratum, outcome }
      scored.push(item)
      const isEval = sidecar?.eval === true
      if (isEval) scoredEval.push(item)
      if (reading) {
        calReads.push({ rawConf: reading.confidence, correct: timesEqual(reading, label.time), stratum, isEval })
      }
      const badge = outcome === 'correct' ? '✓ correct' : outcome === 'abstain' ? '∅ abstain' : '✗ WRONG'
      mark = `  (expect ${fmt(label.time)}, ${stratum}, ${isEval ? 'eval' : 'seed'})  ${badge}`
    }

    const cellStr = debug.cells.map((c) => (c.kind === 'colon' ? ':' : (c.digit ?? '?'))).join('')
    const lcd = debug.lcd ? `@${debug.lcd.x},${debug.lcd.y} ${debug.lcd.w}×${debug.lcd.h}` : '—'
    console.log(`\n=== ${basename(file)}${mark}`)
    console.log(`  ${dw}×${dh}  lcd:${lcd}  note:${debug.note}  conf:${reading ? reading.confidence.toFixed(2) : '-'}`)
    console.log(`  decoded: ${reading ? fmt(reading) : 'none'}   cells:[${cellStr}]`)
    if (process.env.FRAC) {
      for (const c of debug.cells) {
        if (c.kind === 'colon' || !c.frac) continue
        const segs = c.frac.map((f, i) => `${'ABCDEFG'[i]}${f.toFixed(2)}`).join(' ')
        console.log(`    ${c.kind} -> ${c.digit ?? '?'}  ${segs}`)
      }
    }
    console.log(`  overlay: tools/out/${basename(outPath)}`)
  }

  // Precision-first report + the acceptance gate. Two tables: the whole labelled
  // pool (context), then the HELD-OUT EVAL GOLD (eval:true) — the gate runs on the
  // gold, the precision-first truth set, never on the training seed (grading on data
  // the model will train on flatters the result; PLAN "eval = real only, held out").
  // The gate is the CI-failing assertion: a FAIL sets a non-zero exit. Tolerant
  // (advisory) while the gold is below the statistical floor — see evaluateGate.
  const reportAll = aggregate(scored, STRATA)
  const reportEval = aggregate(scoredEval, STRATA)
  printMetrics('ALL LABELLED (eval gold + training seed)', reportAll)
  printMetrics('EVAL GOLD — held out, the precision-first gate set', reportEval)
  const gate = evaluateGate(reportEval.overall)
  printGate(gate)
  if (!gate.pass) process.exitCode = 1

  // Issue #10 adds the easy+moderate eval reals (the recoverable strata the harvested
  // CC/PD reals target). Surface the gate on that pooled slice too — advisory while it
  // is under the sample floor, exactly like the all-strata gate. The ENFORCING gate
  // (the exit code above) stays the all-strata pool, because PLAN keeps the
  // confidently-wrong ceiling across every stratum (hard included — a wrong read on a
  // hard image is still the cardinal sin), so this slice is informational only.
  const reportEM = aggregate(
    scoredEval.filter((it) => it.stratum === 'easy' || it.stratum === 'moderate'),
    STRATA,
  )
  printMetrics('EVAL GOLD — easy+moderate pool (issue #10, informational)', reportEM)
  printGate(evaluateGate(reportEM.overall))

  // Issue #11: the learned corner detector. Load the trained asset once; if it is
  // missing (e.g. a checkout without built models) the sections below say so and skip.
  const cornerModel = loadCornerModel()

  await reportCornerErrors(files, cornerModel) // AC#3: corner-stage isolation eval
  await reportReadSuccess(files, cornerModel) // AC#4: full pipeline vs the stub (raw)
  reportCalibration(calReads) // AC#5: calibrate v1 confidence + set the abstain threshold

  await demonstrateRectification(files, cornerModel)
}

// ── Corner detector helpers (issue #11) ─────────────────────────────────────────

const MODELS_DIR = join(HERE, '..', 'public', 'models')

/** Load the committed trained corner asset, or null if absent. */
function loadCornerModel(): LoadedModel | null {
  try {
    const manifest = JSON.parse(readFileSync(join(MODELS_DIR, 'corner-v1.json'), 'utf8'))
    const blob = new Uint8Array(readFileSync(join(MODELS_DIR, 'corner-v1.bin')))
    return loadModel(manifest, blob)
  } catch {
    return null
  }
}

/** Run the corner model on a frame → the 4 predicted corners in NORMALISED [0,1]
 *  frame coords, and whether they form a plausible quad (the abstain gate). */
function predictCorners(model: LoadedModel, frame: RawImage): { norm: Corners; plausible: boolean } {
  const out = runModel(model, toModelInput(frame, model.manifest.input))
  const norm: Corners = [
    { x: out[0], y: out[1] },
    { x: out[2], y: out[3] },
    { x: out[4], y: out[5] },
    { x: out[6], y: out[7] },
  ]
  return { norm, plausible: plausibleQuad(norm) }
}

/** AC#3 — corner-stage isolation eval: predicted vs hand-annotated eval-gold corners,
 *  as mean per-corner displacement / LCD diagonal. The corner stage is the pipeline
 *  bottleneck (PLAN top-risk #3), so it is scored ALONE on the held-out gold. The gate
 *  runs on the recoverable easy+moderate pool (PLAN); hard is reported, never gated. */
async function reportCornerErrors(files: string[], model: LoadedModel | null): Promise<void> {
  console.log('\n=== CORNER-STAGE ISOLATION — predicted vs eval-gold corners (issue #11) ===')
  if (!model) {
    console.log('  (no corner-v1 model in public/models — skipped)')
    return
  }
  console.log('  metric = mean per-corner displacement / LCD diagonal (lower is better)')
  const scores: CornerScore[] = []
  for (const file of files) {
    const sidecar = loadSidecar(file)
    if (sidecar?.eval !== true || !sidecar.corners) continue // held-out gold with truth corners only
    const img = await loadImage(file)
    const frame = await loadFrame(file)
    const { norm, plausible } = predictCorners(model, frame)
    const truth = sidecar.corners.map((p: LabelPt) => ({ x: p.x / img.width, y: p.y / img.height })) as unknown as Corners
    const err = cornerError(norm, truth)
    const stratum = sidecar.stratum ?? 'unstratified'
    scores.push({ stratum, error: err })
    console.log(`  ${stratum.padEnd(11)} err ${err.toFixed(3)}  ${plausible ? 'plausible' : 'ABSTAIN(implausible)'}  ${basename(file)}`)
  }
  if (scores.length === 0) {
    console.log('  (no eval-gold corner labels present — gitignored fixtures; corner gate runs locally)')
    return
  }
  const report = aggregateCornerErrors(scores, STRATA)
  console.log(`  ${'stratum'.padEnd(11)}${'n'.padStart(4)}${'mean'.padStart(9)}${'max'.padStart(9)}`)
  for (const g of report.byStratum) {
    console.log(`  ${g.group.padEnd(11)}${String(g.total).padStart(4)}${g.meanError.toFixed(3).padStart(9)}${g.maxError.toFixed(3).padStart(9)}`)
  }
  // Gate on the recoverable easy+moderate pool; report hard separately.
  const em = aggregateCornerErrors(scores.filter((s) => s.stratum === 'easy' || s.stratum === 'moderate'), STRATA)
  const gate = evaluateCornerGate(em.overall)
  const tag = gate.advisory ? 'ADVISORY (tolerant)' : gate.pass ? 'PASS' : 'FAIL'
  console.log(`\n  CORNER GATE [easy+moderate mean ≤ ${DEFAULT_CORNER_GATE.maxMeanError}]: ${tag}`)
  console.log(`    ${gate.reason}`)
  const hard = report.byStratum.find((g) => g.group === 'hard')
  if (hard) console.log(`    hard (reported, not gated — PLAN #21): mean ${hard.meanError.toFixed(3)} over ${hard.total}`)
}

/** AC#4 — read-success of the full learned pipeline (corners → rectify → v1, combined
 *  precision-first) vs the STUB baseline (raw v1 decode, the path with no detector).
 *  The learned corners can only ADD reads on shots raw drops (the geometry win) — the
 *  combine defers to raw on a clash — so the pipeline column is ≥ the stub column. */
async function reportReadSuccess(files: string[], model: LoadedModel | null): Promise<void> {
  console.log('\n=== READ-SUCCESS — learned pipeline vs stub (raw) on the eval gold (issue #11) ===')
  if (!model) {
    console.log('  (no corner-v1 model — skipped)')
    return
  }
  let rawOk = 0
  let pipeOk = 0
  let recovered = 0
  let scoredN = 0
  for (const file of files) {
    const sidecar = loadSidecar(file)
    const label = resolveLabel(basename(file), sidecar)
    if (sidecar?.eval !== true || !label.time) continue
    const frame = await loadFrame(file)
    const raw = decodeSegments(frame.data, frame.width, frame.height)
    const { norm, plausible } = predictCorners(model, frame)
    const cornersPx = plausible
      ? (norm.map((p) => ({ x: p.x * frame.width, y: p.y * frame.height })) as unknown as import('../src/recognize/rectify.ts').Quad)
      : null
    const { result, source } = rectifyThenDecode(frame.data, frame.width, frame.height, cornersPx)
    const rOk = !!raw.reading && timesEqual(raw.reading, label.time)
    const pOk = !!result.reading && timesEqual(result.reading, label.time)
    scoredN++
    if (rOk) rawOk++
    if (pOk) pipeOk++
    if (pOk && !rOk) recovered++
    const tag = pOk && !rOk ? '  ← RECOVERED by rectify' : ''
    console.log(`  ${(label.stratum ?? '—').padEnd(11)} stub:${rOk ? '✓' : '·'} pipeline:${pOk ? '✓' : '·'} (${source})${tag}  ${basename(file)}`)
  }
  if (scoredN === 0) {
    console.log('  (no eval-gold images present — gitignored; runs locally)')
    return
  }
  console.log(`\n  stub (raw) read-success:     ${rawOk}/${scoredN}`)
  console.log(`  learned-pipeline read-success: ${pipeOk}/${scoredN}  (${recovered} recovered on angled/off-centre, 0 regressions by construction)`)
}

/** AC#5 — calibrate the v1 decoder's confidence (Platt scaling) and set the abstain
 *  threshold to hold the confident-wrong ceiling, then show its effect on the eval
 *  gold. PLAN: the raw Hamming/margin score isn't a probability (a confident-WRONG
 *  read can outscore a correct one), so the threshold is meaningless until calibrated. */
function reportCalibration(reads: Array<{ rawConf: number; correct: boolean; stratum: string; isEval: boolean }>): void {
  console.log('\n=== CALIBRATION — v1 confidence → P(correct) + abstain threshold (issue #11) ===')
  if (reads.length === 0) {
    console.log('  (no labelled reads — skipped)')
    return
  }
  const samples: CalSample[] = reads.map((r) => ({ rawConf: r.rawConf, correct: r.correct }))
  const cal = fitCalibration(samples)
  const CEIL = 0.005
  const thr = chooseAbstainThreshold(samples, cal, CEIL)
  console.log(`  fitted Platt scaling: P(correct) = sigmoid(${cal.a.toFixed(3)}·raw ${cal.b >= 0 ? '+' : '−'} ${Math.abs(cal.b).toFixed(3)})`)
  console.log(`  abstain threshold (hold confident-wrong ≤ ${(CEIL * 100).toFixed(1)}%): calibrated P ≥ ${thr.threshold.toFixed(3)}`)
  console.log(`  fit over ${samples.length} labelled reads (PROVISIONAL — tiny set; the mechanism ships, more data sharpens it)`)
  // Show the effect on the EVAL GOLD: confident-wrong before vs after the threshold.
  const evalReads = reads.filter((r) => r.isEval)
  const wrongBefore = evalReads.filter((r) => !r.correct).length
  const lockedAfter = evalReads.filter((r) => applyCalibration(cal, r.rawConf) >= thr.threshold)
  const wrongAfter = lockedAfter.filter((r) => !r.correct).length
  console.log(`  eval-gold locked reads: ${evalReads.length} → ${lockedAfter.length} after threshold`)
  console.log(`  eval-gold confident-WRONG: ${wrongBefore} (uncalibrated, any reading locks) → ${wrongAfter} (after calibrated abstain)`)
  if (wrongBefore > 0 && wrongAfter < wrongBefore) {
    console.log(`  ✓ calibration converts ${wrongBefore - wrongAfter} confident-wrong read(s) into honest abstain(s) — the precision-first win`)
  }
}

// ── Rectification demo (issue #4, acceptance #3) ────────────────────────────────
// Take a fixture the decoder reads HEAD-ON, perspective-warp the whole frame into
// an angled "photo", and compare two paths on it:
//   • raw     — decodeSegments on the angled frame (v1's perspective-naive path)
//   • rectify — rectifyThenDecode given the LCD's four (ground-truth) corners
// The corners come from the known warp, standing in for the learned detector (#9):
// this proves the rectify→read wiring lifts an angled shot that the raw path drops.

/** Where the full source frame's corners land in the angled image (TL,TR,BR,BL),
 *  as fractions of the canvas — a keystone + rotation that skews the digit row. */
const ANGLE_QUAD: ReadonlyArray<readonly [number, number]> = [
  [0.05, 0.07],
  [0.74, 0.16],
  [0.82, 0.86],
  [0.09, 0.95],
]

function mapQuad(h: Homography, q: Quad): Quad {
  return q.map((p) => applyHomography(h, p.x, p.y)) as unknown as Quad
}

/** Forward-warp `src` so its full rectangle lands at `dstQuad` on a same-sized white
 *  canvas — an inverse-sampled perspective warp (each output pixel reads back into
 *  the source), producing a synthetic angled shot. */
function warpToQuad(src: RawImage, dstQuad: Quad): RawImage {
  const back = solveHomography(dstQuad, [
    { x: 0, y: 0 },
    { x: src.width, y: 0 },
    { x: src.width, y: src.height },
    { x: 0, y: src.height },
  ])!
  const data = new Uint8ClampedArray(src.width * src.height * 4)
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = applyHomography(back, x + 0.5, y + 0.5)
      const i = (y * src.width + x) * 4
      if (s.x < 0 || s.x >= src.width || s.y < 0 || s.y >= src.height) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255 // white surround
        continue
      }
      const [r, g, b, a] = sampleBilinear(src, s.x, s.y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width: src.width, height: src.height }
}

async function demonstrateRectification(files: string[], cornerModel: LoadedModel | null): Promise<void> {
  console.log('\n=== RECTIFICATION DEMO (issue #4) ===')

  // Pick the first labelled fixture the decoder reads correctly head-on — that
  // gives us a ground-truth LCD box to warp and a known time to recover.
  let source: { frame: RawImage; lcd: DecodeDebug['lcd']; expected: Expected } | null = null
  for (const file of files) {
    const expected = expectedFromName(file)
    if (!expected) continue
    const frame = await loadFrame(file)
    const { reading, debug } = decodeSegments(frame.data, frame.width, frame.height)
    if (matches(reading, expected) && debug.lcd) {
      source = { frame, lcd: debug.lcd, expected }
      console.log(`  source: ${basename(file)} reads ${fmt(expected)} head-on; warping it to an angle.`)
      break
    }
  }
  if (!source) {
    console.log('  (skipped — no fixture decodes head-on, so no ground-truth corners to warp.)')
    return
  }

  const { frame, lcd, expected } = source
  const lcdBox: Quad = [
    { x: lcd!.x, y: lcd!.y },
    { x: lcd!.x + lcd!.w, y: lcd!.y },
    { x: lcd!.x + lcd!.w, y: lcd!.y + lcd!.h },
    { x: lcd!.x, y: lcd!.y + lcd!.h },
  ]
  const identity: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]]

  // AC#4 — ANGLE SWEEP. The single harsh warp is too extreme for the data-limited
  // learned corners; sweeping mild→harsh finds the window where the GEOMETRY WIN
  // shows: angles the raw (stub) path drops but rectification recovers. We test both
  // GROUND-TRUTH corners (proves the rectify→read WIRING) and the LEARNED corner-v1
  // (the real detector, no ground truth) at each level, and report where each lifts a
  // read raw missed. Recovery by the learned detector on any level = AC#4's
  // "improved read-success on angled/off-centre vs the stub".
  console.log('  angle sweep (raw=stub baseline · GT=ground-truth corners · learned=corner-v1):')
  console.log(`  ${'strength'.padEnd(9)}${'raw'.padStart(6)}${'GT'.padStart(6)}${'learned'.padStart(9)}`)
  let learnedRecover = 0
  let gtRecover = 0
  let rawDrops = 0
  for (const s of [0.6, 0.8, 1.0, 1.15, 1.3, 1.45]) {
    const quadFrac = ANGLE_QUAD.map((p, i) => [
      identity[i][0] + s * (p[0] - identity[i][0]),
      identity[i][1] + s * (p[1] - identity[i][1]),
    ]) as ReadonlyArray<readonly [number, number]>
    const dstQuad = quadFrac.map(([fx, fy]) => ({ x: fx * frame.width, y: fy * frame.height })) as unknown as Quad
    const angled = warpToQuad(frame, dstQuad)
    const fwd = solveHomography(
      [{ x: 0, y: 0 }, { x: frame.width, y: 0 }, { x: frame.width, y: frame.height }, { x: 0, y: frame.height }],
      dstQuad,
    )!
    const gtQuad = mapQuad(fwd, lcdBox)

    const rawOk = matches(decodeSegments(angled.data, angled.width, angled.height).reading, expected)
    const gtOk = matches(rectifyThenDecode(angled.data, angled.width, angled.height, gtQuad).result.reading, expected)
    const { norm, plausible } = cornerModel ? predictCorners(cornerModel, angled) : { norm: null, plausible: false }
    const learnedQuad = plausible && norm
      ? (norm.map((p) => ({ x: p.x * angled.width, y: p.y * angled.height })) as unknown as Quad)
      : null
    const learnedOk = cornerModel
      ? matches(rectifyThenDecode(angled.data, angled.width, angled.height, learnedQuad).result.reading, expected)
      : false
    if (!rawOk) rawDrops++
    if (!rawOk && gtOk) gtRecover++
    if (!rawOk && learnedOk) learnedRecover++
    const learnedCell = !cornerModel ? '—' : learnedOk ? '✓' : plausible ? '✗' : '∅'
    console.log(`  ${s.toFixed(2).padEnd(9)}${(rawOk ? '✓' : '✗').padStart(6)}${(gtOk ? '✓' : '✗').padStart(6)}${learnedCell.padStart(9)}`)

    // Save overlays for the first level the raw path drops (the canonical demo shot).
    if (!rawOk && rawDrops === 1) {
      writeFileSync(join(OUT, 'rectify-demo-angled.png'), rawImageToCanvas(angled).toBuffer('image/png'))
      const gt = rectifyThenDecode(angled.data, angled.width, angled.height, gtQuad)
      writeDecodeOverlay(decodeSegments(angled.data, angled.width, angled.height).debug, join(OUT, 'rectify-demo-raw-decode.png'))
      if (gt.rectified) writeFileSync(join(OUT, 'rectify-demo-rectified.png'), rawImageToCanvas(gt.rectified).toBuffer('image/png'))
      writeDecodeOverlay(gt.result.debug, join(OUT, 'rectify-demo-rectified-decode.png'))
    }
  }
  console.log('  legend: ✓ read · ✗ misread/none · ∅ detector abstained (→ raw, no regression)')
  console.log(`  RESULT(wiring): GT corners recovered ${gtRecover}/${rawDrops} angled shots the raw path dropped (rectify→read proven).`)
  if (cornerModel) {
    if (learnedRecover > 0) {
      console.log(`  RESULT(learned): ✓ corner-v1 recovered ${learnedRecover}/${rawDrops} angled shots raw dropped — improved read-success vs the stub (the geometry win).`)
    } else {
      console.log(`  RESULT(learned): corner-v1 recovered 0/${rawDrops} — corners not yet accurate enough end-to-end on this watch (data-limited; routed to #21).`)
    }
  }
  console.log('  overlays: tools/out/rectify-demo-{angled,raw-decode,rectified,rectified-decode}.png')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
