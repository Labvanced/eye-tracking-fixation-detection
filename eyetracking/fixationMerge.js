/**
 * The merge rule shared by the "Merged Fixations" detector (2.0.12), plus the descriptive fields every
 * fixation should carry.
 *
 * WHY THE MERGE EXISTS. The lagged detector never merges two true fixations, but it splits one true
 * fixation into several: a steady look of one second typically comes out as about three pieces.
 * Everything downstream of fixation events, counts, durations, dwell time and AOI hits, inherits that.
 * The merge joins pieces that the data cannot tell apart.
 *
 * THE RULE. Join a fixation with the one held before it when BOTH hold:
 *   1. the gap between them is at most maxGapMs, and
 *   2. distance(centroid_pending, centroid_next) <= max(k * SE, floor)
 * where SE = sqrt(sd_pending^2 / n_pending + sd_next^2 / n_next) is the standard error of the
 * difference between the two centroids. A real saccade moves the centroid far further than that, so
 * nothing merges across one.
 *
 * WHY THE FLOOR EXISTS. k * SE alone shrinks as the data gets cleaner, so on clean data it stops
 * merging. The floor supplies an absolute scale, measured from the participant's own data as a
 * multiple of the median within-fixation scatter. Accuracy is not what the floor needs: a constant
 * offset shifts the whole trace and never makes one look resemble two. The scatter is.
 *
 * DO NOT set the floor from the gap between consecutive fixations, the intuitive choice: in free
 * viewing that gap is a real saccade, so the floor inflates and genuinely separate looks merge.
 *
 * PROVISIONAL. k, the multipliers and the gap live in MERGE_DEFAULTS so they can be refitted without
 * touching the logic.
 */

/**
 * The provisional constants, in ONE place on purpose.
 *
 * `holdTimeoutMs` is the live half: a concluded fixation is held this long waiting for the next one,
 * because the merge decision needs it. Nearly all merges happen well within it, and a fixation that
 * times out is emitted UNMERGED rather than lost.
 *
 * It only governs waiting WITHIN a trial. Frame end and trial end flush whatever is held
 * (concludeFinalFixations, called before the frame finishes and before the trial's data is recorded),
 * so a trial shorter than the timeout still reports its fixations when it ends rather than two seconds
 * later, and nothing is left pending to leak into the next trial.
 *
 * `floorSeedMult` seeds the floor from the calibration error before enough fixations exist to measure
 * it: the median within-fixation scatter is typically about a fifth of the calibration error, so
 * 0.6 x the calibration error is the right order of magnitude (3 x a scatter of about a fifth).
 */
export const MERGE_DEFAULTS = {
  k: 3,
  scatterMult: 3,
  maxGapMs: 100,
  holdTimeoutMs: 2000,
  minFixationsForScatter: 10,
  scatterWindow: 50,
  floorSeedMult: 0.6,
  floorCalibrationCap: 2
};

const mean = (v) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

