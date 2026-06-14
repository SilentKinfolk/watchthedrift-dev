import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModel, type Manifest } from '../src/ml/blob'
import { runReference } from '../src/ml/model'

// Validate the COMMITTED trained corner asset end-to-end — the one the live app
// ships and the byte-gate measures. Produced by `python3 tools/train/train_corners.py`
// (numpy trainer; PLAN "Training is agent-doable — numpy-first"). The reference
// vector here is the trainer↔runtime PARITY GUARD (PLAN top-risk #4): the numpy
// trainer wrote referenceVector.output from its own forward on the dequantised int8
// weights; this asserts the TS kernel reproduces it, so the weights compute the same
// thing in the browser as they did in training.
const DIR = join(process.cwd(), 'public', 'models')
const manifest = JSON.parse(readFileSync(join(DIR, 'corner-v1.json'), 'utf8')) as Manifest
const blob = new Uint8Array(readFileSync(join(DIR, 'corner-v1.bin')))

describe('the shipped corner-v1 asset', () => {
  it('loads and reproduces its reference vector (numpy trainer ↔ TS runtime parity)', () => {
    const model = loadModel(manifest, blob)
    const { maxAbsError } = runReference(model)
    expect(maxAbsError).toBeLessThan(1e-4)
  })

  it('is the corner contract: 1×128×128 in, 8 corner coords out', () => {
    expect(manifest.input).toMatchObject({ channels: 1, height: 128, width: 128 })
    expect(manifest.output.size).toBe(8)
    expect(manifest.architecture).toBe('corner-cnn-v1')
  })

  it('is a real trained model, not the degenerate abstain-dummy', () => {
    // The dummy emitted a constant quad (zero head). A trained model responds to its
    // input: the reference output coords have real spread, not 8 identical values.
    const out = runReference(loadModel(manifest, blob)).output
    const spread = Math.max(...out) - Math.min(...out)
    expect(spread).toBeGreaterThan(0.01)
  })

  it('is far under the per-model byte allowance (int8 tiny-CNN, well below ~1.5 MB)', () => {
    expect(blob.length).toBeGreaterThan(50 * 1024) // a real model, not empty
    expect(blob.length).toBeLessThan(512 * 1024) // tiny vs the ~1.5 MB allowance
  })
})
