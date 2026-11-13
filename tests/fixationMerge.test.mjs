// Run: node tests/fixationMerge.test.mjs   (or `npm test` for the whole suite)
//
// "Merged Fixations" (2.0.12): the lagged detector with the merge pass around it, LIVE. The merge runs
// in the event path and what is emitted is what is recorded, so a study's fixation events and its
// exported fixations cannot disagree.
//
// The rule is pinned here rather than the offline numbers it produced, because k, the multipliers and
// the gap are PROVISIONAL and will be refitted on a gaze-contingent task. What must not change is the
// shape: a real saccade never merges, a long gap never merges, chains collapse because the MERGED
// fixation stays pending, at most one fixation leaves per call, order is chronological, and nothing is
// emitted twice or dropped.
//
// The inner detector is stubbed. This is about the wrapper's state machine; the lagged detector has
// its own tests.
import {
  MERGE_DEFAULTS,
  resolveFloor,
  scatterOf,
  shouldMerge,
  mergeInto,
  effectiveFixationResolutionMs
} from "../eyetracking/fixationMerge.js";
import { FixationDetectorMerged } from "../eyetracking/FixationDetectorMerged.js";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`}`
  );
}
function near(name, actual, expected, tol = 0.01) {
  const ok = typeof actual === "number" && Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  expected~=${expected} got=${actual}`}`);
}

// A concluded fixation as the inner detector hands it over: gazeData rows are [t, x, y, confidence].
function fix(t0, t1, x, y, n = 10, jitter = 1, conf = 0.8) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    pts.push([t0 + f * (t1 - t0), x + (i % 2 ? jitter : -jitter), y + (i % 3 ? jitter : -jitter), conf]);
  }
  return {
    fixationStatus: "concluded",
    fixationStartTime: t0,
    fixationEndTime: t1,
    fixationDuration: t1 - t0,
    centroidXmean: x,
    centroidYmean: y,
    dispersion: jitter,
    gazeData: pts
  };
}
const NONE = { fixationStatus: "none-detected" };

/**
 * A wrapper whose inner detector concludes exactly what a script says, so the state machine can be
 * driven sample by sample. `script` maps a sample index to a fixation (or nothing).
 */
function rig(script, finals = [], opts = {}) {
  const det = new FixationDetectorMerged(opts);
  let i = -1;
  det.inner = {
    setCalibrationError() {},
    executeAlgorithm() {
      i++;
      return script[i] || NONE;
    },
    concludeFinalFixations() {
      return finals;
    }
  };
  return det;
}
// Drive n samples at a fixed time step and collect whatever came out.
function drive(det, times) {
  const out = [];
  times.forEach((t) => {
    const r = det.executeAlgorithm({ t: t, x: 0, y: 0 });
    if (r && r.fixationStatus === "concluded") out.push(r);
  });
  return out;
}

console.log("two pieces of one look:");
{
  const det = rig([fix(0, 200, 100, 100), fix(240, 440, 102, 100)], []);
  det.setCalibrationError(20);
  const emitted = drive(det, [100, 500]);
  check("nothing is emitted while the pieces are still joining", emitted.length, 0);
  const finals = det.concludeFinalFixations();
  check("the flush produces ONE fixation", finals.length, 1);
  check("spanning both", [finals[0].fixationStartTime, finals[0].fixationEndTime], [0, 440]);
  check("holding the union of the samples", finals[0].nSamples, 20);
  check("and counting what it came from", finals[0].mergedCount, 2);
  near("with a centroid recomputed from the union", finals[0].centroidXmean, 101, 0.5);
}

console.log("\nthe gap rule:");
{
  const det = rig([fix(0, 200, 100, 100), fix(520, 720, 102, 100)], []);
  det.setCalibrationError(20);
  // The first is emitted LIVE the moment the second refuses to join it: holding it any longer would
  // be waiting for a merge that cannot happen.
  const live = drive(det, [100, 800]);
  const all = live.concat(det.concludeFinalFixations());
  check("300 ms apart stays two fixations, however close the centroids", all.length, 2);
  check("the first leaves as soon as the second cannot join it", live.length, 1);
  check(
    "in chronological order",
    all.map((f) => f.fixationStartTime),
    [0, 520]
  );
}

