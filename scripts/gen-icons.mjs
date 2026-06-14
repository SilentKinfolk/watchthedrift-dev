#!/usr/bin/env node
// Generate the PWA icons (issue #13). Build-time tool, not shipped — it writes the
// committed PNGs under public/ that the web app manifest references and the service
// worker precaches. Re-run after a design tweak:  node scripts/gen-icons.mjs
//
// The mark is on-brand: black-and-white, close-to-raw, no font dependency (pure
// geometry, so it renders identically headless). A clock rim with the minute hand on
// true 12 and a thin second hand that has slipped just off it — "watch the drift",
// the whole product in one glyph. All ink sits well inside the central 80% safe zone,
// so the same art doubles as the maskable icon (full-bleed black, OS masks the rest).

import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** Draw the icon at `size`px and return a PNG buffer. */
function drawIcon(size) {
  const c = createCanvas(size, size)
  const x = c.getContext('2d')

  // Full-bleed black tile (a dark app icon; also valid as a maskable background).
  x.fillStyle = '#000'
  x.fillRect(0, 0, size, size)

  const cx = size / 2
  const cy = size / 2
  const r = size * 0.34 // rim radius — diameter 0.68·size, inside the 0.8 safe zone
  x.strokeStyle = '#fff'
  x.fillStyle = '#fff'
  x.lineCap = 'round'

  // Clock rim.
  x.lineWidth = size * 0.045
  x.beginPath()
  x.arc(cx, cy, r, 0, Math.PI * 2)
  x.stroke()

  // A hand at `deg` clockwise from 12 o'clock (0 = up), drawn from the centre.
  const hand = (deg, len, w) => {
    const a = ((deg - 90) * Math.PI) / 180
    x.lineWidth = w
    x.beginPath()
    x.moveTo(cx, cy)
    x.lineTo(cx + Math.cos(a) * len * r, cy + Math.sin(a) * len * r)
    x.stroke()
  }

  hand(60, 0.5, size * 0.05) // hour hand → ~2 o'clock
  hand(0, 0.74, size * 0.04) // minute hand → true 12
  hand(20, 0.74, size * 0.022) // thin second hand, drifted just off 12 — the point

  // Centre pin (covers the three hand origins).
  x.beginPath()
  x.arc(cx, cy, size * 0.032, 0, Math.PI * 2)
  x.fill()

  return c.toBuffer('image/png')
}

const icons = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512], // same art; manifest tags it purpose=maskable
  ['apple-touch-icon.png', 180], // iOS home-screen icon (non-transparent, black bg)
]

for (const [name, size] of icons) {
  writeFileSync(join(OUT, name), drawIcon(size))
  console.log(`wrote public/${name} (${size}×${size})`)
}
