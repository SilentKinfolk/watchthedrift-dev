import { describe, it, expect } from 'vitest'
import { renderServiceWorker, cacheName, uniqueUrls } from './service-worker.mjs'

const BASE = '/watchthedrift-dev/'
const URLS = [
  BASE,
  `${BASE}index.html`,
  `${BASE}assets/index-ABC123.js`,
  `${BASE}assets/corner-v1-DEADBEEF.bin`,
  `${BASE}assets/corner-v1-C0FFEE42.json`,
  `${BASE}manifest.webmanifest`,
]

describe('renderServiceWorker', () => {
  const src = renderServiceWorker(URLS, 'wtd-abc123def456', BASE)

  it('emits SYNTACTICALLY VALID JS — the guard against a silent brace mismatch', () => {
    // The SW throwing at evaluation goes redundant in the browser (no offline, no
    // error surfaced). `new Function` parses without executing, so `self`/`caches`
    // need not exist — it just proves the source parses. This is the test that would
    // have caught the original respondWith paren/brace mismatch.
    expect(() => new Function(src)).not.toThrow()
  })

  it('bakes in the cache name, shell, and every precache URL', () => {
    expect(src).toContain("const CACHE = \"wtd-abc123def456\"")
    expect(src).toContain(`const SHELL = "${BASE}index.html"`)
    for (const u of URLS) expect(src).toContain(JSON.stringify(u))
  })

  it('leaves cross-origin + non-GET + no-store requests untouched (the honest offline boundary)', () => {
    // These are what make the time sources fail honestly offline rather than serve a
    // stale cached time. Assert the guards are present.
    expect(src).toContain("req.method !== 'GET'")
    expect(src).toContain('self.location.origin')
    expect(src).toContain("req.cache === 'no-store'")
  })

  it('precaches the corner model so reading works offline', () => {
    expect(src).toContain(`${BASE}assets/corner-v1-DEADBEEF.bin`)
    expect(src).toContain(`${BASE}assets/corner-v1-C0FFEE42.json`)
  })
})

describe('cacheName', () => {
  it('is stable for the same URL set (order-independent)', () => {
    expect(cacheName(URLS)).toBe(cacheName([...URLS].reverse()))
  })

  it('rotates when an asset hash changes — atomic app+model versioning', () => {
    const bumped = URLS.map((u) => u.replace('corner-v1-DEADBEEF', 'corner-v1-99999999'))
    expect(cacheName(bumped)).not.toBe(cacheName(URLS))
  })

  it('starts with the wtd- prefix the activate cleanup keys off', () => {
    expect(cacheName(URLS)).toMatch(/^wtd-[0-9a-f]{12}$/)
  })
})

describe('uniqueUrls', () => {
  it('dedupes while preserving first-seen order', () => {
    expect(uniqueUrls(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })
})
