import { describe, it, expect } from 'vitest'
import { offsetFromSamples, TimeSync, type RawSample, type ChainEntry } from './TimeSync'
import type { TimeSample } from './sources'

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

  it('shrinks the band vs the 1 s Date-header floor when a sub-second source is used', () => {
    // Same round-trip for a fair comparison, so the resolution floor is the only
    // difference: timeapi resolves to 1 ms, the Date header only to 500 ms.
    const rtt = 80
    const subSecond = offsetFromSamples(
      [{ serverMs: ORIGIN + 40 + 12, floorMs: 1, t0: 0, t1: rtt }],
      ORIGIN,
      'timeapi',
    )
    const dateHeader = offsetFromSamples(
      [{ serverMs: ORIGIN + 40 + 500, floorMs: 500, t0: 0, t1: rtt }],
      ORIGIN,
      'date-header',
    )
    expect(subSecond.uncertaintyMs).toBe(rtt / 2 + 1) // 41 ms — well under a second
    expect(dateHeader.uncertaintyMs).toBe(rtt / 2 + 500) // 540 ms — floored by the source
    expect(subSecond.uncertaintyMs).toBeLessThan(dateHeader.uncertaintyMs)
  })
})

describe('TimeSync.sync resilience', () => {
  // Fake sources ignore the abort signal; only the success/failure shape matters
  // for the failover and degradation behaviour under test.
  const ok =
    (serverMs: number, floorMs: number): ChainEntry['fetch'] =>
    async (): Promise<TimeSample> => ({ serverMs, floorMs })
  const fail: ChainEntry['fetch'] = async (): Promise<TimeSample> => {
    throw new Error('source down')
  }

  it('falls through to the next source when the first is down', async () => {
    const ts = new TimeSync([
      { id: 'timeapi', fetch: fail },
      { id: 'cloudflare', fetch: ok(5_000_000, 10) },
    ])
    const off = await ts.sync({ samples: 3, timeoutMs: 50 })
    expect(off.source).toBe('cloudflare')
    expect(off.degraded).toBe(false)
  })

  it('falls back to the degraded device clock when every source fails', async () => {
    const ts = new TimeSync([
      { id: 'timeapi', fetch: fail },
      { id: 'date-header', fetch: fail },
    ])
    const off = await ts.sync({ samples: 2, timeoutMs: 50 })
    expect(off.source).toBe('device')
    expect(off.degraded).toBe(true)
    expect(off.uncertaintyMs).toBe(Number.POSITIVE_INFINITY)
    // Even degraded, trueUtcAt resolves so the UI can show a (flagged) answer.
    expect(ts.trueUtcAt(performance.now()).uncertaintyMs).toBe(Number.POSITIVE_INFINITY)
  })

  it('locks onto a source after one good sample, despite later failures', async () => {
    let calls = 0
    const flaky: ChainEntry['fetch'] = async (): Promise<TimeSample> => {
      if (++calls === 1) return { serverMs: 7_000_000, floorMs: 1 }
      throw new Error('flaky')
    }
    const ts = new TimeSync([{ id: 'timeapi', fetch: flaky }])
    const off = await ts.sync({ samples: 4, timeoutMs: 50 })
    expect(off.source).toBe('timeapi')
    expect(off.degraded).toBe(false)
  })
})
