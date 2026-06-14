// Confidence calibration for the v1 decoder (PLAN "Calibration is mandatory … v2
// calibrates the v1 decoder's confidence (its Hamming-distance proxy isn't good
// enough) so the abstain threshold means something"; issue #11).
//
// The v1 decoder's raw confidence is an ad-hoc product of a Hamming-distance bucket
// and a segment margin (segments.ts sampleDigit). It is NOT a probability: a
// confidently-WRONG hard read can outscore a correct one (observed on the eval gold —
// a wrong read at 0.71 above a correct read at 0.51). So a raw threshold can't
// separate honest from confident-wrong cleanly. Calibration maps raw → an estimated
// P(correct) via Platt scaling (1-D logistic regression), and then we pick the
// abstain threshold on that calibrated scale to HOLD the confident-wrong ceiling —
// turning the cardinal-sin wrong read into an honest abstain.
//
// Pure, deterministic, dependency-free (numbers in, numbers out): fit by fixed-step
// gradient descent with a fixed iteration count and seedless init, so the same
// samples always yield the same calibration — it unit-tests exactly and runs in the
// harness without surprises. With a tiny calibration set the fit is provisional (the
// honesty caveat the harness prints), but the MECHANISM is what ships; more data
// sharpens it with no code change, like the precision gate's advisory floor.

/** One labelled read for fitting: the decoder's raw confidence and whether the
 *  locked time was actually correct. */
export interface CalSample {
  rawConf: number
  correct: boolean
}

/** Platt parameters: calibrated P(correct) = sigmoid(a·raw + b). */
export interface Calibration {
  a: number
  b: number
}

export interface FitOpts {
  /** Gradient-descent steps (fixed → deterministic). Default 2000. */
  iters?: number
  /** Learning rate. Default 0.5. */
  lr?: number
  /** L2 penalty on `a` (keeps the slope finite when the set is perfectly separable
   *  or all-one-class). Default 1e-3. */
  l2?: number
}

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

/** Calibrated probability for a raw confidence under a fitted calibration. */
export function applyCalibration(cal: Calibration, rawConf: number): number {
  return sigmoid(cal.a * rawConf + cal.b)
}

/**
 * Fit Platt scaling (a,b) on labelled reads by deterministic gradient descent on the
 * mean negative log-likelihood (with L2 on the slope). Returns {a:1,b:0} (identity-ish)
 * for an empty set. Numerically guarded (the sigmoid is stable; log clamped).
 */
export function fitCalibration(samples: CalSample[], opts: FitOpts = {}): Calibration {
  const iters = opts.iters ?? 2000
  const lr = opts.lr ?? 0.5
  const l2 = opts.l2 ?? 1e-3
  const n = samples.length
  if (n === 0) return { a: 1, b: 0 }

  let a = 1
  let b = 0
  for (let step = 0; step < iters; step++) {
    let ga = 0
    let gb = 0
    for (const s of samples) {
      const p = sigmoid(a * s.rawConf + b)
      const err = p - (s.correct ? 1 : 0) // d(NLL)/d(logit)
      ga += err * s.rawConf
      gb += err
    }
    ga = ga / n + l2 * a
    gb = gb / n
    a -= lr * ga
    b -= lr * gb
  }
  return { a, b }
}

export interface ThresholdResult {
  /** Lock a read iff its CALIBRATED confidence ≥ this; below it → honest abstain. */
  threshold: number
  /** Wrong-rate among the reads this threshold would lock (on the fitting set). */
  lockedWrongRate: number
  /** How many reads it would lock / how many are scored. */
  locked: number
  total: number
}

/**
 * Choose the abstain threshold on the CALIBRATED scale: the LOWEST threshold whose
 * locked set (calibrated ≥ τ) holds confident-wrong ≤ `maxWrongRate` — i.e. keep as
 * many true reads as possible without breaching the precision-first ceiling. If even
 * locking only the single highest-confidence read breaches it, returns a threshold
 * above every read (abstain everything — the honest precision-first choice). Pure.
 */
export function chooseAbstainThreshold(samples: CalSample[], cal: Calibration, maxWrongRate: number): ThresholdResult {
  const scored = samples.map((s) => ({ p: applyCalibration(cal, s.rawConf), correct: s.correct }))
  const total = scored.length
  // Candidate thresholds = each read's calibrated p (ascending). For each, lock p≥τ
  // and measure the wrong-rate; take the lowest τ that satisfies the ceiling.
  const candidates = [...new Set(scored.map((s) => s.p))].sort((x, y) => x - y)
  let best: ThresholdResult | null = null
  for (const tau of candidates) {
    const locked = scored.filter((s) => s.p >= tau)
    const wrong = locked.filter((s) => !s.correct).length
    const wrongRate = locked.length ? wrong / locked.length : 0
    if (wrongRate <= maxWrongRate) {
      best = { threshold: tau, lockedWrongRate: wrongRate, locked: locked.length, total }
      break // candidates ascending → first satisfying is the lowest (most permissive)
    }
  }
  if (best) return best
  // Nothing holds the ceiling → abstain everything (τ above the max calibrated conf).
  const maxP = scored.length ? Math.max(...scored.map((s) => s.p)) : 1
  return { threshold: maxP + 1e-6, lockedWrongRate: 0, locked: 0, total }
}
