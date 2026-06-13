// Custom Casio F-91W seven-segment decoder — the primary recogniser (general
// OCR proved unreliable on this rigid font). Pure: operates on a raw RGBA frame
// (the camera view, or any framing of the watch) and owns all binarisation, so
// the browser app and the Node harness share identical logic.
//
// Pipeline:
//  0. Binarise with global Otsu — this keeps the dark case/bezel solidly black,
//     which step 1 needs. (We tried OR-ing in an adaptive local threshold to
//     recover faint segments, but the F-91W LCD's subtle background mottling
//     reads as speckle under any window/C aggressive enough to help, so a single
//     global threshold is both simpler and more reliable. Genuinely faint shots
//     fall to the app's retake flow.)
//  1. Auto-detect the LCD: collect the largest bright (non-ink) regions as
//     candidate panels. The dark case AND the dark digits both binarise to black,
//     so the bright LCD background is the anchor — and there's no need for a tight
//     crop, we just search the frame. Other bright things (a wall, a window) come
//     up as extra candidates and get rejected in step 4 (decode-to-verify).
//  2. For each candidate: find the tall band of big HH:MM digits.
//  3. Split it into digit cells + colon by column gaps.
//  4. Read each digit by sampling its seven segment regions (on/off → digit), and
//     assemble HH:MM:SS. Keep the highest-confidence candidate that yields a VALID
//     time — only the real display does, so framing can be loose.
// Lots of tunable constants — refine against the harness overlay (tools/out/).

import { toGray, histogram, otsuThreshold } from './binarize.ts'