console.log("\na real saccade is never merged:");
{
  [0, 10, 50, 200].forEach((cal) => {
    const det = rig([fix(0, 200, 100, 100), fix(240, 440, 400, 100)], []);
    det.setCalibrationError(cal);
    const live = drive(det, [100, 500]);
    const all = live.concat(det.concludeFinalFixations());
    check(`calibration error ${cal} leaves them apart`, all.length, 2);
  });
}

console.log("\na chain of three, which is why the merged fixation stays pending:");
{
  const det = rig([fix(0, 150, 100, 100), fix(190, 340, 101, 100), fix(380, 530, 102, 101)], []);
  det.setCalibrationError(20);
  drive(det, [100, 200, 400]);
  const finals = det.concludeFinalFixations();
  check("three become one", finals.length, 1);
  check("...spanning all of it", [finals[0].fixationStartTime, finals[0].fixationEndTime], [0, 530]);
  check("...counting all three", finals[0].mergedCount, 3);
  check("...with every sample", finals[0].nSamples, 30);
}

console.log("\nat most ONE fixation leaves per call:");
{
  // The timeout releases the held fixation on the same call the next one concludes. The other
  // detectors promise one per call and the host's callback path assumes it.
  const det = rig([fix(0, 200, 100, 100), null, fix(3000, 3200, 100, 100)], []);
  det.setCalibrationError(20);
  const a = det.executeAlgorithm({ t: 100 });
  check("the first is held, nothing out", a.fixationStatus, "none-detected");
  const b = det.executeAlgorithm({ t: 2500 });
  check("past the timeout it is released, unmerged", b.fixationStatus, "concluded");
  check("...as itself, not merged with anything", b.mergedCount === undefined || b.mergedCount === 1, true);
  const c = det.executeAlgorithm({ t: 3300 });
  check("the call that both times out and concludes emits only the older one", c.fixationStatus, "none-detected");
  const finals = det.concludeFinalFixations();
  check("and the newer one is flushed at the end", finals.length, 1);
  check("chronological throughout", [b.fixationStartTime, finals[0].fixationStartTime], [0, 3000]);
}

console.log("\na held fixation with nothing following is released by the timeout:");
{
  const det = rig([fix(0, 200, 100, 100)], []);
  det.setCalibrationError(20);
  check("held at first", det.executeAlgorithm({ t: 300 }).fixationStatus, "none-detected");
  check("still held before the timeout", det.executeAlgorithm({ t: 2000 }).fixationStatus, "none-detected");
  const out = det.executeAlgorithm({ t: 2400 });
  check("released after it", out.fixationStatus, "concluded");
  check("and gone from the pending slot", det.pending, null);
  check("so the flush has nothing left", det.concludeFinalFixations().length, 0);
}

console.log("\nnothing is emitted twice and nothing is dropped:");
{
  const script = [
    fix(0, 150, 100, 100), // merges with the next
    fix(190, 340, 101, 100),
    fix(900, 1050, 400, 400), // a saccade away
    fix(1100, 1250, 401, 400) // merges with the previous
  ];
  const det = rig(script, []);
  det.setCalibrationError(20);
  const live = drive(det, [200, 400, 1000, 1300]);
  const finals = det.concludeFinalFixations();
  const all = live.concat(finals);
  check("four inner fixations become two", all.length, 2);
  check("the first is the first pair", all[0].mergedCount, 2);
  check("the second is the second pair", all[1].mergedCount, 2);
  check("every inner fixation is accounted for", all[0].mergedCount + all[1].mergedCount, 4);
  check(
    "chronological",
    all.map((f) => f.fixationStartTime),
    [0, 900]
  );
  const stats = det.mergeStats();
  check("the record says how many went in and came out", [stats.nIn, stats.nOut], [4, 2]);
}

