// What region of the camera frame the recogniser reads.
//
// v2 drops the alignment box (issue #12): the learned corner detector finds the LCD
// anywhere in frame, so we feed it the WHOLE frame and let it locate the watch —
// the region is FULL_FRAME by default. A `?crop=w,h,cx,cy` debug override (fractions
// 0..1) can still restrict it to a sub-rectangle for dev work, mapped 1:1 onto the
// live frame (the viewfinder's aspect-ratio matches the camera's).

export interface NormCrop {
  cx: number
  cy: number
  w: number
  h: number
}

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/** The whole camera frame — the default region fed to the recogniser now that the
 *  alignment box is gone (issue #12). The learned corner detector localises the LCD
 *  within it (and on abstain the decoder flood-fills for the LCD itself), so there's
 *  nothing for the user to line up. */
export const FULL_FRAME: NormCrop = { cx: 0.5, cy: 0.5, w: 1, h: 1 }

export function cropToPixels(c: NormCrop, frameW: number, frameH: number): PixelRect {
  const w = Math.round(c.w * frameW)
  const h = Math.round(c.h * frameH)
  return {
    x: Math.round(c.cx * frameW - w / 2),
    y: Math.round(c.cy * frameH - h / 2),
    w,
    h,
  }
}

/** Debug crop override from ?crop=w,h,cx,cy (fractions). null if absent/invalid. */
export function cropOverride(): NormCrop | null {
  const raw = new URLSearchParams(location.search).get('crop')
  if (!raw) return null
  const parts = raw.split(',').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [w, h, cx, cy] = parts
  return { w, h, cx, cy }
}
