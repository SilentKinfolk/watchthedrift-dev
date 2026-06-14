// The harvest core (issue #10) — the pure logic behind the license-aware web
// harvester. The harvester's job is "search an open image source for F-91W photos →
// download them into the gitignored local corpus → write a provenance sidecar beside
// each"; everything here is the *decide/parse* half of that, factored out of fs and
// network so it unit-tests deterministically (no live API in CI).
//
// Two responsibilities, mirroring the annotation core's split:
//   1. Talk the source's protocol — build the query URL, parse the response into a
//      flat list of `HarvestImage` (Wikimedia Commons today; the shape is generic so
//      Openverse / Flickr drop in behind the same type).
//   2. Apply the RIGHTS line — `classifyLicense` decides redistributable (CC-BY /
//      CC-BY-SA / CC0 / PD) vs restricted (everything else, conservatively), the
//      bright line from PLAN "Rights": *any* source may train locally, only CC/PD
//      may be committed. `provenanceSidecar` records that call in a schema-valid
//      sidecar (via the annotation core), so "CC/PD vs other" is captured per image.
//
// Pure (strings/objects in, values out): no fs, no fetch, no canvas — the CLI shell
// (tools/harvest.ts) does the I/O. Uses `.ts` import specifiers + no class
// param-properties so the strip-types CLI can load it (see the harness/augment
// tooling constraints in the other tools).

import { buildCornerLabel } from './annotate.ts'
import type { CornerLabel } from './label.ts'

/** The two rights tiers from PLAN "Rights — the line is redistribution, not
 *  training": `redistributable` images (CC-BY / CC-BY-SA / CC0 / PD) may be committed
 *  with attribution; `restricted` (anything else — NC/ND, GFDL-only, unknown,
 *  all-rights-reserved) stays in the gitignored local training corpus only. */
export type LicenseTier = 'redistributable' | 'restricted'

/** One harvested image, source-agnostic so a second source (Openverse, Flickr) can
 *  produce the same shape and reuse the rest of the pipeline. */
export interface HarvestImage {
  /** Commons title / source id, e.g. `File:Casio F-91W 5051.jpg`. */
  title: string
  /** The human description / attribution page (what goes in the sidecar `source.url`
   *  and CREDITS, and where a person re-fetches the image from). */
  pageUrl: string
  /** The direct binary URL to download the pixels from. */
  downloadUrl: string
  /** Canonical SPDX-ish licence id, e.g. `CC-BY-SA-4.0` (see `canonicalLicense`). */
  license: string
  /** Attribution (author), HTML stripped, e.g. `Ashley Pomeroy`. */
  credit: string
  mime: string
  width: number
  height: number
  sizeBytes: number
}

export interface HarvestQuery {
  /** Free-text search, e.g. `Casio F-91W`. */
  query: string
  /** Max results to request from the source. */
  limit: number
  /** API endpoint; defaults to Wikimedia Commons. */
  endpoint?: string
}

export const COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'

/** Normalise a licence string to a canonical SPDX-ish form: upper-case, whitespace
 *  and underscores collapsed to single dashes. So both Commons fields converge —
 *  `License`=`cc-by-sa-4.0` and `LicenseShortName`=`CC BY-SA 4.0` both become
 *  `CC-BY-SA-4.0`, matching the form the committed fixtures already use. */
