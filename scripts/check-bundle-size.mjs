#!/usr/bin/env node
// First-load byte-budget gate — CLI (PLAN.md decision #2 / issue #3).
//
// watchthedrift is zero-install: it must load fast on a mid-range phone over
// cellular. PLAN.md fixes a tight on-device budget — "≤ ~5 MB total first-load"
// (both future models ≤ ~1.5 MB int8 + a lean wasm-SIMD runtime). This is the CI
// guardrail that keeps that promise from silently regressing as the learned
// corner detector + reader (issues #9, #10) and their runtime land. The pass/fail
// *decision* lives in bundle-budget.mjs (pure, unit-tested); this file does the
// I/O: walk dist/, feed the file list in, print a legible table, set the exit code.
//
// WHAT COUNTS AS "FIRST-LOAD" (the payload the browser downloads to render the
// screen and perform the first reading):
//
//   COUNTED
//     • dist/index.html                      — the entry document
//     • dist/assets/**                       — Vite's bundled app: the entry JS,
//                                              CSS, and any code-split/preloaded
//                                              chunks. (A model imported through
//                                              the module graph, e.g. `?url`, also
//                                              lands here and is counted for free.)
//     • files matching EAGER_RUNTIME_ASSETS  — model/runtime assets the app
//                                              FETCHES AT RUNTIME at or before the
//                                              first reading. These are copied from
//                                              public/ to the dist root (NOT into
//                                              assets/), so they must be declared
//                                              explicitly. Empty today — no model
//                                              yet. Issue #9 registers its model
//                                              here when it lands.
//
//   NOT COUNTED (lazy / passthrough — present in dist/ but not fetched at first load)
//     • Any other public/ passthrough file. Today that is the *unwired* Tesseract
//       data (dist/traineddata/digits.traineddata, ~1.4 MB): it sits in the output
//       but nothing references or fetches it (Tesseract is dropped in issue #11),
//       so it is not part of first-load. It is still LISTED below with its size,
//       and — because it is large — FLAGGED, so a genuinely-eager model that
//       someone forgot to declare can never hide here and slip under the gate.
//     • *.map sourcemaps — dev-only, browsers don't fetch them for users.
//
// Conservative by design: counting all of assets/** treats any future *lazy*
// dynamic-import chunk as first-load too. That over-counts (fails loud) rather
// than under-counts (lets a regression through) — the right bias for a budget.
//
// Exit codes: 0 = within budget · 1 = over budget · 2 = nothing to measure.
// Run after `npm run build`:  node scripts/check-bundle-size.mjs  (npm run size)

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBudget } from './bundle-budget.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = join(ROOT, 'dist')

/** Recursively list every file under `dir` as absolute paths. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/** Bytes → human string (binary units), e.g. 26021 → "25.41 KB". */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(2)} ${units[i]}`
}

/** Print an aligned table of file rows ({rel, bytes, warn?}); returns summed bytes. */
function printRows(rows) {
  if (rows.length === 0) {
    console.log('    (none)')
    return 0
  }
  const width = Math.max(...rows.map((f) => `dist/${f.rel}`.length))
  let total = 0
  for (const f of rows) {
    total += f.bytes
    const note = f.warn
      ? '   ⚠ large — if fetched at/before the first reading, add it to EAGER_RUNTIME_ASSETS'
      : ''
    console.log(`    ${`dist/${f.rel}`.padEnd(width)}  ${human(f.bytes).padStart(9)}${note}`)
  }
  return total
}

// ── Main ────────────────────────────────────────────────────────────────────

if (!existsSync(DIST_DIR)) {
  console.error(`✗ ${relative(ROOT, DIST_DIR)}/ not found — run \`npm run build\` first.`)
  process.exit(2)
}

const files = walk(DIST_DIR)
  .map((abs) => ({ rel: relative(DIST_DIR, abs).split('\\').join('/'), bytes: statSync(abs).size }))
  .sort((a, b) => a.rel.localeCompare(b.rel))

if (files.length === 0) {
  console.error(`✗ ${relative(ROOT, DIST_DIR)}/ is empty — run \`npm run build\` first.`)
  process.exit(2)
}

const { firstLoad, uncounted, firstLoadTotal, budgetBytes, over, withinBudget } =
  computeBudget(files)

console.log(`\nFirst-load byte-budget — budget ${human(budgetBytes)} (${budgetBytes} bytes)\n`)
console.log('  counted as first-load:')
printRows(firstLoad)
console.log(`  ${'─'.repeat(48)}`)
console.log(
  `    first-load total  ${human(firstLoadTotal).padStart(9)}   (${(
    (firstLoadTotal / budgetBytes) *
    100
  ).toFixed(1)}% of budget)\n`,
)

if (uncounted.length > 0) {
  console.log('  not counted (lazy / passthrough — not fetched at first load):')
  printRows(uncounted)
  console.log('')
}

if (!withinBudget) {
  console.error(
    `✗ first-load ${human(firstLoadTotal)} exceeds the ${human(budgetBytes)} budget by ${human(
      over,
    )}.`,
  )
  process.exit(1)
}
console.log(`✓ first-load ${human(firstLoadTotal)} is within the ${human(budgetBytes)} budget.`)
