import { describe, it, expect } from 'vitest'
import {
  cornerError,
  aggregateCornerErrors,
  evaluateCornerGate,
  type CornerScore,
} from './cornerError'
import type { Corners } from './label'

const square: Corners = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

describe('cornerError', () => {
  it('is 0 for an exact prediction', () => {
    expect(cornerError(square, square)).toBe(0)
  })

  it('is the mean per-corner displacement over the LCD diagonal', () => {
    // Shift every corner by +0.1 in x → displacement 0.1 each; diagonal = √2.
    const shifted: Corners = square.map((p) => ({ x: p.x + 0.1, y: p.y })) as unknown as Corners
    expect(cornerError(shifted, square)).toBeCloseTo(0.1 / Math.SQRT2, 6)
  })

  it('returns NaN for a degenerate (zero-diagonal) truth', () => {
    const degen: Corners = [
      { x: 0.5, y: 0.5 },
      { x: 0.6, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.4, y: 0.5 },
    ]
    expect(Number.isNaN(cornerError(square, degen))).toBe(true)
  })
})

describe('aggregateCornerErrors', () => {
  it('groups by stratum, counts detections, and excludes abstains from the mean', () => {
    const items: CornerScore[] = [
      { stratum: 'easy', error: 0.04 },
      { stratum: 'easy', error: 0.06 },
      { stratum: 'moderate', error: 0.2 },
      { stratum: 'moderate', error: null }, // abstained → detected excludes it
    ]
    const rep = aggregateCornerErrors(items, ['easy', 'moderate', 'hard'])
    const easy = rep.byStratum.find((g) => g.group === 'easy')!
    expect(easy.total).toBe(2)
    expect(easy.detected).toBe(2)
    expect(easy.meanError).toBeCloseTo(0.05, 6)
    const mod = rep.byStratum.find((g) => g.group === 'moderate')!
    expect(mod.total).toBe(2)
    expect(mod.detected).toBe(1) // one abstain
    expect(mod.meanError).toBeCloseTo(0.2, 6)
    expect(rep.overall.total).toBe(4)
    expect(rep.overall.detected).toBe(3)
  })
})

describe('evaluateCornerGate', () => {
  it('is advisory below the sample floor (never fails)', () => {
    const rep = aggregateCornerErrors(
      [
        { stratum: 'easy', error: 0.5 },
        { stratum: 'easy', error: 0.5 },
      ],
      ['easy'],
    )
    const gate = evaluateCornerGate(rep.overall, { maxMeanError: 0.08, minSamples: 30 })
    expect(gate.advisory).toBe(true)
    expect(gate.pass).toBe(true) // tolerant while tiny even though 0.5 ≫ 0.08
  })

  it('enforces once the detected count meets the floor', () => {
    const good = aggregateCornerErrors(
      Array.from({ length: 30 }, () => ({ stratum: 'easy', error: 0.05 })),
      ['easy'],
    )
    const bad = aggregateCornerErrors(
      Array.from({ length: 30 }, () => ({ stratum: 'easy', error: 0.2 })),
      ['easy'],
    )
    expect(evaluateCornerGate(good.overall, { maxMeanError: 0.08, minSamples: 30 })).toMatchObject({
      advisory: false,
      pass: true,
    })
    expect(evaluateCornerGate(bad.overall, { maxMeanError: 0.08, minSamples: 30 })).toMatchObject({
      advisory: false,
      pass: false,
    })
  })
})