export function canonicalLicense(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/** Decide a licence's rights tier — the redistribution bright line. Redistributable
 *  iff it is a public-domain marker (PD / CC0 / "public domain") OR a CC-BY family
 *  licence with NO NonCommercial (`NC`) or NoDerivatives (`ND`) clause. Everything
 *  else — GFDL-only, NC/ND, unknown, empty — is `restricted` (train-local only). The
 *  default is deliberately conservative: an unrecognised licence is NEVER treated as
 *  committable, so "only CC/PD committed" can't be breached by a parsing gap. */
export function classifyLicense(license: string): LicenseTier {
  const norm = canonicalLicense(license)
  if (norm === '') return 'restricted'
  const tokens = norm.split('-')
  const isPublicDomain =
    norm.startsWith('CC0') ||
    norm.startsWith('PUBLIC-DOMAIN') ||
    norm === 'PD' ||
    tokens.includes('PD') ||
    norm === 'NO-RESTRICTIONS'
  const isFreeCcBy =
    tokens[0] === 'CC' && tokens.includes('BY') && !tokens.includes('NC') && !tokens.includes('ND')
  return isPublicDomain || isFreeCcBy ? 'redistributable' : 'restricted'
}

/** Convenience predicate over `classifyLicense`. */
export function isRedistributable(license: string): boolean {
  return classifyLicense(license) === 'redistributable'
}

/** Build the Wikimedia Commons `api.php` URL that lists File-namespace images
 *  matching a search, with the image-info props the harvester needs (direct +
 *  description URLs, mime, size, dimensions, licence/credit metadata). `api.php`
 *  tolerates a default User-Agent; the binary download from `upload.wikimedia.org`
 *  does not (the CLI sends a descriptive one). */
export function buildCommonsApiUrl(q: HarvestQuery): string {
  const url = new URL(q.endpoint ?? COMMONS_ENDPOINT)
  const params: Record<string, string> = {
    action: 'query',
    generator: 'search',
    gsrsearch: q.query,
    gsrnamespace: '6', // File:
    gsrlimit: String(q.limit),
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    format: 'json',
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/** Strip HTML tags + collapse whitespace from a Commons metadata value (the `Artist`
 *  field arrives as an anchor element). Returns '' for non-strings. */
function stripHtml(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

function extValue(extmetadata: unknown, key: string): string {
  if (typeof extmetadata !== 'object' || extmetadata === null) return ''
  const entry = (extmetadata as Record<string, unknown>)[key]
  if (typeof entry !== 'object' || entry === null) return ''
  const v = (entry as Record<string, unknown>).value
  return typeof v === 'string' ? v : ''
}

/** Parse a Commons `api.php` (generator=search + imageinfo) JSON response into a flat
 *  `HarvestImage[]`. Defensive: pages missing imageinfo / a binary URL are skipped
 *  (not every File page is an image), licence is taken from `License` (SPDX-ish),
 *  falling back to `LicenseShortName`, then canonicalised; credit from `Artist`. */
export function parseCommonsResponse(json: unknown): HarvestImage[] {
  if (typeof json !== 'object' || json === null) return []
  const pages = (json as { query?: { pages?: unknown } }).query?.pages
  if (typeof pages !== 'object' || pages === null) return []

  const out: HarvestImage[] = []
  for (const page of Object.values(pages as Record<string, unknown>)) {
    if (typeof page !== 'object' || page === null) continue
    const p = page as Record<string, unknown>
    const info = Array.isArray(p.imageinfo) ? p.imageinfo[0] : undefined
    if (typeof info !== 'object' || info === null) continue
    const ii = info as Record<string, unknown>
    const downloadUrl = typeof ii.url === 'string' ? ii.url : ''
    if (!downloadUrl) continue
    const licenseRaw = extValue(ii.extmetadata, 'License') || extValue(ii.extmetadata, 'LicenseShortName')
    out.push({
      title: typeof p.title === 'string' ? p.title : '',
      pageUrl: typeof ii.descriptionurl === 'string' ? ii.descriptionurl : downloadUrl,
      downloadUrl,
      license: canonicalLicense(licenseRaw),
      credit: stripHtml(extValue(ii.extmetadata, 'Artist')),
      mime: typeof ii.mime === 'string' ? ii.mime : '',
      width: typeof ii.width === 'number' ? ii.width : 0,
      height: typeof ii.height === 'number' ? ii.height : 0,
      sizeBytes: typeof ii.size === 'number' ? ii.size : 0,
    })
  }
  return out
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i

/** A safe, descriptive local filename for a harvested image: drop the `File:`
 *  prefix, lower-case, non-alphanumerics → single dashes, keep the extension. The
 *  stem is capped so deeply-parenthesised Commons titles stay manageable. Falls back
 *  to a generic name when the title carries no usable image extension. */
export function slugForTitle(title: string): string {
  const name = title.replace(/^File:/i, '').trim()
  const extMatch = name.match(IMAGE_EXT_RE)
  const ext = extMatch ? extMatch[0].toLowerCase().replace('jpeg', 'jpg') : '.jpg'
  const stem = name
    .replace(IMAGE_EXT_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/g, '')
  return `${stem || 'image'}${ext}`
}

/** Build the provenance sidecar the harvester writes beside a downloaded image: a
 *  schema-valid `CornerLabel` carrying `source` (url / licence / credit), MERGED onto
 *  any existing sidecar so a re-harvest refreshes provenance WITHOUT clobbering
 *  corners / time / stratum added later by annotation. The corners / time / stratum
 *  are filled in by agent-assisted annotation; built through the annotation core so
 *  it is guaranteed to round-trip `parseCornerLabel`. */
export function provenanceSidecar(img: HarvestImage, base: CornerLabel | null = null): CornerLabel {
  return buildCornerLabel(
    { source: { url: img.pageUrl, license: img.license, credit: img.credit } },
    base,
  )
}