console.log("\nconcludeFinalFixations returns several, in order:");
{
  // Both conclude modes land here, and with the merge this is the normal case rather than an edge one.
  const det = rig([], [fix(0, 150, 100, 100), fix(900, 1050, 400, 400), fix(1800, 1950, 700, 700)]);
  det.setCalibrationError(20);
  const finals = det.concludeFinalFixations();
  check("three separate looks come back as three", finals.length, 3);
  check(
    "oldest first",
    finals.map((f) => f.fixationStartTime),
    [0, 900, 1800]
  );
  check(
    "each is a real fixation",
    finals.every((f) => f.fixationStatus === "concluded"),
    true
  );
}

console.log("\na trial shorter than the timeout still reports when it ends:");
{
  // The timeout only governs waiting WITHIN a trial. Frame end and trial end flush whatever is held,
  // and the host calls that before the frame finishes and before the trial's data is recorded, so a
  // 400 ms trial does not wait two seconds for its fixations.
  const det = rig([fix(0, 150, 100, 100), fix(200, 350, 400, 400)], []);
  det.setCalibrationError(20);
  const live = drive(det, [160, 360]); // the whole trial is 400 ms, far inside holdTimeoutMs
  const finals = det.concludeFinalFixations();
  const all = live.concat(finals);
  check("both fixations are reported", all.length, 2);
  check(
    "in order",
    all.map((f) => f.fixationStartTime),
    [0, 200]
  );
  check("nothing is left pending to leak into the next trial", det.pending, null);
}

console.log("\nthe flush leaves no state behind:");
{
  // Two trials in a row on the same detector: trial 2 must not inherit trial 1's pending fixation, or
  // a fixation would be attributed to the wrong trial.
  const det = rig([fix(0, 150, 100, 100), fix(5000, 5150, 100, 100)], []);
  det.setCalibrationError(20);
  det.executeAlgorithm({ t: 160 });
  const trial1 = det.concludeFinalFixations();
  check("trial 1 ends with its own fixation", trial1.length, 1);
  check("...and nothing held", det.pending, null);
  det.executeAlgorithm({ t: 5200 });
  const trial2 = det.concludeFinalFixations();
  check("trial 2 reports only its own", trial2.length, 1);
  check("...which is the later one", trial2[0].fixationStartTime, 5000);
}

console.log("\nreleasing the held fixation follows the task's conclude setting:");
{
  // The wrapper does not know the setting: the flush lives in concludeFinalFixations, and the host
  // calls that only where the setting says so. So the modes are just call patterns from here.
  //
  // On 2.0 the host concludes before recording a trial's data whatever the mode says, which is why
  // "no" was retired there (it became identical to trialEnd). What is still worth pinning is the
  // wrapper's own behaviour in both shapes: concluded at the boundary, and never concluded at all.
  const script = [fix(0, 150, 100, 100), fix(900, 1050, 400, 400)];

  // trialEnd / frameEnd: the host concludes at the boundary, so everything held comes out there.
  const concluded = rig(script.slice(), []);
  concluded.setCalibrationError(20);
  const liveA = drive(concluded, [200, 1100]);
  const atBoundary = concluded.concludeFinalFixations();
  check("concluding at the boundary releases what is held", liveA.length + atBoundary.length, 2);
  check("...and leaves nothing behind", concluded.pending, null);

  // Never concluded (1.x "no", or any caller that simply does not conclude): nothing is flushed, so
  // the held fixation waits for the next one or for the timeout. The wrapper must not invent a flush
  // of its own, because that would contradict the caller.
  const open = rig(script.slice(), []);
  open.setCalibrationError(20);
  const liveB = drive(open, [200, 1100]);
  check("without a conclude call the second fixation is still held", liveB.length, 1);
  check("...so one is pending across the boundary", open.pending !== null, true);
  // ...and the timeout is the only bound on it. It runs from the HANDOVER (t = 1100 here), not from
  // the fixation's own end time (1050): the inner detector's lag must not be spent out of the budget
  // for waiting on the next fixation, or a fixation handed over late would be released immediately.
  const notYet = open.executeAlgorithm({ t: 1050 + MERGE_DEFAULTS.holdTimeoutMs + 1 });
  check("end time + timeout is NOT the deadline", notYet.fixationStatus, "none-detected");
  check("...so it is still held", open.pending !== null, true);
  const released = open.executeAlgorithm({ t: 1100 + MERGE_DEFAULTS.holdTimeoutMs + 1 });
  check("handover + timeout releases it", released.fixationStatus, "concluded");
  check("...as the second fixation, unmerged", released.fixationStartTime, 900);
}

