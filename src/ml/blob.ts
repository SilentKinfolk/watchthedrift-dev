// The weights-blob contract — the seam that decouples training from integration
// (PLAN.md "weights-blob contract" / issue #9).
//
// One versioned asset per model: a binary weight blob + a JSON manifest. The TS
// kernel reads EXACTLY what the trainer writes; the trainer writes EXACTLY what the
// kernel reads. Consequences the rest of v2 leans on:
//   • The runtime + integration are buildable and unit-testable against a DUMMY
//     blob (random/analytic weights) BEFORE any model is trained — which is what
//     makes this slice agent-doable with no data. Real corner weights (#11) drop in
//     with NO code change: the manifest is self-describing, so a different layer
//     stack or size is just a different asset.
//   • A reference test vector (one input → expected output), stored in the manifest,
//     proves the trainer's and this kernel's forward passes agree (see ./model.ts).
//
// This module owns the BYTES: the manifest/format types, int8 (de)quantisation, the
// pack helper the dummy generator and tests use to WRITE blobs, and `loadModel`,
// which validates a {manifest, blob} pair and resolves every tensor to float32 —
// the only direction the runtime needs. Forward execution lives in ./model.ts.
//
// Binary layout: the blob is a flat byte buffer; each tensor is a contiguous slice
// the manifest locates by `offset` + element `length` + `dtype`. int8 tensors are
// 1 byte/element and carry a per-tensor `scale`/`zeroPoint` (dequant:
// `f = (q - zeroPoint) · scale`); float32 tensors are 4 bytes/element little-endian
// and need no dequant. Convention: conv/dense WEIGHTS are int8 (the byte sink we
// quantise), BIASES are float32 (tiny count, precision-sensitive, negligible bytes).

export interface TensorRef {
  /** Byte offset of this tensor's first byte within the blob. */
  offset: number
  /** Element count (NOT bytes). */
  length: number
  dtype: 'int8' | 'float32'
  /** int8 only: per-tensor dequant scale. */
  scale?: number
  /** int8 only: per-tensor dequant zero-point. */
  zeroPoint?: number
}

export type Layer =
  | ({ type: 'conv2d'; inChannels: number; outChannels: number; kernelH: number; kernelW: number; strideH: number; strideW: number; padH: number; padW: number } & ParamRefs)
  | { type: 'relu' }
  | { type: 'maxpool'; kernelH: number; kernelW: number; strideH: number; strideW: number }
  | { type: 'avgpool'; kernelH: number; kernelW: number; strideH: number; strideW: number }
  | { type: 'globalavgpool' }
  | { type: 'flatten' }
  | ({ type: 'dense'; inFeatures: number; outFeatures: number } & ParamRefs)
  | { type: 'softmax' }

interface ParamRefs {
  weight: TensorRef
  bias?: TensorRef
}

/** How the canonical reference input is reconstructed (kept tiny: a pattern, not a
 *  16k-float dump). Both the trainer and the parity test rebuild the same tensor. */
export type ReferenceInput =
  | { pattern: 'constant'; value: number }
  | { pattern: 'ramp' } // data[i] = (i % 256) / 255 — trivially reproducible in numpy
  | { pattern: 'explicit'; data: number[] }

export interface Manifest {
  formatVersion: 1
  /** Architecture id — documentation/versioning only; the runner is driven by `layers`. */
  architecture: string
  input: { channels: number; height: number; width: number; mean: number; std: number }
  layers: Layer[]
  output: { size: number; meaning?: string }
  /** One input→output pair proving trainer↔runtime forward-pass parity (./model.ts). */
  referenceVector: { input: ReferenceInput; output: number[] }
}

/** A tensor's resolved float weights + bias, aligned 1:1 with `manifest.layers`
 *  (null for non-parametric layers). */
export interface ResolvedTensors {
  weight: Float32Array
  bias: Float32Array | null
}

export interface LoadedModel {
  manifest: Manifest
  layerTensors: Array<ResolvedTensors | null>
}

/** Bytes a tensor occupies in the blob. */
export function byteLength(ref: TensorRef): number {
  return ref.dtype === 'int8' ? ref.length : ref.length * 4
}

/**
 * Symmetric per-tensor int8 quantisation: `q = round(f / scale)` with
 * `scale = maxAbs / 127`, `zeroPoint = 0`. Symmetric (zero-point 0) is the simplest
 * scheme that round-trips weights centred on zero — exactly conv/dense weights.
 * An all-zero tensor gets `scale = 1` (avoids 0/0); it dequantises back to zeros.
 */
