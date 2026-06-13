// Augmentation pipeline (issue #7): turn clean, labelled F-91W photos into
// hard-condition TRAINING variants while preserving the labels — by distorting
// REAL pixels (not rendering), so the LCD stays photoreal (PLAN decision #5,
// "augment the clean ones into the hard conditions … distorts real pixels (not
// rendering), so the LCD stays photoreal, and labels transform automatically").
//
// Two kinds of step, unified behind one `Augment` type:
//   • GEOMETRIC — the perspective warp. Moves pixels AND the 4 LCD corners through
//     the SAME homography, so corner labels for the warped variant come for free
//     ("corners follow the warp — which also solves corner labelling for augmented
//     data"). The displayed time is unchanged.
//   • PHOTOMETRIC — low-light gamma, glare, blur, segment-fade. Change pixels only;
//     corners and the time are untouched (an identity on the label).
//
// Everything here is PURE — RawImage + params in, RawImage out; Corners + homography
// in, Corners out — with no fs, no canvas and no model, so it unit-tests
// deterministically and both the Node CLI (tools/augment.ts) and the tests import it
// freely. Randomness is a SEEDED PRNG passed in, so a given (seed, recipe, image) is
// fully reproducible — the acceptance's "reproducible given a seed".

import {
  applyHomography,
  solveHomography,
  sampleBilinear,
  type Homography,
  type Quad,
  type RawImage,
} from '../recognize/rectify.ts'
import type { Corners } from '../eval/label.ts'
import type { Stratum } from '../eval/label.ts'

export type RGBA = [number, number, number, number]

// ── Seeded PRNG ─────────────────────────────────────────────────────────────────
// mulberry32: a tiny, fast, well-distributed 32-bit generator. Deterministic given
// its seed, so the whole pipeline is reproducible (we never touch Math.random).

export interface Rng {
  /** Next float in [0, 1). */
  next(): number
  /** Float in [lo, hi). */
  range(lo: number, hi: number): number
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, range: (lo, hi) => lo + (hi - lo) * next() }
}

/** Deterministic uint32 seed from any mix of parts (FNV-1a over their join). Lets
 *  the CLI derive a per-(image, recipe) seed from one base seed so every variant is
 *  independently reproducible. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5
  const s = parts.join(':')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ── State + composition ─────────────────────────────────────────────────────────

export interface AugState {
  image: RawImage
  /** The 4 LCD corners in image px (TL, TR, BR, BL — rectify's `Quad` order), or
   *  null when the source carries none. Geometric steps then warp the image but
   *  leave corners null (honest: unknown, never fabricated); photometric steps pass
   *  them through untouched. */
  corners: Corners | null
}

/** One augmentation step — pure given the draws it takes from `rng`. Compose with
 *  `compose`; a photometric step simply ignores `rng`. */
export type Augment = (state: AugState, rng: Rng) => AugState

/** Run `steps` left-to-right on a state, threading the same rng — so a composite
 *  recipe (e.g. warp then dim) is itself an `Augment` and stays reproducible. */
export function compose(...steps: Augment[]): Augment {
  return (state, rng) => steps.reduce((s, step) => step(s, rng), state)
}

// ── Geometric: perspective warp ──────────────────────────────────────────────────

/** The image's own rectangle as a quad (TL, TR, BR, BL). */
export function imageRect(img: RawImage): Quad {
  return [
    { x: 0, y: 0 },
    { x: img.width, y: 0 },
    { x: img.width, y: img.height },
    { x: 0, y: img.height },
  ]
}

/** Push the 4 corners through a homography — the LABEL half of a perspective warp.
 *  This is the exact map the pixels undergo (`warpImageToQuad`'s `forward`), so the
 *  returned corners land on the same LCD features in the warped image. That shared
 *  homography is what "warped corners match the applied homography" means. */
export function warpCorners(corners: Corners, forward: Homography): Corners {
  return corners.map((p) => applyHomography(forward, p.x, p.y)) as unknown as Corners
}

/** Warp `img` so its rectangle lands on `dstQuad` within an `out`-sized canvas,
 *  inverse-sampling each output pixel (no holes); output pixels that map outside the
 *  source read `fill`. Returns the warped image AND the forward homography
 *  (source px → output px) the corners must follow, or null on a degenerate quad. */
