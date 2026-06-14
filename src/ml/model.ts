// Forward execution over a loaded weights-blob model (issue #9).
//
// `loadModel` (./blob.ts) turns {manifest, blob} into resolved float tensors; this
// module RUNS them. The runner is data-driven by `manifest.layers` — it dispatches
// each layer to the matching ./kernel op — so a new architecture (e.g. the real
// corner net in #11) executes with no code change, just a new asset. That is the
// whole point of the weights-blob seam.
//
// `referenceInput` + `runReference` are the trainer↔runtime parity check: the
// trainer exports one (input → output) pair into the manifest, and we assert this
// kernel reproduces it. With a hand-rolled forward pass that's the guard against a
// maths divergence between the numpy trainer and the TS runtime (PLAN top-risk #4).

import { conv2d, relu, maxPool2d, avgPool2d, globalAvgPool, flatten, dense, softmax, type Tensor3 } from './kernel.ts'
import type { LoadedModel, Manifest, ReferenceInput } from './blob.ts'

/** Run the model's forward pass on a normalised CHW input tensor (length must equal
 *  `manifest.input` C·H·W — the CornerSource does the image→tensor normalisation).
 *  Returns the raw output vector (length `manifest.output.size`). */
export function runModel(model: LoadedModel, input: Float32Array): Float32Array {
  const { input: ind, layers } = model.manifest
  const expected = ind.channels * ind.height * ind.width
  if (input.length !== expected) {
    throw new Error(`runModel: input length ${input.length} ≠ C·H·W ${expected}`)
  }
  let cur: Tensor3 = { data: input.slice(), channels: ind.channels, height: ind.height, width: ind.width }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    const tensors = model.layerTensors[i]
    switch (layer.type) {
      case 'conv2d':
        cur = conv2d(cur, tensors!.weight, tensors!.bias, layer)
        break
      case 'relu':
        cur = { ...cur, data: relu(cur.data) }
        break
      case 'maxpool':
        cur = maxPool2d(cur, layer)
        break
      case 'avgpool':
        cur = avgPool2d(cur, layer)
        break
      case 'globalavgpool':
        cur = globalAvgPool(cur)
        break
      case 'flatten':
        cur = flatten(cur)
        break
      case 'dense': {
        const v = dense(cur.data, tensors!.weight, tensors!.bias, layer.inFeatures, layer.outFeatures)
        cur = { data: v, channels: v.length, height: 1, width: 1 }
        break
      }
      case 'softmax':
        cur = { ...cur, data: softmax(cur.data) }
        break
    }
  }

  if (cur.data.length !== model.manifest.output.size) {
    throw new Error(`runModel: output length ${cur.data.length} ≠ declared ${model.manifest.output.size}`)
  }
  return cur.data
}

/** Rebuild the canonical reference input tensor from its compact manifest spec, so
 *  the parity check needs no bulky float dump (and the numpy trainer can reproduce
 *  the exact same tensor). Length = C·H·W. */
export function referenceInput(manifest: Manifest): Float32Array {
  const { channels, height, width } = manifest.input
  const n = channels * height * width
  const spec: ReferenceInput = manifest.referenceVector.input
  const out = new Float32Array(n)
  switch (spec.pattern) {
    case 'constant':
      out.fill(spec.value)
      break
    case 'ramp':
      for (let i = 0; i < n; i++) out[i] = (i % 256) / 255
      break
    case 'explicit':
      if (spec.data.length !== n) throw new Error(`explicit reference input length ${spec.data.length} ≠ ${n}`)
      out.set(spec.data)
      break
  }
  return out
}

/** Run the model on its own reference input and report the largest absolute
 *  deviation from the stored reference output — 0-ish proves trainer↔runtime
 *  forward-pass parity. */
export function runReference(model: LoadedModel): { output: Float32Array; expected: number[]; maxAbsError: number } {
  const output = runModel(model, referenceInput(model.manifest))
  const expected = model.manifest.referenceVector.output
  let maxAbsError = 0
  for (let i = 0; i < output.length; i++) {
    const e = Math.abs(output[i] - (expected[i] ?? NaN))
    if (e > maxAbsError) maxAbsError = e
  }
  return { output, expected, maxAbsError }
}
