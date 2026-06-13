// Corner-annotation CLI (issue #8): write or update the corner-label sidecar beside
// a real F-91W photo. This is the headless/scriptable shell over the pure core in
// src/eval/annotate.ts — the browser GUI (tools/annotate/) is the point-and-click
// shell over the SAME core. Use whichever fits:
//
//   npm run annotate -- --image tools/fixtures/foo.jpg --auto --stratum easy
//   npm run annotate -- --image tools/fixtures/foo.jpg \
//       --corners 780,1032,2400,1032,2400,1672,780,1672 --time 15:53:08 --eval
//
// `--auto` SEEDS the four corners from the v1 decoder's detected LCD box (the
// bright-region bounding box, run at full resolution) — a reproducible first label
// for a roughly-front-on shot, to be nudged to the true glass corners in the GUI.
// Any flag merges onto the existing sidecar, so you can add corners without losing a
// stratum/source/note already recorded (and vice-versa).
//
// Runs under bare-node strip-types (`node --experimental-strip-types`), so every
// src/ module it pulls in uses .ts specifiers and no constructor param-properties.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, relative, basename } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { decodeSegments } from '../src/recognize/segments.ts'
import {
  parseCornerLabel,
  sidecarPathFor,
  STRATA,
  type CornerLabel,
  type Pt,
  type Stratum,
  type Time,
} from '../src/eval/label.ts'
import { buildCornerLabel, serializeCornerLabel, type CornerLabelPatch } from '../src/eval/annotate.ts'

const USAGE = `annotate — write/update a corner-label sidecar for an F-91W photo (issue #8)

Usage: npm run annotate -- --image <path> [options]
  --image <path>        the photo to annotate (its sidecar is <path>.json)   [required]
  --corners x0,y0,..    four LCD corners as 8 image-pixel numbers, ANY order
                        (canonicalised to TL,TR,BR,BL); mutually exclusive with --auto
  --auto                seed the corners from the v1 decoder's detected LCD box
  --clear-corners       drop the corners from the sidecar
  --time HH:MM:SS       ground-truth display time (':' or '-' separated). Omit to keep
                        the filename's _HH-MM-SS_ label
  --24h | --12h         display mode (default: keep existing / filename token)
  --stratum <s>         difficulty: ${STRATA.join(' | ')}
  --eval | --seed       mark held-out eval gold (never augmented) | training seed
  --note <text>         free-form note
  --source-url <url> --license <spdx> --credit <name>   provenance (for CC/PD fixtures)
  --dry-run             print the resulting sidecar; do not write
  --help                show this help`

interface Opts {
  image: string
  patch: CornerLabelPatch
  auto: boolean
  dryRun: boolean
}

function parseTimeArg(raw: string): Time {
  const m = raw.match(/^(\d{1,2})[:-](\d{2})[:-](\d{2})$/)
  if (!m) throw new Error(`--time must be HH:MM:SS (or HH-MM-SS), got "${raw}"`)
  return { hh: +m[1], mm: +m[2], ss: +m[3] }
}

function parseCornersArg(raw: string): Pt[] {
  const n = raw.split(',').map((s) => Number(s.trim()))
  if (n.length !== 8 || n.some((v) => !Number.isFinite(v))) {
    throw new Error('--corners needs 8 finite numbers: x0,y0,x1,y1,x2,y2,x3,y3 (image pixels)')
  }
  return [
    { x: n[0], y: n[1] },
    { x: n[2], y: n[3] },
    { x: n[4], y: n[5] },
    { x: n[6], y: n[7] },
  ]
}

