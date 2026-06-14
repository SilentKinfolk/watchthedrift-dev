// Corner-stage isolation metric (PLAN "Calibration … the corner-error metric gates
// the corner stage in isolation"; issue #11). The corner detector is the pipeline
// bottleneck (PLAN top-risk #3): wrong corners → wrong homography → garbage to the
// decoder. So we score it ALONE, not just end-to-end — predicted corners vs the
// hand-annotated eval-gold corners — before it ever feeds rectification.
//
// Metric: mean per-corner displacement normalised by the LCD diagonal — a
// scale-free "how far off, in LCD-widths" number. Normalising by the diagonal makes
// it comparable across a tiny distant LCD and a frame-filling one, and lets a single
// threshold mean the same thing on every image. (This mirrors train_corners.py's
// corner_error exactly, so the numpy training monitor and this TS harness metric
// agree.)
//
// Pure and dependency-free (corners in, number out) so it unit-tests deterministically
// and the harness imports it without dragging in image/model code — same discipline
// as metrics.ts. The gate mirrors metrics.evaluateGate: ADVISORY while the eval set
// is below a sample floor (the real-photo eval gold is scarce; PLAN top-risks #1/#3),
// enforced once it is large enough.

import type { Corners } from './label.ts'

/** Mean per-corner displacement (Euclidean) normalised by the truth LCD's TL→BR
 *  diagonal. Corners are in the SAME coordinate space (normalised [0,1] over the
 *  frame in the harness). Returns NaN for a degenerate (zero-diagonal) truth. */
export function cornerError(pred: Corners, truth: Corners): number {
  const dx = truth[2].x - truth[0].x
  const dy = truth[2].y - truth[0].y
  const diag = Math.hypot(dx, dy)
  if (!(diag > 0)) return NaN
  let sum = 0
  for (let i = 0; i < 4; i++) sum += Math.hypot(pred[i].x - truth[i].x, pred[i].y - truth[i].y)
  return sum / 4 / diag
}

/** One scored corner prediction: its stratum bucket and normalised error (or null
 *  when the detector ABSTAINED — no plausible quad — so abstains are counted, not
 *  silently treated as zero error). */
export interface CornerScore {
  stratum: string
  /** Normalised corner error, or null if the detector abstained on this image. */
  error: number | null
}

export interface CornerGroupMetrics {
  group: string
  /** Images with a labelled corner truth in this group. */
  total: number
  /** Of those, how many the detector produced a (plausible) quad for. */
  detected: number
  /** Mean normalised corner error over the DETECTED ones (NaN if none detected). */
  meanError: number
  /** Worst normalised corner error over the detected ones (NaN if none). */
  maxError: number
}

export interface CornerReport {
  byStratum: CornerGroupMetrics[]
  /** Pooled across all strata. */
  overall: CornerGroupMetrics
}

function metricsFor(group: string, scores: CornerScore[]): CornerGroupMetrics {
  const errs = scores.map((s) => s.error).filter((e): e is number => e !== null && Number.isFinite(e))
  return {
    group,
    total: scores.length,
    detected: errs.length,
    meanError: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN,
    maxError: errs.length ? Math.max(...errs) : NaN,
  }
}

/** Aggregate corner scores into per-stratum rows + an overall row, `groupOrder`
 *  fixing the row order (unknown strata appended after). Mirrors metrics.aggregate. */
export function aggregateCornerErrors(items: CornerScore[], groupOrder: readonly string[] = []): CornerReport {
  const byGroup = new Map<string, CornerScore[]>()
  for (const it of items) {
    const arr = byGroup.get(it.stratum) ?? []
    arr.push(it)
    byGroup.set(it.stratum, arr)
  }
  const ordered = [
    ...groupOrder.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !groupOrder.includes(g)),
  ]
  return {
    byStratum: ordered.map((g) => metricsFor(g, byGroup.get(g)!)),
    overall: metricsFor('overall', items),
  }
}

export interface CornerGateConfig {
  /** Max acceptable mean normalised corner error. Default 0.08 — at ≲8% of the LCD
   *  diagonal the rectified crop is square enough for the v1 decoder's fixed-rect
   *  segment sampling to read; beyond that the homography skews cells into each other. */
  maxMeanError: number
  /** Below this many DETECTED eval images the gate is ADVISORY (reports, never
   *  fails) — the real eval gold is scarce (PLAN top-risks #1/#3), so enforcing a
   *  threshold on a handful is statistically meaningless. Mirrors metrics.minSamples. */
  minSamples: number
}

export const DEFAULT_CORNER_GATE: CornerGateConfig = { maxMeanError: 0.08, minSamples: 30 }

export interface CornerGateResult {
  pass: boolean
  advisory: boolean
  detected: number
  meanError: number
  maxMeanError: number
  reason: string
}

const r3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : 'n/a')

/** Evaluate the corner gate on a pooled group (the harness pools easy+moderate —
 *  PLAN gates the recoverable strata; hard is reported, not gated). Tolerant while
 *  the detected count is below the floor. */
export function evaluateCornerGate(group: CornerGroupMetrics, cfg: Partial<CornerGateConfig> = {}): CornerGateResult {
  const { maxMeanError, minSamples } = { ...DEFAULT_CORNER_GATE, ...cfg }
  const base = { detected: group.detected, meanError: group.meanError, maxMeanError }
  if (group.detected < minSamples) {
    return {
      ...base,
      pass: true,
      advisory: true,
      reason: `advisory — ${group.detected} detected < ${minSamples} min samples; corner gate not enforced (mean error ${r3(group.meanError)})`,
    }
  }
  const pass = group.meanError <= maxMeanError
  return {
    ...base,
    pass,
    advisory: false,
    reason: pass
      ? `pass — mean corner error ${r3(group.meanError)} ≤ ${r3(maxMeanError)} over ${group.detected} detected`
      : `FAIL — mean corner error ${r3(group.meanError)} exceeds ${r3(maxMeanError)} over ${group.detected} detected`,
  }
}
