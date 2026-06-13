import type { PixelRect } from './geometry'

// Crops the capture region out of the camera frame and scales it to a workable
// size. It does NOT binarise: the segment decoder owns binarisation (it needs the
// grayscale to threshold each detected LCD locally), so we hand it the raw pixels.

export interface Preprocessed {
  canvas: HTMLCanvasElement
  imageData: ImageData
}

/** Upscale tiny crops so there are enough pixels to work with. */
const MIN_OCR_WIDTH = 600
/** Downscale big captures (we feed the decoder a large region) so the longest
 *  side is at most this — keeps the flood fill fast and matches the harness. */
const MAX_DECODE_LONGEST = 1600

export function preprocess(source: HTMLCanvasElement, crop: PixelRect): Preprocessed {
  const sx = Math.max(0, Math.min(crop.x, source.width - 1))
  const sy = Math.max(0, Math.min(crop.y, source.height - 1))
  const sw = Math.max(1, Math.min(crop.w, source.width - sx))
  const sh = Math.max(1, Math.min(crop.h, source.height - sy))

  const longest = Math.max(sw, sh)
  let scale = 1
  if (sw < MIN_OCR_WIDTH) scale = MIN_OCR_WIDTH / sw
  else if (longest > MAX_DECODE_LONGEST) scale = MAX_DECODE_LONGEST / longest
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)

  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh)

  const img = ctx.getImageData(0, 0, dw, dh)
  return { canvas, imageData: img }
}
