import { describe, it, expect } from 'vitest'
import {
  quantizeInt8,
  readTensor,
  packTensors,
  loadModel,
  byteLength,
  type Manifest,
  type Layer,
  type TensorRef,
} from './blob'
import { runModel, runReference, referenceInput } from './model'

describe('quantizeInt8', () => {
  it('round-trips zero-centred values within half a quantum', () => {
    const data = Float32Array.from([-1, 0, 0.5, 1])
    const { values, scale, zeroPoint } = quantizeInt8(data)
    expect(zeroPoint).toBe(0)
    expect(Array.from(values)).toEqual([-127, 0, 64, 127]) // 0.5/scale = 63.5 → 64
    const back = data.map((_, i) => (values[i] - zeroPoint) * scale)
    for (let i = 0; i < data.length; i++) expect(back[i]).toBeCloseTo(data[i], 2)
  })

  it('handles an all-zero tensor without dividing by zero', () => {
    const { values, scale } = quantizeInt8(Float32Array.from([0, 0, 0]))
    expect(scale).toBe(1)
    expect(Array.from(values)).toEqual([0, 0, 0])
  })
})

describe('packTensors / readTensor round-trip (the dummy-blob seam)', () => {
  it('packs mixed int8 + float32 tensors and reads them back', () => {
    const { blob, refs } = packTensors([
      { data: Float32Array.from([-1, 0, 0.5, 1]), dtype: 'int8' },
      { data: Float32Array.from([1.5, -2.25]), dtype: 'float32' },
    ])
    // Contiguous, in order: 4 int8 bytes then 2×4 float32 bytes.
    expect(refs[0]).toMatchObject({ offset: 0, length: 4, dtype: 'int8' })
    expect(refs[1]).toMatchObject({ offset: 4, length: 2, dtype: 'float32' })
    expect(blob.length).toBe(byteLength(refs[0]) + byteLength(refs[1]))

    const a = readTensor(blob, refs[0])
    expect(a[0]).toBeCloseTo(-1, 5)
    expect(a[3]).toBeCloseTo(1, 5)
    const b = readTensor(blob, refs[1])
    expect(Array.from(b)).toEqual([1.5, -2.25]) // float32 is exact
  })

  it('reads a float32 tensor correctly even at an unaligned blob offset', () => {
    // 1 int8 byte first → the float32 tensor starts at offset 1 (not 4-aligned).
    const { blob, refs } = packTensors([
      { data: Float32Array.from([1]), dtype: 'int8' },
      { data: Float32Array.from([3.5, -0.25]), dtype: 'float32' },
    ])
    expect(refs[1].offset).toBe(1)
    expect(Array.from(readTensor(blob, refs[1]))).toEqual([3.5, -0.25])
  })

  it('throws when a tensor runs past the end of the blob', () => {
    const ref: TensorRef = { offset: 8, length: 4, dtype: 'float32' } // needs 16 bytes from offset 8
    expect(() => readTensor(new Uint8Array(10), ref)).toThrow(/out of blob bounds/)
  })
})

// ── A tiny hand-computable model, built through the real pack/load path ──────────
// input (1×2×2, constant 0.5)
//   → conv 1×1 (w=2, b=0.5)  → each pixel = 0.5·2 + 0.5 = 1.5
//   → relu                   → 1.5
//   → globalAvgPool          → mean = 1.5
//   → dense (w=3, b=-1)      → 1.5·3 − 1 = 3.5
// Output: [3.5].  (w=2 and w=3 are exact under symmetric int8: maxAbs/127·127.)
function tinyModel(referenceOutput: number[]): { manifest: Manifest; blob: Uint8Array } {
  const { blob, refs } = packTensors([
    { data: Float32Array.from([2]), dtype: 'int8' }, // conv weight
    { data: Float32Array.from([0.5]), dtype: 'float32' }, // conv bias
    { data: Float32Array.from([3]), dtype: 'int8' }, // dense weight
    { data: Float32Array.from([-1]), dtype: 'float32' }, // dense bias
  ])
  const layers: Layer[] = [
    { type: 'conv2d', inChannels: 1, outChannels: 1, kernelH: 1, kernelW: 1, strideH: 1, strideW: 1, padH: 0, padW: 0, weight: refs[0], bias: refs[1] },
    { type: 'relu' },
    { type: 'globalavgpool' },
    { type: 'dense', inFeatures: 1, outFeatures: 1, weight: refs[2], bias: refs[3] },
  ]
  const manifest: Manifest = {
    formatVersion: 1,
    architecture: 'test-tiny',
    input: { channels: 1, height: 2, width: 2, mean: 0, std: 1 },
    layers,
    output: { size: 1 },
    referenceVector: { input: { pattern: 'constant', value: 0.5 }, output: referenceOutput },
  }
  return { manifest, blob }
}

