// Shared pixel utilities. `toGray` + `otsuThreshold` are the building blocks the
// segment decoder composes (segments.ts owns its own two-stage binarisation:
// global Otsu to find the LCD, then a sensitive adaptive pass within it). The
// in-place `binarize` (plain global Otsu) is kept for the Tesseract preprocess
// path. All pure, so the browser app and the Node harness run identical logic.

/** Luma (Rec. 601) of an RGBA buffer, one byte per pixel. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height
  const gray = new Uint8Array(n)
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    gray[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0
  }
  return gray
}

export function histogram(gray: Uint8Array): number[] {
  const hist = new Array<number>(256).fill(0)
  for (let p = 0; p < gray.length; p++) hist[gray[p]]++
  return hist
}

/** Plain global-Otsu binarisation, mutating RGBA in place to black-on-white. */
export function binarize(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): { threshold: number } {
  const gray = toGray(rgba, width, height)
  const threshold = otsuThreshold(histogram(gray), width * height)
  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    const v = gray[p] <= threshold ? 0 : 255 // dark pixels (digits) → black on white
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  return { threshold }
}

/** Otsu's method: the global threshold maximising between-class variance. */
export function otsuThreshold(hist: number[], total: number): number {
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }
  return threshold
}
