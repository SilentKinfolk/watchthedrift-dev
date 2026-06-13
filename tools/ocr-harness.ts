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
import {
  parseCornerLabel,
  resolveLabel,
  sidecarPathFor,
  timeFromFilename,
  STRATA,
  type CornerLabel,
} from '../src/eval/label.ts'
import {
  classify,
  aggregate,
  evaluateGate,
  type ScoredItem,
  type Report,
  type GroupMetrics,
  type GateResult,
} from '../src/eval/metrics.ts'

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
 *  and the gated wrong-rate, per stratum and pooled. */
function printMetrics(report: Report): void {
  console.log('\n=== PRECISION-FIRST METRICS ===')
  console.log('  correct = read == truth · abstain = honest retake · WRONG = confidently-wrong (gated)')
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
      scored.push({ stratum, outcome })
      const badge = outcome === 'correct' ? '✓ correct' : outcome === 'abstain' ? '∅ abstain' : '✗ WRONG'
      mark = `  (expect ${fmt(label.time)}, ${stratum})  ${badge}`
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

  // Precision-first report + the acceptance gate. The gate is the CI-failing
  // assertion: a FAIL sets a non-zero exit. Tolerant (advisory) while the eval set
  // is below the statistical floor — see evaluateGate's minSamples.
  const report = aggregate(scored, STRATA)
  printMetrics(report)
  const gate = evaluateGate(report.overall)
  printGate(gate)
  if (!gate.pass) process.exitCode = 1

  await demonstrateRectification(files)
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

async function demonstrateRectification(files: string[]): Promise<void> {
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
  const angleQuad = ANGLE_QUAD.map(([fx, fy]) => ({ x: fx * frame.width, y: fy * frame.height })) as unknown as Quad
  const angled = warpToQuad(frame, angleQuad)

  // The LCD's four corners in the angled image = its head-on box pushed through the
  // same warp. This is what the learned corner detector (#9) will one day predict.
  const forward = solveHomography(
    [
      { x: 0, y: 0 },
      { x: frame.width, y: 0 },
      { x: frame.width, y: frame.height },
      { x: 0, y: frame.height },
    ],
    angleQuad,
  )!
  const lcdQuad: Quad = mapQuad(forward, [
    { x: lcd!.x, y: lcd!.y },
    { x: lcd!.x + lcd!.w, y: lcd!.y },
    { x: lcd!.x + lcd!.w, y: lcd!.y + lcd!.h },
    { x: lcd!.x, y: lcd!.y + lcd!.h },
  ])

  // Path A: raw decode on the angled frame (no rectification).
  const raw = decodeSegments(angled.data, angled.width, angled.height)
  // Path B: rectify from the LCD corners, then decode the frontal crop.
  const { result: rect, rectified } = rectifyThenDecode(angled.data, angled.width, angled.height, lcdQuad)

  writeFileSync(join(OUT, 'rectify-demo-angled.png'), rawImageToCanvas(angled).toBuffer('image/png'))
  writeDecodeOverlay(raw.debug, join(OUT, 'rectify-demo-raw-decode.png'))
  if (rectified) {
    writeFileSync(join(OUT, 'rectify-demo-rectified.png'), rawImageToCanvas(rectified).toBuffer('image/png'))
  }
  writeDecodeOverlay(rect.debug, join(OUT, 'rectify-demo-rectified-decode.png'))

  const rawOk = matches(raw.reading, expected)
  const rectOk = matches(rect.reading, expected)
  console.log(`  raw   (angled, no rectify): ${raw.reading ? fmt(raw.reading) : 'none'}  ${rawOk ? '✓' : '✗'}`)
  console.log(`  rectify (LCD corners → frontal crop): ${rect.reading ? fmt(rect.reading) : 'none'}  ${rectOk ? '✓' : '✗'}`)
  console.log('  overlays: tools/out/rectify-demo-{angled,raw-decode,rectified,rectified-decode}.png')
  if (!rawOk && rectOk) {
    console.log(`  RESULT: ✓ rectification recovered ${fmt(expected)} on an angled shot the raw path dropped.`)
  } else if (rawOk && rectOk) {
    console.log('  RESULT: both read — the warp was too mild to break the raw path; stiffen ANGLE_QUAD.')
  } else {
    console.log('  RESULT: ✗ rectified path did not read — check ANGLE_QUAD / corner mapping.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