export interface SegmentReading {
  hh: number
  mm: number
  ss: number
  confidence: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface CellDebug extends Box {
  digit: number | null
  conf: number
  kind: 'big' | 'small' | 'colon'
  /** Per-segment ink fractions [A,B,C,D,E,F,G], for tuning. */
  frac?: number[]
}

export interface DecodeDebug {
  /** Frame-coords box of the chosen LCD candidate (where it was found). */
  lcd: Box | null
  /** The cropped LCD that was decoded, binarised with its own local threshold —
   *  the clean b&w to display (ink: 1 = dark), sized width×height. bigBand and
   *  cells are in THESE crop coordinates. */
  crop: { ink: Uint8Array; width: number; height: number } | null
  /** Big-digit band, in crop coordinates. */
  bigBand: Box | null
  /** Cells, in crop coordinates. */
  cells: CellDebug[]
  note: string
}

export interface DecodeResult {
  reading: SegmentReading | null
  debug: DecodeDebug
}

const A = 1
const B = 2
const C = 4
const D = 8
const E = 16
const F = 32
const G = 64

const PATTERNS: Array<[number, number]> = [
  [0, A | B | C | D | E | F],
  [1, B | C],
  [2, A | B | G | E | D],
  [3, A | B | G | C | D],
  [4, F | G | B | C],
  [5, A | F | G | C | D],
  [6, A | F | G | E | C | D],
  [7, A | B | C],
  [8, A | B | C | D | E | F | G],
  [9, A | B | C | D | F | G],
]

const INK = 0.04 // min ink fraction to treat a row/column as "content"
const SEG_ON = 0.4 // min ink fraction for a segment to count as lit

// Auto-detect candidate filtering: ignore bright blobs too small to be a
// readable display. The real LCD is among the largest few; decode-to-verify
// sorts out which. These bound how many regions we bother decoding.
const MIN_CAND_AREA_FRAC = 0.0015 // share of the frame
const MIN_CAND_W = 50 // px (in the working-resolution frame)
const MIN_CAND_H = 18 // px
const MAX_CANDIDATES = 12 // decode at most this many, largest first

export function decodeSegments(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): DecodeResult {
  const n = width * height
  const gray = toGray(data, width, height)

  // Detection pass: a global-Otsu mask over the input (the app's boxed crop, or a
  // full frame in the harness) — dark digits AND dark case/bezel → 1 — just to
  // LOCATE bright LCD candidates. Reading happens later, per candidate, on its own
  // local threshold — so the dark watch body never muddies the digits' b&w.
  const globalOtsu = otsuThreshold(histogram(gray), n)
  const ink = new Uint8Array(n)
  for (let p = 0; p < n; p++) ink[p] = gray[p] <= globalOtsu ? 1 : 0

  const debug: DecodeDebug = { lcd: null, crop: null, bigBand: null, cells: [], note: '' }

  // 1. Candidate LCD panels = the largest bright connected regions (biggest
  //    first). We search the whole input: the app hands us a tight box around the
  //    time row, but the decoder still locates the LCD within it (and tolerates a
  //    looser crop, as in the harness).
  const candidates = brightBoxes(ink, width, height)
  if (candidates.length === 0) {
    debug.note = 'no bright regions'
    return { reading: null, debug }
  }

  // 2. Crop + locally binarise + decode each candidate; keep the highest-confidence
  //    VALID reading. Only the real display yields a valid HH:MM:SS, so other bright
  //    regions in the frame (a wall, a window, paper) are rejected automatically.
  let best: CandidateResult | null = null
  let bestConf = -1
  // Best partial decode, for the debug overlay when nothing reads cleanly — the
  // candidate with the most digit cells is almost always the real LCD (far more
  // useful to show than the largest blank bright blob).
  let fallback: CandidateResult | null = null
  let fallbackDigits = -1
  for (const cand of candidates) {
    const r = decodeCandidate(gray, width, cand)
    const digitCount = r.cells.reduce((k, c) => k + (c.digit != null ? 1 : 0), 0)
    if (digitCount > fallbackDigits) {
      fallbackDigits = digitCount
      fallback = r
    }
    if (r.reading && r.reading.confidence > bestConf) {
      best = r
      bestConf = r.reading.confidence
    }
  }

  const chosen = best ?? fallback!
  debug.lcd = chosen.lcd
  debug.crop = { ink: chosen.cropInk, width: chosen.cw, height: chosen.ch }
  debug.bigBand = chosen.bigBand
  debug.cells = chosen.cells
  debug.note = best ? chosen.note : `none (${chosen.note})`
  return { reading: best ? best.reading : null, debug }
}

interface CandidateResult {
  reading: SegmentReading | null
  /** The candidate's box in frame coordinates. */
  lcd: Box
  /** Locally-binarised crop of the candidate (1 = dark), sized cw×ch. */
  cropInk: Uint8Array
  cw: number
  ch: number
  /** Big-digit band + cells, in CROP coordinates. */
  bigBand: Box | null
  cells: CellDebug[]
  note: string
}

/**
 * Crop one candidate LCD box out of the grayscale frame, binarise it with its OWN
 * Otsu threshold (so the digits separate cleanly from the LCD background, free of
 * the dark watch body that dominates a whole-frame threshold), then decode:
 * find the big-digit band, split into cells + colon by column gaps, read each
 * digit, assemble. A candidate that isn't a display fails a check (no ink band /
 * no colon / out of range) → reading=null. All boxes returned in crop coordinates.
 */
function decodeCandidate(gray: Uint8Array, width: number, lcd: Box): CandidateResult {
  const ins = Math.max(1, Math.round(Math.min(lcd.w, lcd.h) * 0.03))
  const cx0 = lcd.x + ins
  const cy0 = lcd.y + ins
  const cw = lcd.w - 2 * ins
  const ch = lcd.h - 2 * ins
  const cells: CellDebug[] = []
  if (cw < 10 || ch < 10) {
    return { reading: null, lcd, cropInk: new Uint8Array(0), cw: 0, ch: 0, bigBand: null, cells, note: 'lcd too small' }
  }

  // Local Otsu on just this crop → a threshold tuned to LCD-bg vs. digits.
  const hist = new Array<number>(256).fill(0)
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) hist[gray[(cy0 + y) * width + (cx0 + x)]]++
  const localOtsu = otsuThreshold(hist, cw * ch)
  const cropInk = new Uint8Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) cropInk[y * cw + x] = gray[(cy0 + y) * width + (cx0 + x)] <= localOtsu ? 1 : 0
  }

  const at = (x: number, y: number): number => cropInk[y * cw + x]
  const rowFrac = (y: number, x0: number, x1: number): number => {
    let s = 0
    for (let x = x0; x < x1; x++) s += cropInk[y * cw + x]
    return s / (x1 - x0)
  }
  const colFrac = (x: number, y0: number, y1: number): number => {
    let s = 0
    for (let y = y0; y < y1; y++) s += cropInk[y * cw + x]
    return s / (y1 - y0)
  }
  const result = (reading: SegmentReading | null, bigBand: Box | null, note: string): CandidateResult => ({
    reading,
    lcd,
    cropInk,
    cw,
    ch,
    bigBand,
    cells,
    note,
  })

  // 2. Tallest horizontal ink band = the big HH:MM digits.
  const rowMask: boolean[] = []
  for (let y = 0; y < ch; y++) rowMask.push(rowFrac(y, 0, cw) > INK)
  const bands = runs(rowMask)
  if (bands.length === 0) return result(null, null, 'no ink bands')
  const big = bands.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
  const by0 = big.start
  const by1 = big.end
  const bigBand: Box = { x: 0, y: by0, w: cw, h: by1 - by0 }

  // 3. Split the band into column runs (digits + colon).
  const colMask: boolean[] = []
  for (let x = 0; x < cw; x++) colMask.push(colFrac(x, by0, by1) > INK)
  const groups = runs(colMask)
    .map((r) => tighten(at, r.start, r.end, by0, by1))
    .filter((g) => g.w > 1 && g.h > 1)
  if (groups.length === 0) return result(null, bigBand, 'no column groups')

  // Classify by the tallest digit (the colon/seconds are shorter; the median
  // would be dragged down by them).
  const maxH = Math.max(...groups.map((g) => g.h))
  const digW = median(groups.filter((g) => g.h >= maxH * 0.65).map((g) => g.w)) || maxH * 0.5

  // 4. Classify + decode each group.
  let confSum = 0
  let confN = 0
  let colonX = -1
  const digits: Array<{ x: number; digit: number }> = []

  for (const g of groups) {
    const tall = g.h >= maxH * 0.65
    const narrow = g.w < digW * 0.55
    if (!tall && narrow) {
      if (colonX < 0) colonX = g.x
      cells.push({ ...g, digit: null, conf: 1, kind: 'colon' })
      continue
    }
    // A "1" only inks its right side; widen the cell left to a full digit width.
    let cell: Box = g
    if (narrow && tall) cell = { x: Math.max(0, g.x - Math.round(digW - g.w)), y: g.y, w: Math.round(digW), h: g.h }
    const { digit, conf, frac } = sampleDigit(at, cell)
    confSum += conf
    confN++
    cells.push({ ...cell, digit, conf, kind: tall ? 'big' : 'small', frac })
    if (digit != null) digits.push({ x: g.x, digit })
  }

  digits.sort((a, b) => a.x - b.x)
  if (colonX < 0) return result(null, bigBand, 'no colon found')
  // Left of the colon = hours; after it, always MM then SS, left-to-right.
  const hours = digits.filter((d) => d.x < colonX).map((d) => d.digit)
  const afterColon = digits.filter((d) => d.x > colonX).map((d) => d.digit)
  const minutes = afterColon.slice(0, 2)
  const seconds = afterColon.slice(2, 4)
  if (hours.length < 1 || minutes.length < 2 || seconds.length < 2) {
    return result(null, bigBand, `parts h${hours.length} after${afterColon.length}`)
  }

  const toNum = (ds: number[]): number => ds.slice(-2).reduce((a, d) => a * 10 + d, 0)
  const hh = toNum(hours)
  const mm = toNum(minutes)
  const ss = toNum(seconds)
  if (hh > 23 || mm > 59 || ss > 59) return result(null, bigBand, `range ${hh}:${mm}:${ss}`)

  return result({ hh, mm, ss, confidence: confN ? confSum / confN : 0 }, bigBand, 'ok')
}