function parseArgs(argv: string[]): Opts | null {
  let image: string | null = null
  let auto = false
  let dryRun = false
  let cornersArg: string | null = null
  let clearCorners = false
  const patch: CornerLabelPatch = {}
  const source: { url?: string; license?: string; credit?: string } = {}

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--help' || a === '-h') return null
    else if (a === '--image') image = resolve(val())
    else if (a === '--corners') cornersArg = val()
    else if (a === '--auto') auto = true
    else if (a === '--clear-corners') clearCorners = true
    else if (a === '--time') patch.time = parseTimeArg(val())
    else if (a === '--24h') patch.is24h = true
    else if (a === '--12h') patch.is24h = false
    else if (a === '--stratum') patch.stratum = val() as Stratum // validated by buildCornerLabel
    else if (a === '--eval') patch.eval = true
    else if (a === '--seed') patch.eval = false
    else if (a === '--note') patch.note = val()
    else if (a === '--source-url') source.url = val()
    else if (a === '--license') source.license = val()
    else if (a === '--credit') source.credit = val()
    else if (a === '--dry-run') dryRun = true
    else throw new Error(`unknown argument: ${a} (try --help)`)
  }

  if (!image) throw new Error('--image is required (try --help)')
  if (cornersArg && auto) throw new Error('--corners and --auto are mutually exclusive')
  if ((cornersArg || auto) && clearCorners) throw new Error('--clear-corners cannot combine with --corners/--auto')
  if (cornersArg) patch.corners = parseCornersArg(cornersArg)
  if (clearCorners) patch.corners = null
  if (source.url || source.license || source.credit) patch.source = source

  return { image, patch, auto, dryRun }
}

/** Seed corners from the v1 decoder's detected LCD box (bright-region bounding box),
 *  run at the image's full resolution → the four corners in image-pixel coords,
 *  TL,TR,BR,BL. Throws when nothing is detected (a dark/odd frame the decoder can't
 *  anchor) — annotate those by hand (--corners / the GUI). */
async function autoCorners(imagePath: string): Promise<Pt[]> {
  const img = await loadImage(imagePath)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, 0, img.width, img.height)
  const { debug } = decodeSegments(data, img.width, img.height)
  if (!debug.lcd) {
    throw new Error(`--auto: the v1 decoder found no LCD in ${basename(imagePath)} — annotate it by hand`)
  }
  const { x, y, w, h } = debug.lcd
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

function loadSidecar(path: string): CornerLabel | null {
  if (!existsSync(path)) return null
  try {
    return parseCornerLabel(JSON.parse(readFileSync(path, 'utf8')))
  } catch (e) {
    throw new Error(`existing sidecar ${basename(path)} is malformed: ${(e as Error).message}`)
  }
}

async function main(): Promise<void> {
  let opts: Opts | null
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`annotate: ${(e as Error).message}`)
    process.exit(2)
  }
  if (!opts) {
    console.log(USAGE)
    return
  }

  if (!existsSync(opts.image)) {
    console.error(`annotate: image not found: ${opts.image}`)
    process.exit(2)
  }

  if (opts.auto) {
    try {
      opts.patch.corners = await autoCorners(opts.image)
    } catch (e) {
      console.error(`annotate: ${(e as Error).message}`)
      process.exit(1)
    }
  }

  const sidecarPath = sidecarPathFor(opts.image)
  let base: CornerLabel | null
  try {
    base = loadSidecar(sidecarPath)
  } catch (e) {
    console.error(`annotate: ${(e as Error).message}`)
    process.exit(2)
  }

  // Nothing to do? (no field present in the patch) — guide rather than write a no-op.
  if (Object.keys(opts.patch).length === 0) {
    console.error('annotate: nothing to set — pass --corners/--auto and/or --time/--stratum/… (try --help)')
    process.exit(2)
  }

  let label: CornerLabel
  try {
    label = buildCornerLabel(opts.patch, base)
  } catch (e) {
    console.error(`annotate: ${(e as Error).message}`)
    process.exit(1)
  }

  const text = serializeCornerLabel(label)
  const rel = relative(process.cwd(), sidecarPath)
  if (opts.dryRun) {
    console.log(`annotate: would write ${rel} (--dry-run):\n`)
    console.log(text)
    return
  }
  writeFileSync(sidecarPath, text)
  const cornerNote = label.corners
    ? `corners ${opts.auto ? '(auto-seeded from v1 LCD box) ' : ''}set`
    : 'no corners'
  console.log(`annotate: ${base ? 'updated' : 'wrote'} ${rel} — ${cornerNote}.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
