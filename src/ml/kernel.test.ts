import { describe, it, expect } from 'vitest'
import {
  conv2d,
  relu,
  maxPool2d,
  avgPool2d,
  globalAvgPool,
  flatten,
  dense,
  softmax,
  type Tensor3,
  type Conv2dParams,
} from './kernel'

// Every assertion below is a value computed BY HAND from the inputs, so these tests
// pin the kernel's arithmetic independently of the implementation — the guard
// against a silent off-by-one in an index or an accumulation. The reference-vector
// parity test (blob.test.ts) is the complementary check: it proves the *trainer's*
// forward pass and this kernel agree on a whole model.

function t3(channels: number, height: number, width: number, data: number[]): Tensor3 {
  return { data: Float32Array.from(data), channels, height, width }
}
const arr = (x: Float32Array): number[] => Array.from(x)

describe('conv2d', () => {
  const base: Conv2dParams = {
    inChannels: 1,
    outChannels: 1,
    kernelH: 2,
    kernelW: 2,
    strideH: 1,
    strideW: 1,
    padH: 0,
    padW: 0,
  }

  it('cross-correlates a 2×2 kernel over a 3×3 input (with bias)', () => {
    // input        kernel (identity diagonal)
    // 1 2 3        1 0
    // 4 5 6        0 1
    // 7 8 9
    // out[y][x] = in[y][x] + in[y+1][x+1], then +0.5 bias.
    const input = t3(1, 3, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    const out = conv2d(input, Float32Array.from([1, 0, 0, 1]), Float32Array.from([0.5]), base)
    expect({ c: out.channels, h: out.height, w: out.width }).toEqual({ c: 1, h: 2, w: 2 })
    expect(arr(out.data)).toEqual([6.5, 8.5, 12.5, 14.5])
  })

  it('zero-pads so a centred 3×3 kernel is the identity', () => {
    const input = t3(1, 2, 2, [1, 2, 3, 4])
    const centre = Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0])
    const out = conv2d(input, centre, null, {
      ...base,
      kernelH: 3,
      kernelW: 3,
      padH: 1,
      padW: 1,
    })
    expect({ h: out.height, w: out.width }).toEqual({ h: 2, w: 2 })
    expect(arr(out.data)).toEqual([1, 2, 3, 4])
  })

  it('accumulates across input channels (1×1 conv, two in-channels)', () => {
    // ch0 weight 1, ch1 weight 2 → out = ch0 + 2·ch1, elementwise.
    const input = t3(2, 2, 2, [1, 2, 3, 4, /*ch1*/ 10, 20, 30, 40])
    const out = conv2d(input, Float32Array.from([1, 2]), null, {
      ...base,
      inChannels: 2,
      kernelH: 1,
      kernelW: 1,
    })
    expect(arr(out.data)).toEqual([21, 42, 63, 84])
  })

  it('strides ≥ 2 subsample the output grid', () => {
    const input = t3(1, 4, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    // 2×2 sum kernel, stride 2 → top-left of each 2×2 block summed.
    const out = conv2d(input, Float32Array.from([1, 1, 1, 1]), null, {
      ...base,
      strideH: 2,
      strideW: 2,
    })
    expect({ h: out.height, w: out.width }).toEqual({ h: 2, w: 2 })
    expect(arr(out.data)).toEqual([1 + 2 + 5 + 6, 3 + 4 + 7 + 8, 9 + 10 + 13 + 14, 11 + 12 + 15 + 16])
  })
})

describe('relu', () => {
  it('clamps negatives to zero, keeps positives', () => {
    expect(arr(relu(Float32Array.from([-2, -0.5, 0, 0.5, 3])))).toEqual([0, 0, 0, 0.5, 3])
  })
})

describe('maxPool2d / avgPool2d', () => {
  const input = t3(1, 4, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const p = { kernelH: 2, kernelW: 2, strideH: 2, strideW: 2 }

  it('max-pools each 2×2 block', () => {
    const out = maxPool2d(input, p)
    expect({ h: out.height, w: out.width }).toEqual({ h: 2, w: 2 })
    expect(arr(out.data)).toEqual([6, 8, 14, 16])
  })

  it('avg-pools each 2×2 block', () => {
    expect(arr(avgPool2d(input, p).data)).toEqual([3.5, 5.5, 11.5, 13.5])
  })
})

describe('globalAvgPool', () => {
  it('collapses each channel to its mean → a C-vector', () => {
    const input = t3(2, 2, 2, [1, 2, 3, 4, /*ch1*/ 10, 20, 30, 40])
    const out = globalAvgPool(input)
    expect({ c: out.channels, h: out.height, w: out.width }).toEqual({ c: 2, h: 1, w: 1 })
    expect(arr(out.data)).toEqual([2.5, 25])
  })
})

describe('flatten', () => {
  it('row-major flattens CHW into a vector', () => {
    expect(arr(flatten(t3(2, 1, 2, [1, 2, 3, 4])).data)).toEqual([1, 2, 3, 4])
  })
})

describe('dense', () => {
  it('computes Wx + b with nn.Linear [outF, inF] layout', () => {
    const w = Float32Array.from([1, 0, 1, /*row1*/ 0, 1, 0])
    const out = dense(Float32Array.from([1, 2, 3]), w, Float32Array.from([0.5, -1]), 3, 2)
    expect(arr(out)).toEqual([4.5, 1])
  })

  it('throws when the input length disagrees with inF', () => {
    expect(() => dense(Float32Array.from([1, 2]), Float32Array.from([1, 1, 1]), null, 3, 1)).toThrow()
  })
})

describe('softmax', () => {
  it('is uniform on equal logits', () => {
    // float32 storage means 1/3 won't compare exactly to the float64 literal.
    for (const v of arr(softmax(Float32Array.from([0, 0, 0])))) expect(v).toBeCloseTo(1 / 3, 6)
  })

  it('matches a hand-computed distribution and sums to 1', () => {
    const out = softmax(Float32Array.from([1, 2, 3]))
    expect(out[0]).toBeCloseTo(0.09003, 4)
    expect(out[1]).toBeCloseTo(0.24473, 4)
    expect(out[2]).toBeCloseTo(0.66524, 4)
    expect(arr(out).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
  })

  it('is stable on large logits (no overflow)', () => {
    const out = softmax(Float32Array.from([1000, 1001, 1002]))
    expect(out.every(Number.isFinite)).toBe(true)
    expect(out[2]).toBeCloseTo(0.66524, 4)
  })
})
