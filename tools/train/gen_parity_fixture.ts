// Generate a numpy<->TS forward-pass parity fixture (issue #11).
//
// The trainer is numpy; the runtime is the bespoke TS kernel. Their forward passes
// MUST agree or the shipped int8 weights compute one thing in training and another
// in the browser (PLAN top-risk #4). The committed guard is the manifest's
// referenceVector (numpy writes it, the TS asset test asserts the TS kernel
// reproduces it). This script is the DEV-LOOP version of that check on the real
// corner architecture and shapes, decoupled from a (minutes-long) training run:
//
//   npm run gen:parity            # → tools/train/parity-fixture.json (gitignored)
//   python3 tools/train/check_parity.py
//
// It builds a small, RANDOM, NON-degenerate model in the corner net's exact shape
// (1×128×128 → conv stack → GAP → dense → relu → dense → 8), runs the TS kernel on
// the ramp input, and dumps {manifest, blob(base64), output}. check_parity.py loads
// it, runs the numpy kernel, and asserts the outputs match — so a maths bug in
// tools/train/cnn_numpy.py is caught in seconds, on real conv/dense maths the
// all-0.5 dummy could never exercise.

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { packTensors, loadModel, type Manifest, type Layer, type PackTensor, type TensorRef } from '../../src/ml/blob.ts'
import { runModel, referenceInput } from '../../src/ml/model.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const INPUT = { channels: 1, height: 128, width: 128, mean: 0.5, std: 0.5 }
// The real corner architecture (kept in sync with train_corners.py ARCH).
const CONV = [
  { inC: 1, outC: 8 },
  { inC: 8, outC: 16 },
  { inC: 16, outC: 32 },
  { inC: 32, outC: 32 },
]
const GAP_C = 32
const HID = 64

/** Deterministic PRNG (mulberry32) so the fixture is reproducible. */
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
const rand = mulberry32(0xc0ffee11)
const rnd = (n: number, k = 0.3): Float32Array => Float32Array.from({ length: n }, () => (rand() - 0.5) * k)

const pack: PackTensor[] = []
for (const c of CONV) {
  pack.push({ data: rnd(c.outC * c.inC * 9), dtype: 'int8' })
  pack.push({ data: rnd(c.outC), dtype: 'float32' })
}
pack.push({ data: rnd(GAP_C * HID), dtype: 'int8' })
pack.push({ data: rnd(HID), dtype: 'float32' })
pack.push({ data: rnd(HID * 8), dtype: 'int8' }) // NON-zero head → exercises the maths
pack.push({ data: rnd(8), dtype: 'float32' })

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
const base = CONV.length * 2
layers.push({ type: 'globalavgpool' })
layers.push({ type: 'dense', inFeatures: GAP_C, outFeatures: HID, weight: ref(base), bias: ref(base + 1) })
layers.push({ type: 'relu' })
layers.push({ type: 'dense', inFeatures: HID, outFeatures: 8, weight: ref(base + 2), bias: ref(base + 3) })

const manifest: Manifest = {
  formatVersion: 1,
  architecture: 'corner-parity-fixture',
  input: INPUT,
  layers,
  output: { size: 8, meaning: '4 LCD corners (x,y) normalised, TL,TR,BR,BL' },
  referenceVector: { input: { pattern: 'ramp' }, output: [] },
}
const out = runModel(loadModel(manifest, blob), referenceInput(manifest))
manifest.referenceVector.output = Array.from(out)

const fixture = {
  manifest,
  blobBase64: Buffer.from(blob).toString('base64'),
  output: Array.from(out),
}
const outPath = join(HERE, 'parity-fixture.json')
writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${outPath}  (TS output: [${Array.from(out).map((v) => v.toFixed(4)).join(', ')}])`)
