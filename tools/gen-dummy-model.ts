// Generate the DUMMY corner-detector model asset (issue #9, slice 4).
//
// This proves the runtime + the byte budget BEFORE any model is trained. It writes
// the same weights-blob format (../src/ml/blob.ts) the #11 numpy trainer will emit,
// so the trained corner weights drop in later with no code change. Run:
//
//     npm run gen:dummy        # → public/models/corner-dummy-v1.{bin,json}
//
// Deterministic (seeded PRNG) so the committed bytes regenerate identically.
//
// Design — three jobs, met without conflict:
//   1. Op coverage: a real corner-CNN spine (conv ×4 + global-avg-pool) exercises
//      conv2d/relu/pool in the shipped asset's forward pass.
//   2. Representative SIZE (~1.5 MB, the PLAN budget allowance per model): a wide
//      dense head carries the bytes with cheap FLOPs (one matmul), so the live
//      preview forward stays a few ms — the real #11 corner net is far smaller, and
//      the self-describing manifest lets it swap straight in.
//   3. Safe ABSTAIN: the FINAL dense layer has ZERO weights and a bias = a
//      degenerate quad (all corners coincident), so the output is that constant
//      regardless of input → KernelCornerSource's plausibility gate rejects it →
//      the live app falls back to the raw decode, unchanged, until real weights land.
//      (Consequence: this dummy's reference vector proves the load→forward→compare
//      MECHANISM; op-level maths is pinned by src/ml/kernel.test.ts. #11's real,
//      non-degenerate model exercises the full forward through its reference vector.)

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { packTensors, loadModel, type Manifest, type Layer, type PackTensor, type TensorRef } from '../src/ml/blob.ts'
import { runModel, referenceInput } from '../src/ml/model.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'models')
const NAME = 'corner-dummy-v1'
const INPUT = { channels: 1, height: 128, width: 128, mean: 0.5, std: 0.5 }
const TARGET_BYTES = 1.5 * 1024 * 1024 // ~1.5 MB — the PLAN per-model budget allowance

/** Deterministic PRNG (mulberry32) so the committed weights are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0x5eed1234)
/** Small zero-centred analytic weights (so int8 quantisation is meaningful). */
const weights = (n: number): Float32Array => Float32Array.from({ length: n }, () => (rand() - 0.5) * 0.4)
const zeros = (n: number): Float32Array => new Float32Array(n)

// ── Architecture ────────────────────────────────────────────────────────────────
// conv 1→8→16→32→64 (3×3, stride-2, pad-1) → global-avg-pool(64) → dense 64→HID →
// relu → dense HID→8. HID is solved so the int8 blob lands near TARGET_BYTES; the
// head's weights are the byte bulk (64·HID + HID·8 = 72·HID int8 bytes).
const CONV = [
  { inC: 1, outC: 8 },
  { inC: 8, outC: 16 },
  { inC: 16, outC: 32 },
  { inC: 32, outC: 64 },
]
const convWeightCount = CONV.reduce((n, c) => n + c.outC * c.inC * 9, 0)
const convBiasBytes = CONV.reduce((n, c) => n + c.outC * 4, 0)
// total ≈ convWeightCount + 72·HID (int8) + convBiasBytes + 8·4 (dense2 f32 bias)
const HID = Math.round((TARGET_BYTES - convWeightCount - convBiasBytes - 32) / 72)

// Pack tensors in the order the layers reference them.
const pack: PackTensor[] = []
for (const c of CONV) {
  pack.push({ data: weights(c.outC * c.inC * 9), dtype: 'int8' }) // conv weight
  pack.push({ data: weights(c.outC), dtype: 'float32' }) // conv bias
}
pack.push({ data: weights(64 * HID), dtype: 'int8' }) // dense1 weight (the byte bulk), no bias
pack.push({ data: zeros(HID * 8), dtype: 'int8' }) // dense2 weight = 0 → constant output
pack.push({ data: Float32Array.from([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), dtype: 'float32' }) // degenerate quad

const { blob, refs } = packTensors(pack)
const ref = (i: number): TensorRef => refs[i]

const layers: Layer[] = []
CONV.forEach((c, i) => {
  layers.push({
    type: 'conv2d',
    inChannels: c.inC,
    outChannels: c.outC,
    kernelH: 3,
    kernelW: 3,
    strideH: 2,
    strideW: 2,
    padH: 1,
    padW: 1,
    weight: ref(i * 2),
    bias: ref(i * 2 + 1),
  })
  layers.push({ type: 'relu' })
})
const denseBase = CONV.length * 2
layers.push({ type: 'globalavgpool' })
layers.push({ type: 'dense', inFeatures: 64, outFeatures: HID, weight: ref(denseBase) })
layers.push({ type: 'relu' })
layers.push({ type: 'dense', inFeatures: HID, outFeatures: 8, weight: ref(denseBase + 1), bias: ref(denseBase + 2) })

const manifest: Manifest = {
  formatVersion: 1,
  architecture: 'corner-dummy-cnn-v1',
  input: INPUT,
  layers,
  output: { size: 8, meaning: '4 LCD corners (x,y) normalised, TL,TR,BR,BL' },
  // Filled below once we can run the forward pass.
  referenceVector: { input: { pattern: 'ramp' }, output: [] },
}

// Compute the reference output through the real load→run path, then persist it.
const out = runModel(loadModel(manifest, blob), referenceInput(manifest))
manifest.referenceVector.output = Array.from(out)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, `${NAME}.bin`), blob)
writeFileSync(join(OUT_DIR, `${NAME}.json`), JSON.stringify(manifest, null, 2) + '\n')

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`
console.log(`wrote public/models/${NAME}.{bin,json}`)
console.log(`  HID=${HID}  blob=${kb(blob.length)} (${blob.length} B)  output=[${manifest.referenceVector.output.map((v) => v.toFixed(3)).join(', ')}]`)