export function median(v) {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * A fixation's samples as [x, y] pairs.
 *
 * The detector's own rows are [t, x, y, confidence]; a fixation this module has already merged carries
 * the same shape, since the union is taken over the original rows.
 *
 * @param {Object} f a concluded fixation
 * @returns {Array<Array<number>>}
 */
function pointsOf(f) {
  const g = f && f.gazeData;
  if (!Array.isArray(g)) return [];
  return g.map((p) => (p.length >= 3 ? [p[1], p[2]] : [p[0], p[1]])).filter((p) => isFinite(p[0]) && isFinite(p[1]));
}

/**
 * Centroid, RMS scatter about it, and sample count.
 *
 * @param {Array<Array<number>>} pts
 * @param {Object} fallback a fixation whose centroid stands in when there are no points
 * @returns {{x: number, y: number, sd: number, n: number}}
 */
function shape(pts, fallback) {
  if (!pts.length) {
    return { x: fallback.centroidXmean, y: fallback.centroidYmean, sd: 0, n: 1 };
  }
  const x = mean(pts.map((p) => p[0]));
  const y = mean(pts.map((p) => p[1]));
  // RMS distance from the centroid: this is the SCATTER, the standard-error input the merge test
  // needs, and it is NOT what the detectors call "dispersion". Both inner detectors define dispersion
  // as the MEAN distance (calcDispersion), which is always the smaller of the two, so writing this
  // number into a merged fixation's dispersion field would make merged rows read systematically
  // higher than unmerged ones inside a single export with nothing saying which formula produced a
  // row. mergeInto therefore recomputes dispersion the detectors' way and uses `sd` only internally.
  const sd = Math.sqrt(mean(pts.map((p) => (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y))));
  const dispersion = mean(pts.map((p) => Math.hypot(p[0] - x, p[1] - y)));
  return { x: x, y: y, sd: sd, dispersion: dispersion, n: pts.length };
}

/**
 * One fixation's own scatter: the RMS spread of its samples about its centroid.
 *
 * This is what the floor is measured from, and the detector keeps the NUMBERS rather than the
 * fixations, because a session's worth of fixations with their sample arrays is a lot to hold for a
 * running median.
 *
 * @param {Object} f a concluded fixation
 * @returns {number|null} null when the fixation is too short to say anything
 */
export function scatterOf(f) {
  const pts = pointsOf(f);
  if (pts.length < 3) return null;
  return shape(pts, f).sd;
}

/**
 * Resolve the floor, and say where it came from.
 *
 * The measured scatter takes over once enough fixations exist; before that the calibration error seeds
 * it, and where there is no calibration at all (a passive session) whatever scatter has been seen is
 * still better than no floor. The record says which was in force, so an analysis can tell why early
 * trials merged differently rather than guessing.
 *
 * @param {Array<number>} scatterValues the scatter of the fixations seen so far, most recent last
 * @param {number} calibrationError the participant's calibration error in gaze units, 0 when unknown
 * @param {Object} [opts] overrides of MERGE_DEFAULTS
 * @returns {{floor: number, source: string, scatter: number, nFixations: number, capped: boolean}}
 */
export function resolveFloor(scatterValues, calibrationError, opts) {
  const o = Object.assign({}, MERGE_DEFAULTS, opts || {});
  const all = (scatterValues || []).filter((v) => typeof v === "number" && isFinite(v));
  const recent = all.slice(-o.scatterWindow);
  const scatter = recent.length ? median(recent) : 0;
  let floor;
  let source;
  if (all.length >= o.minFixationsForScatter && scatter > 0) {
    floor = o.scatterMult * scatter;
    source = "measured";
  } else if (calibrationError > 0) {
    floor = o.floorSeedMult * calibrationError;
    source = "seeded";
  } else if (scatter > 0) {
    floor = o.scatterMult * scatter;
    source = "thin";
  } else {
    floor = 0;
    source = "none";
  }
  let capped = false;
  if (calibrationError > 0 && floor > o.floorCalibrationCap * calibrationError) {
    floor = o.floorCalibrationCap * calibrationError;
    capped = true;
  }
  return { floor: floor, source: source, scatter: scatter, nFixations: all.length, capped: capped };
}

/**
 * Can these two be told apart by the data? The pairwise test: gap, then centroid agreement.
 *
 * @param {Object} pending the fixation being held
 * @param {Object} next the one that just concluded
 * @param {number} floor the absolute tolerance from resolveFloor
 * @param {Object} [opts] overrides of MERGE_DEFAULTS
 * @returns {boolean}
 */
export function shouldMerge(pending, next, floor, opts) {
  const o = Object.assign({}, MERGE_DEFAULTS, opts || {});
  if (!pending || !next) return false;
  if (next.fixationStartTime - pending.fixationEndTime > o.maxGapMs) return false;
  const a = shape(pointsOf(pending), pending);
  const b = shape(pointsOf(next), next);
  const se = Math.sqrt((a.sd * a.sd) / a.n + (b.sd * b.sd) / b.n);
  const tol = Math.max(o.k * se, floor);
  return Math.hypot(b.x - a.x, b.y - a.y) <= tol;
}

/**
 * Join `next` into `pending`, recomputing everything from the union of their samples.
 *
 * Returns a NEW object: the inner detector's own fixations are left alone, so nothing that already
 * holds one sees it change underneath.
 *
 * @param {Object} pending
 * @param {Object} next
 * @returns {Object} the merged fixation
 */
export function mergeInto(pending, next) {
  const gazeData = (pending.gazeData || []).concat(next.gazeData || []);
  const merged = {
    fixationStatus: "concluded",
    fixationStartTime: pending.fixationStartTime,
    fixationEndTime: next.fixationEndTime,
    fixationDuration: next.fixationEndTime - pending.fixationStartTime,
    gazeData: gazeData,
    mergedCount: (pending.mergedCount || 1) + (next.mergedCount || 1),
    conclusionCritria: "merged"
  };
  const s = shape(pointsOf(merged), pending);
  merged.centroidXmean = s.x;
  merged.centroidYmean = s.y;
  merged.fixationCentroid = { xmean: s.x, ymean: s.y };
  // The detectors' definition (mean distance from the centroid), so one export's dispersion column
  // means one thing whether or not a row was merged.
  merged.dispersion = s.dispersion;
  annotateFixation(merged);
  return merged;
}

/**
 * Attach the descriptive fields a fixation should have carried all along: how many samples it rests
 * on, the effective rate during it, and the mean confidence of those samples.
 *
 * Mean confidence lets an analysis judge how reliable each fixation is. (Weighting samples by
 * confidence WITHIN a fixation does not help, so that is not done.)
 *
 * Mutates, deliberately: it runs on the detector's own object before anyone sees it, so every fixation
 * is described the same way whichever algorithm produced it. Idempotent.
 *
 * @param {Object} f a concluded fixation
 * @returns {Object} the same fixation
 */
export function annotateFixation(f) {
  if (!f || f.nSamples !== undefined) return f;
  const pts = pointsOf(f);
  const dur = f.fixationEndTime - f.fixationStartTime;
  const conf = (f.gazeData || [])
    .map((p) => (p && p.length >= 4 ? p[3] : null))
    .filter((c) => typeof c === "number" && isFinite(c));
  f.nSamples = pts.length;
  f.rateHz = dur > 0 && pts.length ? +((pts.length / dur) * 1000).toFixed(2) : null;
  f.meanConfidence = conf.length ? +mean(conf).toFixed(4) : null;
  return f;
}

/**
 * The smallest fixation this session could actually resolve, in ms.
 *
 * Both of the detector's limits stay: it needs sampleThresh points AND minFixTimeInMS of elapsed time,
 * and neither should be relaxed, because two or three samples cannot support a trustworthy centroid or
 * dispersion whatever the clock says. Which limit BINDS, though, depends on the participant's rate:
 * at 60 Hz four samples span 67 ms so the 120 ms duration binds, at 20 Hz they span 200 ms and the
 * sample count binds, at 10 Hz 400 ms. Recording this makes "short fixations were not detectable for
 * this participant" a fact in the data rather than something an analyst has to infer.
 *
 * @param {number} minFixTimeInMS the detector's duration limit
 * @param {number} sampleThresh the detector's sample limit
 * @param {number} rateHz the session's measured effective gaze rate
 * @returns {number|null} null when the rate is unknown
 */
export function effectiveFixationResolutionMs(minFixTimeInMS, sampleThresh, rateHz) {
  if (!(rateHz > 0)) return null;
  return +Math.max(minFixTimeInMS, (sampleThresh / rateHz) * 1000).toFixed(1);
}
