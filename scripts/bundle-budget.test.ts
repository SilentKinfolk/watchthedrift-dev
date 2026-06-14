import { describe, it, expect } from 'vitest'
import { isFirstLoad, computeBudget, globToRegExp, BUDGET_BYTES } from './bundle-budget.mjs'

describe('isFirstLoad', () => {
  it('counts the entry document and the bundled app', () => {
    expect(isFirstLoad('index.html')).toBe(true)
    expect(isFirstLoad('assets/index-CPWZAPQQ.js')).toBe(true)
    expect(isFirstLoad('assets/index-KN4EMpIF.css')).toBe(true)
  })

  it('excludes sourcemaps (dev-only, never fetched by users)', () => {
    expect(isFirstLoad('assets/index-CPWZAPQQ.js.map')).toBe(false)
  })

  it('counts the corner model as a hashed assets/ asset (issue #13: ?url, not passthrough)', () => {
    // Since #13 the model is imported with `?url`, so Vite emits it into assets/ with
    // a content hash — counted by the assets/ rule for free, no eager declaration.
    expect(isFirstLoad('assets/corner-v1-DEADBEEF.bin')).toBe(true)
    expect(isFirstLoad('assets/corner-v1-DEADBEEF.json')).toBe(true)
  })

  it('excludes public/ passthrough (sw.js, manifest, icons) — not fetched at first paint', () => {
    // The service worker, manifest, and PWA icons land at the dist root and are
    // fetched after first paint (on SW install), so they are not first-load.
    expect(isFirstLoad('sw.js')).toBe(false)
    expect(isFirstLoad('manifest.webmanifest')).toBe(false)
    expect(isFirstLoad('icon-512.png')).toBe(false)
  })

  it('honours an explicit eager override for a future runtime-fetched passthrough', () => {
    expect(isFirstLoad('weights/corner.bin', ['weights/**'])).toBe(true)
    expect(isFirstLoad('weights/corner.bin', [])).toBe(false) // default: nothing eager
  })
})

describe('globToRegExp', () => {
  it('treats * as intra-segment and ** as cross-segment', () => {
    expect(globToRegExp('models/*.bin').test('models/a.bin')).toBe(true)
    expect(globToRegExp('models/*.bin').test('models/sub/a.bin')).toBe(false)
    expect(globToRegExp('models/**').test('models/sub/a.bin')).toBe(true)
  })

  it('anchors fully (no partial matches)', () => {
    expect(globToRegExp('models/**').test('x/models/a.bin')).toBe(false)
  })
})

describe('computeBudget', () => {
  // The current-shape bundle (issue #13): the app + the trained ~144 KB corner model,
  // now a HASHED assets/ asset (?url) rather than a public/models/ passthrough — so it
  // is counted by the assets/ rule, not an eager declaration.
  const currentBundle = [
    { rel: 'index.html', bytes: 2105 },
    { rel: 'assets/index-CPWZAPQQ.js', bytes: 29815 },
    { rel: 'assets/index-KN4EMpIF.css', bytes: 3093 },
    { rel: 'assets/corner-v1-DEADBEEF.bin', bytes: 147_272 },
    { rel: 'assets/corner-v1-C0FFEE42.json', bytes: 3313 },
    // PWA passthrough at the dist root — present in dist/ but fetched after first paint.
    { rel: 'sw.js', bytes: 1800 },
    { rel: 'manifest.webmanifest', bytes: 420 },
    { rel: 'icon-512.png', bytes: 4000 },
  ]

  it('counts the app + the hashed model, and excludes PWA passthrough', () => {
    const r = computeBudget(currentBundle)
    expect(r.firstLoadTotal).toBe(2105 + 29815 + 3093 + 147_272 + 3313)
    expect(r.budgetBytes).toBe(BUDGET_BYTES)
    expect(r.withinBudget).toBe(true)
    expect(r.over).toBeLessThan(0)
    expect(r.firstLoad.map((f) => f.rel)).toContain('assets/corner-v1-DEADBEEF.bin')
    expect(r.uncounted.map((f) => f.rel).sort()).toEqual(['icon-512.png', 'manifest.webmanifest', 'sw.js'])
  })

  it('flags a large uncounted passthrough so a forgotten eager asset cannot hide', () => {
    const r = computeBudget([
      { rel: 'index.html', bytes: 2105 },
      { rel: 'media/poster.png', bytes: 1_400_000 }, // passthrough, undeclared → uncounted
    ])
    const poster = r.uncounted.find((f) => f.rel === 'media/poster.png')
    expect(poster?.warn).toBe(true) // ≥ 256 KiB warn threshold
  })

  it('does not flag small uncounted files', () => {
    const r = computeBudget([{ rel: 'robots.txt', bytes: 64 }])
    expect(r.uncounted[0].warn).toBe(false)
  })

  it('fails when the first-load payload exceeds the budget', () => {
    const r = computeBudget(
      [
        { rel: 'index.html', bytes: 2105 },
        // a hashed model asset (?url → assets/) that blows the gate
        { rel: 'assets/oversized-DEADBEEF.bin', bytes: 6 * 1024 * 1024 },
      ],
      { budgetBytes: 5 * 1024 * 1024 },
    )
    expect(r.withinBudget).toBe(false)
    expect(r.over).toBeGreaterThan(0)
  })

  it('counts a declared eager runtime model toward first-load', () => {
    const files = [
      { rel: 'index.html', bytes: 2105 },
      { rel: 'assets/index.js', bytes: 20000 },
      { rel: 'weights/corner.bin', bytes: 1_200_000 },
    ]
    const without = computeBudget(files)
    const withModel = computeBudget(files, { eagerAssets: ['weights/**'] })
    expect(without.firstLoadTotal).toBe(2105 + 20000) // excluded until declared
    expect(withModel.firstLoadTotal).toBe(2105 + 20000 + 1_200_000) // now counted
    expect(withModel.uncounted).toHaveLength(0)
  })
})
