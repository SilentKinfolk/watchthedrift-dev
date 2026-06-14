// The CornerSource seam — where the four LCD corners come from.
//
// The rectification stage (issue #4) wired up `corners → homography → frontal crop
// → reader` behind a manual stub (below) so it was exercisable before any model
// existed. Issue #9 lands the real implementation — `KernelCornerSource`, which
// runs the bespoke inference kernel — at this same seam. The manual stub stays for
// the `?corners=` debug override; production swaps in the kernel source at the one
// call site (the recognizer's constructor).

import type { Quad, RawImage } from './rectify.ts'

/** Supplies the four LCD corners for a frame, or null to abstain — in which case the
 *  recognizer reads the raw crop unchanged (so a non-detection is fail-safe, never
 *  worse than v1). Implemented by the manual stub (debug) and `KernelCornerSource`
 *  (the learned detector). The learned source needs the frame PIXELS, not just its
 *  size — hence `RawImage`, not `(width, height)` as the #4 stub had it. */
export interface CornerSource {
  readonly id: string
  /** Optional async load of model assets; the recognizer awaits it in `init()`. */
  init?(): Promise<void>
  corners(image: RawImage): Quad | null
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
    corners: (image) => parseCornersParam(raw, image.width, image.height),
  }
}

/** Compose corner sources by priority: the first to return a quad wins; `init()`
 *  initialises all of them. Lets the `?corners=` debug override sit in front of the
 *  learned detector (a dev can force corners), with the detector as the default. */
export function firstAvailable(...sources: CornerSource[]): CornerSource {
  return {
    id: `first(${sources.map((s) => s.id).join(',')})`,
    async init(): Promise<void> {
      for (const s of sources) await s.init?.()
    },
    corners(image: RawImage): Quad | null {
      for (const s of sources) {
        const q = s.corners(image)
        if (q) return q
      }
      return null
    },
  }
}
