// The annotation core (issue #8) — the pure logic behind the corner-annotation
// tool. The tool's job is "click the 4 LCD corners + enter the time → write the
// corner-label sidecar"; everything here is the *write* half of that, factored out
// of any UI so it can be unit-tested and shared by both shells:
//
//   • the browser GUI (tools/annotate/) — clicks become points, this builds the JSON,
//   • the Node CLI (tools/annotate.ts) — flags/`--auto` become points, same JSON.
//
// Two responsibilities:
//   1. `orderCorners` — make CLICK ORDER not matter: four points in any order →
//      the canonical TL, TR, BR, BL the schema (and rectify's `Quad`) require.
//   2. `buildCornerLabel` — assemble (and *merge onto* an existing sidecar) a
//      `CornerLabel`, then validate it back through `parseCornerLabel`, so anything
//      this emits is guaranteed schema-valid (a malformed sidecar can never be written).
//
// Pure (points/objects in, object/string out): no fs, no canvas, no DOM — so it
// unit-tests deterministically and the GUI/CLI import it without dragging in deps.
// Uses `.ts` import specifiers + no class param-properties so the strip-types CLI
// can load it (see the harness/augment tooling constraints).

import {
  parseCornerLabel,
  type CornerLabel,
  type Corners,
  type LabelSource,
  type Pt,
  type Stratum,
  type Time,
} from './label.ts'

/** Canonicalise four clicked points (in ANY order) to the schema's TL, TR, BR, BL.
 *  Splits the points into the top two and bottom two by `y`, then orders each pair
 *  left→right by `x`. This assumes a roughly-upright quad — true for a hand-held
 *  watch photo, and the only case the corner detector targets; a quad rotated past
 *  ~45° could mislabel, which is why the GUI overlays the resulting order for the
 *  annotator to eyeball. Throws on the wrong count or non-finite coordinates so a
 *  bad click set fails loud rather than writing nonsense corners. */
export function orderCorners(points: readonly Pt[]): Corners {
  if (points.length !== 4) {
    throw new Error(`need exactly 4 corner points, got ${points.length}`)
  }
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error('corner points must have finite x and y')
    }
  }
  const byY = [...points].sort((a, b) => a.y - b.y)
  const [tl, tr] = byY.slice(0, 2).sort((a, b) => a.x - b.x) // top pair, left then right
  const [bl, br] = byY.slice(2).sort((a, b) => a.x - b.x) // bottom pair, left then right
  return [
    { x: tl.x, y: tl.y },
    { x: tr.x, y: tr.y },
    { x: br.x, y: br.y },
    { x: bl.x, y: bl.y },
  ]
}

/** The fields the annotation tool can set or change. Every field is optional so a
 *  record fills in over its life (corners today, a stratum tomorrow); `corners` is
 *  the RAW clicked points (any order — `buildCornerLabel` canonicalises them), or
 *  `null` to clear an existing set. A field left `undefined` keeps the base's value;
 *  a field set to a value (incl. `null` where the schema allows it) overrides it. */
export interface CornerLabelPatch {
  corners?: readonly Pt[] | null
  time?: Time | null
  is24h?: boolean
  stratum?: Stratum | null
  eval?: boolean
  source?: LabelSource
  note?: string
}

/** Build a corner-label sidecar from annotation inputs, optionally MERGING onto an
 *  existing record (the CLI's "add corners, keep the stratum/source/note already
 *  there" path; pass `base = null` to build fresh). Clicked corners are canonicalised
 *  to TL,TR,BR,BL, then the whole record is validated back through `parseCornerLabel`
 *  — so this can only ever return a schema-valid label, and an out-of-range time or
 *  unknown stratum throws here rather than being written to disk. */
export function buildCornerLabel(patch: CornerLabelPatch, base: CornerLabel | null = null): CornerLabel {
  // Start from a plain object copy of the base so we can overlay raw values and hand
  // the result to the validator (which re-derives a clean CornerLabel).
  const merged: Record<string, unknown> = base ? { ...base } : {}
  merged.version = 1

  if (patch.corners !== undefined) {
    merged.corners = patch.corners === null ? null : orderCorners(patch.corners)
  }
  if (patch.time !== undefined) merged.time = patch.time
  if (patch.is24h !== undefined) merged.is24h = patch.is24h
  if (patch.stratum !== undefined) merged.stratum = patch.stratum
  if (patch.eval !== undefined) merged.eval = patch.eval
  if (patch.source !== undefined) merged.source = patch.source
  if (patch.note !== undefined) merged.note = patch.note

  return parseCornerLabel(merged)
}

/** Serialise a sidecar to the on-disk form the rest of the tooling writes: 2-space
 *  pretty JSON with a trailing newline (matches the augment CLI and the committed
 *  fixtures, so re-annotating produces a minimal diff). */
export function serializeCornerLabel(label: CornerLabel): string {
  return JSON.stringify(label, null, 2) + '\n'
}
