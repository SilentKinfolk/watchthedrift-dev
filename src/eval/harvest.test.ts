import { describe, it, expect } from 'vitest'
import {
  canonicalLicense,
  classifyLicense,
  isRedistributable,
  buildCommonsApiUrl,
  parseCommonsResponse,
  slugForTitle,
  provenanceSidecar,
  COMMONS_ENDPOINT,
  type HarvestImage,
} from './harvest'
import { parseCornerLabel } from './label'

describe('canonicalLicense — converge the two Commons licence fields', () => {
  it('upper-cases and dashes whitespace/underscores', () => {
    expect(canonicalLicense('cc-by-sa-4.0')).toBe('CC-BY-SA-4.0')
    expect(canonicalLicense('CC BY-SA 4.0')).toBe('CC-BY-SA-4.0')
    expect(canonicalLicense('  cc_by_2.0  ')).toBe('CC-BY-2.0')
  })

  it('collapses repeated/edge dashes', () => {
    expect(canonicalLicense('CC - BY')).toBe('CC-BY')
    expect(canonicalLicense('-PD-')).toBe('PD')
  })
})

describe('classifyLicense — the redistribution bright line (PLAN Rights)', () => {
  it('treats CC-BY / CC-BY-SA / CC0 / PD as redistributable', () => {
    for (const l of ['CC-BY-SA-4.0', 'CC BY-SA 3.0', 'cc-by-4.0', 'CC0-1.0', 'CC0', 'PD', 'Public Domain', 'public-domain-mark']) {
      expect(classifyLicense(l)).toBe('redistributable')
    }
  })

  it('treats NC / ND / GFDL / unknown / empty as restricted (conservative default)', () => {
    for (const l of ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-ND-4.0', 'GFDL', 'GPL-3.0', 'All rights reserved', '', '   ', 'mystery']) {
      expect(classifyLicense(l)).toBe('restricted')
    }
  })

  it('isRedistributable agrees with classifyLicense', () => {
    expect(isRedistributable('CC-BY-SA-4.0')).toBe(true)
    expect(isRedistributable('CC-BY-NC-4.0')).toBe(false)
  })
})

describe('buildCommonsApiUrl', () => {
  it('targets Commons api.php with the search generator + imageinfo props', () => {
    const u = new URL(buildCommonsApiUrl({ query: 'Casio F-91W', limit: 25 }))
    expect(`${u.origin}${u.pathname}`).toBe(COMMONS_ENDPOINT)
    expect(u.searchParams.get('action')).toBe('query')
    expect(u.searchParams.get('generator')).toBe('search')
    expect(u.searchParams.get('gsrsearch')).toBe('Casio F-91W')
    expect(u.searchParams.get('gsrnamespace')).toBe('6')
    expect(u.searchParams.get('gsrlimit')).toBe('25')
    expect(u.searchParams.get('iiprop')).toContain('extmetadata')
    expect(u.searchParams.get('format')).toBe('json')
  })

  it('honours a custom endpoint', () => {
    const u = buildCommonsApiUrl({ query: 'x', limit: 1, endpoint: 'https://example.test/w/api.php' })
    expect(u.startsWith('https://example.test/w/api.php?')).toBe(true)
  })
})

// A minimal stand-in for the real api.php response (shape verified against the live
// API): two image pages + one File page with no imageinfo (must be skipped).
const SAMPLE_RESPONSE = {
  query: {
    pages: {
      '111': {
        title: 'File:Casio F-91W 5051.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/9/96/Casio_F-91W_5051.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Casio_F-91W_5051.jpg',
            mime: 'image/jpeg',
            size: 1947198,
            width: 3393,
            height: 5000,
            extmetadata: {
              License: { value: 'cc-by-sa-3.0' },
              LicenseShortName: { value: 'CC BY-SA 3.0' },
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Ashley_Pomeroy">Ashley Pomeroy</a>' },
            },
          },
        ],
      },
      '222': {
        title: 'File:Some NC photo.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/a/aa/Some_NC_photo.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Some_NC_photo.jpg',
            mime: 'image/jpeg',
            size: 1000,
            width: 100,
            height: 100,
            extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' }, Artist: { value: 'Jane &amp; Co' } },
          },
        ],
      },
      '333': { title: 'File:Not an image.pdf' }, // no imageinfo → skipped
    },
  },
}

describe('parseCommonsResponse', () => {
  it('flattens image pages, strips HTML credit, canonicalises licence, skips non-images', () => {
    const imgs = parseCommonsResponse(SAMPLE_RESPONSE)
    expect(imgs).toHaveLength(2)
    const byTitle = Object.fromEntries(imgs.map((i) => [i.title, i]))

    const a = byTitle['File:Casio F-91W 5051.jpg']
    expect(a.downloadUrl).toContain('upload.wikimedia.org')
    expect(a.pageUrl).toContain('commons.wikimedia.org/wiki/File:')
    expect(a.license).toBe('CC-BY-SA-3.0')
    expect(a.credit).toBe('Ashley Pomeroy')
    expect(a.width).toBe(3393)
    expect(a.sizeBytes).toBe(1947198)

    const b = byTitle['File:Some NC photo.jpg']
    expect(b.license).toBe('CC-BY-NC-4.0')
    expect(b.credit).toBe('Jane & Co') // HTML entity decoded
    expect(isRedistributable(b.license)).toBe(false)
  })

  it('returns [] for malformed input', () => {
    expect(parseCommonsResponse(null)).toEqual([])
    expect(parseCommonsResponse({})).toEqual([])
    expect(parseCommonsResponse({ query: {} })).toEqual([])
  })
})

describe('slugForTitle', () => {
  it('drops File:, lower-cases, dashes punctuation, keeps/normalises the extension', () => {
    expect(slugForTitle('File:Casio F-91W 5051.jpg')).toBe('casio-f-91w-5051.jpg')
    expect(slugForTitle('File:Casio F-91W watch (2023) (front closeup - time).JPEG')).toMatch(
      /^casio-f-91w-watch-2023-front-closeup-time\.jpg$/,
    )
    expect(slugForTitle('File:weird.png')).toBe('weird.png')
  })

  it('falls back to a generic name with a .jpg extension when none is usable', () => {
    expect(slugForTitle('File:.jpg')).toBe('image.jpg')
  })
})

describe('provenanceSidecar', () => {
  const img: HarvestImage = {
    title: 'File:Casio F-91W 5051.jpg',
    pageUrl: 'https://commons.wikimedia.org/wiki/File:Casio_F-91W_5051.jpg',
    downloadUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/96/Casio_F-91W_5051.jpg',
    license: 'CC-BY-SA-3.0',
    credit: 'Ashley Pomeroy',
    mime: 'image/jpeg',
    width: 3393,
    height: 5000,
    sizeBytes: 1947198,
  }

  it('writes a schema-valid provenance-only sidecar that round-trips parseCornerLabel', () => {
    const label = provenanceSidecar(img)
    expect(() => parseCornerLabel(label)).not.toThrow()
    expect(label.version).toBe(1)
    expect(label.source).toEqual({
      url: img.pageUrl,
      license: 'CC-BY-SA-3.0',
      credit: 'Ashley Pomeroy',
    })
    // Corners/time/stratum are added later by annotation, not by the harvester.
    expect(label.corners).toBeUndefined()
    expect(label.time).toBeUndefined()
    expect(label.stratum).toBeUndefined()
  })
})
