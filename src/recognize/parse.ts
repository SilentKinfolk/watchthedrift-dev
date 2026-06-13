import type { WatchReading } from '../drift/Drift'

// Turns raw OCR text (digits and colons, post-whitelist) into a validated
// HH:MM:SS reading, or null if it doesn't look like a plausible time. Kept
// dependency-free so it can be unit-tested without the OCR engine. This is
// best-effort and expected to be tuned against real reads via the debug view.

export function parseTime(raw: string, is24h: boolean): WatchReading | null {
  const cleaned = raw.replace(/[^\d:]/g, '')

  let hh: number
  let mm: number
  let ss: number

  // Prefer a colon-anchored match (handles "10:42:15" and "10:4215").
  const m = cleaned.match(/(\d{1,2}):(\d{2}):?(\d{2})/)
  if (m) {
    hh = +m[1]
    mm = +m[2]
    ss = +m[3]
  } else {
    // Otherwise fall back to a bare digit run: HHMMSS, or H MM SS in 12h mode.
    const digits = cleaned.replace(/\D/g, '')
    if (digits.length === 6) {
      hh = +digits.slice(0, 2)
      mm = +digits.slice(2, 4)
      ss = +digits.slice(4, 6)
    } else if (digits.length === 5) {
      hh = +digits.slice(0, 1)
      mm = +digits.slice(1, 3)
      ss = +digits.slice(3, 5)
    } else {
      return null
    }
  }

  if (mm > 59 || ss > 59) return null
  if (is24h ? hh > 23 : hh < 1 || hh > 12) return null
  return { hh, mm, ss }
}
