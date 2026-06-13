// Pure, I/O-free first-load byte-budget logic (issue #3 / PLAN.md decision #2).
//
// This module owns the *decision* — given a list of built files, which are
// first-load and is the total within budget — so it can be unit-tested
// deterministically (bundle-budget.test.ts), exactly like the app's other
// pure seams (parse, Drift, TimeSync). The CLI wrapper (check-bundle-size.mjs)
// does the I/O: walk dist/, feed the file list here, print, set the exit code.
//
// See check-bundle-size.mjs for the full prose on WHAT COUNTS as first-load.

/** The first-load budget. Single source of truth — bump this one constant. */
export const BUDGET_BYTES = 5 * 1024 * 1024 // ~5 MB (5 MiB)

/**
 * Glob patterns (dist-relative, forward slashes) for model/runtime assets the
 * app fetches at runtime at/before the first reading — i.e. public/ passthrough
 * assets that must count toward first-load even though they aren't bundled into
 * assets/**. EMPTY until a model lands; issue #9 adds e.g. 'models/**' or a
 * specific 'models/corner-v1.onnx'. Supports `*` (intra-segment) and `**` (any).
 */
export const EAGER_RUNTIME_ASSETS = []

/** Uncounted files at/above this size are flagged — catches a forgotten eager asset. */
export const WARN_UNCOUNTED_BYTES = 256 * 1024 // 256 KiB

/** Anchored regex for a glob supporting `*` (intra-segment) and `**` (any). */
export function globToRegExp(glob) {
  const body = glob
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'),
    )
    .join('')
  return new RegExp(`^${body}$`)
}

/** Is this dist-relative path part of the first-load payload? */
export function isFirstLoad(rel, eagerAssets = EAGER_RUNTIME_ASSETS) {
  if (rel.endsWith('.map')) return false // sourcemaps: dev-only, not fetched
  if (rel === 'index.html') return true // the entry document
  if (rel.startsWith('assets/')) return true // Vite's bundled app (JS/CSS/chunks)
  return eagerAssets.some((g) => globToRegExp(g).test(rel)) // declared eager runtime assets
}

/**
 * Classify built files and total the first-load payload.
 * @param {{rel: string, bytes: number}[]} files  dist-relative path + size
 * @param {{budgetBytes?: number, eagerAssets?: string[], warnBytes?: number}} [opts]
 * @returns report: first-load + uncounted partitions, total, and pass/fail.
 */
export function computeBudget(files, opts = {}) {
  const budgetBytes = opts.budgetBytes ?? BUDGET_BYTES
  const eagerAssets = opts.eagerAssets ?? EAGER_RUNTIME_ASSETS
  const warnBytes = opts.warnBytes ?? WARN_UNCOUNTED_BYTES

  const firstLoad = []
  const uncounted = []
  for (const f of files) {
    if (isFirstLoad(f.rel, eagerAssets)) firstLoad.push(f)
    else uncounted.push({ ...f, warn: f.bytes >= warnBytes })
  }

  const firstLoadTotal = firstLoad.reduce((sum, f) => sum + f.bytes, 0)
  const over = firstLoadTotal - budgetBytes
  return { firstLoad, uncounted, firstLoadTotal, budgetBytes, over, withinBudget: over <= 0 }
}
