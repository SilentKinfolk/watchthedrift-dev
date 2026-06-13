import { describe, it, expect } from 'vitest'
import { computeDrift, type WatchReading } from './Drift'

// True UTC instant on a fixed date; tests use tzOffset 0 unless noted, so local
// time-of-day equals this UTC time-of-day.
const T = (h: number, m: number, s: number, ms = 0) => Date.UTC(2026, 5, 4, h, m, s, ms)

const watch = (hh: number, mm: number, ss: number): WatchReading => ({ hh, mm, ss })

describe('computeDrift', () => {
  it('reports a fast watch (24h)', () => {
    // Watch shows 10:42:15; true time is 10:42:09.300 → ~+6 s.
    const r = computeDrift(watch(10, 42, 15), T(10, 42, 9, 300), 0, 0, true)
    expect(r.offsetSec).toBeCloseTo(6.2, 6)
    expect(r.direction).toBe('fast')
  })

  it('reports a slow watch (24h)', () => {
    // Watch shows 10:42:05; true time is 10:42:09.000 → ~-3.5 s.
    const r = computeDrift(watch(10, 42, 5), T(10, 42, 9, 0), 0, 0, true)
    expect(r.offsetSec).toBeCloseTo(-3.5, 6)
    expect(r.direction).toBe('slow')
  })

  it('reports an in-sync watch as exact', () => {
    // Watch shows :09; true time is :09.500 → midpoint estimate is exactly 0.
    const r = computeDrift(watch(10, 42, 9), T(10, 42, 9, 500), 0, 0, true)
    expect(r.offsetSec).toBeCloseTo(0, 6)
    expect(r.direction).toBe('exact')
  })

  it('handles a minute boundary without wrapping to ~60 s', () => {
    // Watch :43:00, true :42:59.000 → +1.5 s, not -58.5 s.
    const r = computeDrift(watch(10, 43, 0), T(10, 42, 59, 0), 0, 0, true)
    expect(r.offsetSec).toBeCloseTo(1.5, 6)
  })

  it('handles the midnight boundary (24h)', () => {
    // Watch 00:00:01, true 23:59:59.000 → +2.5 s, not -86397.5 s.
    const r = computeDrift(watch(0, 0, 1), T(23, 59, 59, 0), 0, 0, true)
    expect(r.offsetSec).toBeCloseTo(2.5, 6)
    expect(r.direction).toBe('fast')
  })

  it('resolves AM/PM ambiguity in 12h mode', () => {
    // Watch shows 11:00:05 (12h) but it is actually 23:00 (11 PM); true 23:00:03.
    const r = computeDrift(watch(11, 0, 5), T(23, 0, 3, 0), 0, 0, false)
    expect(r.offsetSec).toBeCloseTo(2.5, 6)
    expect(r.direction).toBe('fast')
  })

  it('handles 12 o’clock in 12h mode (12 ≡ 0)', () => {
    // Watch shows 12:00:00 (noon, 12h); true 12:00:02 → ~-1.5 s.
    const r = computeDrift(watch(12, 0, 0), T(12, 0, 2, 0), 0, 0, false)
    expect(r.offsetSec).toBeCloseTo(-1.5, 6)
    expect(r.direction).toBe('slow')
  })

  it('respects the timezone offset (watch set to local time)', () => {
    // UTC+1 (tzOffset −60): watch shows local 11:42:15 when true UTC is 10:42:09.3.
    const r = computeDrift(watch(11, 42, 15), T(10, 42, 9, 300), 0, -60, true)
    expect(r.offsetSec).toBeCloseTo(6.2, 6)
  })

  it('folds time-source uncertainty into the band', () => {
    const r = computeDrift(watch(10, 42, 15), T(10, 42, 9, 300), 120, 0, true)
    expect(r.uncertaintySec).toBeCloseTo(0.5 + 0.12, 6)
  })
})
