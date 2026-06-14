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

  it('counts the corner model + manifest under models/ (eager by default, issue #9)', () => {
    // KernelCornerSource fetches both before the first reading, so they count.
    expect(isFirstLoad('models/corner-v1.bin')).toBe(true)
    expect(isFirstLoad('models/corner-v1.json')).toBe(true)
  })

  it('excludes other public/ passthrough not under models/', () => {
    expect(isFirstLoad('robots.txt')).toBe(false)
    expect(isFirstLoad('icons/app.svg')).toBe(false)
  })

  it('honours an explicit eager override', () => {
    expect(isFirstLoad('weights/corner.bin', ['weights/**'])).toBe(true)
    expect(isFirstLoad('weights/corner.bin', ['models/**'])).toBe(false) // anchored, no accident
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
  // The current-shape bundle (issue #11): the app + the trained ~144 KB corner model
  // asset (the int8 corner-v1 weights, far under the per-model allowance).
  const currentBundle = [
    { rel: 'index.html', bytes: 2105 },
    { rel: 'assets/index-CPWZAPQQ.js', bytes: 29815 },
    { rel: 'assets/index-KN4EMpIF.css', bytes: 3093 },
    { rel: 'models/corner-v1.bin', bytes: 147_272 },
    { rel: 'models/corner-v1.json', bytes: 3313 },
  ]

  it('counts the app + the eager model, and passes within budget', () => {
    const r = computeBudget(currentBundle)
    expect(r.firstLoadTotal).toBe(2105 + 29815 + 3093 + 147_272 + 3313)
    expect(r.budgetBytes).toBe(BUDGET_BYTES)
    expect(r.withinBudget).toBe(true)
    expect(r.over).toBeLessThan(0)
    expect(r.firstLoad.map((f) => f.rel)).toContain('models/corner-v1.bin')
    expect(r.uncounted).toHaveLength(0)
  })

  it('flags a large uncounted passthrough so a forgotten eager asset cannot hide', () => {
    const r = computeBudget([
      { rel: 'index.html', bytes: 2105 },
      { rel: 'media/poster.png', bytes: 1_400_000 }, // not under models/ → uncounted
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
        { rel: 'models/oversized.bin', bytes: 6 * 1024 * 1024 }, // a model that blows the gate
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
