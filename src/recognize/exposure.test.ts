import { describe, it, expect } from 'vitest'
import {
  measureExposure,
  legibility,
  TOO_DARK_LUMA,
  GLARE_BRIGHT_FRAC,
  type Exposure,
} from './exposure'

/** Build an RGBA buffer of `count` pixels, all the given grey (r=g=b=v, a=255). */
function solid(v: number, count = 1000): Uint8ClampedArray {
  const d = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v
    d[i * 4 + 3] = 255
  }
  return d
}

describe('measureExposure', () => {
  it('reports the mean luma of a uniform grey field', () => {
    expect(measureExposure(solid(120)).meanLuma).toBeCloseTo(120, 5)
  })

  it('weights luma by Rec.601 (green dominates)', () => {
    // One green pixel: luma = 0.587 * 255 ≈ 149.7, not 255.
    const d = new Uint8ClampedArray([0, 255, 0, 255])
    expect(measureExposure(d).meanLuma).toBeCloseTo(0.587 * 255, 3)
  })

  it('counts only near-saturated pixels as blown out', () => {
    expect(measureExposure(solid(255)).brightFrac).toBe(1)
    expect(measureExposure(solid(120)).brightFrac).toBe(0)
  })

  it('returns zeros for an empty buffer rather than NaN', () => {
    expect(measureExposure(new Uint8ClampedArray(0))).toEqual({ meanLuma: 0, brightFrac: 0 })
  })
})

describe('legibility', () => {
  const e = (meanLuma: number, brightFrac = 0): Exposure => ({ meanLuma, brightFrac })

  it('flags a genuinely dark scene as too-dark', () => {
    expect(legibility(e(TOO_DARK_LUMA - 1))).toBe('too-dark')
  })

  it('lets moderate indoor dimness through (above the dark floor)', () => {
    expect(legibility(e(TOO_DARK_LUMA + 30))).toBe('ok')
  })

  it('flags a blown-out frame as glare', () => {
    expect(legibility(e(180, GLARE_BRIGHT_FRAC + 0.05))).toBe('glare')
  })

  it('prefers too-dark over glare when both could trip (dark wins)', () => {
    // A dark frame's bright fraction is meaningless, so darkness takes priority.
    expect(legibility(e(TOO_DARK_LUMA - 1, 1))).toBe('too-dark')
  })

  it('treats an ordinary lit scene as ok', () => {
    expect(legibility(e(110, 0.02))).toBe('ok')
  })
})
