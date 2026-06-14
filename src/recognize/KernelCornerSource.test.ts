import { describe, it, expect } from 'vitest'
import { toModelInput, plausibleQuad, outputToQuad, kernelCornerSource } from './KernelCornerSource'
import { RectifyingSegmentRecognizer } from './RectifyingSegmentRecognizer'
import { packTensors, loadModel, type Manifest, type Layer, type LoadedModel } from '../ml/blob'
import type { Quad, RawImage } from './rectify'

/** Compare a quad to expected pixel corners with float32 tolerance (the model's
 *  coords round-trip through int8/float32, so they aren't bit-exact). */
function expectQuadClose(actual: Quad | null, expected: Array<{ x: number; y: number }>): void {
  expect(actual).not.toBeNull()
  actual!.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i].x, 3)
    expect(p.y).toBeCloseTo(expected[i].y, 3)
  })
}

/** A model whose output is a fixed 8-vector regardless of input: flatten → dense
 *  with ZERO weights and bias = the desired corners. This is how the shipped dummy
 *  works too (analytic, constant) — here we pick the constant per test to drive the
 *  plausibility gate either way. */
function constantOutputModel(coords: number[]): LoadedModel {
  const { blob, refs } = packTensors([
    { data: new Float32Array(4 * 8), dtype: 'int8' }, // dense weight [outF8, inF4] = zeros
    { data: Float32Array.from(coords), dtype: 'float32' }, // dense bias = the corners
  ])
  const layers: Layer[] = [
    { type: 'flatten' },
    { type: 'dense', inFeatures: 4, outFeatures: 8, weight: refs[0], bias: refs[1] },
  ]
  const manifest: Manifest = {
    formatVersion: 1,
    architecture: 'test-constant',
    input: { channels: 1, height: 2, width: 2, mean: 0, std: 1 },
    layers,
    output: { size: 8 },
    referenceVector: { input: { pattern: 'constant', value: 0 }, output: coords },
  }
  return loadModel(manifest, blob)
}

const grayFrame = (w: number, h: number, v = 128): RawImage => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = v
    data[i + 3] = 255
  }
  return { data, width: w, height: h }
}

const RECT = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9] // a clean TL,TR,BR,BL rectangle
const DEGENERATE = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] // zero area → abstain (the dummy)

describe('plausibleQuad', () => {
  it('accepts a clean in-frame convex quad', () => {
    expect(plausibleQuad([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }])).toBe(true)
  })
  it('rejects a degenerate (zero-area) quad — the dummy abstains here', () => {
    expect(plausibleQuad([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }])).toBe(false)
  })
  it('rejects corners far outside the frame', () => {
    expect(plausibleQuad([{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 2 }, { x: -1, y: 2 }])).toBe(false)
  })
  it('rejects a non-convex (bowtie / self-crossing) quad', () => {
    // TL, BR, TR, BL traces a bowtie — not a simple convex quad.
    expect(plausibleQuad([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }])).toBe(false)
  })
  it('rejects collinear corners', () => {
    expect(plausibleQuad([{ x: 0, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.9, y: 0.5 }])).toBe(false)
  })
})

describe('outputToQuad', () => {
  it('scales a plausible normalised read to pixel corners', () => {
    const q = outputToQuad(Float32Array.from(RECT), 1000, 500)
    expectQuadClose(q, [
      { x: 100, y: 50 },
      { x: 900, y: 50 },
      { x: 900, y: 450 },
      { x: 100, y: 450 },
    ])
  })
  it('returns null on a degenerate read', () => {
    expect(outputToQuad(Float32Array.from(DEGENERATE), 1000, 500)).toBeNull()
  })
})

describe('toModelInput', () => {
  it('produces a C·H·W tensor, normalised from luma', () => {
    const spec = { channels: 1, height: 2, width: 2, mean: 0, std: 1 }
    const t = toModelInput(grayFrame(8, 8, 128), spec)
    expect(t.length).toBe(4)
    for (const v of t) expect(v).toBeCloseTo(128 / 255, 5) // grey 128 → luma, downscaled flat
  })
  it('applies mean/std normalisation', () => {
    const t = toModelInput(grayFrame(4, 4, 255), { channels: 1, height: 1, width: 1, mean: 0.5, std: 0.25 })
    expect(t[0]).toBeCloseTo((1 - 0.5) / 0.25, 5) // white → luma 1 → (1-0.5)/0.25 = 2
  })
})

describe('kernelCornerSource', () => {
  it('abstains before init (no model loaded → raw decode)', () => {
    const src = kernelCornerSource(async () => constantOutputModel(RECT))
    expect(src.corners(grayFrame(40, 20))).toBeNull()
  })

  it('returns the model’s corners (scaled) once a plausible model is loaded', async () => {
    const src = kernelCornerSource(async () => constantOutputModel(RECT))
    await src.init!()
    expectQuadClose(src.corners(grayFrame(100, 50)), [
      { x: 10, y: 5 },
      { x: 90, y: 5 },
      { x: 90, y: 45 },
      { x: 10, y: 45 },
    ])
  })

  it('abstains when the loaded model reads implausibly (the shipped dummy)', async () => {
    const src = kernelCornerSource(async () => constantOutputModel(DEGENERATE))
    await src.init!()
    expect(src.corners(grayFrame(100, 50))).toBeNull()
  })

  it('fails soft when the asset can’t load (offline / 404)', async () => {
    const src = kernelCornerSource(async () => null)
    await src.init!()
    expect(src.corners(grayFrame(40, 20))).toBeNull()
    const thrower = kernelCornerSource(async () => {
      throw new Error('network')
    })
    await thrower.init!()
    expect(thrower.corners(grayFrame(40, 20))).toBeNull()
  })

  it('loads the model only once across repeated init()', async () => {
    let loads = 0
    const src = kernelCornerSource(async () => {
      loads++
      return constantOutputModel(RECT)
    })
    await src.init!()
    await src.init!()
    expect(loads).toBe(1)
  })
})

// ── End-to-end behind RectifyingSegmentRecognizer (the seam the stub had) ────────
// A minimal fake canvas is enough: the recognizer reads width/height + getImageData.
// We assert via the `raw` debug string whether the rectify path ran ('rectified')
// or the source abstained to the raw crop ('raw') — proving the kernel corners
// actually drive the recognizer, in node, with no real model.
function fakeCanvas(image: RawImage): HTMLCanvasElement {
  return {
    width: image.width,
    height: image.height,
    getContext: () => ({ getImageData: () => ({ data: image.data }) }),
  } as unknown as HTMLCanvasElement
}

describe('RectifyingSegmentRecognizer + kernelCornerSource', () => {
  it('rectifies when the kernel detector reports a plausible LCD', async () => {
    const rec = new RectifyingSegmentRecognizer(kernelCornerSource(async () => constantOutputModel(RECT)))
    await rec.init() // awaits the corner source's model load
    const out = await rec.recognize({ canvas: fakeCanvas(grayFrame(80, 40)), is24h: true })
    expect(out.ok).toBe(false) // a blank frame has no digits…
    if (!out.ok) expect(out.raw ?? '').toContain('rectified') // …but it went through the rectify path
  })

  it('falls back to the raw crop when the detector abstains (dummy)', async () => {
    const rec = new RectifyingSegmentRecognizer(kernelCornerSource(async () => constantOutputModel(DEGENERATE)))
    await rec.init()
    const out = await rec.recognize({ canvas: fakeCanvas(grayFrame(80, 40)), is24h: true })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.raw ?? '').toContain('(raw;')
  })
})
