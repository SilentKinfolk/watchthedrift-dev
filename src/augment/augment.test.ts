import { describe, it, expect } from 'vitest'
import {
  makeRng,
  hashSeed,
  compose,
  perspective,
  warpCorners,
  warpImageToQuad,
  imageRect,
  lowLightGamma,
  glare,
  blur,
  segmentFade,
  DEFAULT_RECIPES,
  type AugState,
  type RGBA,
} from './augment'
import { applyHomography, solveHomography, type Quad, type RawImage } from '../recognize/rectify'
import type { Corners } from '../eval/label'

// ── test image helpers ───────────────────────────────────────────────────────────

function makeImage(width: number, height: number, fill: (x: number, y: number) => RGBA): RawImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { data, width, height }
}

const px = (img: RawImage, x: number, y: number): RGBA => {
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
}
const lum = (img: RawImage, x: number, y: number): number => {
  const [r, g, b] = px(img, x, y)
  return (r + g + b) / 3
}
const meanLum = (img: RawImage): number => {
  let s = 0
  for (let p = 0; p < img.data.length; p += 4) s += (img.data[p] + img.data[p + 1] + img.data[p + 2]) / 3
  return s / (img.data.length / 4)
}
const GRAY = (v: number): ((x: number, y: number) => RGBA) => () => [v, v, v, 255]

// ── PRNG + seed hashing ──────────────────────────────────────────────────────────

