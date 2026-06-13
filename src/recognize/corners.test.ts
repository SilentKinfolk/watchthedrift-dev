import { describe, it, expect } from 'vitest'
import { parseCornersParam, manualCornerSource } from './corners'

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
    expect(src.corners(200, 100)).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ])
  })

  it('returns null with no override, so the pipeline reads the raw crop', () => {
    expect(manualCornerSource('').corners(200, 100)).toBeNull()
    expect(manualCornerSource('?debug=1').corners(200, 100)).toBeNull()
  })
})
