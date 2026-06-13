import { describe, it, expect } from 'vitest'
import {
  rectify,
  rectifiedSize,
  solveHomography,
  applyHomography,
  type Quad,
  type RawImage,
} from './rectify'

type RGBA = [number, number, number, number]
const RED: RGBA = [255, 0, 0, 255]
const BLUE: RGBA = [0, 0, 255, 255]

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

function px(img: RawImage, x: number, y: number): RGBA {
  const i = (y * img.width + x) * 4
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
}

const rect = (w: number, h: number): Quad => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
]

describe('solveHomography / applyHomography', () => {
  it('maps the `from` corners exactly onto the `to` corners', () => {
    const from = rect(100, 100)
    // A genuinely non-affine quad (a trapezoid → tests the projective terms).
    const to: Quad = [
      { x: 10, y: 12 },
      { x: 102, y: 4 },
      { x: 88, y: 96 },
      { x: 3, y: 80 },
    ]
    const h = solveHomography(from, to)!
    expect(h).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      const p = applyHomography(h, from[i].x, from[i].y)
      expect(p.x).toBeCloseTo(to[i].x, 6)
      expect(p.y).toBeCloseTo(to[i].y, 6)
    }
  })

  it('round-trips an interior point through forward then inverse homography', () => {
    const from = rect(100, 100)
    const to: Quad = [
      { x: 10, y: 12 },
      { x: 102, y: 4 },
      { x: 88, y: 96 },
      { x: 3, y: 80 },
    ]
    const fwd = solveHomography(from, to)!
    const inv = solveHomography(to, from)!
    const q = applyHomography(fwd, 50, 40)
    const back = applyHomography(inv, q.x, q.y)
    expect(back.x).toBeCloseTo(50, 4)
    expect(back.y).toBeCloseTo(40, 4)
  })

  it('returns null for degenerate correspondences (collinear or non-finite)', () => {
    const from = rect(100, 100)
    // Four points on a line → no unique homography → singular system.
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ]
    const nan: Quad = [
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 50, y: 50 },
      { x: 0, y: 50 },
    ]
    expect(solveHomography(from, collinear)).toBeNull()
    expect(solveHomography(from, nan)).toBeNull()
  })
})

describe('rectify', () => {
  // Left half red, right half blue — flat regions so bilinear taps land cleanly.
  const split = makeImage(4, 4, (x) => (x < 2 ? RED : BLUE))

  it('reproduces the source under an identity (full-frame) quad', () => {
    const out = rectify(split, rect(4, 4), { width: 4, height: 4 })!
    expect(out).not.toBeNull()
    expect(px(out, 0, 0)).toEqual(RED)
    expect(px(out, 0, 3)).toEqual(RED)
    expect(px(out, 3, 0)).toEqual(BLUE)
    expect(px(out, 3, 3)).toEqual(BLUE)
  })

  it('crops to a sub-quad (the right, blue half)', () => {
    const rightHalf: Quad = [
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 2, y: 4 },
    ]
    const out = rectify(split, rightHalf, { width: 2, height: 4 })!
    expect(out.width).toBe(2)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) expect(px(out, x, y)).toEqual(BLUE)
    }
  })

  it('straightens a perspective quad back to a known frontal crop', () => {
    // Forward-warp the flat split image into a trapezoid on a larger canvas, then
    // rectify that quad back: the recovered crop must show the same left/right
    // split (red on the left edge, blue on the right edge).
    const W = 60
    const H = 40
    const quad: Quad = [
      { x: 8, y: 5 },
      { x: 52, y: 11 },
      { x: 50, y: 34 },
      { x: 6, y: 30 },
    ]
    // Render the warp: each canvas pixel inside the quad samples the source.
    const back = solveHomography(quad, rect(4, 4))! // canvas → source coords
    const scene = makeImage(W, H, (x, y) => {
      const s = applyHomography(back, x + 0.5, y + 0.5)
      if (s.x < 0 || s.x >= 4 || s.y < 0 || s.y >= 4) return [255, 255, 255, 255]
      return s.x < 2 ? RED : BLUE
    })
    const out = rectify(scene, quad, { width: 4, height: 4 })!
    expect(out).not.toBeNull()
    // Left column reads red, right column reads blue — the split survived the warp.
    expect(px(out, 0, 1)[0]).toBeGreaterThan(200) // red channel high on the left
    expect(px(out, 0, 1)[2]).toBeLessThan(60)
    expect(px(out, 3, 1)[2]).toBeGreaterThan(200) // blue channel high on the right
    expect(px(out, 3, 1)[0]).toBeLessThan(60)
  })

  it('returns null for degenerate corners or a zero-size output', () => {
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]
    expect(rectify(split, collinear, { width: 4, height: 4 })).toBeNull()
    expect(rectify(split, rect(4, 4), { width: 0, height: 4 })).toBeNull()
  })

  it('handles a near-degenerate sliver quad safely (null or all-finite, never NaN)', () => {
    const sliver: Quad = [
      { x: 0, y: 2 },
      { x: 4, y: 1.99 },
      { x: 4, y: 2.01 },
      { x: 0, y: 2 },
    ]
    const out = rectify(split, sliver, { width: 4, height: 4 })
    if (out) {
      for (const v of out.data) expect(Number.isFinite(v)).toBe(true)
    }
  })
})

describe('rectifiedSize', () => {
  it('preserves the quad aspect ratio with the long side capped', () => {
    expect(rectifiedSize(rect(200, 100), 520)).toEqual({ width: 520, height: 260 })
    expect(rectifiedSize(rect(100, 200), 520)).toEqual({ width: 260, height: 520 })
  })
})
