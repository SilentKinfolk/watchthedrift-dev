import { describe, it, expect } from 'vitest'
import { feedbackFor, feedbackMessage, type Feedback } from './feedback'

describe('feedbackFor', () => {
  it('abstains on too-dark before anything else, even with a read', () => {
    // Defensive: we never attempt a read when too-dark, but the priority must hold.
    expect(feedbackFor({ legibility: 'too-dark', gotRead: true })).toBe('too-dark')
  })

  it('says "found" the moment a read lands, even under glare', () => {
    expect(feedbackFor({ legibility: 'glare', gotRead: true })).toBe('found')
    expect(feedbackFor({ legibility: 'ok', gotRead: true })).toBe('found')
  })

  it('surfaces glare only when nothing read', () => {
    expect(feedbackFor({ legibility: 'glare', gotRead: false })).toBe('glare')
  })

  it('falls back to the steady searching nudge', () => {
    expect(feedbackFor({ legibility: 'ok', gotRead: false })).toBe('searching')
  })
})

describe('feedbackMessage', () => {
  const states: Feedback[] = ['too-dark', 'glare', 'found', 'searching', 'implausible']

  it('has a non-empty line for every state', () => {
    for (const s of states) expect(feedbackMessage(s).length).toBeGreaterThan(0)
  })

  it('tells the user to find light when too dark, never to retry blindly', () => {
    expect(feedbackMessage('too-dark').toLowerCase()).toContain('light')
  })

  it('names glare so the user knows what to fix', () => {
    expect(feedbackMessage('glare').toLowerCase()).toContain('glare')
  })

  it('signals a rejected misread without ever implying a number', () => {
    const m = feedbackMessage('implausible')
    expect(m.length).toBeGreaterThan(0)
    expect(m).not.toMatch(/\d/) // never shows a value for a read we threw away
  })
})
