// Augmentation CLI (issue #7): expand clean, labelled F-91W photos into
// hard-condition TRAINING variants, carrying the labels through each warp. It is
// the thin IO shell around the pure library in src/augment/augment.ts — it loads
// pixels (via @napi-rs/canvas, like the harness), runs the seeded transforms, and
// writes each variant image plus its corner-label sidecar into the gitignored
// training dir. Deterministic: a given (--seed, image, recipe) always produces the
// same bytes.
//
//   npm run augment                         # all recipes over tools/fixtures+local
//   npm run augment -- --recipes dim,glare  # a subset
//   npm run augment -- --seed 7 --out tools/training --max 1024
//
// Held-out EVAL images are skipped by default — the gold set is never augmented
// (grading on our own distortions flatters the model; PLAN "eval = real only").
// `--include-eval` overrides this for ad-hoc experimentation only.
//
// Runs under bare-node strip-types (`node --experimental-strip-types`), so every
// src/ module it pulls in uses .ts specifiers and no constructor param-properties.

import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { makeRng, hashSeed, DEFAULT_RECIPES, type Recipe, type AugState } from '../src/augment/augment.ts'
import type { RawImage } from '../src/recognize/rectify.ts'
import {
  parseCornerLabel,
  resolveLabel,
  sidecarPathFor,
  type CornerLabel,
  type Corners,
} from '../src/eval/label.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const IMG_RE = /\.(png|jpe?g|webp)$/i
const ALL_RECIPE_NAMES = DEFAULT_RECIPES.map((r) => r.name)
// Don't re-augment our own output if an --in dir overlaps --out.
const AUGMENTED_RE = new RegExp(`__(${ALL_RECIPE_NAMES.join('|')})\\.`, 'i')

interface Opts {
  inDirs: string[]
  outDir: string
  seed: number
  max: number
  recipes: Recipe[]
  includeEval: boolean
  limit: number
}

const USAGE = `augment — clean F-91W photos → hard training variants (issue #7)

Usage: npm run augment -- [options]
  --in <dir>           input dir (repeatable; default: tools/fixtures, tools/local)
  --out <dir>          output dir (default: tools/training)
  --seed <n>           base seed for reproducibility (default: 1)
  --max <px>           downscale longest side to this before augmenting (default: 1024)
  --recipes <a,b,..>   subset of: ${ALL_RECIPE_NAMES.join(', ')}
  --limit <n>          process at most n source images
  --include-eval       also augment eval-held-out images (NOT for the real eval set)
  --help               show this help`

function parseArgs(argv: string[]): Opts | null {
  const inDirs: string[] = []
  let outDir = join(ROOT, 'tools', 'training')
  let seed = 1
  let max = 1024
  let includeEval = false
  let limit = Infinity
  let recipeNames: string[] | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = (): string => argv[++i]
    if (a === '--help' || a === '-h') return null
    else if (a === '--in') inDirs.push(resolve(val()))
    else if (a === '--out') outDir = resolve(val())
    else if (a === '--seed') seed = Number(val())
    else if (a === '--max') max = Number(val())
    else if (a === '--limit') limit = Number(val())
    else if (a === '--include-eval') includeEval = true
    else if (a === '--recipes') recipeNames = val().split(',').map((s) => s.trim()).filter(Boolean)
    else throw new Error(`unknown argument: ${a} (try --help)`)
  }
  if (!Number.isFinite(seed) || !Number.isFinite(max) || max < 1) {
    throw new Error('--seed must be a number and --max a positive number')
  }
  const recipes = recipeNames
    ? recipeNames.map((n) => {
        const r = DEFAULT_RECIPES.find((x) => x.name === n)
        if (!r) throw new Error(`unknown recipe "${n}" (have: ${ALL_RECIPE_NAMES.join(', ')})`)
        return r
      })
    : [...DEFAULT_RECIPES]
  const dirs = inDirs.length ? inDirs : [join(ROOT, 'tools', 'fixtures'), join(ROOT, 'tools', 'local')]
  return { inDirs: dirs.filter(existsSync), outDir, seed, max, recipes, includeEval, limit }
}

/** Load an image and downscale its longest side to `max`, as an RGBA RawImage. */
async function loadFrame(file: string, max: number): Promise<RawImage> {
  const img = await loadImage(file)
  const longest = Math.max(img.width, img.height)
  const scale = longest > max ? max / longest : 1
  const width = Math.max(1, Math.round(img.width * scale))
  const height = Math.max(1, Math.round(img.height * scale))
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, width, height)
  return { data: ctx.getImageData(0, 0, width, height).data, width, height }
}

