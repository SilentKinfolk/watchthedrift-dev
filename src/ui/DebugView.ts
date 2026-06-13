// Optional diagnostics, shown only with ?debug=1 in the URL. Surfaces the colour
// scene the decoder saw, the cropped LCD it locked onto (binarised, with its
// band/cell boxes), and the raw decode string + confidence — what we stare at
// while tuning recognition on a real watch.

export function isDebug(): boolean {
  return new URLSearchParams(location.search).has('debug')
}

export interface DebugInfo {
  /** Colour crop of the capture region — the whole scene the decoder searched. */
  scene?: HTMLCanvasElement
  /** The detected LCD, cropped + binarised + annotated (null if none found). */
  decoded?: HTMLCanvasElement
  raw: string
  confidence?: number
  /** Capture-region fractions, for reference. */
  crop?: { cx: number; cy: number; w: number; h: number }
}

export function renderDebug(container: HTMLElement, info: DebugInfo): void {
  container.innerHTML = ''

  const title = document.createElement('div')
  title.className = 'debug-title'
  title.textContent = 'debug — what the reader sees'
  container.appendChild(title)

  if (info.scene) {
    container.appendChild(caption('scene (what the camera saw)'))
    info.scene.className = 'debug-canvas'
    container.appendChild(info.scene)
  }
  if (info.decoded) {
    container.appendChild(caption('detected LCD (cropped, binarised + boxes)'))
    info.decoded.className = 'debug-canvas'
    container.appendChild(info.decoded)
  } else {
    container.appendChild(caption('no LCD detected in that frame'))
  }

  const meta = document.createElement('pre')
  meta.className = 'debug-meta'
  const lines = [`decode: ${JSON.stringify(info.raw)}`]
  if (info.confidence != null) lines.push(`confidence: ${(info.confidence * 100).toFixed(0)}%`)
  if (info.crop) {
    lines.push(`capture w,h,cx,cy: ${info.crop.w},${info.crop.h},${info.crop.cx},${info.crop.cy}`)
  }
  meta.textContent = lines.join('\n')
  container.appendChild(meta)

  // Temporary sharing aid: copy an image as a data URL to paste into chat.
  const fallback = document.createElement('textarea')
  fallback.className = 'debug-fallback'
  fallback.readOnly = true
  fallback.hidden = true

  const copyBtn = (label: string, getData: () => string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = 'btn'
    b.textContent = label
    b.addEventListener('click', async () => {
      const data = getData()
      try {
        await navigator.clipboard.writeText(data)
        b.textContent = `${label} ✓`
      } catch {
        fallback.value = data
        fallback.hidden = false
        fallback.focus()
        fallback.select()
      }
    })
    return b
  }

  const share = document.createElement('div')
  share.className = 'debug-share'
  if (info.scene) {
    share.appendChild(copyBtn('copy scene', () => info.scene!.toDataURL('image/jpeg', 0.6)))
  }
  if (info.decoded) {
    share.appendChild(copyBtn('copy LCD', () => info.decoded!.toDataURL('image/png')))
  }
  container.append(share, fallback)
}

function caption(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'debug-title'
  el.textContent = text
  return el
}
