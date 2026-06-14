import { describe, it, expect } from 'vitest'
import { rectifyThenDecode, preferRectified } from './RectifyingSegmentRecognizer'
import { decodeSegments } from './segments'
import { rectifiedSize, type Quad } from './rectify'

// A deterministic, flat synthetic frame: decodeSegments returns a stable,
// reading-less result on it, which is all we need to test the *wiring* (the
// end-to-end angled-fixture proof lives in the Node harness, where real images are
// available — they are gitignored, so they can't be a CI unit-test dependency).
const W = 80
const H = 40
function grayFrame(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4)
  data.fill(180)
  return data
}

describe('rectifyThenDecode', () => {
  it('passes through to the raw v1 decode when there are no corners', () => {
    const data = grayFrame()
    const direct = decodeSegments(data, W, H)
    const { result, rectified } = rectifyThenDecode(data, W, H, null)
    expect(rectified).toBeNull()
    expect(result.reading).toEqual(direct.reading)
    expect(result.debug.note).toBe(direct.debug.note)
    expect(result.debug.lcd).toEqual(direct.debug.lcd)
  })

  it('rectifies first when corners are supplied, decoding the frontal crop', () => {
    const corners: Quad = [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ]
    const { rectified } = rectifyThenDecode(grayFrame(), W, H, corners)
    expect(rectified).not.toBeNull()
    // The decode ran on the canonical frontal crop, not the original frame.
    expect({ width: rectified!.width, height: rectified!.height }).toEqual(rectifiedSize(corners))
  })

  it('falls back to the raw decode if the corners are degenerate', () => {
    const data = grayFrame()
    const collinear: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ]
    const direct = decodeSegments(data, W, H)
    const { result, rectified } = rectifyThenDecode(data, W, H, collinear)
    expect(rectified).toBeNull()
    expect(result.debug.note).toBe(direct.debug.note)
  })
})

describe('preferRectified — precision-first combine of raw vs rectified', () => {
  const t = (hh: number, mm: number, ss: number) => ({ hh, mm, ss })

  it('recovers: rectified reads where raw was silent → prefer rectified', () => {
    expect(preferRectified(null, t(10, 42, 15))).toBe(true)
  })

  it('confirms: both read and agree → prefer rectified (the frontal crop)', () => {
    expect(preferRectified(t(10, 42, 15), t(10, 42, 15))).toBe(true)
  })

  it('clash: both read but disagree → defer to the validated raw baseline', () => {
    expect(preferRectified(t(10, 42, 15), t(10, 42, 16))).toBe(false)
  })

  it('rectified silent → keep raw, regardless of raw', () => {
    expect(preferRectified(t(10, 42, 15), null)).toBe(false)
    expect(preferRectified(null, null)).toBe(false)
  })
})
