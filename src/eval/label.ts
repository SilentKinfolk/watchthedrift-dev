// The corner-label sidecar — the canonical per-image label record for the F-91W
// eval/training data, and the single schema three pieces of the pipeline share:
//
//   • the corner-annotation tool (#8) WRITES it (click 4 corners + enter the time),
//   • the augmentation pipeline (#7) READS corners + time and TRANSFORMS them
//     through each warp (corners follow the homography; the digits are unchanged),
//   • the harness (#5) READS time + stratum to score the precision-first gate.
//
// One JSON sidecar sits beside each image: `foo.jpg` → `foo.jpg.json` (the full
// filename plus `.json`, so `foo.jpg` and `foo.png` never collide). Fields fill in
// over the data's life — a record may carry only a `stratum` today and gain
// `corners` once annotated — so most fields are optional, with documented
// resolution rules (`resolveLabel`, below; see docs/eval-labels.md for the prose).
//
// Pure (string/object in, value out): no fs, no canvas, no model — so it
// unit-tests deterministically and the harness, annotation tool and augmentation
// tool can all import it without dragging in heavy deps.

/** Difficulty strata for the stratified eval. Definitions live in
 *  docs/eval-labels.md; in one line: easy = v1's comfort zone (clean, front-on,
 *  well-lit); moderate = mild angle / off-centre / dimness / glare; hard = strong
 *  angle, near-threshold dimness, glare, faint/aged segments, the small seconds
 *  digit — the cases the learned reader exists to win, weighted heaviest in eval. */
export const STRATA = ['easy', 'moderate', 'hard'] as const
export type Stratum = (typeof STRATA)[number]

export interface Time {
  hh: number
  mm: number
  ss: number
}

/** Image pixel coordinates (origin top-left), in the image's own resolution. */
export interface Pt {
  x: number
  y: number
}

/** The four LCD corners in TL, TR, BR, BL order — the same order and meaning as
 *  rectify's `Quad`, so an annotated/augmented corner set drops straight into the
 *  homography with no reordering. */
export type Corners = readonly [Pt, Pt, Pt, Pt]

export interface LabelSource {
  url?: string
  /** SPDX-ish licence id, e.g. `CC-BY-SA-4.0`, `CC0-1.0`, `PD`. */
  license?: string
  credit?: string
}

/** The sidecar record. `version` lets the schema migrate; everything else is
 *  optional so a record can be partially filled as it moves through the pipeline. */
export interface CornerLabel {
  version: 1
  /** Ground-truth display time. Absent → fall back to the filename label. */
  time?: Time | null
  /** Display mode. Absent → fall back to the filename `12h` token (else 24h). */
  is24h?: boolean
  /** The four LCD corners (image px). Absent until annotated (#8) or augmented (#7). */
  corners?: Corners | null
  /** Difficulty stratum. Absent → counted under `unstratified` in the report. */
  stratum?: Stratum | null
  /** Held-out eval gold set — never augmented (the precision gate's truth set). */
  eval?: boolean
  /** Provenance for redistributable (CC/PD) fixtures; required before committing one. */
  source?: LabelSource
  /** Free-form note, e.g. why it's hard / what v1 does with it. */
  note?: string
}

/** A plausible wall-clock time (permissive across 12h/24h: hours 0–23 cover a 12h
 *  display's 1–12 too). Integers only. */
export function isValidTime(t: unknown): t is Time {
  if (typeof t !== 'object' || t === null) return false
  const { hh, mm, ss } = t as Record<string, unknown>
  const intIn = (v: unknown, lo: number, hi: number): boolean =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
  return intIn(hh, 0, 23) && intIn(mm, 0, 59) && intIn(ss, 0, 59)
}

function isPt(p: unknown): p is Pt {
  if (typeof p !== 'object' || p === null) return false
  const { x, y } = p as Record<string, unknown>
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
}

