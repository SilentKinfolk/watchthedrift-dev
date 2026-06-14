// Bespoke tiny-CNN inference kernel (PLAN.md decision #2 / issue #9).
//
// A hand-written, pure-TypeScript op set — NOT a general ML runtime. We measured
// onnxruntime-web 1.26.0's leanest SIMD wasm at ~12.4 MB, ~2.5× the entire 5 MB
// first-load gate before a single byte of weights, so a stock runtime cannot ship
// under budget. Instead we hand-roll exactly the ops our two tiny, known nets need
// — conv2d, ReLU, max/avg-pool, dense, softmax — as pure functions over typed
// arrays: a few KB of code that, with int8 weights, stays well under 0.5 MB.
//
// Conventions (chosen to match PyTorch / numpy so the #11 trainer's export is a
// straight copy, which also pins train↔infer parity — the numpy ops mirror these
// one-to-one):
//   • Feature maps are CHW: a flat Float32Array indexed [(c*H + y)*W + x].
//   • Conv weights are [outC, inC, kH, kW], indexed [((oc*inC + ic)*kH + ky)*kW + kx].
//   • Dense weights are [outF, inF] (nn.Linear layout), indexed [o*inF + i].
//   • Math is float32 throughout ("float accumulate"); int8 lives only in the
//     stored weights and is dequantised to float by the loader (see ./blob.ts)
//     before it reaches these ops. Keeping the ops float makes them testable
//     against hand-computed values — you cannot hand-check a fused-int8 conv.
//
// Every function is pure (no shared state, no I/O), so the browser app, the Node
// harness, and the unit tests all exercise identical maths.

/** A CHW feature map: `data` holds channels × height × width in row-major order. */
export interface Tensor3 {
  data: Float32Array
  channels: number
  height: number
  width: number
}

export interface Conv2dParams {
  inChannels: number
  outChannels: number
  kernelH: number
  kernelW: number
  strideH: number
  strideW: number
  padH: number
  padW: number
}

export interface PoolParams {
  kernelH: number
  kernelW: number
  strideH: number
  strideW: number
}

/** Output spatial extent of a sliding window — the standard conv/pool size rule. */
function outDim(inSize: number, kernel: number, stride: number, pad: number): number {
  return Math.floor((inSize + 2 * pad - kernel) / stride) + 1
}

/**
 * 2-D convolution with zero-padding (cross-correlation, as PyTorch/TF define it —
 * no kernel flip). `weights` is [outC, inC, kH, kW] flat; `bias` is [outC] (or null
 * for no bias). Float accumulate. Taps that fall outside the padded input read 0.
 */
export function conv2d(input: Tensor3, weights: Float32Array, bias: Float32Array | null, p: Conv2dParams): Tensor3 {
  if (input.channels !== p.inChannels) {
    throw new Error(`conv2d: input has ${input.channels} channels, params expect ${p.inChannels}`)
  }
  const outH = outDim(input.height, p.kernelH, p.strideH, p.padH)
  const outW = outDim(input.width, p.kernelW, p.strideW, p.padW)
  if (outH < 1 || outW < 1) throw new Error('conv2d: kernel larger than padded input')
  const out = new Float32Array(p.outChannels * outH * outW)

  for (let oc = 0; oc < p.outChannels; oc++) {
    const b = bias ? bias[oc] : 0
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        let acc = b
        for (let ic = 0; ic < p.inChannels; ic++) {
          for (let ky = 0; ky < p.kernelH; ky++) {
            const iy = oy * p.strideH - p.padH + ky
            if (iy < 0 || iy >= input.height) continue
            for (let kx = 0; kx < p.kernelW; kx++) {
              const ix = ox * p.strideW - p.padW + kx
              if (ix < 0 || ix >= input.width) continue
              const w = weights[((oc * p.inChannels + ic) * p.kernelH + ky) * p.kernelW + kx]
              acc += input.data[(ic * input.height + iy) * input.width + ix] * w
            }
          }
        }
        out[(oc * outH + oy) * outW + ox] = acc
      }
    }
  }
  return { data: out, channels: p.outChannels, height: outH, width: outW }
}

