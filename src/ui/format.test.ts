import { describe, it, expect } from 'vitest'
import { formatAnswer, formatDetail, formatBand, applyResult, type ResultSlots } from './format'
import type { DriftResult } from '../drift/Drift'

const d = (offsetSec: number, direction: DriftResult['direction'], uncertaintySec = 0.5): DriftResult => ({
  offsetSec,
  uncertaintySec,
  direction,
})

describe('formatAnswer', () => {
  it('signs a fast watch with a plus', () => {
    expect(formatAnswer(d(6.2, 'fast'))).toBe('+6 s')
  })
  it('signs a slow watch with a minus', () => {
    expect(formatAnswer(d(-3.4, 'slow'))).toBe('−3 s')
  })
  it('shows a bare "0 s" when on the nearest second', () => {
    expect(formatAnswer(d(0.2, 'exact'))).toBe('0 s')
  })
})

describe('formatDetail', () => {
  it('uses the singular for one second', () => {
    expect(formatDetail(d(1.2, 'fast'))).toBe('Your watch is 1 second fast.')
  })
  it('uses the plural and the slow wording', () => {
    expect(formatDetail(d(-4.1, 'slow'))).toBe('Your watch is 4 seconds slow.')
  })
  it('says spot on when exact', () => {
    expect(formatDetail(d(0.2, 'exact'))).toBe('Spot on — no drift to the nearest second.')
  })
})

describe('formatBand', () => {
  it('renders a tight sub-second-source band to one decimal', () => {
    // 0.5 s quantisation ⊕ ~0.02 s time source → "± 0.5 s".
    expect(formatBand(d(6, 'fast', 0.52))).toBe('± 0.5 s')
  })
  it('renders the looser Date-header band as visibly wider', () => {
    // 0.5 s quantisation ⊕ ~0.5 s Date-header floor → "± 1.0 s".
    expect(formatBand(d(6, 'fast', 1.02))).toBe('± 1.0 s')
  })
  it('returns null when the band is unbounded (degraded device clock)', () => {
    expect(formatBand(d(6, 'fast', Number.POSITIVE_INFINITY))).toBeNull()
  })
})

describe('applyResult', () => {
  const slots = (): ResultSlots => ({
    answer: { textContent: null },
    band: { textContent: null, hidden: true },
    sub: { textContent: null },
  })

  it('shows the answer paired with a visible ± band', () => {
    const els = slots()
    applyResult(els, d(6.2, 'fast', 0.52))
    expect(els.answer.textContent).toBe('+6 s')
    expect(els.band.textContent).toBe('± 0.5 s')
    expect(els.band.hidden).toBe(false)
    expect(els.sub.textContent).toBe('Your watch is 6 seconds fast.')
  })

  it('still shows the answer but hides the band when the sync is degraded', () => {
    const els = slots()
    applyResult(els, d(6.2, 'fast', Number.POSITIVE_INFINITY))
    expect(els.answer.textContent).toBe('+6 s')
    expect(els.band.textContent).toBe('')
    expect(els.band.hidden).toBe(true)
    expect(els.sub.textContent).toBe('Your watch is 6 seconds fast.')
  })
})
