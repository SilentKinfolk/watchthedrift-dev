// ────────────────────────────────────────────────────────────────────────────
// TEMPORARY SCAFFOLDING — replaced by the learned corner detector (issue #9).
//
// The rectification stage (issue #4) wires up the `corners → homography → frontal
// crop → reader` seam BEFORE any model exists. To run that pipeline end-to-end we
// need the four LCD corners from *somewhere*; this is a throwaway stub that supplies
// them from a manual/debug source, never from real detection. It exists so the
// rectify wiring is exercisable and testable now. When the learned corner detector
// lands, swap a real `CornerSource` in at the single call site (the recognizer's
// constructor) and delete this file — nothing else changes.
// ────────────────────────────────────────────────────────────────────────────

import type { Quad } from './rectify'

/** Supplies the four LCD corners for a frame of the given size, or null when it
 *  has nothing (→ the recognizer reads the raw crop, unchanged). The learned
 *  detector (#9) will implement this same interface. */
export interface CornerSource {
  readonly id: string
  corners(width: number, height: number): Quad | null
}

/**
 * Parse a `?corners=` debug override into pixel-space corners. The value is eight
 * comma-separated fractions (0..1) of the frame — x0,y0,x1,y1,x2,y2,x3,y3 in
 * TL,TR,BR,BL order — e.g. `?corners=0.1,0.2,0.9,0.18,0.92,0.8,0.08,0.82`. Returns
 * null if absent or malformed. Pure (takes the raw string) so it unit-tests
 * without a DOM.
 */
export function parseCornersParam(raw: string | null, width: number, height: number): Quad | null {
  if (!raw) return null
  const n = raw.split(',').map(Number)
  if (n.length !== 8 || n.some((v) => !Number.isFinite(v))) return null
  const pt = (i: number): { x: number; y: number } => ({ x: n[i] * width, y: n[i + 1] * height })
  return [pt(0), pt(2), pt(4), pt(6)]
}

/** The stub corner source: corners come only from a `?corners=` URL override; with
 *  none present it returns null and the pipeline falls back to the raw crop (so the
 *  live app is unchanged until a real detector exists). `search` is injectable for
 *  tests; it defaults to the live query string in the browser. */
export function manualCornerSource(search?: string): CornerSource {
  const query = search ?? (typeof location !== 'undefined' ? location.search : '')
  const raw = new URLSearchParams(query).get('corners')
  return {
    id: 'stub-manual-corners',
    corners: (width, height) => parseCornersParam(raw, width, height),
  }
}
