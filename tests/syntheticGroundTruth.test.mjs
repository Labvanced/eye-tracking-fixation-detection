// Run: node tests/syntheticGroundTruth.test.mjs   (or `npm test` for the whole suite)
//
// The three detectors on synthetic gaze whose true fixations are known.
//
// A seeded generator produces webcam-like gaze: about 30 Hz with timing jitter, fixations of 250 to
// 1500 ms at random positions at least 120 units apart, two-sample saccades between them, and
// Gaussian noise on every sample. Each sample carries the id of the fixation it belongs to, so every
// detected fixation can be checked against the truth.
//
// What is pinned are the properties the algorithms claim, not exact counts:
//   - Lagged and Merged never join two true fixations into one (nothing merges across a saccade).
//     Real-Time can, rarely: its threshold is absolute (3.25 x the calibration error), so two looks
//     closer together than that can read as one. Across seeds that is 1 to 3 of about 115.
//   - the lagged detector splits long fixations, and the merge pass undoes most of that,
//   - centroids land on the true position to within the noise.
// The printed table shows the actual numbers; change SEED or NOISE to explore.
import { FixationDetectorRealTime } from "../eyetracking/FixationDetectorRealTime.js";
import { FixationDetectorLaggedDispersion } from "../eyetracking/FixationDetectorLaggedDispersion.js";
import { FixationDetectorMerged } from "../eyetracking/FixationDetectorMerged.js";

const SEED = 20261113;
const NOISE = 8; // per-sample gaze noise (SD per axis), in frame units of an 800x450 frame
const CALIBRATION_ERROR = 30; // what the calibration would report for this participant, same units
const N_TRIALS = 6;
const FIXATIONS_PER_TRIAL = 8;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

// mulberry32: small, seedable, identical on every platform.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

/**
 * One session: trials of samples [t, x, y, confidence], plus the truth for every sample
 * (fixation id, or -1 during a saccade) and every fixation (position, start, end).
 */
function makeSession() {
  const trials = [];
  const label = new Map();
  const truth = new Map();
  let t = 1000;
  let id = 0;
  let pos = [400, 225];
  for (let tr = 0; tr < N_TRIALS; tr++) {
    const samples = [];
    for (let f = 0; f < FIXATIONS_PER_TRIAL; f++) {
      let next;
      do {
        next = [40 + rand() * 720, 30 + rand() * 390];
      } while (Math.hypot(next[0] - pos[0], next[1] - pos[1]) < 120);
      // Saccade: two samples on the way.
      if (f > 0) {
        for (const s of [1 / 3, 2 / 3]) {
          t += 33.3 + (rand() - 0.5) * 6;
          const row = [t, pos[0] + s * (next[0] - pos[0]), pos[1] + s * (next[1] - pos[1]), 0.9];
          label.set(t, -1);
          samples.push(row);
        }
      }
      pos = next;
      const duration = 250 + rand() * 1250;
      const start = t + 33.3;
      const fixTruth = { id, x: pos[0], y: pos[1], start, end: start };
      while (t + 33.3 <= start + duration) {
        t += 33.3 + (rand() - 0.5) * 6;
        samples.push([t, pos[0] + NOISE * gauss(), pos[1] + NOISE * gauss(), 0.9]);
        label.set(t, id);
        fixTruth.end = t;
      }
      truth.set(id, fixTruth);
      id++;
    }
    trials.push(samples);
    t += 2000; // inter-trial interval: no samples
  }
  return { trials, label, truth };
}

function detect(session, makeDetector) {
  const det = makeDetector();
  det.setCalibrationError(CALIBRATION_ERROR);
  const out = [];
  const take = (f) => f && f.fixationStatus === "concluded" && out.push(f);
  for (const samples of session.trials) {
    samples.forEach((s) => take(det.executeAlgorithm(s)));
    (det.concludeFinalFixations() || []).forEach(take);
  }
  return out;
}

/** Score detected fixations against the truth. */
function score(session, fixations) {
  const pieces = new Map(); // true id -> number of detected fixations that are mostly that one
  let joined = 0;
  const errors = [];
  for (const f of fixations) {
    const counts = new Map();
    for (const s of f.gazeData) {
      const id = session.label.get(s[0]);
      if (id >= 0) counts.set(id, (counts.get(id) || 0) + 1);
    }
    // Joined: two true fixations each contribute at least two samples.
    if ([...counts.values()].filter((n) => n >= 2).length >= 2) joined++;
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!main) continue;
    pieces.set(main[0], (pieces.get(main[0]) || 0) + 1);
    const tr = session.truth.get(main[0]);
    errors.push(Math.hypot(f.centroidXmean - tr.x, f.centroidYmean - tr.y));
  }
  errors.sort((a, b) => a - b);
  const nTrue = session.truth.size;
  const found = pieces.size;
  const single = [...pieces.values()].filter((n) => n === 1).length;
  return {
    detected: fixations.length,
    joined,
    found,
    single,
    nTrue,
    perTrue: fixations.length / nTrue,
    medianError: errors[Math.floor(errors.length / 2)]
  };
}

const session = makeSession();
const results = {
  realtime: score(
    session,
    detect(session, () => new FixationDetectorRealTime())
  ),
  lagged: score(
    session,
    detect(session, () => new FixationDetectorLaggedDispersion())
  ),
  merged: score(
    session,
    detect(session, () => new FixationDetectorMerged())
  )
};

console.log(
  `\n${session.truth.size} true fixations, ${session.trials.reduce((a, s) => a + s.length, 0)} samples, ` +
    `noise SD ${NOISE}, seed ${SEED}\n`
);
console.log("  algorithm  detected  per true  found  found as ONE  joined two  median centroid error");
for (const [name, r] of Object.entries(results)) {
  console.log(
    `  ${name.padEnd(9)}  ${String(r.detected).padStart(8)}  ${r.perTrue.toFixed(2).padStart(8)}  ` +
      `${String(r.found).padStart(5)}  ${String(r.single).padStart(12)}  ${String(r.joined).padStart(10)}  ` +
      `${r.medianError.toFixed(2).padStart(21)}`
  );
}

console.log("\nnothing merges across a saccade:");
for (const name of ["lagged", "merged"]) {
  const r = results[name];
  check(`${name}: no detected fixation joins two true fixations`, r.joined === 0, `${r.joined} do`);
}
check(
  "realtime: at most 5 % of detected fixations join two true fixations",
  results.realtime.joined <= 0.05 * results.realtime.detected,
  `${results.realtime.joined} of ${results.realtime.detected}`
);

console.log("\nevery true fixation is found:");
for (const [name, r] of Object.entries(results)) {
  check(`${name}: found ${r.found} of ${r.nTrue}`, r.found === r.nTrue);
}

console.log("\nthe merge undoes the lagged detector's splitting:");
check(
  "lagged splits: more than 1.2 detected fixations per true fixation",
  results.lagged.perTrue > 1.2,
  results.lagged.perTrue.toFixed(2)
);
check(
  "merged: at most 1.1 detected fixations per true fixation",
  results.merged.perTrue <= 1.1,
  results.merged.perTrue.toFixed(2)
);
check(
  "merged reports more true fixations as exactly one fixation than lagged does",
  results.merged.single > results.lagged.single,
  `${results.merged.single} vs ${results.lagged.single}`
);

console.log("\ncentroids land on the target:");
for (const [name, r] of Object.entries(results)) {
  check(`${name}: median centroid error below the noise SD`, r.medianError < NOISE, r.medianError.toFixed(2));
}

console.log(failures ? `\n✗ ${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
