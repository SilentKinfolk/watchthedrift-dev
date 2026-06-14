// Live capture feedback (issue #12). With the alignment box gone, these short,
// honest lines are the only guidance during a scan — so each maps directly off what
// the pipeline actually sees that frame, and they fail to a retake rather than imply
// a guess. Kept pure (no DOM) so the wording is unit-testable.

import type { Legibility } from '../recognize/exposure'

export type Feedback = 'too-dark' | 'glare' | 'found' | 'searching' | 'implausible'

export interface ScanSignal {
  /** Scene legibility from the frame's exposure. */
  legibility: Legibility
  /** Did the pipeline get a valid (above-threshold) read this frame? */
  gotRead: boolean
}

/**
 * Pick the feedback state for a scan frame. Priority:
 *   1. too-dark — the honest abstain; we don't even attempt a read there.
 *   2. found — a live read is in hand (holding for a second to corroborate).
 *   3. glare — couldn't read and the frame is blown out: a likely cause to fix.
 *   4. searching — the steady default nudge.
 * "found" outranks "glare" so a successful read is never undercut by a glare hint.
 */
export function feedbackFor(s: ScanSignal): Feedback {
  if (s.legibility === 'too-dark') return 'too-dark'
  if (s.gotRead) return 'found'
  if (s.legibility === 'glare') return 'glare'
  return 'searching'
}

const MESSAGES: Record<Feedback, string> = {
  'too-dark': 'Too dark to read — find more light.',
  glare: 'Bright reflection on the face — tilt the watch to cut the glare.',
  found: 'Got the time — hold steady…',
  searching: 'Point at your watch and hold steady — it locks on its own.',
  // Set directly by the scan loop (post-drift), not by feedbackFor: the read parsed,
  // but the resulting drift was too large to be real — a likely misread digit.
  implausible: 'That reading didn’t look right — hold steady to re-read.',
}

export function feedbackMessage(f: Feedback): string {
  return MESSAGES[f]
}
