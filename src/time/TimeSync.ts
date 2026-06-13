// NTP-style time reference for the browser. We can't speak real NTP (UDP), so
// we estimate the offset between true UTC and the local monotonic clock
// (performance.timeOrigin + performance.now()) using round-trip-compensated
// HTTPS samples and NTP's trick of trusting the minimum-RTT sample.

import {
  fetchTimeapi,
  fetchCloudflare,
  fetchDateHeader,
  type TimeSample,
  type SourceId,
} from './sources'

export interface TimeOffset {
  /** trueUtcMs = performance.timeOrigin + perfNow + skewMs. */
  skewMs: number
  /** Half-width of the confidence band, ms. */
  uncertaintyMs: number
  source: SourceId
  /** True when we fell back to the unverified device clock. */
  degraded: boolean
}

export interface RawSample {
  serverMs: number
  floorMs: number
  /** performance.now() before the request. */
  t0: number
  /** performance.now() after the response was parsed. */
  t1: number
}

/** Pick the minimum-RTT sample and derive the clock skew + uncertainty. */
export function offsetFromSamples(
  samples: RawSample[],
  timeOrigin: number,
  source: SourceId,
): TimeOffset {
  let best: RawSample | undefined
  for (const s of samples) {
    if (!best || s.t1 - s.t0 < best.t1 - best.t0) best = s
  }
  if (!best) throw new Error('offsetFromSamples: no samples')
  const rtt = best.t1 - best.t0
  const localMidMs = timeOrigin + (best.t0 + best.t1) / 2
  return {
    skewMs: best.serverMs - localMidMs,
    uncertaintyMs: rtt / 2 + best.floorMs,
    source,
    degraded: false,
  }
}

export interface ChainEntry {
  id: SourceId
  fetch: (signal: AbortSignal) => Promise<TimeSample>
}

const CHAIN: ChainEntry[] = [
  { id: 'timeapi', fetch: fetchTimeapi },
  { id: 'cloudflare', fetch: fetchCloudflare },
  { id: 'date-header', fetch: fetchDateHeader },
]

export interface SyncOptions {
  samples?: number
  timeoutMs?: number
}

export class TimeSync {
  private offset: TimeOffset | null = null
  private readonly chain: ChainEntry[]

  /** The source chain defaults to the live network sources, tried in order;
   *  tests inject fakes to drive failover and degradation deterministically. */
  constructor(chain: ChainEntry[] = CHAIN) {
    this.chain = chain
  }

  /** Sample the source chain and store the best offset. Always resolves: if
   *  every network source fails it falls back to the device clock (degraded). */
  async sync(opts: SyncOptions = {}): Promise<TimeOffset> {
    const samples = opts.samples ?? 5
    const timeoutMs = opts.timeoutMs ?? 3000

    for (const src of this.chain) {
      const raw: RawSample[] = []
      let failures = 0
      for (let i = 0; i < samples; i++) {
        try {
          const t0 = performance.now()
          const s = await src.fetch(AbortSignal.timeout(timeoutMs))
          const t1 = performance.now()
          raw.push({ serverMs: s.serverMs, floorMs: s.floorMs, t0, t1 })
        } catch {
          // Skip this sample. Bail early on a clearly dead source.
          if (++failures >= 2 && raw.length === 0) break
        }
      }
      if (raw.length > 0) {
        this.offset = offsetFromSamples(raw, performance.timeOrigin, src.id)
        return this.offset
      }
    }

    this.offset = {
      skewMs: 0,
      uncertaintyMs: Number.POSITIVE_INFINITY,
      source: 'device',
      degraded: true,
    }
    return this.offset
  }

  get current(): TimeOffset | null {
    return this.offset
  }

  /** Map a capture-instant performance.now() value to true UTC + its band. */
  trueUtcAt(perfNow: number): { epochMs: number; uncertaintyMs: number } {
    if (!this.offset) throw new Error('TimeSync: call sync() first')
    return {
      epochMs: performance.timeOrigin + perfNow + this.offset.skewMs,
      uncertaintyMs: this.offset.uncertaintyMs,
    }
  }
}