export function warpImageToQuad(
  img: RawImage,
  dstQuad: Quad,
  out: { width: number; height: number },
  fill: RGBA,
): { image: RawImage; forward: Homography } | null {
  const width = Math.round(out.width)
  const height = Math.round(out.height)
  if (!(width >= 1) || !(height >= 1)) return null
  const src = imageRect(img)
  const forward = solveHomography(src, dstQuad) // source px → output px (for corners)
  const back = solveHomography(dstQuad, src) // output px → source px (for sampling)
  if (!forward || !back) return null

  const data = new Uint8ClampedArray(width * height * 4)
  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      const s = applyHomography(back, ox + 0.5, oy + 0.5)
      const i = (oy * width + ox) * 4
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || s.x < 0 || s.x >= img.width || s.y < 0 || s.y >= img.height) {
        data[i] = fill[0]
        data[i + 1] = fill[1]
        data[i + 2] = fill[2]
        data[i + 3] = fill[3]
        continue
      }
      const [r, g, b, a] = sampleBilinear(img, s.x, s.y)
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a === 0 ? 255 : a
    }
  }
  return { image: { data, width, height }, forward }
}

export interface PerspectiveOpts {
  /** Max per-corner jitter as a fraction of the image's W/H (default 0.12). The 4
   *  corners are inset by this much, then each pushed independently within ±jitter —
   *  a keystone + skew that puts the watch off-square and off-centre, surrounded by
   *  `fill` where the warp reveals canvas. */
  jitter?: number
  /** RGBA for revealed area outside the warped image (default opaque white). */
  fill?: RGBA
}

/** A randomized perspective warp. Geometric → it transforms the corners too (when
 *  present) through the very homography it warps the pixels with, so the variant's
 *  corner label stays correct. Degenerate draws fail safe (state returned unchanged). */
export function perspective(opts: PerspectiveOpts = {}): Augment {
  const jitter = opts.jitter ?? 0.12
  const fill = opts.fill ?? [255, 255, 255, 255]
  return (state, rng) => {
    const W = state.image.width
    const H = state.image.height
    const mx = jitter * W
    const my = jitter * H
    // Inset base so each corner has room to move both ways within the frame.
    const base: Quad = [
      { x: mx, y: my },
      { x: W - mx, y: my },
      { x: W - mx, y: H - my },
      { x: mx, y: H - my },
    ]
    const dst = base.map((p) => ({
      x: clamp(p.x + rng.range(-jitter, jitter) * W, 0, W),
      y: clamp(p.y + rng.range(-jitter, jitter) * H, 0, H),
    })) as unknown as Quad
    const warped = warpImageToQuad(state.image, dst, { width: W, height: H }, fill)
    if (!warped) return state
    return {
      image: warped.image,
      corners: state.corners ? warpCorners(state.corners, warped.forward) : null,
    }
  }
}

// ── Photometric: gamma, glare, blur, segment-fade ────────────────────────────────
// All leave geometry — and therefore corners and the time — untouched.

/** Apply a pure per-channel map to RGB (alpha copied), returning a new image. */
function mapPixels(
  img: RawImage,
  fn: (r: number, g: number, b: number, x: number, y: number) => [number, number, number],
): RawImage {
  const { data, width, height } = img
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b] = fn(data[i], data[i + 1], data[i + 2], x, y)
      out[i] = r
      out[i + 1] = g
      out[i + 2] = b
      out[i + 3] = data[i + 3]
    }
  }
  return { data: out, width, height }
}

export interface GammaOpts {
  /** Gamma exponent on normalized intensity; > 1 darkens midtones (default 2.2). */
  gamma?: number
  /** Linear gain after gamma; < 1 dims overall (default 0.5). */
  gain?: number
}

/** Low-light: push the image down a gamma curve and dim it, the dominant effect of
 *  shooting a no-backlight reflective LCD in a dim room. Moderate dimness the model
 *  should cope with; true darkness is handled by honest abstain, not here (PLAN). */
export function lowLightGamma(opts: GammaOpts = {}): Augment {
  const gamma = opts.gamma ?? 2.2
  const gain = opts.gain ?? 0.5
  const ch = (v: number): number => 255 * Math.pow(v / 255, gamma) * gain
  return (state) => ({ ...state, image: mapPixels(state.image, (r, g, b) => [ch(r), ch(g), ch(b)]) })
}

export interface GlareOpts {
  /** Highlight centre as fractions of W, H. Default: drawn from the rng (a random
   *  reflection position). */
  center?: { x: number; y: number }
  /** Radius as a fraction of the image diagonal (default 0.22). */
  radius?: number
  /** Peak added brightness (0..255) at the centre (default 200). */
  intensity?: number
}

