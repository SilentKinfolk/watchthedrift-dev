import { describe, it, expect } from 'vitest'
import { parseCornersParam, manualCornerSource, firstAvailable } from './corners'
import type { CornerSource } from './corners'
import type { Quad, RawImage } from './rectify'

/** A blank frame of the given size — the manual stub only reads its dimensions. */
const frame = (width: number, height: number): RawImage => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
})

describe('parseCornersParam', () => {
  it('scales eight fractions into TL,TR,BR,BL pixel corners', () => {
    const q = parseCornersParam('0.1,0.2,0.9,0.18,0.92,0.8,0.08,0.82', 1000, 500)!
    expect(q).not.toBeNull()
    expect(q).toEqual([
      { x: 100, y: 100 },
      { x: 900, y: 90 },
      { x: 920, y: 400 },
      { x: 80, y: 410 },
    ])
  })

  it('returns null when absent or malformed', () => {
    expect(parseCornersParam(null, 100, 100)).toBeNull()
    expect(parseCornersParam('', 100, 100)).toBeNull()
    expect(parseCornersParam('0.1,0.2,0.3', 100, 100)).toBeNull() // too few
    expect(parseCornersParam('0.1,0.2,0.9,0.2,0.9,0.8,0.1,nope', 100, 100)).toBeNull() // non-numeric
  })
})

describe('manualCornerSource', () => {
  it('supplies corners from a ?corners= override', () => {
    const src = manualCornerSource('?corners=0,0,1,0,1,1,0,1')
    expect(src.corners(frame(200, 100))).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ])
  })

  it('returns null with no override, so the pipeline reads the raw crop', () => {
    expect(manualCornerSource('').corners(frame(200, 100))).toBeNull()
    expect(manualCornerSource('?debug=1').corners(frame(200, 100))).toBeNull()
  })
})

describe('firstAvailable', () => {
  const fixed = (id: string, q: Quad | null): CornerSource => ({ id, corners: () => q })
  const unit: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]

  it('takes the first source that returns a quad (debug override wins)', () => {
    const src = firstAvailable(fixed('a', unit), fixed('b', null))
    expect(src.corners(frame(10, 10))).toBe(unit)
  })

  it('falls through abstaining sources to the next', () => {
    const src = firstAvailable(fixed('a', null), fixed('b', unit))
    expect(src.corners(frame(10, 10))).toBe(unit)
  })

  it('returns null when all sources abstain', () => {
    expect(firstAvailable(fixed('a', null), fixed('b', null)).corners(frame(10, 10))).toBeNull()
  })

  it('inits every source that has an init()', async () => {
    const inited: string[] = []
    const withInit = (id: string): CornerSource => ({
      id,
      async init() {
        inited.push(id)
      },
      corners: () => null,
    })
    await firstAvailable(withInit('a'), fixed('b', null), withInit('c')).init?.()
    expect(inited).toEqual(['a', 'c'])
  })
})
