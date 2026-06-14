// License-aware web harvester (issue #10): pull real F-91W photos from an open
// image source into the gitignored local training corpus, writing a provenance
// sidecar (url / licence / credit) beside each. This is the I/O shell over the pure
// core in src/eval/harvest.ts (query/parse/licence/slug); the core unit-tests
// without a network, this does the fetch + fs.
//
//   npm run harvest                              # 25 "Casio F-91W" images → tools/local/
//   npm run harvest -- --query "Casio F-91W" --limit 40
//   npm run harvest -- --redistributable-only    # skip restricted (CC/PD only)
//   npm run harvest -- --dry-run                 # list candidates + tiers, download nothing
//
// SOURCE: Wikimedia Commons (api.php generator=search over the File namespace). The
// shape the core parses is source-agnostic, so Openverse / Flickr can be added behind
// the same HarvestImage type without touching the download/annotate path.
//
// RIGHTS (PLAN "Rights — the line is redistribution, not training"): every image
// lands in gitignored tools/local/ — fine to TRAIN on from any source. Whether an
// image may ever be COMMITTED (redistributed) is its licence tier: CC-BY / CC-BY-SA /
// CC0 / PD = redistributable, everything else = restricted. The harvester records the
// licence in each sidecar's `source` and prints the tier per image + a summary, so
// the CC/PD-vs-other split is captured; PROMOTING a redistributable image to the
// committed eval gold (corners + time + stratum + eval:true in tools/fixtures/) is a
// deliberate later step (annotate, then move the sidecar), never automatic.
//
// UA: upload.wikimedia.org 400s a default/empty User-Agent (Wikimedia policy), so the
// binary download sends a descriptive one. api.php tolerates the default but gets it too.
//
// Runs under bare-node strip-types (`node --experimental-strip-types`), so every src/
// module it pulls in uses .ts specifiers and no constructor param-properties.

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCommonsApiUrl,
  parseCommonsResponse,
  classifyLicense,
  slugForTitle,
  provenanceSidecar,
  COMMONS_ENDPOINT,
  type HarvestImage,
} from '../src/eval/harvest.ts'
import { serializeCornerLabel } from '../src/eval/annotate.ts'
import { parseCornerLabel, sidecarPathFor, type CornerLabel } from '../src/eval/label.ts'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const DEFAULT_OUT = join(ROOT, 'tools', 'local')
const DEFAULT_UA =
  'watchthedrift-dev-harvester/0.1 (+https://github.com/SilentKinfolk/watchthedrift; silentkinfolk@posteo.co.uk)'

const USAGE = `harvest — license-aware web harvester for F-91W photos (issue #10)

Usage: npm run harvest -- [options]
  --query <q>             search text                          (default: "Casio F-91W")
  --limit <n>             max results to request               (default: 25)
  --out <dir>             download directory (gitignored)      (default: tools/local)
  --redistributable-only  skip restricted licences (commit only CC-BY/CC-BY-SA/CC0/PD)
  --min-dim <px>          skip images whose shorter side < px  (default: 0 = keep all)
  --overwrite             re-download images that already exist (default: skip)
  --delay <ms>            polite gap between downloads            (default: 500)
  --retries <n>           retries on HTTP 429/503 (backoff)       (default: 4)
  --ua <string>           override the User-Agent sent to the source
  --endpoint <url>        Commons api.php endpoint             (default: ${COMMONS_ENDPOINT})
  --dry-run               list candidates + tiers; download nothing, write nothing
  --help                  show this help`

interface Opts {
  query: string
  limit: number
  out: string
  redistributableOnly: boolean
  minDim: number
  overwrite: boolean
  delay: number
  retries: number
  ua: string
  endpoint: string
  dryRun: boolean
}

function parseArgs(argv: string[]): Opts | null {
  const o: Opts = {
    query: 'Casio F-91W',
    limit: 25,
    out: DEFAULT_OUT,
    redistributableOnly: false,
    minDim: 0,
    overwrite: false,
    delay: 500,
    retries: 4,
    ua: DEFAULT_UA,
    endpoint: COMMONS_ENDPOINT,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    const num = (): number => {
      const n = Number(val())
      if (!Number.isFinite(n)) throw new Error(`${a} needs a number`)
      return n
    }
    if (a === '--help' || a === '-h') return null
    else if (a === '--query') o.query = val()
    else if (a === '--limit') o.limit = num()
    else if (a === '--out') o.out = resolve(val())
    else if (a === '--redistributable-only') o.redistributableOnly = true
    else if (a === '--min-dim') o.minDim = num()
    else if (a === '--overwrite') o.overwrite = true
    else if (a === '--delay') o.delay = num()
    else if (a === '--retries') o.retries = num()
    else if (a === '--ua') o.ua = val()
    else if (a === '--endpoint') o.endpoint = val()
    else if (a === '--dry-run') o.dryRun = true
    else throw new Error(`unknown argument: ${a} (try --help)`)
  }
  return o
}

