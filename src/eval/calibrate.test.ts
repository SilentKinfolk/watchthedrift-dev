import { describe, it, expect } from 'vitest'
import { fitCalibration, applyCalibration, chooseAbstainThreshold, type CalSample } from './calibrate'

/** A separable-ish calibration set: high raw confidence → mostly correct, low → wrong. */
const samples: CalSample[] = [
  { rawConf: 0.95, correct: true },
  { rawConf: 0.9, correct: true },
  { rawConf: 0.85, correct: true },
  { rawConf: 0.8, correct: true },
  { rawConf: 0.55, correct: false },
  { rawConf: 0.5, correct: false },
  { rawConf: 0.45, correct: false },
  { rawConf: 0.4, correct: false },
]

describe('fitCalibration + applyCalibration', () => {
  it('maps raw confidence to a probability in [0,1], monotonically increasing', () => {
    const cal = fitCalibration(samples)
    const lo = applyCalibration(cal, 0.4)
    const hi = applyCalibration(cal, 0.95)
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(1)
    expect(hi).toBeGreaterThan(lo) // positive slope learned
  })

  it('separates correct from wrong: correct reads calibrate higher than wrong ones', () => {
    const cal = fitCalibration(samples)
    const meanCorrect = samples.filter((s) => s.correct).reduce((a, s) => a + applyCalibration(cal, s.rawConf), 0) / 4
    const meanWrong = samples.filter((s) => !s.correct).reduce((a, s) => a + applyCalibration(cal, s.rawConf), 0) / 4
    expect(meanCorrect).toBeGreaterThan(meanWrong)
  })

  it('is deterministic (same samples → same fit)', () => {
    expect(fitCalibration(samples)).toEqual(fitCalibration(samples))
  })

  it('returns identity-ish for an empty set', () => {
    expect(fitCalibration([])).toEqual({ a: 1, b: 0 })
  })
})

describe('chooseAbstainThreshold', () => {
  it('picks a threshold that holds the confident-wrong ceiling', () => {
    const cal = fitCalibration(samples)
    const res = chooseAbstainThreshold(samples, cal, 0.005)
    expect(res.lockedWrongRate).toBeLessThanOrEqual(0.005)
    // It should still lock the clearly-correct high-confidence reads.
    expect(res.locked).toBeGreaterThanOrEqual(4)
  })

  it('abstains everything when even the top read is wrong', () => {
    const allWrong: CalSample[] = [
      { rawConf: 0.9, correct: false },
      { rawConf: 0.5, correct: false },
    ]
    const cal = fitCalibration(allWrong)
    const res = chooseAbstainThreshold(allWrong, cal, 0.005)
    expect(res.locked).toBe(0)
    expect(res.threshold).toBeGreaterThan(applyCalibration(cal, 0.9))
  })

  it('locks everything when a loose ceiling tolerates the wrong rate', () => {
    const cal = fitCalibration(samples)
    const res = chooseAbstainThreshold(samples, cal, 1) // ceiling 100% → lock all
    expect(res.locked).toBe(samples.length)
  })
})