describe('loadModel + runModel (the forward pass over a loaded blob)', () => {
  it('runs the hand-computed model to its by-hand output', () => {
    const { manifest, blob } = tinyModel([3.5])
    const model = loadModel(manifest, blob)
    const out = runModel(model, referenceInput(manifest))
    expect(out.length).toBe(1)
    expect(out[0]).toBeCloseTo(3.5, 4)
  })

  it('reference-vector parity: kernel output matches the stored reference', () => {
    const model = loadModel(...Object.values(tinyModel([3.5])) as [Manifest, Uint8Array])
    const { maxAbsError } = runReference(model)
    expect(maxAbsError).toBeLessThan(1e-4)
  })

  it('detects a broken forward pass (parity catches a wrong reference)', () => {
    const model = loadModel(...Object.values(tinyModel([99])) as [Manifest, Uint8Array])
    expect(runReference(model).maxAbsError).toBeGreaterThan(1)
  })

  it('rejects an unsupported format version', () => {
    const { manifest, blob } = tinyModel([3.5])
    expect(() => loadModel({ ...manifest, formatVersion: 2 as 1 }, blob)).toThrow(/formatVersion/)
  })

  it('rejects a manifest whose declared shape disagrees with the tensor length', () => {
    const { manifest, blob } = tinyModel([3.5])
    const broken: Manifest = {
      ...manifest,
      layers: manifest.layers.map((l) => (l.type === 'conv2d' ? { ...l, outChannels: 2 } : l)),
    }
    expect(() => loadModel(broken, blob)).toThrow(/weight length/)
  })
})

describe('runModel dispatch coverage (maxpool / flatten / dense / softmax / avgpool)', () => {
  it('maxpool → flatten → dense → softmax', () => {
    const { blob, refs } = packTensors([
      { data: Float32Array.from([1, -1]), dtype: 'int8' }, // dense weight [outF2, inF1]
      { data: Float32Array.from([0, 0]), dtype: 'float32' }, // dense bias
    ])
    const manifest: Manifest = {
      formatVersion: 1,
      architecture: 'test-pool',
      input: { channels: 1, height: 2, width: 2, mean: 0, std: 1 },
      layers: [
        { type: 'maxpool', kernelH: 2, kernelW: 2, strideH: 2, strideW: 2 }, // [1,2,3,4] → [4]
        { type: 'flatten' },
        { type: 'dense', inFeatures: 1, outFeatures: 2, weight: refs[0], bias: refs[1] }, // → [4, -4]
        { type: 'softmax' },
      ],
      output: { size: 2 },
      referenceVector: { input: { pattern: 'explicit', data: [1, 2, 3, 4] }, output: [0.999665, 0.000335] },
    }
    const model = loadModel(manifest, blob)
    const out = runModel(model, referenceInput(manifest))
    expect(out[0]).toBeCloseTo(0.999665, 4)
    expect(out[1]).toBeCloseTo(0.000335, 4)
  })

  it('avgpool collapses a block to its mean', () => {
    const manifest: Manifest = {
      formatVersion: 1,
      architecture: 'test-avg',
      input: { channels: 1, height: 2, width: 2, mean: 0, std: 1 },
      layers: [{ type: 'avgpool', kernelH: 2, kernelW: 2, strideH: 2, strideW: 2 }],
      output: { size: 1 },
      referenceVector: { input: { pattern: 'explicit', data: [2, 4, 6, 8] }, output: [5] },
    }
    expect(runReference(loadModel(manifest, new Uint8Array(0))).maxAbsError).toBeLessThan(1e-5)
  })
})