console.log("\nthe floor, and where it came from:");
{
  const scat = [];
  for (let i = 0; i < 12; i++) scat.push(scatterOf(fix(i * 1000, i * 1000 + 300, 100, 100, 10, 2)));
  const measured = resolveFloor(scat, 0);
  check("with enough fixations the floor is measured", measured.source, "measured");
  near("...at the configured multiple of the scatter", measured.floor, MERGE_DEFAULTS.scatterMult * measured.scatter);

  const seeded = resolveFloor(scat.slice(0, 3), 10);
  check("too few fixations, but a calibration to lean on -> seeded", seeded.source, "seeded");
  near("...at the seed multiple of the calibration error", seeded.floor, MERGE_DEFAULTS.floorSeedMult * 10);

  const thin = resolveFloor(scat.slice(0, 3), 0);
  check("a passive session with no calibration still gets a finite floor", thin.source, "thin");
  check("...and it is positive", thin.floor > 0, true);

  const nothing = resolveFloor([], 0);
  check("nothing seen at all -> zero, and it says so", [nothing.source, nothing.floor], ["none", 0]);

  const wild = [];
  for (let i = 0; i < 12; i++) wild.push(200);
  const capped = resolveFloor(wild, 5);
  check("a pathological scatter is capped against the calibration", capped.capped, true);
  check("...at the configured multiple", capped.floor, MERGE_DEFAULTS.floorCalibrationCap * 5);
  check("so one bad session cannot merge everything", capped.floor < MERGE_DEFAULTS.scatterMult * 200, true);
}

console.log("\nthe floor a live detector is using, and its provenance:");
{
  const det = rig([], []);
  det.setCalibrationError(10);
  check("before any fixation it is seeded", det.currentFloor().source, "seeded");
  for (let i = 0; i < 12; i++) det._noteInner(fix(i * 1000, i * 1000 + 300, 100, 100, 10, 1));
  check("after enough fixations it is measured", det.currentFloor().source, "measured");
  const stats = det.mergeStats();
  check("the stats carry the parameters in force", [stats.k, stats.maxGapMs, stats.holdTimeoutMs], [3, 100, 2000]);
  check("and say which estimate produced the floor", stats.floorSource, "measured");
}

console.log("\nthe pairwise rule on its own:");
{
  const a = fix(0, 200, 100, 100);
  const b = fix(240, 440, 102, 100);
  check("a close pair inside the gap merges", shouldMerge(a, b, 10), true);
  check("the same pair beyond the gap does not", shouldMerge(a, fix(600, 800, 102, 100), 10), false);
  check("a saccade does not, at any floor", shouldMerge(a, fix(240, 440, 500, 100), 100), false);
  const m = mergeInto(a, b);
  check("merging recomputes the union", m.nSamples, 20);
  check("...and leaves the inputs alone", [a.fixationEndTime, b.fixationStartTime], [200, 240]);
}

console.log("\nthe effective fixation resolution:");
{
  near("at 60 Hz the 120 ms duration binds", effectiveFixationResolutionMs(120, 4, 60), 120);
  near("at 30 Hz they are about balanced", effectiveFixationResolutionMs(120, 4, 30), 133.3, 0.2);
  near("at 20 Hz the sample count binds", effectiveFixationResolutionMs(120, 4, 20), 200);
  near("at 10 Hz it is 400 ms", effectiveFixationResolutionMs(120, 4, 10), 400);
  check("an unknown rate reports nothing rather than guessing", effectiveFixationResolutionMs(120, 4, 0), null);
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