/**
 * The largest bright (non-ink) connected regions, biggest first — candidate LCD
 * panels. Both the dark case and the dark digits binarise to black, so the LCD
 * background is a large bright blob that flows around the digits; other bright
 * things in frame (walls, windows, paper) show up as separate candidates and are
 * filtered out by decode-to-verify upstream. Iterative flood fill, O(width·height).
 * Filters out blobs too small to be a readable display and caps the count.
 */
function brightBoxes(ink: Uint8Array, width: number, height: number): Box[] {
  const n = width * height
  const visited = new Uint8Array(n)
  const stack = new Int32Array(n)
  const minArea = Math.max(MIN_CAND_W * MIN_CAND_H, n * MIN_CAND_AREA_FRAC)
  const found: Array<{ box: Box; area: number }> = []
  for (let start = 0; start < n; start++) {
    if (visited[start] || ink[start]) continue
    let sp = 0
    stack[sp++] = start
    visited[start] = 1
    let area = 0
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % width
      const y = (p / width) | 0
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && !visited[p - 1] && !ink[p - 1]) (visited[p - 1] = 1), (stack[sp++] = p - 1)
      if (x + 1 < width && !visited[p + 1] && !ink[p + 1]) (visited[p + 1] = 1), (stack[sp++] = p + 1)
      if (y > 0 && !visited[p - width] && !ink[p - width]) (visited[p - width] = 1), (stack[sp++] = p - width)
      if (y + 1 < height && !visited[p + width] && !ink[p + width]) (visited[p + width] = 1), (stack[sp++] = p + width)
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (area >= minArea && w >= MIN_CAND_W && h >= MIN_CAND_H) {
      found.push({ box: { x: x0, y: y0, w, h }, area })
    }
  }
  found.sort((a, b) => b.area - a.area)
  return found.slice(0, MAX_CANDIDATES).map((f) => f.box)
}