/** ReLU, element-wise (`max(0, x)`). Shape-agnostic — returns a fresh array, so the
 *  caller keeps the surrounding tensor metadata. */
export function relu(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] > 0 ? data[i] : 0
  return out
}

/** Max-pool over non-overlapping-or-strided windows (zero-pad-free: windows are
 *  clamped to the input, matching `ceil_mode=False`). */
export function maxPool2d(input: Tensor3, p: PoolParams): Tensor3 {
  return pool(input, p, 'max')
}

/** Average-pool, same windowing as maxPool2d; the mean is over the in-bounds taps. */
export function avgPool2d(input: Tensor3, p: PoolParams): Tensor3 {
  return pool(input, p, 'avg')
}

function pool(input: Tensor3, p: PoolParams, kind: 'max' | 'avg'): Tensor3 {
  const outH = outDim(input.height, p.kernelH, p.strideH, 0)
  const outW = outDim(input.width, p.kernelW, p.strideW, 0)
  if (outH < 1 || outW < 1) throw new Error('pool: window larger than input')
  const out = new Float32Array(input.channels * outH * outW)
  for (let c = 0; c < input.channels; c++) {
    for (let oy = 0; oy < outH; oy++) {
      for (let ox = 0; ox < outW; ox++) {
        let acc = kind === 'max' ? -Infinity : 0
        let count = 0
        for (let ky = 0; ky < p.kernelH; ky++) {
          const iy = oy * p.strideH + ky
          if (iy >= input.height) continue
          for (let kx = 0; kx < p.kernelW; kx++) {
            const ix = ox * p.strideW + kx
            if (ix >= input.width) continue
            const v = input.data[(c * input.height + iy) * input.width + ix]
            if (kind === 'max') acc = v > acc ? v : acc
            else acc += v
            count++
          }
        }
        out[(c * outH + oy) * outW + ox] = kind === 'max' ? acc : acc / count
      }
    }
  }
  return { data: out, channels: input.channels, height: outH, width: outW }
}

/** Global average pool: collapse each channel's H×W plane to its mean → a length-C
 *  vector (returned as a C×1×1 tensor so it slots into a dense layer). */
export function globalAvgPool(input: Tensor3): Tensor3 {
  const plane = input.height * input.width
  const out = new Float32Array(input.channels)
  for (let c = 0; c < input.channels; c++) {
    let sum = 0
    for (let i = 0; i < plane; i++) sum += input.data[c * plane + i]
    out[c] = sum / plane
  }
  return { data: out, channels: input.channels, height: 1, width: 1 }
}

/** Flatten a CHW map to a length-(C·H·W) vector (row-major), as a 1×1 tensor. */
export function flatten(input: Tensor3): Tensor3 {
  return { data: input.data.slice(), channels: input.data.length, height: 1, width: 1 }
}

/**
 * Fully-connected layer: `out[o] = bias[o] + Σ_i input[i]·weights[o·inF + i]`.
 * `weights` is [outF, inF] flat (nn.Linear layout); `bias` is [outF] or null.
 */
export function dense(input: Float32Array, weights: Float32Array, bias: Float32Array | null, inF: number, outF: number): Float32Array {
  if (input.length !== inF) throw new Error(`dense: input length ${input.length} ≠ inF ${inF}`)
  const out = new Float32Array(outF)
  for (let o = 0; o < outF; o++) {
    let acc = bias ? bias[o] : 0
    const base = o * inF
    for (let i = 0; i < inF; i++) acc += input[i] * weights[base + i]
    out[o] = acc
  }
  return out
}

/** Numerically-stable softmax over a 1-D vector (subtract the max before exp). */
export function softmax(data: Float32Array): Float32Array {
  let max = -Infinity
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i]
  const out = new Float32Array(data.length)
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    const e = Math.exp(data[i] - max)
    out[i] = e
    sum += e
  }
  for (let i = 0; i < data.length; i++) out[i] /= sum
  return out
}