/** Glare: add a soft radial specular highlight that washes out part of the LCD — the
 *  reflective-glass failure v2 exists to survive. Gaussian falloff, additive (clamped). */
export function glare(opts: GlareOpts = {}): Augment {
  const radiusFrac = opts.radius ?? 0.22
  const intensity = opts.intensity ?? 200
  return (state, rng) => {
    const W = state.image.width
    const H = state.image.height
    const cx = (opts.center?.x ?? rng.next()) * W
    const cy = (opts.center?.y ?? rng.next()) * H
    const radius = radiusFrac * Math.hypot(W, H)
    const inv2 = 1 / (2 * radius * radius)
    return {
      ...state,
      image: mapPixels(state.image, (r, g, b, x, y) => {
        const add = intensity * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) * inv2)
        return [r + add, g + add, b + add]
      }),
    }
  }
}

export interface BlurOpts {
  /** Box-blur radius in px (default 2). 0 → no-op. */
  radius?: number
}

/** Blur: a separable box blur, standing in for motion/defocus from a hand-held shot
 *  at arm's length. Edge-clamped so borders stay clean. */
export function blur(opts: BlurOpts = {}): Augment {
  const radius = Math.max(0, Math.round(opts.radius ?? 2))
  return (state) => (radius === 0 ? state : { ...state, image: boxBlur(state.image, radius) })
}

function boxBlur(img: RawImage, r: number): RawImage {
  return blurPass(blurPass(img, r, true), r, false)
}

function blurPass(img: RawImage, r: number, horizontal: boolean): RawImage {
  const { data, width, height } = img
  const out = new Uint8ClampedArray(data.length)
  const n = 2 * r + 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sr = 0
      let sg = 0
      let sb = 0
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? clampInt(x + k, 0, width - 1) : x
        const yy = horizontal ? y : clampInt(y + k, 0, height - 1)
        const i = (yy * width + xx) * 4
        sr += data[i]
        sg += data[i + 1]
        sb += data[i + 2]
      }
      const o = (y * width + x) * 4
      out[o] = sr / n
      out[o + 1] = sg / n
      out[o + 2] = sb / n
      out[o + 3] = data[o + 3]
    }
  }
  return { data: out, width, height }
}

export interface FadeOpts {
  /** Fraction (0..1) to lift dark ink toward `bg` — 0 no-op, → fainter segments
   *  (default 0.5). */
  amount?: number
  /** The light LCD background level the ink fades toward (default 200). Pixels at or
   *  above it (the ground) are left alone, so only the digits weaken. */
  bg?: number
}

/** Segment-fade: lift the dark ink toward the light LCD ground, emulating faint/aged
 *  segments — the failure v1's thresholding can't recover and the learned reader
 *  exists to win. Only sub-`bg` pixels move, so the bright ground stays put. */
export function segmentFade(opts: FadeOpts = {}): Augment {
  const amount = clamp(opts.amount ?? 0.5, 0, 1)
  const bg = opts.bg ?? 200
  const ch = (v: number): number => (v < bg ? v + (bg - v) * amount : v)
  return (state) => ({ ...state, image: mapPixels(state.image, (r, g, b) => [ch(r), ch(g), ch(b)]) })
}

// ── Default recipes ──────────────────────────────────────────────────────────────
// Named compositions the CLI ships by default: each of the five families alone, plus
// a couple of composites (the real world stacks dimness/glare onto an angle). The
// `stratum` tags the difficulty the augmentation pushes a clean photo into.

export interface Recipe {
  name: string
  stratum: Stratum
  build: Augment
}

export const DEFAULT_RECIPES: readonly Recipe[] = [
  { name: 'angle', stratum: 'moderate', build: perspective({ jitter: 0.12 }) },
  { name: 'dim', stratum: 'moderate', build: lowLightGamma({ gamma: 2.2, gain: 0.5 }) },
  { name: 'glare', stratum: 'hard', build: glare({ radius: 0.2, intensity: 210 }) },
  { name: 'blur', stratum: 'moderate', build: blur({ radius: 2 }) },
  { name: 'faded', stratum: 'hard', build: segmentFade({ amount: 0.55 }) },
  {
    name: 'dim-angle',
    stratum: 'hard',
    build: compose(perspective({ jitter: 0.14 }), lowLightGamma({ gamma: 2.4, gain: 0.45 })),
  },
  {
    name: 'glare-angle',
    stratum: 'hard',
    build: compose(perspective({ jitter: 0.12 }), glare({ radius: 0.18, intensity: 200 })),
  },
]

// ── small helpers ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function clampInt(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}
