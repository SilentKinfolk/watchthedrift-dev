// Geometric rectification: given the four corners of the LCD in a frame, warp it
// to a frontal, axis-aligned crop so the (perspective-naive) v1 segment decoder
// sees an upright display. This is the deterministic homography step of PLAN's
// pipeline — `corner detector → homography → frontal crop → reader`. Pure, so the
// browser app and the Node harness share identical maths.
//
// The v1 decoder splits digit cells by vertical column gaps and samples seven
// FIXED normalized rectangles per cell — both assume an upright, frontal digit.
// Rotation/skew breaks it and cannot be patched out of the reader, so something
// upstream must hand it a frontal crop. That is exactly this module.

export interface Pt {
  x: number
  y: number
}

/** Four corners of a quad, in TL, TR, BR, BL order (clockwise from top-left). */
export type Quad = readonly [Pt, Pt, Pt, Pt]

/** Projective transform as 8 coefficients [a,b,c,d,e,f,g,h] with the conventional
 *  h33 = 1. Maps (x,y) → ((ax+by+c)/(gx+hy+1), (dx+ey+f)/(gx+hy+1)). */
export type Homography = readonly number[]

export interface RawImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Solve the homography that maps the `from` quad onto the `to` quad (i.e.
 * `to = H · from`), via the standard 4-point DLT: each corner contributes two
 * linear equations, giving an 8×8 system we solve with Gaussian elimination and
 * partial pivoting. Returns null for a degenerate/ill-conditioned correspondence
 * (collinear or coincident points → singular system), so callers fail safe rather
 * than propagate NaNs.
 */
export function solveHomography(from: Quad, to: Quad): Homography | null {
  for (const p of [...from, ...to]) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
  }
  // Unknowns u = [a,b,c,d,e,f,g,h]; rows of M·u = r, two per correspondence.
  const M: number[][] = []
  const r: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]
    const { x: X, y: Y } = to[i]
    M.push([x, y, 1, 0, 0, 0, -x * X, -y * X])
    r.push(X)
    M.push([0, 0, 0, x, y, 1, -x * Y, -y * Y])
    r.push(Y)
  }
  return solveLinear(M, r)
}

/** Map a single point through a homography. */
export function applyHomography(h: Homography, x: number, y: number): Pt {
  const denom = h[6] * x + h[7] * y + 1
  return {
    x: (h[0] * x + h[1] * y + h[2]) / denom,
    y: (h[3] * x + h[4] * y + h[5]) / denom,
  }
}

/**
 * Bilinearly sample an RGBA image at fractional (x,y), clamping to the edge.
 * Returns a 4-tuple [r,g,b,a]. Edge clamp means out-of-bounds taps read the
 * nearest border pixel rather than transparent — corners sit inside the frame in
 * practice, and a hard clamp keeps the warp's border clean.
 */
export function sampleBilinear(img: RawImage, x: number, y: number): [number, number, number, number] {
  const { data, width, height } = img
  const x0 = clampInt(Math.floor(x), 0, width - 1)
  const y0 = clampInt(Math.floor(y), 0, height - 1)
  const x1 = clampInt(x0 + 1, 0, width - 1)
  const y1 = clampInt(y0 + 1, 0, height - 1)
  const fx = x - Math.floor(x)
  const fy = y - Math.floor(y)
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    const p00 = data[(y0 * width + x0) * 4 + c]
    const p10 = data[(y0 * width + x1) * 4 + c]
    const p01 = data[(y1 * width + x0) * 4 + c]
    const p11 = data[(y1 * width + x1) * 4 + c]
    const top = p00 + (p10 - p00) * fx
    const bot = p01 + (p11 - p01) * fx
    out[c] = Math.round(top + (bot - top) * fy)
  }
  return out
}

/**
 * Warp the quad `corners` of `src` into a frontal `width`×`height` crop. For each
 * output pixel we map its centre back into the source via the homography
 * (out-rectangle → source corners) and bilinearly sample — an inverse warp, which
 * avoids holes. Returns null if `corners` are degenerate or the output size is
 * invalid, so the caller can fall back to the raw crop.
 */
export function rectify(src: RawImage, corners: Quad, out: { width: number; height: number }): RawImage | null {
  const width = Math.round(out.width)
  const height = Math.round(out.height)
  if (!(width >= 1) || !(height >= 1)) return null
  // Map the output rectangle's corners onto the source quad (TL,TR,BR,BL).
  const rect: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  const h = solveHomography(rect, corners)
  if (!h) return null

  const data = new Uint8ClampedArray(width * height * 4)
  for (let oy = 0; oy < height; oy++) {
    for (let ox = 0; ox < width; ox++) {
      const s = applyHomography(h, ox + 0.5, oy + 0.5)
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return null
      const [r, g, b, a] = sampleBilinear(src, s.x, s.y)
      const i = (oy * width + ox) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a === 0 ? 255 : a
    }
  }
  return { data, width, height }
}

/**
 * Pick a frontal output size for a rectified quad that preserves its on-screen
 * aspect ratio (so digits aren't stretched), with the long side capped at
 * TARGET_LONG. A fixed canonical size will come with the learned reader (#10);
 * until then, preserving aspect keeps the v1 decoder's segment sampling honest.
 */
export function rectifiedSize(corners: Quad, targetLong = 520): { width: number; height: number } {
  const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
  const w = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2
  const h = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2
  if (!(w > 0) || !(h > 0)) return { width: targetLong, height: targetLong }
  if (w >= h) return { width: targetLong, height: Math.max(1, Math.round((targetLong * h) / w)) }
  return { width: Math.max(1, Math.round((targetLong * w) / h)), height: targetLong }
}

/** Solve M·u = r for an n×n system (Gaussian elimination, partial pivoting).
 *  Returns null if singular. */
function solveLinear(M: number[][], r: number[]): number[] | null {
  const n = r.length
  // Augmented matrix [M | r].
  const a = M.map((row, i) => [...row, r[i]])
  for (let col = 0; col < n; col++) {
    // Partial pivot: largest-magnitude entry in this column at/under the diagonal.
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null // singular / ill-conditioned
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    // Eliminate below.
    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / a[col][col]
      if (factor === 0) continue
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k]
    }
  }
  // Back-substitute.
  const u = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row][n]
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * u[k]
    u[row] = sum / a[row][row]
  }
  return u.every(Number.isFinite) ? u : null
}

function clampInt(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}
