import { describe, it, expect } from 'vitest'
import { offsetFromSamples, type RawSample } from './TimeSync'

const ORIGIN = 1_000_000

describe('offsetFromSamples', () => {
  it('selects the minimum-RTT sample', () => {
    const samples: RawSample[] = [
      // RTT 200, would imply skew +80
      { serverMs: ORIGIN + 200 + 80, floorMs: 1, t0: 100, t1: 300 },
      // RTT 40 (smaller), skew +50 → this one should win
      { serverMs: ORIGIN + 120 + 50, floorMs: 1, t0: 100, t1: 140 },
    ]
    const off = offsetFromSamples(samples, ORIGIN, 'timeapi')
    expect(off.skewMs).toBeCloseTo(50, 6)
    expect(off.uncertaintyMs).toBeCloseTo(40 / 2 + 1, 6) // rtt/2 + floor
    expect(off.source).toBe('timeapi')
    expect(off.degraded).toBe(false)
  })

  it('adds the source floor to the uncertainty band', () => {
    const samples: RawSample[] = [
      { serverMs: ORIGIN + 250 + 500, floorMs: 500, t0: 0, t1: 500 },
    ]
    const off = offsetFromSamples(samples, ORIGIN, 'date-header')
    expect(off.skewMs).toBeCloseTo(500, 6)
    expect(off.uncertaintyMs).toBeCloseTo(250 + 500, 6)
  })

  it('throws when given no samples', () => {
    expect(() => offsetFromSamples([], ORIGIN, 'timeapi')).toThrow()
  })
})
