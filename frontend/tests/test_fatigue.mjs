// Node unit tests for the on-device fatigue signal library.
// Run: node frontend/tests/test_fatigue.mjs
import { EYES, eyeEAR, perclosToScore, headDroopRatio, pitchDegFromMatrix, combineFatigue, isDrooping, tierForScore, NOD_DROOP_THRESHOLD, NOD_PITCH_DEG } from '../src/lib/fatigue.js'

const failures = []
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}`)
  else {
    failures.push(name)
    console.log(`FAIL ${name} ${detail}`)
  }
}

// Build a synthetic 468-landmark face array. y grows downward (image coords).
// Upright: nose clearly below the eye line; drooped: nose approaches eye line.
function face(noseDy, { lidGap = 0.06 } = {}) {
  const lm = []
  for (let i = 0; i < 468; i++) lm.push({ x: 0, y: 0.5, z: 0 })
  // forehead top
  lm[10] = { x: 0.5, y: 0.30, z: 0 }
  // eyes (left outer/inner, right outer/inner) — horizontal corners define d3
  lm[33] = { x: 0.30, y: 0.50, z: 0 }
  lm[133] = { x: 0.44, y: 0.50, z: 0 }
  lm[263] = { x: 0.56, y: 0.50, z: 0 }
  lm[362] = { x: 0.70, y: 0.50, z: 0 }
  // vertical lid landmarks: vertical gap = lidGap (closed eyes => small gap => low EAR)
  const lidY = (cx) => ({
    up1: { x: cx, y: 0.50 - lidGap / 2, z: 0 },
    low1: { x: cx, y: 0.50 + lidGap / 2, z: 0 },
    up2: { x: cx, y: 0.50 - lidGap / 2, z: 0 },
    low2: { x: cx, y: 0.50 + lidGap / 2, z: 0 },
  })
  Object.assign(lm, {
    160: lidY(0.37).up1, 153: lidY(0.37).low1, 158: lidY(0.37).up2, 144: lidY(0.37).low2,
    385: lidY(0.63).up1, 373: lidY(0.63).low1, 387: lidY(0.63).up2, 380: lidY(0.63).low2,
  })
  // nose tip at eye line + noseDy
  lm[1] = { x: 0.50, y: 0.50 + noseDy, z: 0 }
  // chin
  lm[152] = { x: 0.50, y: 0.90, z: 0 }
  return lm
}

// --- EAR / PERCLOS ---
check('tier mapping 8->critical', tierForScore(8.2) === 'critical')
check('tier mapping 5->moderate', tierForScore(5.0) === 'moderate')
check('tier mapping 1->safe', tierForScore(1.0) === 'safe')

const open = face(0.20, { lidGap: 0.10 })
const earOpen = (eyeEAR(open, EYES.left) + eyeEAR(open, EYES.right)) / 2
check('open-eye EAR above closure threshold', earOpen > 0.18, `ear=${earOpen.toFixed(3)}`)

const shut = face(0.20, { lidGap: 0.02 })
const earShut = (eyeEAR(shut, EYES.left) + eyeEAR(shut, EYES.right)) / 2
check('closed-eye EAR below closure threshold', earShut < 0.18, `ear=${earShut.toFixed(3)}`)

check('PERCLOS 0.20 -> score 5 (moderate threshold)', perclosToScore(0.20) === 5)
check('PERCLOS 0.32 -> score 8 (critical threshold)', perclosToScore(0.32) === 8)
check('PERCLOS 0 -> score 0', perclosToScore(0) === 0)

// --- head droop (landmark proxy) ---
const upright = face(0.20) // nose well below eyes
const ratioUpright = headDroopRatio(upright)
check('upright head has a healthy nose-below-eyes ratio', ratioUpright > NOD_DROOP_THRESHOLD, `ratio=${ratioUpright.toFixed(3)}`)
const drooped = face(0.04) // nose near eye line (head down)
const ratioDroop = headDroopRatio(drooped)
check('drooped head collapses nose-below-eyes ratio below threshold', ratioDroop < NOD_DROOP_THRESHOLD, `ratio=${ratioDroop.toFixed(3)}`)
check('isDrooping true for drooped landmarks', isDrooping(drooped, 0) === true)
check('isDrooping false for upright landmarks', isDrooping(upright, 0) === false)

// --- pitch angle from a synthetic rotation matrix (pure math recovery) ---
// Column-major 4x4: R[row + 4*col].
function rotMatrix(col0, col1, col2) {
  const m = new Float32Array(16)
  m[0] = col0[0]; m[1] = col0[1]; m[2] = col0[2]
  m[4] = col1[0]; m[5] = col1[1]; m[6] = col1[2]
  m[8] = col2[0]; m[9] = col2[1]; m[10] = col2[2]
  m[3] = m[7] = m[11] = 0
  m[12] = m[13] = m[14] = 0; m[15] = 1
  return m
}
// Rotation about X by 25 deg. Column-major columns as above.
const a = (25 * Math.PI) / 180
const Rx = rotMatrix(
  [1, 0, 0],
  [0, Math.cos(a), Math.sin(a)],
  [0, -Math.sin(a), Math.cos(a)],
)
const pitch = pitchDegFromMatrix(Rx)
check('pitchDegFromMatrix recovers a 25deg X-rotation magnitude', Math.abs(Math.abs(pitch) - 25) < 1, `pitch=${pitch.toFixed(1)}`)
check('isDrooping true when pitch corroborates a down tilt', isDrooping(upright, NOD_PITCH_DEG + 5) === true)

// --- combineFatigue ---
const base = combineFatigue({ perclos: 0.02 })
check('alert: low PERCLOS + upright -> low score', base.score < 2 && base.tier === 'safe', JSON.stringify(base))

const microsleep = combineFatigue({ perclos: 0.05, closedStreakMs: 4000 })
check('sustained 4s eye closure raises score above baseline', microsleep.score >= 5, JSON.stringify(microsleep))
check('sustained 4s eye closure reaches moderate+ tier', microsleep.tier !== 'safe', JSON.stringify(microsleep))

const nodding = combineFatigue({ perclos: 0.02, droopActive: true, droopSustainedMs: 3000 })
check('sustained 3s head droop raises score (nod-alone can reach critical)', nodding.score >= 5, JSON.stringify(nodding))
check('head droop alone reaches critical tier at ~5s', combineFatigue({ perclos: 0.02, droopActive: true, droopSustainedMs: 5000 }).tier === 'critical')

const briefNod = combineFatigue({ perclos: 0.02, droopActive: true, droopSustainedMs: 400 })
check('brief (<1.5s) droop does NOT raise the score', briefNod.score < 2, JSON.stringify(briefNod))

const both = combineFatigue({ perclos: 0.2, closedStreakMs: 3000, droopActive: true, droopSustainedMs: 3000 })
check('both signals present -> score clamped to 10 ceiling', both.score <= 10 && both.score >= 8, JSON.stringify(both))

console.log('\nfatigue lib results:', JSON.stringify({ microsleep, nodding, both }, null, 2))
if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nFATIGUE LIB TESTS PASS')