describe('makeRng', () => {
  it('is deterministic for a given seed and stays in [0,1)', () => {
    const a = makeRng(42)
    const b = makeRng(42)
    for (let i = 0; i < 100; i++) {
      const v = a.next()
      expect(v).toBe(b.next())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('different seeds give different streams; range() maps into [lo,hi)', () => {
    expect(makeRng(1).next()).not.toBe(makeRng(2).next())
    const r = makeRng(7)
    for (let i = 0; i < 50; i++) {
      const v = r.range(-3, 5)
      expect(v).toBeGreaterThanOrEqual(-3)
      expect(v).toBeLessThan(5)
    }
  })
})

describe('hashSeed', () => {
  it('is a stable uint32 and varies with its inputs', () => {
    expect(hashSeed('img.jpg', 'angle', 1)).toBe(hashSeed('img.jpg', 'angle', 1))
    expect(hashSeed('img.jpg', 'angle', 1)).not.toBe(hashSeed('img.jpg', 'angle', 2))
    expect(hashSeed('img.jpg', 'angle', 1)).not.toBe(hashSeed('img.jpg', 'dim', 1))
    const h = hashSeed('a', 'b')
    expect(Number.isInteger(h)).toBe(true)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(2 ** 32)
  })
})

// ── the label-transform math (the headline acceptance) ───────────────────────────

describe('warpCorners', () => {
  it('is exactly the applied homography, per corner', () => {
    const corners: Corners = [
      { x: 10, y: 12 },
      { x: 40, y: 8 },
      { x: 44, y: 38 },
      { x: 7, y: 41 },
    ]
    const h = solveHomography(imageRect({ data: new Uint8ClampedArray(0), width: 50, height: 50 }), [
      { x: 3, y: 4 },
      { x: 47, y: 1 },
      { x: 49, y: 46 },
      { x: 2, y: 44 },
    ])!
    const warped = warpCorners(corners, h)
    for (let i = 0; i < 4; i++) {
      const expected = applyHomography(h, corners[i].x, corners[i].y)
      expect(warped[i].x).toBeCloseTo(expected.x, 9)
      expect(warped[i].y).toBeCloseTo(expected.y, 9)
    }
  })

  it('maps the image-rectangle corners exactly onto the destination quad', () => {
    // The rect corners pushed through `forward` (rect→dst) must BE dst — the
    // identity that guarantees an augmented sidecar's corners frame the warped LCD.
    const img = makeImage(60, 40, GRAY(128))
    const dst: Quad = [
      { x: 6, y: 5 },
      { x: 52, y: 9 },
      { x: 50, y: 34 },
      { x: 4, y: 31 },
    ]
    const warped = warpImageToQuad(img, dst, { width: 60, height: 40 }, [255, 255, 255, 255])!
    const out = warpCorners(imageRect(img), warped.forward)
    for (let i = 0; i < 4; i++) {
      expect(out[i].x).toBeCloseTo(dst[i].x, 6)
      expect(out[i].y).toBeCloseTo(dst[i].y, 6)
    }
  })
})

describe('perspective: corners follow the pixels through the SAME warp', () => {
  // Black frame with a bright 3×3 marker at each of four interior "LCD corner"
  // positions. After a seeded warp, each TRANSFORMED corner must land on a bright
  // pixel — i.e. the marker (a pixel feature) and the corner (a label) moved
  // together. This is "warped corners match the applied homography" end-to-end.
  const SIZE = 80
  const markers: Corners = [
    { x: 24, y: 22 },
    { x: 56, y: 24 },
    { x: 58, y: 54 },
    { x: 22, y: 56 },
  ]
  const near = (mx: number, my: number): boolean =>
    markers.some((m) => Math.abs(m.x - mx) <= 1 && Math.abs(m.y - my) <= 1)
  const img = makeImage(SIZE, SIZE, (x, y) => (near(x, y) ? [255, 255, 255, 255] : [0, 0, 0, 255]))

  it('each warped corner sits on bright pixels in the warped image', () => {
    const state: AugState = { image: img, corners: markers }
    const out = perspective({ jitter: 0.12, fill: [0, 0, 0, 255] })(state, makeRng(123))
    expect(out.corners).not.toBeNull()
    for (const c of out.corners!) {
      expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
      // brightest pixel within a 2px window around the predicted corner
      let best = 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.round(c.x) + dx
          const yy = Math.round(c.y) + dy
          if (xx < 0 || xx >= SIZE || yy < 0 || yy >= SIZE) continue
          best = Math.max(best, lum(out.image, xx, yy))
        }
      }
      expect(best).toBeGreaterThan(120)
    }
  })

  it('warps the image but yields null corners when the source had none', () => {
    const out = perspective({ jitter: 0.1 })({ image: img, corners: null }, makeRng(5))
    expect(out.corners).toBeNull()
    expect(out.image.width).toBe(SIZE)
    expect(out.image.height).toBe(SIZE)
    for (const v of out.image.data) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('warpImageToQuad', () => {
  it('reveals the fill colour outside the warped (inset) image', () => {
    const img = makeImage(40, 40, GRAY(128))
    const inset: Quad = [
      { x: 8, y: 8 },
      { x: 32, y: 8 },
      { x: 32, y: 32 },
      { x: 8, y: 32 },
    ]
    const RED: RGBA = [255, 0, 0, 255]
    const out = warpImageToQuad(img, inset, { width: 40, height: 40 }, RED)!
    expect(px(out.image, 0, 0)).toEqual(RED) // corner is outside the inset → fill
    expect(px(out.image, 20, 20)[0]).toBeCloseTo(128, -1) // centre is the source grey
  })

  it('returns null for a degenerate destination quad', () => {
    const img = makeImage(10, 10, GRAY(100))
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]
    expect(warpImageToQuad(img, collinear, { width: 10, height: 10 }, [0, 0, 0, 255])).toBeNull()
  })
})

// ── photometric transforms ───────────────────────────────────────────────────────

const stateOf = (img: RawImage, corners: Corners | null = null): AugState => ({ image: img, corners })

describe('lowLightGamma', () => {
  it('darkens a mid-grey image and leaves corners untouched', () => {
    const corners: Corners = [
      { x: 1, y: 1 },
      { x: 9, y: 1 },
      { x: 9, y: 9 },
      { x: 1, y: 9 },
    ]
    const img = makeImage(10, 10, GRAY(140))
    const out = lowLightGamma({ gamma: 2.2, gain: 0.5 })(stateOf(img, corners), makeRng(1))
    expect(meanLum(out.image)).toBeLessThan(meanLum(img))
    expect(out.corners).toBe(corners) // identity on the label
  })
})

describe('glare', () => {
  it('brightens near the highlight centre, barely touches the far corner', () => {
    const img = makeImage(40, 40, GRAY(60))
    const out = glare({ center: { x: 0.25, y: 0.25 }, radius: 0.15, intensity: 180 })(stateOf(img), makeRng(1))
    expect(lum(out.image, 10, 10)).toBeGreaterThan(lum(img, 10, 10) + 40) // near centre
    expect(lum(out.image, 39, 39)).toBeLessThan(lum(img, 39, 39) + 10) // far corner
  })
})

describe('blur', () => {
  it('reduces high-frequency contrast and preserves a flat field', () => {
    const checker = makeImage(20, 20, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    const out = blur({ radius: 2 })(stateOf(checker), makeRng(1))
    const mid = lum(out.image, 10, 10)
    expect(mid).toBeGreaterThan(60)
    expect(mid).toBeLessThan(195) // pulled off the 0/255 extremes toward grey
    const flat = makeImage(8, 8, GRAY(123))
    const flatOut = blur({ radius: 3 })(stateOf(flat), makeRng(1))
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(lum(flatOut.image, x, y)).toBeCloseTo(123, -1)
  })

  it('radius 0 is a no-op', () => {
    const img = makeImage(6, 6, GRAY(77))
    const out = blur({ radius: 0 })(stateOf(img), makeRng(1))
    expect(out.image).toBe(img)
  })
})

describe('segmentFade', () => {
  it('lifts dark ink toward the ground but leaves the light ground put', () => {
    // ink (dark) on a light LCD ground
    const img = makeImage(10, 10, (x) => (x < 3 ? [20, 20, 20, 255] : [210, 210, 210, 255]))
    const out = segmentFade({ amount: 0.5, bg: 200 })(stateOf(img), makeRng(1))
    expect(lum(out.image, 0, 0)).toBeGreaterThan(lum(img, 0, 0) + 30) // ink faded lighter
    expect(lum(out.image, 9, 0)).toBe(lum(img, 9, 0)) // ground (≥ bg) unchanged
  })
})

// ── composition + reproducibility ────────────────────────────────────────────────

describe('compose', () => {
  it('applies steps in order, equivalent to manual sequencing', () => {
    const img = makeImage(16, 16, GRAY(150))
    const a = lowLightGamma({ gamma: 2.0, gain: 0.6 })
    const b = segmentFade({ amount: 0.3, bg: 200 })
    const composed = compose(a, b)(stateOf(img), makeRng(9))
    const manual = b(a(stateOf(img), makeRng(9)), makeRng(9))
    expect(Array.from(composed.image.data)).toEqual(Array.from(manual.image.data))
  })
})

describe('reproducibility', () => {
  it('same seed → identical pixels; different seed → different (for a stochastic step)', () => {
    const img = makeImage(48, 48, GRAY(130))
    const run = (seed: number): Uint8ClampedArray =>
      perspective({ jitter: 0.13 })(stateOf(img), makeRng(seed)).image.data
    expect(Array.from(run(2024))).toEqual(Array.from(run(2024)))
    expect(Array.from(run(2024))).not.toEqual(Array.from(run(2025)))
  })
})

// ── default recipe set ───────────────────────────────────────────────────────────

describe('DEFAULT_RECIPES', () => {
  it('covers all five transform families with unique names', () => {
    const names = DEFAULT_RECIPES.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    for (const need of ['angle', 'dim', 'glare', 'blur', 'faded']) expect(names).toContain(need)
  })

  it('every recipe yields a same-size, all-finite image and a valid stratum', () => {
    const corners: Corners = [
      { x: 8, y: 8 },
      { x: 40, y: 8 },
      { x: 40, y: 40 },
      { x: 8, y: 40 },
    ]
    const img = makeImage(48, 48, (x, y) => [((x * 5) % 256), ((y * 5) % 256), 120, 255])
    for (const recipe of DEFAULT_RECIPES) {
      expect(['easy', 'moderate', 'hard']).toContain(recipe.stratum)
      const out = recipe.build({ image: img, corners }, makeRng(hashSeed('t.jpg', recipe.name, 1)))
      expect(out.image.width).toBe(48)
      expect(out.image.height).toBe(48)
      for (const v of out.image.data) expect(Number.isFinite(v)).toBe(true)
    }
  })
})
