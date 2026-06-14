// Build the corner trainer's TRAINING-label manifest (issue #11, slice 6).
//
//   npm run prep:corners        # → tools/train/corners-train.json (gitignored)
//
// The numpy trainer needs (image, 4 LCD corners) pairs. This derives them WITHOUT
// hand-eyeballing, reproducibly, from data already on disk:
//
//   • Committed training fixtures that already carry HUMAN corners (eval:false) are
//     used as-is.
//   • Other source photos (gitignored tools/local/, front-on) get corners from the
//     v1 LCD detector (decodeSegments' bright-blob box). This is sound because the
//     v1 box ≈ the human eval-gold corners: on f91w-counterfeit the detector's box,
//     scaled to full-res, lands within ~1px of the hand-annotated quad — so the
//     auto labels share the eval gold's label semantics (the LCD glass outline),
//     and corner-error measured against the human eval gold is apples-to-apples.
//
// Two leakage guards keep the held-out eval gold honest (PLAN: "eval = real only,
// held out; grading on data the model trains on flatters the result"):
//   1. eval:true images are never emitted as training labels.
//   2. tools/local/ holds the raw category dump that the eval fixtures were curated
//      FROM, so several locals are pixel-dup originals of eval images. Any local
//      whose dimensions match an eval:true fixture is dropped — training never sees
//      an eval watch, even via its local twin.
//
// Augmentation (perspective warps → angle/off-centre/scale; photometric → lighting)
// is the trainer's job: it multiplies these clean front-on bases into the hard
// geometric variants the detector must survive, corners following each warp.

import { readdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { decodeSegments } from '../../src/recognize/segments.ts'
import { parseCornerLabel, resolveLabel, sidecarPathFor, type CornerLabel } from '../../src/eval/label.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const IMG_RE = /\.(png|jpe?g|webp)$/i
const WORK_MAX = 1600 // match the harness working resolution

interface TrainItem {
  /** Image path relative to repo root (the trainer resolves + loads pixels). */
  path: string
  width: number
  height: number
  /** 4 LCD corners, normalised [0,1] over the image, TL,TR,BR,BL. */
  corners: [number, number][]
  source: 'human' | 'auto-v1'
}

function loadSidecar(imagePath: string): CornerLabel | null {
  const p = sidecarPathFor(imagePath)
  if (!existsSync(p)) return null
  try {
    return parseCornerLabel(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return null
  }
}

async function loadFrame(file: string): Promise<{ data: Uint8ClampedArray; width: number; height: number; fullW: number; fullH: number }> {
  const img = await loadImage(file)
  const longest = Math.max(img.width, img.height)
  const scale = longest > WORK_MAX ? WORK_MAX / longest : 1
  const width = Math.round(img.width * scale)
  const height = Math.round(img.height * scale)
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, width, height)
  return { data: ctx.getImageData(0, 0, width, height).data, width, height, fullW: img.width, fullH: img.height }
}

/** Geometry sanity for an auto-detected LCD box: a real F-91W time row is a wide
 *  rectangle occupying a sensible slice of the frame — filters out garbage boxes. */
function plausibleBox(w: number, h: number, frameW: number, frameH: number): boolean {
  const areaFrac = (w * h) / (frameW * frameH)
  const aspect = w / h
  return areaFrac >= 0.015 && areaFrac <= 0.85 && aspect >= 1.1 && aspect <= 4.5
}

async function main(): Promise<void> {
  const fixturesDir = join(ROOT, 'tools', 'fixtures')
  const localDir = join(ROOT, 'tools', 'local')
  const dirs = [fixturesDir, localDir].filter(existsSync)
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => IMG_RE.test(f)).map((f) => join(d, f)))

  // Eval-gold dimensions (to drop local pixel-dup twins of held-out eval images).
  const evalDims = new Set<string>()
  for (const file of files) {
    if (!file.startsWith(fixturesDir)) continue
    const sc = loadSidecar(file)
    if (sc?.eval === true) {
      const img = await loadImage(file)
      evalDims.add(`${img.width}x${img.height}`)
    }
  }

  const items: TrainItem[] = []
  const skipped: string[] = []
  for (const file of files) {
    const name = basename(file)
    const sc = loadSidecar(file)
    if (sc?.eval === true) {
      skipped.push(`${name} (eval gold — held out)`)
      continue
    }
    const img = await loadImage(file)
    if (file.startsWith(localDir) && evalDims.has(`${img.width}x${img.height}`)) {
      skipped.push(`${name} (dims ${img.width}×${img.height} match an eval image — dup, dropped)`)
      continue
    }

    const rel = file.slice(ROOT.length + 1)
    // 1. Human corners from the committed sidecar win (full-res → normalised).
    const label = resolveLabel(name, sc)
    if (label.corners) {
      const c = label.corners.map((p) => [p.x / img.width, p.y / img.height] as [number, number])
      items.push({ path: rel, width: img.width, height: img.height, corners: c, source: 'human' })
      continue
    }
    // 2. Else auto-detect the LCD with the v1 decoder and take its box corners.
    const frame = await loadFrame(file)
    const { debug } = decodeSegments(frame.data, frame.width, frame.height)
    const lcd = debug.lcd
    if (!lcd || !plausibleBox(lcd.w, lcd.h, frame.width, frame.height)) {
      skipped.push(`${name} (no plausible LCD box — ${lcd ? `${lcd.w}×${lcd.h}` : 'none'})`)
      continue
    }
    const nx = (x: number): number => x / frame.width
    const ny = (y: number): number => y / frame.height
    const corners: [number, number][] = [
      [nx(lcd.x), ny(lcd.y)],
      [nx(lcd.x + lcd.w), ny(lcd.y)],
      [nx(lcd.x + lcd.w), ny(lcd.y + lcd.h)],
      [nx(lcd.x), ny(lcd.y + lcd.h)],
    ]
    items.push({ path: rel, width: img.width, height: img.height, corners, source: 'auto-v1' })
  }

  const out = { workMax: WORK_MAX, count: items.length, items }
  writeFileSync(join(HERE, 'corners-train.json'), JSON.stringify(out, null, 2) + '\n')

  console.log(`\nprep:corners — ${items.length} training bases → tools/train/corners-train.json`)
  for (const it of items) {
    const c = it.corners.map(([x, y]) => `(${x.toFixed(3)},${y.toFixed(3)})`).join(' ')
    console.log(`  ${it.source === 'human' ? 'H' : 'A'} ${basename(it.path).padEnd(58)} ${c}`)
  }
  if (skipped.length) {
    console.log(`\n  skipped (${skipped.length}):`)
    for (const s of skipped) console.log(`    - ${s}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