function loadSidecar(path: string): CornerLabel | null {
  if (!existsSync(path)) return null
  try {
    return parseCornerLabel(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null // a malformed/foreign sidecar is overwritten with fresh provenance
  }
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`

async function fetchJson(url: string, ua: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': ua } })
  if (!res.ok) throw new Error(`search request failed: HTTP ${res.status}`)
  return res.json()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Download with polite backoff: a busy public mirror (upload.wikimedia.org) answers
 *  a burst with HTTP 429 / 503, so retry those, honouring a `Retry-After` header when
 *  present, else exponential backoff. Other statuses fail fast. */
async function downloadImage(url: string, ua: string, dest: string, retries: number): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': ua } })
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(dest, buf)
      return buf.length
    }
    const retryable = res.status === 429 || res.status === 503
    if (!retryable || attempt >= retries) throw new Error(`HTTP ${res.status}`)
    const retryAfter = Number(res.headers.get('retry-after'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 16000)
    await sleep(waitMs)
  }
}

async function main(): Promise<void> {
  let opts: Opts | null
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`harvest: ${(e as Error).message}`)
    process.exit(2)
  }
  if (!opts) {
    console.log(USAGE)
    return
  }

  console.log(`harvest: searching "${opts.query}" (limit ${opts.limit}) on ${opts.endpoint}`)
  let images: HarvestImage[]
  try {
    const json = await fetchJson(buildCommonsApiUrl({ query: opts.query, limit: opts.limit, endpoint: opts.endpoint }), opts.ua)
    images = parseCommonsResponse(json)
  } catch (e) {
    console.error(`harvest: ${(e as Error).message}`)
    process.exit(1)
  }

  // Keep images only; apply the rights + size filters.
  const candidates = images.filter((img) => {
    if (!/^image\//.test(img.mime)) return false
    if (opts.minDim > 0 && Math.min(img.width, img.height) < opts.minDim) return false
    if (opts.redistributableOnly && classifyLicense(img.license) !== 'redistributable') return false
    return true
  })

  console.log(`harvest: ${images.length} results → ${candidates.length} candidates after filters\n`)
  if (candidates.length === 0) {
    console.log('harvest: nothing to do.')
    return
  }

  if (!opts.dryRun) mkdirSync(opts.out, { recursive: true })

  let downloaded = 0
  let skipped = 0
  let bytes = 0
  let redistributable = 0
  let restricted = 0

  for (const img of candidates) {
    const tier = classifyLicense(img.license)
    if (tier === 'redistributable') redistributable++
    else restricted++

    const slug = slugForTitle(img.title)
    const dest = join(opts.out, slug)
    const tag = tier === 'redistributable' ? 'CC/PD ' : 'restr.'
    const dims = `${img.width}×${img.height}`

    if (opts.dryRun) {
      console.log(`  [${tag}] ${(img.license || '?').padEnd(14)} ${dims.padStart(11)}  ${slug}`)
      continue
    }

    // Image: skip if already present (idempotent re-harvest) unless --overwrite.
    let line: string
    if (existsSync(dest) && !opts.overwrite) {
      skipped++
      line = `skip  (have ${kb(statSync(dest).size)})`
    } else {
      if (downloaded > 0 && opts.delay > 0) await sleep(opts.delay) // polite gap between hits
      try {
        const n = await downloadImage(img.downloadUrl, opts.ua, dest, opts.retries)
        downloaded++
        bytes += n
        line = `saved ${kb(n)}`
      } catch (e) {
        console.error(`  [${tag}] ${slug}: download failed — ${(e as Error).message}`)
        continue
      }
    }

    // Sidecar: merge provenance onto any existing one (never clobber annotations).
    const sidecarPath = sidecarPathFor(dest)
    const label = provenanceSidecar(img, loadSidecar(sidecarPath))
    writeFileSync(sidecarPath, serializeCornerLabel(label))

    console.log(`  [${tag}] ${(img.license || '?').padEnd(14)} ${dims.padStart(11)}  ${slug}  — ${line}`)
  }

  const where = relative(process.cwd(), opts.out)
  console.log(
    `\nharvest: ${candidates.length} candidates — ${redistributable} redistributable (CC/PD), ${restricted} restricted.`,
  )
  if (opts.dryRun) {
    console.log('harvest: --dry-run, nothing written.')
  } else {
    console.log(
      `harvest: ${downloaded} downloaded (${kb(bytes)}), ${skipped} already present → ${where}/ (gitignored).`,
    )
    console.log('harvest: next — annotate the watch-face shots (npm run annotate), then promote CC/PD easy/moderate ones to tools/fixtures/ eval gold.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
