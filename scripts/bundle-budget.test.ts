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

  it('excludes public/ passthrough not declared eager (e.g. the unwired Tesseract data)', () => {
    expect(isFirstLoad('traineddata/digits.traineddata')).toBe(false)
    expect(isFirstLoad('models/corner-v1.onnx')).toBe(false)
  })

  it('counts a runtime-fetched asset once it is declared eager', () => {
    expect(isFirstLoad('models/corner-v1.onnx', ['models/**'])).toBe(true)
    expect(isFirstLoad('models/corner-v1.onnx', ['models/corner-v1.onnx'])).toBe(true)
    // glob is anchored: a sibling dir is not swept in by accident
    expect(isFirstLoad('other/corner-v1.onnx', ['models/**'])).toBe(false)
  })
})

describe('globToRegExp', () => {
  it('treats * as intra-segment and ** as cross-segment', () => {
    expect(globToRegExp('models/*.onnx').test('models/a.onnx')).toBe(true)
    expect(globToRegExp('models/*.onnx').test('models/sub/a.onnx')).toBe(false)
    expect(globToRegExp('models/**').test('models/sub/a.onnx')).toBe(true)
  })

  it('anchors fully (no partial matches)', () => {
    expect(globToRegExp('models/**').test('x/models/a.onnx')).toBe(false)
  })
})

describe('computeBudget', () => {
  // The current-shape bundle: app + the unwired ~1.4 MB Tesseract passthrough.
  const currentBundle = [
    { rel: 'index.html', bytes: 2105 },
    { rel: 'assets/index-CPWZAPQQ.js', bytes: 20823 },
    { rel: 'assets/index-KN4EMpIF.css', bytes: 3093 },
    { rel: 'traineddata/digits.traineddata', bytes: 1442809 },
  ]

  it('counts only the app, not the lazy passthrough, and passes well under budget', () => {
    const r = computeBudget(currentBundle)
    expect(r.firstLoadTotal).toBe(2105 + 20823 + 3093) // 26021 — the traineddata excluded
    expect(r.budgetBytes).toBe(BUDGET_BYTES)
    expect(r.withinBudget).toBe(true)
    expect(r.over).toBeLessThan(0)
    expect(r.firstLoad.map((f) => f.rel)).not.toContain('traineddata/digits.traineddata')
  })

  it('flags the large uncounted passthrough so a forgotten eager asset cannot hide', () => {
    const r = computeBudget(currentBundle)
    const trained = r.uncounted.find((f) => f.rel === 'traineddata/digits.traineddata')
    expect(trained?.warn).toBe(true) // 1.4 MB ≥ 256 KiB warn threshold
  })

  it('does not flag small uncounted files', () => {
    const r = computeBudget([{ rel: 'robots.txt', bytes: 64 }])
    expect(r.uncounted[0].warn).toBe(false)
  })

  it('fails when the first-load payload exceeds the budget', () => {
    const r = computeBudget(
      [
        { rel: 'index.html', bytes: 2105 },
        { rel: 'assets/model-bundle.js', bytes: 6 * 1024 * 1024 },
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
      { rel: 'models/corner-v1.onnx', bytes: 1_200_000 },
    ]
    const without = computeBudget(files)
    const withModel = computeBudget(files, { eagerAssets: ['models/**'] })
    expect(without.firstLoadTotal).toBe(2105 + 20000) // model excluded until declared
    expect(withModel.firstLoadTotal).toBe(2105 + 20000 + 1_200_000) // now counted
    expect(withModel.uncounted).toHaveLength(0)
  })
})
