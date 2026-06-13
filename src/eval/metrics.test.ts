import { describe, it, expect } from 'vitest'
import {
  classify,
  aggregate,
  ratesOf,
  evaluateGate,
  timesEqual,
  type ScoredItem,
} from './metrics'

const T = (hh: number, mm: number, ss: number) => ({ hh, mm, ss })

describe('classify — the three honest outcomes', () => {
  const expected = T(19, 45, 8)

  it('correct when the reading equals ground truth', () => {
    expect(classify({ reading: T(19, 45, 8), confidence: 0.7 }, expected)).toBe('correct')
  })

  it('abstain when the pipeline returned no reading (fail-to-retake)', () => {
    expect(classify({ reading: null, confidence: null }, expected)).toBe('abstain')
  })

  it('wrong when it locked a confident answer that is off (the cardinal sin)', () => {
    // The real baseline: faint-segment 19:45:08 read as 19:45:09.
    expect(classify({ reading: T(19, 45, 9), confidence: 0.71 }, expected)).toBe('wrong')
  })

  it('treats a below-threshold reading as an honest abstain, not wrong', () => {
    const wrongRead = { reading: T(19, 45, 9), confidence: 0.3 }
    expect(classify(wrongRead, expected)).toBe('wrong') // no threshold → it locks
    expect(classify(wrongRead, expected, { abstainBelow: 0.5 })).toBe('abstain') // gated out
  })

  it('keeps a correct read above the abstain threshold', () => {
    expect(classify({ reading: T(19, 45, 8), confidence: 0.71 }, expected, { abstainBelow: 0.5 })).toBe(
      'correct',
    )
  })
})

describe('timesEqual', () => {
  it('compares all three fields and rejects nulls', () => {
    expect(timesEqual(T(1, 2, 3), T(1, 2, 3))).toBe(true)
    expect(timesEqual(T(1, 2, 3), T(1, 2, 4))).toBe(false)
    expect(timesEqual(null, T(1, 2, 3))).toBe(false)
    expect(timesEqual(T(1, 2, 3), null)).toBe(false)
  })
})

describe('ratesOf', () => {
  it('divides by total', () => {
    expect(ratesOf({ total: 4, correct: 2, abstain: 1, wrong: 1 })).toEqual({
      correct: 0.5,
      abstain: 0.25,
      wrong: 0.25,
    })
  })

  it('is all-zero for an empty group (no divide-by-zero)', () => {
    expect(ratesOf({ total: 0, correct: 0, abstain: 0, wrong: 0 })).toEqual({
      correct: 0,
      abstain: 0,
      wrong: 0,
    })
  })
})

describe('aggregate — per-stratum + overall, the recorded baseline shape', () => {
  // Exactly the current 3 labelled fixtures.
  const items: ScoredItem[] = [
    { stratum: 'easy', outcome: 'correct' }, // clean 15:53:08
    { stratum: 'hard', outcome: 'wrong' }, // faint 19:45:08 → :09
    { stratum: 'hard', outcome: 'abstain' }, // small-seconds 5051
  ]

  it('rolls strata up and pools an overall row', () => {
    const r = aggregate(items, ['easy', 'moderate', 'hard'])
    expect(r.byStratum.map((g) => g.group)).toEqual(['easy', 'hard']) // moderate has 0 items → omitted
    const hard = r.byStratum.find((g) => g.group === 'hard')!
    expect(hard).toMatchObject({ total: 2, correct: 0, abstain: 1, wrong: 1 })
    expect(hard.rates.wrong).toBe(0.5)
    expect(r.overall).toMatchObject({ total: 3, correct: 1, abstain: 1, wrong: 1 })
    expect(r.overall.rates.wrong).toBeCloseTo(1 / 3)
  })

  it('honours group order and appends unknown strata after known ones', () => {
    const r = aggregate(
      [
        { stratum: 'unstratified', outcome: 'correct' },
        { stratum: 'easy', outcome: 'correct' },
      ],
      ['easy', 'moderate', 'hard'],
    )
    expect(r.byStratum.map((g) => g.group)).toEqual(['easy', 'unstratified'])
  })

  it('handles the empty set', () => {
    const r = aggregate([])
    expect(r.byStratum).toEqual([])
    expect(r.overall).toMatchObject({ total: 0, correct: 0, abstain: 0, wrong: 0 })
  })
})

describe('evaluateGate — tolerant while tiny, enforces once there are enough samples', () => {
  it('is advisory (and passes) on the tiny current set even at 33% wrong', () => {
    const g = evaluateGate({ total: 3, correct: 1, abstain: 1, wrong: 1 })
    expect(g.advisory).toBe(true)
    expect(g.pass).toBe(true) // tolerant: 3 < 200 min samples
    expect(g.wrongRate).toBeCloseTo(1 / 3)
    expect(g.reason).toMatch(/advisory/)
  })

  it('FAILS once there are enough samples and the ceiling is exceeded', () => {
    // 2 wrong / 200 = 1.0% > 0.5% ceiling.
    const g = evaluateGate({ total: 200, correct: 180, abstain: 18, wrong: 2 })
    expect(g.advisory).toBe(false)
    expect(g.pass).toBe(false)
    expect(g.reason).toMatch(/FAIL/)
  })

  it('passes at exactly the ceiling (≤ is inclusive)', () => {
    // 1 wrong / 200 = 0.5% == ceiling.
    const g = evaluateGate({ total: 200, correct: 190, abstain: 9, wrong: 1 })
    expect(g.advisory).toBe(false)
    expect(g.pass).toBe(true)
  })

  it('passes with many samples and zero confidently-wrong reads', () => {
    const g = evaluateGate({ total: 500, correct: 460, abstain: 40, wrong: 0 })
    expect(g.pass).toBe(true)
    expect(g.advisory).toBe(false)
    expect(g.wrongRate).toBe(0)
  })

  it('respects an overridden ceiling and sample floor', () => {
    const g = evaluateGate({ total: 50, correct: 40, abstain: 9, wrong: 1 }, { minSamples: 10, maxWrongRate: 0.01 })
    expect(g.advisory).toBe(false) // 50 ≥ 10
    expect(g.pass).toBe(false) // 2% > 1%
  })
})