/** Shrink a column run to the tight ink bounding box. */
function tighten(
  at: (x: number, y: number) => number,
  gx0: number,
  gx1: number,
  by0: number,
  by1: number,
): Box {
  let x0 = gx1
  let x1 = gx0
  let y0 = by1
  let y1 = by0
  for (let y = by0; y < by1; y++) {
    for (let x = gx0; x < gx1; x++) {
      if (at(x, y)) {
        if (x < x0) x0 = x
        if (x + 1 > x1) x1 = x + 1
        if (y < y0) y0 = y
        if (y + 1 > y1) y1 = y + 1
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function sampleDigit(
  at: (x: number, y: number) => number,
  cell: Box,
): { digit: number | null; conf: number; frac: number[] } {
  // Segment sample regions, normalised within the cell [x0,y0,x1,y1].
  const regions: Array<[number, number, number, number, number]> = [
    [A, 0.25, 0.0, 0.75, 0.2],
    [B, 0.74, 0.08, 1.0, 0.46],
    [C, 0.74, 0.54, 1.0, 0.92],
    [D, 0.25, 0.8, 0.75, 1.0],
    [E, 0.0, 0.54, 0.26, 0.92],
    [F, 0.0, 0.08, 0.26, 0.46],
    [G, 0.25, 0.4, 0.75, 0.6],
  ]
  let pattern = 0
  let margin = 1
  const frac: number[] = []
  for (const [seg, rx0, ry0, rx1, ry1] of regions) {
    const x0 = cell.x + Math.floor(rx0 * cell.w)
    const x1 = cell.x + Math.ceil(rx1 * cell.w)
    const y0 = cell.y + Math.floor(ry0 * cell.h)
    const y1 = cell.y + Math.ceil(ry1 * cell.h)
    let s = 0
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        s += at(x, y)
        n++
      }
    }
    const f = n ? s / n : 0
    frac.push(f)
    if (f > SEG_ON) pattern |= seg
    margin = Math.min(margin, Math.abs(f - SEG_ON))
  }
  let best: number | null = null
  let bestDiff = 99
  for (const [digit, pat] of PATTERNS) {
    const diff = popcount(pat ^ pattern)
    if (diff < bestDiff) {
      bestDiff = diff
      best = digit
    }
  }
  const conf = (bestDiff === 0 ? 1 : bestDiff === 1 ? 0.5 : 0.1) * (0.5 + margin)
  return { digit: bestDiff <= 1 ? best : null, conf, frac }
}

function runs(mask: boolean[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let s = -1
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && s < 0) s = i
    else if (!mask[i] && s >= 0) {
      out.push({ start: s, end: i })
      s = -1
    }
  }
  if (s >= 0) out.push({ start: s, end: mask.length })
  return out
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function popcount(n: number): number {
  let c = 0
  while (n) {
    c += n & 1
    n >>= 1
  }
  return c
}