function writePng(img: RawImage, outPath: string): void {
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  const id = ctx.createImageData(img.width, img.height)
  id.data.set(img.data)
  ctx.putImageData(id, 0, 0)
  writeFileSync(outPath, c.toBuffer('image/png'))
}

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

const round2 = (n: number): number => Math.round(n * 100) / 100
const roundCorners = (c: Corners): Corners =>
  c.map((p) => ({ x: round2(p.x), y: round2(p.y) })) as unknown as Corners

/** Build the variant's sidecar: the time/is24h carry through unchanged, the corners
 *  are the transformed ones (or null when the source had none), the stratum is the
 *  one the recipe pushes into, eval is forced false, and provenance is preserved. */
function variantSidecar(
  state: AugState,
  recipe: Recipe,
  src: { time: { hh: number; mm: number; ss: number }; is24h: boolean; source?: CornerLabel['source'] },
  fromName: string,
): CornerLabel {
  const out: CornerLabel = {
    version: 1,
    time: src.time,
    is24h: src.is24h,
    corners: state.corners ? roundCorners(state.corners) : null,
    stratum: recipe.stratum,
    eval: false,
    note: `Augmented (${recipe.name}) from ${fromName}. Real pixels distorted — LCD photoreal; time unchanged; corners follow the warp.`,
  }
  if (src.source) out.source = src.source
  return out
}

async function main(): Promise<void> {
  let opts: Opts | null
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`augment: ${(e as Error).message}`)
    process.exit(2)
  }
  if (!opts) {
    console.log(USAGE)
    return
  }

  if (opts.inDirs.length === 0) {
    console.log('augment: no input dirs exist (looked for tools/fixtures, tools/local).')
    return
  }
  mkdirSync(opts.outDir, { recursive: true })

  const files = opts.inDirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => IMG_RE.test(f) && !AUGMENTED_RE.test(f))
      .map((f) => join(d, f)),
  )

  console.log(`augment: ${files.length} source image(s); recipes [${opts.recipes.map((r) => r.name).join(', ')}]; seed ${opts.seed}`)
  console.log(`         in: ${opts.inDirs.map((d) => d.replace(ROOT + '/', '')).join(', ')}  →  out: ${opts.outDir.replace(ROOT + '/', '')}`)

  let processed = 0
  let written = 0
  const skipped: string[] = []
  for (const file of files) {
    if (processed >= opts.limit) break
    const name = basename(file)
    const sidecar = loadSidecar(file)
    const label = resolveLabel(name, sidecar)
    if (!label.time) {
      skipped.push(`${name} (no time label)`)
      continue
    }
    if (sidecar?.eval && !opts.includeEval) {
      skipped.push(`${name} (eval held-out — never augmented)`)
      continue
    }
    processed++

    const frame = await loadFrame(file, opts.max)
    const stem = name.replace(IMG_RE, '')
    const haveCorners = label.corners ? 'corners' : 'no-corners'
    console.log(`\n• ${name}  ${frame.width}×${frame.height}  ${fmt(label.time)}  ${haveCorners}`)
    for (const recipe of opts.recipes) {
      const rng = makeRng(hashSeed(opts.seed, name, recipe.name))
      const state = recipe.build({ image: frame, corners: label.corners }, rng)
      const outStem = `${stem}__${recipe.name}`
      writePng(state.image, join(opts.outDir, `${outStem}.png`))
      const meta = variantSidecar(state, recipe, { time: label.time, is24h: label.is24h, source: sidecar?.source }, name)
      writeFileSync(join(opts.outDir, `${outStem}.png.json`), JSON.stringify(meta, null, 2) + '\n')
      written++
      const cornersTag = state.corners ? '✓corners' : '·no-corners'
      console.log(`    ${recipe.name.padEnd(12)} → ${outStem}.png  [${recipe.stratum}] ${cornersTag}`)
    }
  }

  console.log(`\naugment: wrote ${written} variant(s) from ${processed} source image(s) into ${opts.outDir.replace(ROOT + '/', '')}/`)
  if (skipped.length) {
    console.log(`         skipped ${skipped.length}: ${skipped.join('; ')}`)
  }
  if (processed === 0) {
    console.log('         (nothing augmented — drop labelled clean photos in tools/local, or pass --include-eval to use the eval fixtures.)')
  }
}

const fmt = (t: { hh: number; mm: number; ss: number }): string => {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(t.hh)}:${p(t.mm)}:${p(t.ss)}`
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
