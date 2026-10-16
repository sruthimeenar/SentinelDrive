// Pure fatigue-signal computation. Runs in the browser (rAF loop feeding
// MediaPipe face landmarks) and is unit-tested in Node. NO browser APIs here.
//
// Two real signals are combined:
//   1. PERCLOS — rolling eye-closure ratio (classic blink metric).
//   2. Head droop — sustained downward head tilt (nodding off) measured two
//      ways: a landmark nose-below-eyes ratio (sign-unambiguous) corroborated
//      by the pitch angle from the face-geometry rotation matrix.
// Either condition sustained raises the fatigue score; both additively.

// MediaPipe Face Landmarker 6-point eye keypoints for the classic EAR
// (Eye Aspect Ratio) blink metric. Left eye: 33,160,158,133,153,144.
// Right eye: 362,385,387,263,373,380.
export const EYES = {
  left: { outer: 33, up1: 160, up2: 158, inner: 133, low1: 153, low2: 144 },
  right: { outer: 362, up1: 385, up2: 387, inner: 263, low1: 373, low2: 380 },
}

// Landmarks used for the head-droop proxy:
//   1  = nose tip, 152 = chin, 10 = forehead top, 33/133 = left eye, 263/362 = right eye.
const NOSE = 1
const CHIN = 152
const FOREHEAD = 10
const L_EYE = [33, 133]
const R_EYE = [263, 362]

// Closure threshold: EAR below this counts the eye as "closed" for PERCLOS.
export const EAR_CLOSED_THRESHOLD = 0.18

// Rolling PERCLOS window per the standard definition (~60s of frame samples).
export const PERCLOS_WINDOW_MS = 60_000

// Sustained-drowsiness thresholds.
export const CLOSE_SUSTAIN_MS = 1500 // continuous eye closure that counts as microsleep onset
export const NOD_SUSTAIN_MS = 1500 // sustained head droop that counts as nodding off
export const NOD_DROOP_THRESHOLD = 0.08 // normalized nose-below-eyes; below => head down
export const NOD_PITCH_DEG = 12 // |pitch| corroboration for a down tilt

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function round1(v) {
  return Math.round(v * 10) / 10
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function eyeEAR(lm, kp) {
  const d1 = dist(lm[kp.up1], lm[kp.low1])
  const d2 = dist(lm[kp.up2], lm[kp.low2])
  const d3 = dist(lm[kp.outer], lm[kp.inner])
  return (d1 + d2) / (2 * d3)
}

// PERCLOS (0-1) -> fatigue score (0-10). Documented calibration curve:
//   0.00 (normal blink, ~1-4%) -> 0-1  alert
//   0.08                       -> 2    slightly drowsy
//   0.20                       -> 5    moderate tier threshold
//   0.32                       -> 8    critical tier threshold (arms talk-back)
//   0.40+                      -> 10   deep microsleep
export function perclosToScore(p) {
  return Math.min(10, Math.round(p * 25 * 10) / 10)
}

export function tierForScore(s) {
  return s >= 8 ? 'critical' : s >= 5 ? 'moderate' : 'safe'
}

// Head-droop proxy from 2D landmarks: the vertical distance between the eye
// line and the nose tip, normalized by face height. Upright the nose sits well
// below the eyes (~0.15-0.25); when the head tilts down (nodding off) the nose
// approaches the eye line, so the ratio collapses toward 0 or negative.
export function headDroopRatio(lm) {
  const eyeY = (lm[L_EYE[0]].y + lm[L_EYE[1]].y + lm[R_EYE[0]].y + lm[R_EYE[1]].y) / 4
  const noseY = lm[NOSE].y
  const chinY = lm[CHIN].y
  const topY = lm[FOREHEAD].y
  const faceH = Math.max(1e-6, chinY - topY)
  return (noseY - eyeY) / faceH
}

// Pitch angle (degrees) of the head from the face-geometry rotation matrix.
// m is the 4x4 column-major faceTransformationMatrixes array (Float32Array of
// 16). Sign convention: positive pitch = head tilted DOWN (chin toward chest),
// matching the nodding-off case we want to flag. Purely a corroborating signal;
// the score decision uses the landmark droop ratio (sign-unambiguous).
export function pitchDegFromMatrix(m) {
  if (!m || m.length < 12) return 0
  // Column-major: R[row + 4*col].
  const r02 = m[8] // row0,col2
  const r12 = m[9] // row1,col2
  const r22 = m[10] // row2,col2
  return (Math.atan2(r12, Math.sqrt(r02 * r02 + r22 * r22)) * 180) / Math.PI
}

// Combine both real signals into a single 0-10 fatigue score.
//
//   eyeScore  = PERCLOS calibration (rolling eye closure)
//   closureBonus = +0..8 for SUSTAINED eye closure (microsleep onset)
//   nodScore  = 0 when head upright; ramps to 8 once droop is sustained,
//               so nodding off alone can reach critical
//   score = max(eyeScore + closureBonus, nodScore)  -> "either condition
//           sustained raises the score; both add up via the max"
export function combineFatigue({ perclos, closedStreakMs = 0, droopActive = false, droopSustainedMs = 0 }) {
  const eyeScore = perclosToScore(perclos)

  const closureBonus =
    closedStreakMs > CLOSE_SUSTAIN_MS
      ? Math.min(8, ((closedStreakMs - CLOSE_SUSTAIN_MS) / 1000) * 3)
      : 0

  const nodScore =
    droopActive && droopSustainedMs >= NOD_SUSTAIN_MS
      ? Math.min(8, 2 + ((droopSustainedMs - NOD_SUSTAIN_MS) / 1000) * 2)
      : 0

  const score = Math.min(10, Math.max(eyeScore + closureBonus, nodScore))
  return {
    score: round1(score),
    eyeScore: round1(eyeScore),
    closureBonus: round1(closureBonus),
    nodScore: round1(nodScore),
    tier: tierForScore(score),
    droopActive,
    droopSustainedMs,
  }
}

// Returns true when the face is currently drooping: nose-below-eyes ratio below
// threshold (primary) OR a corroborating downward pitch angle.
export function isDrooping(lm, pitchDeg) {
  if (!lm) return false
  if (headDroopRatio(lm) < NOD_DROOP_THRESHOLD) return true
  if (typeof pitchDeg === 'number' && pitchDeg > NOD_PITCH_DEG) return true
  return false
}