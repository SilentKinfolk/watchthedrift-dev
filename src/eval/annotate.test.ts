import { describe, it, expect } from 'vitest'
import { orderCorners, buildCornerLabel, serializeCornerLabel, type CornerLabelPatch } from './annotate'
import { parseCornerLabel, type CornerLabel, type Pt } from './label'

// A canonical upright quad, TL,TR,BR,BL, used across the cases below.
const TL = { x: 10, y: 20 }
const TR = { x: 90, y: 22 }
const BR = { x: 92, y: 80 }
const BL = { x: 8, y: 78 }
const CANON: Pt[] = [TL, TR, BR, BL]

describe('orderCorners — click order must not matter', () => {
  it('returns TL,TR,BR,BL for points already in order', () => {
    expect(orderCorners(CANON)).toEqual([TL, TR, BR, BL])
  })

  it('canonicalises every starting rotation/permutation to the same order', () => {
    const perms: Pt[][] = [
      [TR, BR, BL, TL], // rotated
      [BL, TL, TR, BR], // rotated the other way
      [BR, TL, BL, TR], // shuffled
      [TR, TL, BR, BL], // top pair swapped
      [TL, TR, BL, BR], // bottom pair swapped
    ]
    for (const p of perms) {
      expect(orderCorners(p)).toEqual([TL, TR, BR, BL])
    }
  })

  it('is idempotent', () => {
    expect(orderCorners(orderCorners(CANON))).toEqual(orderCorners(CANON))
  })

  it('throws on the wrong number of points or non-finite coordinates', () => {
    expect(() => orderCorners([TL, TR, BR])).toThrow(/4 corner points/)
    expect(() => orderCorners([TL, TR, BR, BL, TL])).toThrow(/4 corner points/)
    expect(() => orderCorners([TL, TR, BR, { x: NaN, y: 1 }])).toThrow(/finite/)
  })
})

describe('buildCornerLabel — assemble + validate', () => {
  it('builds a fresh, schema-valid record from a full patch', () => {
    const label = buildCornerLabel({
      corners: [BR, TL, BL, TR], // out of order on purpose
      time: { hh: 15, mm: 53, ss: 8 },
      is24h: true,
      stratum: 'easy',
      eval: false,
      note: 'clean',
    })
    expect(label.version).toBe(1)
    expect(label.corners).toEqual([TL, TR, BR, BL]) // canonicalised
    expect(label.time).toEqual({ hh: 15, mm: 53, ss: 8 })
    expect(label.stratum).toBe('easy')
    expect(label.eval).toBe(false)
    // What it emits always survives a re-parse (the load-bearing guarantee).
    expect(parseCornerLabel(label)).toEqual(label)
  })

  it('merges onto a base: provided fields override, untouched fields are kept', () => {
    const base: CornerLabel = {
      version: 1,
      stratum: 'hard',
      eval: true,
      source: { url: 'https://example/x', license: 'CC-BY-SA-4.0', credit: 'Someone' },
      note: 'faint segment',
    }
    // The `--auto` case: add only corners, keep everything else.
    const label = buildCornerLabel({ corners: CANON }, base)
    expect(label.corners).toEqual([TL, TR, BR, BL])
    expect(label.stratum).toBe('hard')
    expect(label.eval).toBe(true)
    expect(label.source?.credit).toBe('Someone')
    expect(label.note).toBe('faint segment')
  })

  it('overrides a single field while preserving the rest of the base', () => {
    const base = buildCornerLabel({ corners: CANON, stratum: 'moderate', eval: false })
    const moved = buildCornerLabel({ stratum: 'hard' }, base)
    expect(moved.stratum).toBe('hard')
    expect(moved.corners).toEqual([TL, TR, BR, BL]) // kept from base
    expect(moved.eval).toBe(false) // kept from base
  })

  it('clears corners when the patch sets them to null', () => {
    const base = buildCornerLabel({ corners: CANON })
    const cleared = buildCornerLabel({ corners: null }, base)
    expect(cleared.corners).toBeUndefined()
  })

  it('refuses to build an invalid record (validation runs on the merged result)', () => {
    expect(() => buildCornerLabel({ time: { hh: 99, mm: 0, ss: 0 } })).toThrow(/time/)
    // @ts-expect-error — a bad stratum is rejected at runtime too
    expect(() => buildCornerLabel({ stratum: 'tricky' })).toThrow(/stratum/)
    expect(() => buildCornerLabel({ corners: [TL, TR] as unknown as Pt[] })).toThrow(/4 corner points/)
  })
})

describe('serializeCornerLabel', () => {
  it('is 2-space pretty JSON with a trailing newline, and reparses', () => {
    const label = buildCornerLabel({ corners: CANON, stratum: 'easy' } as CornerLabelPatch)
    const text = serializeCornerLabel(label)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "version": 1')
    expect(parseCornerLabel(JSON.parse(text))).toEqual(label)
  })
})
