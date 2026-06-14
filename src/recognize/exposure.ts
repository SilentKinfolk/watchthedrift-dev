// Ambient-exposure read of a frame, for the honest capture feedback (issue #12).
//
// With the alignment box dropped, the app no longer asks the user to frame a clean
// shot — so it must judge for itself whether the scene is even legible before it
// trusts a read. Two coarse, resolution-independent signals come straight off the
// pixels:
//   • mean luma → "too dark": below this the reflective, backlight-less LCD can't be
//     read, so the app ABSTAINS and asks for more light rather than guessing.
//   • bright fraction → "glare": a large blown-out area is the reflective-LCD
//     failure the spec calls out. This is only a HINT (its location matters and we
//     can't localise it here), never a hard abstain — the detector/decoder already
//     fail-to-retake when a glared LCD won't read.
//
// Sampled on a stride for speed (called every scan tick); luma is the standard
// Rec.601 weighting, matching the decoder's grayscale. Pure (takes the raw RGBA
// bytes) so it unit-tests without a DOM.

export interface Exposure {
  /** Mean luma 0..255 over the sampled pixels. */
  meanLuma: number
  /** Fraction 0..1 of sampled pixels at/above the near-saturation cutoff. */
  brightFrac: number
}

/** Pixels at/above this (0..255) count as blown-out for the glare signal. */
const SATURATED = 250
/** Sample every Nth pixel — plenty for a scene-level exposure estimate, and keeps
 *  the per-frame cost negligible on a ~1600px frame scanned several times a second. */
const STRIDE = 7

/** Mean luma + blown-out fraction over an RGBA buffer (e.g. an ImageData's `data`). */
export function measureExposure(data: Uint8ClampedArray): Exposure {
  let sum = 0
  let bright = 0
  let n = 0
  for (let i = 0; i + 2 < data.length; i += 4 * STRIDE) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    sum += luma
    if (luma >= SATURATED) bright++
    n++
  }
  if (n === 0) return { meanLuma: 0, brightFrac: 0 }
  return { meanLuma: sum / n, brightFrac: bright / n }
}

export type Legibility = 'too-dark' | 'glare' | 'ok'

/** Below this mean luma (0..255) the scene is too dark to read honestly → abstain.
 *  Deliberately LOW: the PLAN wants *moderate* indoor dimness to still read, so this
 *  fires only on genuine darkness, not an ordinary dim room. A starting point tuned
 *  without a device on hand (like TIME_CROP was) — easy to revisit against reals. */
export const TOO_DARK_LUMA = 22
/** Above this blown-out fraction we surface a glare hint. Coarse and whole-frame, so
 *  it only nudges; it never blocks a read on its own. */
export const GLARE_BRIGHT_FRAC = 0.14

/** Classify the scene: too-dark (abstain) → glare (hint) → ok. Too-dark wins because
 *  a dark frame's bright fraction is meaningless. */
export function legibility(e: Exposure): Legibility {
  if (e.meanLuma < TOO_DARK_LUMA) return 'too-dark'
  if (e.brightFrac > GLARE_BRIGHT_FRAC) return 'glare'
  return 'ok'
}