/** Validate + normalise a parsed-JSON sidecar into a `CornerLabel`. Throws `Error`
 *  with a field-specific message on anything malformed, so a bad label fails loud
 *  rather than silently mis-scoring. A missing `version` is tolerated (assumed 1);
 *  a present-but-unsupported one is rejected. */
export function parseCornerLabel(raw: unknown): CornerLabel {
  if (typeof raw !== 'object' || raw === null) throw new Error('label must be a JSON object')
  const o = raw as Record<string, unknown>

  if (o.version !== undefined && o.version !== 1) {
    throw new Error(`unsupported label version ${JSON.stringify(o.version)} (expected 1)`)
  }
  const label: CornerLabel = { version: 1 }

  if (o.time !== undefined && o.time !== null) {
    if (!isValidTime(o.time)) throw new Error('time must be {hh,mm,ss} integers in clock range')
    label.time = { hh: o.time.hh, mm: o.time.mm, ss: o.time.ss }
  }

  if (o.is24h !== undefined) {
    if (typeof o.is24h !== 'boolean') throw new Error('is24h must be a boolean')
    label.is24h = o.is24h
  }

  if (o.corners !== undefined && o.corners !== null) {
    if (!Array.isArray(o.corners) || o.corners.length !== 4 || !o.corners.every(isPt)) {
      throw new Error('corners must be 4 points [{x,y}×4] in TL,TR,BR,BL order')
    }
    const c = o.corners as Pt[]
    label.corners = [
      { x: c[0].x, y: c[0].y },
      { x: c[1].x, y: c[1].y },
      { x: c[2].x, y: c[2].y },
      { x: c[3].x, y: c[3].y },
    ]
  }

  if (o.stratum !== undefined && o.stratum !== null) {
    if (typeof o.stratum !== 'string' || !(STRATA as readonly string[]).includes(o.stratum)) {
      throw new Error(`stratum must be one of ${STRATA.join('/')}`)
    }
    label.stratum = o.stratum as Stratum
  }

  if (o.eval !== undefined) {
    if (typeof o.eval !== 'boolean') throw new Error('eval must be a boolean')
    label.eval = o.eval
  }

  if (o.source !== undefined) {
    if (typeof o.source !== 'object' || o.source === null) throw new Error('source must be an object')
    label.source = o.source as LabelSource
  }

  if (o.note !== undefined) {
    if (typeof o.note !== 'string') throw new Error('note must be a string')
    label.note = o.note
  }

  return label
}

/** Pull a `HH-MM-SS` time out of a filename (the v1 harness convention, e.g.
 *  `casio_10-42-15_24h.jpg`). Returns null if absent or out of clock range. */
export function timeFromFilename(name: string): Time | null {
  const m = name.match(/(\d{1,2})-(\d{2})-(\d{2})/)
  if (!m) return null
  const t = { hh: +m[1], mm: +m[2], ss: +m[3] }
  return isValidTime(t) ? t : null
}

/** A `12h` token anywhere in the filename selects 12-hour parsing; otherwise 24h. */
export function is24hFromFilename(name: string): boolean {
  return !/12h/i.test(name)
}

/** The sidecar path for an image: its full path plus `.json`. */
export function sidecarPathFor(imagePath: string): string {
  return `${imagePath}.json`
}

export interface ResolvedLabel {
  /** Ground-truth time, or null when the image carries no label (excluded from scoring). */
  time: Time | null
  is24h: boolean
  /** null → bucketed under `unstratified` in the report. */
  stratum: Stratum | null
  corners: Corners | null
}

/** Resolve the effective label for an image from its filename and (optional)
 *  sidecar, applying precedence: the sidecar wins where present, the filename is
 *  the fallback for `time`/`is24h`. */
export function resolveLabel(imageName: string, sidecar: CornerLabel | null): ResolvedLabel {
  return {
    time: sidecar?.time ?? timeFromFilename(imageName),
    is24h: sidecar?.is24h ?? is24hFromFilename(imageName),
    stratum: sidecar?.stratum ?? null,
    corners: sidecar?.corners ?? null,
  }
}