export function quantizeInt8(data: Float32Array): { values: Int8Array; scale: number; zeroPoint: number } {
  let maxAbs = 0
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i])
    if (a > maxAbs) maxAbs = a
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1
  const values = new Int8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const q = Math.round(data[i] / scale)
    values[i] = q < -127 ? -127 : q > 127 ? 127 : q
  }
  return { values, scale, zeroPoint: 0 }
}

/** Dequantise / decode a tensor's bytes from the blob into float32. */
export function readTensor(blob: Uint8Array, ref: TensorRef): Float32Array {
  const end = ref.offset + byteLength(ref)
  if (ref.offset < 0 || end > blob.length) {
    throw new Error(`tensor [${ref.offset},${end}) out of blob bounds (len ${blob.length})`)
  }
  const out = new Float32Array(ref.length)
  if (ref.dtype === 'int8') {
    const scale = ref.scale ?? 1
    const zp = ref.zeroPoint ?? 0
    const view = new Int8Array(blob.buffer, blob.byteOffset + ref.offset, ref.length)
    for (let i = 0; i < ref.length; i++) out[i] = (view[i] - zp) * scale
  } else {
    const dv = new DataView(blob.buffer, blob.byteOffset + ref.offset, ref.length * 4)
    for (let i = 0; i < ref.length; i++) out[i] = dv.getFloat32(i * 4, true)
  }
  return out
}

/** A tensor to write into a blob: float `data` either quantised to int8 or stored
 *  as float32. */
export interface PackTensor {
  data: Float32Array
  dtype: 'int8' | 'float32'
}

/**
 * Pack tensors into one contiguous blob, returning the bytes and a `TensorRef` for
 * each (in input order). The inverse of `readTensor` — used by the dummy-model
 * generator and the round-trip tests so writer and reader are proven to agree.
 */
export function packTensors(tensors: PackTensor[]): { blob: Uint8Array; refs: TensorRef[] } {
  const encoded: Array<{ bytes: Uint8Array; ref: Omit<TensorRef, 'offset'> }> = tensors.map((t) => {
    if (t.dtype === 'int8') {
      const { values, scale, zeroPoint } = quantizeInt8(t.data)
      return { bytes: new Uint8Array(values.buffer.slice(0)), ref: { length: t.data.length, dtype: 'int8', scale, zeroPoint } }
    }
    const buf = new Uint8Array(t.data.length * 4)
    const dv = new DataView(buf.buffer)
    for (let i = 0; i < t.data.length; i++) dv.setFloat32(i * 4, t.data[i], true)
    return { bytes: buf, ref: { length: t.data.length, dtype: 'float32' } }
  })

  const total = encoded.reduce((n, e) => n + e.bytes.length, 0)
  const blob = new Uint8Array(total)
  const refs: TensorRef[] = []
  let offset = 0
  for (const e of encoded) {
    blob.set(e.bytes, offset)
    refs.push({ offset, ...e.ref })
    offset += e.bytes.length
  }
  return { blob, refs }
}

/** Expected element count of a parametric layer's weight tensor — the shape contract
 *  the manifest must satisfy, validated at load so a malformed blob fails loudly. */
function expectedWeightLen(layer: Layer): number {
  if (layer.type === 'conv2d') return layer.outChannels * layer.inChannels * layer.kernelH * layer.kernelW
  if (layer.type === 'dense') return layer.outFeatures * layer.inFeatures
  return 0
}

function expectedBiasLen(layer: Layer): number {
  if (layer.type === 'conv2d') return layer.outChannels
  if (layer.type === 'dense') return layer.outFeatures
  return 0
}

/**
 * Validate a {manifest, blob} pair and resolve every tensor to float32. Throws on
 * any inconsistency (bad version, out-of-bounds tensor, wrong tensor length) so a
 * corrupt or mismatched asset can never reach the kernel. Returns tensors aligned
 * 1:1 with `manifest.layers`.
 */
export function loadModel(manifest: Manifest, blob: Uint8Array): LoadedModel {
  if (manifest.formatVersion !== 1) throw new Error(`unsupported formatVersion ${manifest.formatVersion}`)
  const layerTensors = manifest.layers.map((layer): ResolvedTensors | null => {
    if (layer.type !== 'conv2d' && layer.type !== 'dense') return null
    const weight = readTensor(blob, layer.weight)
    if (weight.length !== expectedWeightLen(layer)) {
      throw new Error(`${layer.type} weight length ${weight.length} ≠ expected ${expectedWeightLen(layer)}`)
    }
    let bias: Float32Array | null = null
    if (layer.bias) {
      bias = readTensor(blob, layer.bias)
      if (bias.length !== expectedBiasLen(layer)) {
        throw new Error(`${layer.type} bias length ${bias.length} ≠ expected ${expectedBiasLen(layer)}`)
      }
    }
    return { weight, bias }
  })
  return { manifest, layerTensors }
}
