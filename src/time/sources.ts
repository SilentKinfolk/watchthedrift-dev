// Time sources, tried in order by TimeSync. Each performs one network request
// and returns the server's true-UTC instant plus that source's intrinsic
// resolution floor. The request must happen inside the call so TimeSync can
// time the round-trip around it.

export type SourceId = 'timeapi' | 'cloudflare' | 'date-header' | 'device'

export interface TimeSample {
  /** Server's true UTC at the moment it answered, epoch ms. */
  serverMs: number
  /** Intrinsic resolution floor of this source, ms (added to the ± band). */
  floorMs: number
}

interface TimeapiResponse {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  seconds: number
  milliSeconds: number
}

/** Primary: sub-second, CORS-enabled, no key. */
export async function fetchTimeapi(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://timeapi.io/api/time/current/zone?timeZone=Etc/UTC', {
    signal,
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`timeapi ${res.status}`)
  const j = (await res.json()) as TimeapiResponse
  const serverMs = Date.UTC(j.year, j.month - 1, j.day, j.hour, j.minute, j.seconds, j.milliSeconds)
  if (!Number.isFinite(serverMs)) throw new Error('timeapi: unparseable time')
  return { serverMs, floorMs: 1 }
}

/** Fallback: Cloudflare's trace endpoint exposes `ts=` to ~10 ms. */
export async function fetchCloudflare(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal, cache: 'no-store' })
  if (!res.ok) throw new Error(`cloudflare ${res.status}`)
  const m = (await res.text()).match(/^ts=([0-9.]+)/m)
  if (!m) throw new Error('cloudflare: no ts field')
  return { serverMs: parseFloat(m[1]) * 1000, floorMs: 10 }
}

/** Last network fallback: the Date header on a same-origin request. Same-origin
 *  means the header is readable without CORS exposure, but it is whole-second
 *  resolution — so we midpoint the second and floor the band at 500 ms. */
export async function fetchDateHeader(signal: AbortSignal): Promise<TimeSample> {
  const res = await fetch(location.href, { method: 'HEAD', signal, cache: 'no-store' })
  const date = res.headers.get('Date')
  if (!date) throw new Error('date-header: not exposed')
  const ms = Date.parse(date)
  if (!Number.isFinite(ms)) throw new Error('date-header: unparseable')
  return { serverMs: ms + 500, floorMs: 500 }
}
