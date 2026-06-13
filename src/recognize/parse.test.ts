import { describe, it, expect } from 'vitest'
import { parseTime } from './parse'

describe('parseTime', () => {
  it('parses a full colon-separated time', () => {
    expect(parseTime('10:42:15', true)).toEqual({ hh: 10, mm: 42, ss: 15 })
  })

  it('parses when the seconds colon is missing', () => {
    expect(parseTime('10:4215', true)).toEqual({ hh: 10, mm: 42, ss: 15 })
  })

  it('parses a bare 6-digit run', () => {
    expect(parseTime('104215', true)).toEqual({ hh: 10, mm: 42, ss: 15 })
  })

  it('parses a 5-digit run as H MM SS (12h)', () => {
    expect(parseTime('90530', false)).toEqual({ hh: 9, mm: 5, ss: 30 })
  })

  it('strips stray non-digit noise', () => {
    expect(parseTime(' 23:59:59 \n', true)).toEqual({ hh: 23, mm: 59, ss: 59 })
  })

  it('rejects impossible minutes/seconds', () => {
    expect(parseTime('10:75:00', true)).toBeNull()
    expect(parseTime('10:00:88', true)).toBeNull()
  })

  it('rejects out-of-range hours per mode', () => {
    expect(parseTime('25:00:00', true)).toBeNull() // 24h: hh > 23
    expect(parseTime('13:00:00', false)).toBeNull() // 12h: hh > 12
  })

  it('returns null for unreadable text', () => {
    expect(parseTime('', true)).toBeNull()
    expect(parseTime('::', true)).toBeNull()
    expect(parseTime('1234', true)).toBeNull()
  })
})
