import { describe, it, expect } from 'vitest'
import {
  parseCornerLabel,
  isValidTime,
  timeFromFilename,
  is24hFromFilename,
  sidecarPathFor,
  resolveLabel,
  STRATA,
  type CornerLabel,
} from './label'

describe('isValidTime', () => {
  it('accepts in-range integer times', () => {
    expect(isValidTime({ hh: 0, mm: 0, ss: 0 })).toBe(true)
    expect(isValidTime({ hh: 23, mm: 59, ss: 59 })).toBe(true)
  })
  it('rejects out-of-range, non-integer, or malformed', () => {
    expect(isValidTime({ hh: 24, mm: 0, ss: 0 })).toBe(false)
    expect(isValidTime({ hh: 12, mm: 60, ss: 0 })).toBe(false)
    expect(isValidTime({ hh: 12, mm: 0, ss: 1.5 })).toBe(false)
    expect(isValidTime({ hh: 12, mm: 0 })).toBe(false)
    expect(isValidTime(null)).toBe(false)
    expect(isValidTime('10:00:00')).toBe(false)
  })
})

describe('parseCornerLabel', () => {
  it('parses a full record', () => {
    const raw = {
      version: 1,
      time: { hh: 15, mm: 53, ss: 8 },
      is24h: true,
      corners: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
        { x: 7, y: 8 },
      ],
      stratum: 'easy',
      eval: true,
      source: { url: 'https://example/x', license: 'CC-BY-SA-4.0', credit: 'Someone' },
      note: 'clean front-on',
    }
    const label = parseCornerLabel(raw)
    expect(label.time).toEqual({ hh: 15, mm: 53, ss: 8 })
    expect(label.corners).toHaveLength(4)
    expect(label.stratum).toBe('easy')
    expect(label.eval).toBe(true)
    expect(label.source?.license).toBe('CC-BY-SA-4.0')
  })

  it('tolerates a missing version (assumes 1) and a sparse record (stratum only)', () => {
    const label = parseCornerLabel({ stratum: 'hard' })
    expect(label.version).toBe(1)
    expect(label.stratum).toBe('hard')
    expect(label.time).toBeUndefined()
    expect(label.corners).toBeUndefined()
  })

  it('rejects an unsupported version', () => {
    expect(() => parseCornerLabel({ version: 2 })).toThrow(/version/)
  })

  it('rejects a bad stratum, time, and corner count', () => {
    expect(() => parseCornerLabel({ stratum: 'tricky' })).toThrow(/stratum/)
    expect(() => parseCornerLabel({ time: { hh: 99, mm: 0, ss: 0 } })).toThrow(/time/)
    expect(() => parseCornerLabel({ corners: [{ x: 0, y: 0 }] })).toThrow(/corners/)
    expect(() => parseCornerLabel({ corners: [{ x: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] })).toThrow(
      /corners/,
    )
  })

  it('rejects non-object input and bad field types', () => {
    expect(() => parseCornerLabel(null)).toThrow(/object/)
    expect(() => parseCornerLabel('x')).toThrow(/object/)
    expect(() => parseCornerLabel({ is24h: 'yes' })).toThrow(/is24h/)
    expect(() => parseCornerLabel({ note: 5 })).toThrow(/note/)
  })

  it('keeps the four strata names in canonical order', () => {
    expect([...STRATA]).toEqual(['easy', 'moderate', 'hard'])
  })
})

describe('timeFromFilename / is24hFromFilename', () => {
  it('pulls HH-MM-SS from the v1 filename convention', () => {
    expect(timeFromFilename('casio_10-42-15_24h.jpg')).toEqual({ hh: 10, mm: 42, ss: 15 })
    expect(timeFromFilename('f91w-5051_06-04-56_12h.jpg')).toEqual({ hh: 6, mm: 4, ss: 56 })
  })
  it('returns null with no time or an impossible one', () => {
    expect(timeFromFilename('f91w-all-segments.jpg')).toBeNull()
    expect(timeFromFilename('x_99-99-99.jpg')).toBeNull()
  })
  it('selects 12h only on the token', () => {
    expect(is24hFromFilename('x_12h.jpg')).toBe(false)
    expect(is24hFromFilename('x_24h.jpg')).toBe(true)
    expect(is24hFromFilename('x.jpg')).toBe(true)
  })
})

describe('sidecarPathFor', () => {
  it('appends .json to the full image path', () => {
    expect(sidecarPathFor('tools/fixtures/foo.jpg')).toBe('tools/fixtures/foo.jpg.json')
    // full filename keeps the ext, so foo.jpg and foo.png never collide
    expect(sidecarPathFor('a/foo.png')).toBe('a/foo.png.json')
  })
})

describe('resolveLabel — sidecar wins, filename is the fallback', () => {
  it('falls back to the filename when there is no sidecar', () => {
    const r = resolveLabel('f91w-time-noretouch_15-53-08_24h.jpg', null)
    expect(r.time).toEqual({ hh: 15, mm: 53, ss: 8 })
    expect(r.is24h).toBe(true)
    expect(r.stratum).toBeNull()
    expect(r.corners).toBeNull()
  })

  it('takes stratum/corners from the sidecar while time stays on the filename', () => {
    const sidecar: CornerLabel = { version: 1, stratum: 'hard', note: 'faint segment' }
    const r = resolveLabel('f91w-front-closeup_19-45-08_24h.jpg', sidecar)
    expect(r.time).toEqual({ hh: 19, mm: 45, ss: 8 }) // from filename
    expect(r.stratum).toBe('hard') // from sidecar
  })

  it('lets the sidecar override the time and mode', () => {
    const sidecar: CornerLabel = { version: 1, time: { hh: 1, mm: 2, ss: 3 }, is24h: false }
    const r = resolveLabel('no-time-here.jpg', sidecar)
    expect(r.time).toEqual({ hh: 1, mm: 2, ss: 3 })
    expect(r.is24h).toBe(false)
  })
})
