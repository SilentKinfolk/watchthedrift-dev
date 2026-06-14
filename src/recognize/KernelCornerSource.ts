// The learned corner detector, at the CornerSource seam (issue #9).
//
// Runs a corner-regression model through the bespoke inference kernel (../ml) to
// locate the four LCD corners in a frame, replacing the manual stub as the
// production corner source. The model is the weights-blob asset; this slice ships a
// DUMMY one (analytic weights, abstains — see below), and the trained weights (#11)
// drop in with no code change.
//
// Two honesty properties make wiring a dummy into the live app safe:
//   • Abstain-on-implausible. The model's 8 outputs are normalised corner coords; we
//     gate them through `plausibleQuad` (convex, in-frame, non-degenerate area). A
//     bad/untrained read fails the gate → `corners()` returns null → the recognizer
//     decodes the raw crop, exactly as before. The shipped dummy outputs a
//     deliberately degenerate quad, so it ALWAYS abstains — the live preview app is
//     unchanged until real weights land. The gate is also the right thing for the
//     real detector: a low-quality detection should fail to a retake, not warp.
//   • Lazy, fail-soft load. `init()` loads the asset once; if it 404s / is offline /
//     is corrupt, the source holds no model and abstains. Reading never depends on
//     the network (PLAN: reading works offline).

import type { Quad, RawImage, Pt } from './rectify.ts'
import { sampleBilinear } from './rectify.ts'
import type { CornerSource } from './corners.ts'
import { runModel } from '../ml/model.ts'
import { loadModel, type LoadedModel, type Manifest } from '../ml/blob.ts'

/** Minimum quad area, as a fraction of the frame, to be considered a real LCD (a
 *  sanity floor, not the detector — corners come from the model). */
const MIN_AREA_FRAC = 0.02
/** How far outside the frame a corner may sit before we reject the quad (normalised). */
const COORD_SLACK = 0.25

/**
 * Resample a frame to the model's input as a normalised grayscale CHW tensor:
 * bilinear downscale → luma → `(v/255 - mean)/std`. Pure, so it unit-tests without a
 * DOM. (The #11 trainer must preprocess identically for train↔infer parity; the
 * reference-vector parity check covers the kernel forward pass, this covers the
 * front of the pipe.)
 */
export function toModelInput(image: RawImage, spec: Manifest['input']): Float32Array {
  const { width: dstW, height: dstH, mean, std } = spec
  const out = new Float32Array(spec.channels * dstH * dstW) // channels === 1 (grayscale)
  for (let ty = 0; ty < dstH; ty++) {
    // Map the destination pixel CENTRE back into the source (area-preserving).
    const sy = ((ty + 0.5) * image.height) / dstH - 0.5
    for (let tx = 0; tx < dstW; tx++) {
      const sx = ((tx + 0.5) * image.width) / dstW - 0.5
      const [r, g, b] = sampleBilinear(image, sx, sy)
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      out[ty * dstW + tx] = (luma - mean) / std
    }
  }
  return out
}

/** Shoelace area of a quad (always ≥ 0), in whatever units the points carry. */
function quadArea(p: readonly Pt[]): number {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length
    a += p[i].x * p[j].y - p[j].x * p[i].y
  }
  return Math.abs(a) / 2
}

/**
 * Is this a plausible LCD quad? Accept only finite, roughly-in-frame, convex,
 * non-degenerate quads — so an untrained/garbage read abstains rather than warps.
 * Operates on NORMALISED coords (0..1 over the frame), where the thresholds are
 * resolution-independent.
 */
export function plausibleQuad(p: readonly Pt[]): boolean {
  if (p.length !== 4) return false
  for (const { x, y } of p) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    if (x < -COORD_SLACK || x > 1 + COORD_SLACK || y < -COORD_SLACK || y > 1 + COORD_SLACK) return false
  }
  if (quadArea(p) < MIN_AREA_FRAC) return false
  // Convex ⇔ all four turn cross-products share a sign (0 ⇒ collinear ⇒ reject).
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = p[i]
    const b = p[(i + 1) % 4]
    const c = p[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross === 0) return false
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * Map a model's 8 outputs (4 normalised corners, TL,TR,BR,BL) to a pixel-space
 * `Quad`, or null if the read is implausible (→ abstain). Exported for testing the
 * gate directly.
 */
export function outputToQuad(out: Float32Array, width: number, height: number): Quad | null {
  if (out.length < 8) return null
  const norm: Pt[] = [
    { x: out[0], y: out[1] },
    { x: out[2], y: out[3] },
    { x: out[4], y: out[5] },
    { x: out[6], y: out[7] },
  ]
  if (!plausibleQuad(norm)) return null
  return norm.map((p) => ({ x: p.x * width, y: p.y * height })) as unknown as Quad
}

/**
 * The learned corner source. `load` resolves the model (lazily, in `init()`) or null
 * when the asset is unavailable — in which case the source abstains forever, so the
 * app falls back to the raw-crop decode. Factory (not a class) to stay strip-types
 * clean for the Node/eval harness.
 */
export function kernelCornerSource(load: () => Promise<LoadedModel | null>, id = 'kernel-corner-v1'): CornerSource {
  let model: LoadedModel | null = null
  let loaded = false
  return {
    id,
    async init(): Promise<void> {
      if (loaded) return
      loaded = true
      try {
        model = await load()
      } catch {
        model = null
      }
    },
    corners(image: RawImage): Quad | null {
      if (!model) return null
      try {
        const out = runModel(model, toModelInput(image, model.manifest.input))
        return outputToQuad(out, image.width, image.height)
      } catch {
        return null // any inference error → abstain, never crash the read
      }
    },
  }
}

/**
 * Browser loader for a same-origin model asset (manifest JSON + binary blob), e.g.
 * `models/corner-dummy-v1.{json,bin}` under the Vite base URL. Returns null on any
 * failure so the source abstains. Not exercised by unit tests (which inject an
 * in-memory model); used by the live app (Screen.ts).
 */
export async function fetchKernelModel(baseUrl: string, name: string): Promise<LoadedModel | null> {
  try {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const [manifestRes, blobRes] = await Promise.all([
      fetch(`${base}models/${name}.json`),
      fetch(`${base}models/${name}.bin`),
    ])
    if (!manifestRes.ok || !blobRes.ok) return null
    const manifest = (await manifestRes.json()) as Manifest
    const blob = new Uint8Array(await blobRes.arrayBuffer())
    return loadModel(manifest, blob)
  } catch {
    return null
  }
}
