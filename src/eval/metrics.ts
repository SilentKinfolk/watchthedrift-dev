// Precision-first scoring — the maths behind the acceptance gate (PLAN "Success
// metric"; PRD "Acceptance metric"). A read has THREE honest outcomes, not two:
//
//   • correct          — the locked answer equals ground truth,
//   • abstain (retake)  — the pipeline declined to lock (no reading, or a reading
//                         below the abstain threshold) → "fail to a retake",
//   • wrong             — it locked a confident answer that is WRONG.
//
// `wrong` is the cardinal sin: a silently-wrong drift number the user would trust.
// So the gate LEADS with a confidently-wrong ceiling (~0.5%), not a headline
// accuracy — an abstain is honest, a wrong is not.
//
// Pure and dependency-free (no image/model/canvas): it scores read *outcomes*, not
// pixels, so it unit-tests deterministically and runs in CI, and it is agnostic to
// what produced the read — today the v1 decoder, later the post-arbitration locked
// answer (#11). Groups by an opaque stratum string so it never needs to know the
// strata taxonomy.

import type { Time } from './label.ts'

export type Outcome = 'correct' | 'abstain' | 'wrong'

/** One pipeline read to score. `reading: null` = the pipeline abstained (the honest
 *  fail-to-retake). Otherwise the read time and its calibrated 0..1 confidence. */
export interface ScoredRead {
  reading: Time | null
  confidence: number | null
}

export interface ClassifyOpts {
  /** Treat a read whose confidence is below this as an abstain (it never reaches the
   *  user as a locked answer). Omit/undefined → any non-null reading is a lock. The
   *  calibrated abstain threshold lands in #11; the harness leaves it unset for now
   *  so the baseline reflects exactly what v1 locks today. */
  abstainBelow?: number
}

export const timesEqual = (a: Time | null, b: Time | null): boolean =>
  !!a && !!b && a.hh === b.hh && a.mm === b.mm && a.ss === b.ss

/** Classify a single read against ground truth into the three honest outcomes. */
export function classify(read: ScoredRead, expected: Time, opts: ClassifyOpts = {}): Outcome {
  const belowThreshold =
    opts.abstainBelow !== undefined &&
    read.reading !== null &&
    (read.confidence ?? 0) < opts.abstainBelow
  if (read.reading === null || belowThreshold) return 'abstain'
  return timesEqual(read.reading, expected) ? 'correct' : 'wrong'
}

export interface Counts {
  /** Labelled reads scored in this group. */
  total: number
  correct: number
  abstain: number
  wrong: number
}

export interface Rates {
  correct: number
  abstain: number
  /** confidently-wrong / total — the gated quantity. */
  wrong: number
}

export interface GroupMetrics extends Counts {
  /** Stratum name, or `overall` for the pooled row. */
  group: string
  rates: Rates
}

/** One scored item: which stratum bucket it belongs to and how it came out. */
export interface ScoredItem {
  stratum: string
  outcome: Outcome
}

function tally(outcomes: Outcome[]): Counts {
  const c: Counts = { total: outcomes.length, correct: 0, abstain: 0, wrong: 0 }
  for (const o of outcomes) c[o]++
  return c
}

/** Rates as fractions of total; a zero-total group is all-zero (no divide-by-zero). */
export function ratesOf(c: Counts): Rates {
  if (c.total === 0) return { correct: 0, abstain: 0, wrong: 0 }
  return { correct: c.correct / c.total, abstain: c.abstain / c.total, wrong: c.wrong / c.total }
}

function metricsFor(group: string, outcomes: Outcome[]): GroupMetrics {
  const c = tally(outcomes)
  return { group, ...c, rates: ratesOf(c) }
}

export interface Report {
  /** Per-stratum rows, in `groupOrder` order, only for strata that have ≥1 item. */
  byStratum: GroupMetrics[]
  /** All strata pooled — the row the gate is evaluated on. */
  overall: GroupMetrics
}

/** Aggregate scored items into per-stratum rows + an overall row. `groupOrder` fixes
 *  the row order (e.g. easy/moderate/hard/unstratified); any stratum not listed is
 *  appended in first-seen order after the known ones. */
export function aggregate(items: ScoredItem[], groupOrder: readonly string[] = []): Report {
  const byGroup = new Map<string, Outcome[]>()
  for (const it of items) {
    const arr = byGroup.get(it.stratum) ?? []
    arr.push(it.outcome)
    byGroup.set(it.stratum, arr)
  }
  const ordered = [
    ...groupOrder.filter((g) => byGroup.has(g)),
    ...[...byGroup.keys()].filter((g) => !groupOrder.includes(g)),
  ]
  return {
    byStratum: ordered.map((g) => metricsFor(g, byGroup.get(g)!)),
    overall: metricsFor('overall', items.map((it) => it.outcome)),
  }
}

export interface GateConfig {
  /** Confidently-wrong ceiling, as a fraction. Default 0.005 (~0.5%). */
  maxWrongRate: number
  /** Below this many labelled samples the gate is ADVISORY — it reports but never
   *  fails. Default 200: a 0.5% rate is unobservable below ~200 samples (one wrong
   *  read already exceeds the ceiling at N<200), so enforcing it on a tiny set is
   *  statistically meaningless. This is the "tolerant while the set is tiny" knob. */
  minSamples: number
}

export const DEFAULT_GATE: GateConfig = { maxWrongRate: 0.005, minSamples: 200 }

export interface GateResult {
  /** Whether CI should pass. Always true while advisory (tolerant). */
  pass: boolean
  /** True when the sample size is below `minSamples` → not enforced. */
  advisory: boolean
  total: number
  wrongRate: number
  maxWrongRate: number
  reason: string
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`

/** Evaluate the precision-first gate on the OVERALL (pooled across all strata,
 *  including hard) counts — the post-arbitration locked answer in the real pipeline.
 *  Reusable by the harness (exit code) and by unit tests; tolerant while tiny. */
export function evaluateGate(overall: Counts, cfg: Partial<GateConfig> = {}): GateResult {
  const { maxWrongRate, minSamples } = { ...DEFAULT_GATE, ...cfg }
  const wrongRate = ratesOf(overall).wrong
  const base = { total: overall.total, wrongRate, maxWrongRate }
  if (overall.total < minSamples) {
    return {
      ...base,
      pass: true,
      advisory: true,
      reason: `advisory — ${overall.total} labelled < ${minSamples} min samples; gate not enforced (confidently-wrong ${pct(wrongRate)})`,
    }
  }
  const pass = wrongRate <= maxWrongRate
  return {
    ...base,
    pass,
    advisory: false,
    reason: pass
      ? `pass — confidently-wrong ${pct(wrongRate)} ≤ ${pct(maxWrongRate)} ceiling over ${overall.total} samples`
      : `FAIL — confidently-wrong ${pct(wrongRate)} exceeds ${pct(maxWrongRate)} ceiling over ${overall.total} samples`,
  }
}
