import { FixationDetectorLaggedDispersion } from "./FixationDetectorLaggedDispersion.js";
import { MERGE_DEFAULTS, annotateFixation, mergeInto, resolveFloor, scatterOf, shouldMerge } from "./fixationMerge.js";

/**
 * "Merged Fixations": the lagged detector with a merge pass, live.
 *
 * WHY IT IS ITS OWN ALGORITHM rather than a switch on the lagged one. Deciding whether two fixations
 * are one look needs the NEXT fixation's centroid, so a fixation has to be HELD until the next one
 * concludes or a timeout passes. That wait comes on top of the lagged detector's own delay, so a
 * fixation is typically reported about a second after it ended, against ~500 ms for Lagged Optimized
 * and ~50 ms for Real-Time. That is a legitimate trade for the best segmentation, and a researcher
 * should make it deliberately: anyone who needs immediate feedback keeps the other two algorithms and
 * the raw gaze stream.
 *
 * ONE STREAM. What is emitted is what is recorded, so a study's fixation events and its exported
 * fixations cannot disagree.
 *
 * A WRAPPER, so nothing inside the existing detectors changes. The contract is theirs:
 * executeAlgorithm returns at most ONE fixation per call, concludeFinalFixations returns an array.
 *
 * WHEN THE HELD FIXATION IS RELEASED, per the task's own "conclude ongoing fixations" setting. The
 * wrapper does not know the setting and does not need to: the flush lives in concludeFinalFixations,
 * and the host calls that only where the setting says so: at the end of every frame (the 2.0
 * default) or of every trial. On 2.0 the host also always concludes before a trial's data is
 * recorded, so a held fixation can never be attributed to the wrong TRIAL, and a trial shorter than
 * holdTimeoutMs does not wait for the timeout either.
 */
export class FixationDetectorMerged {
  /**
   * @param {Object} [opts] overrides of MERGE_DEFAULTS, for tests and tuning
   */
  constructor(opts) {
    this.opts = Object.assign({}, MERGE_DEFAULTS, opts || {});
    this.inner = new FixationDetectorLaggedDispersion();
    // The inner detector's resolution limits, re-exposed because callers read them off the DETECTOR,
    // not off its internals (to report the shortest fixation a session could resolve, see
    // fixationMerge.effectiveFixationResolutionMs). On a wrapper that hid them, both were undefined and
    // that report silently came out empty.
    // Merging never shortens a fixation, so the inner limits are the wrapper's limits too.
    this.minFixTimeInMS = this.inner.minFixTimeInMS;
    this.sampleThresh = this.inner.sampleThresh;
    // At most one concluded-but-held fixation. Holding the MERGED one rather than emitting it is what
    // makes a chain of three or more collapse into one: each new piece is tested against the running
    // union, not against the last piece.
    this.pending = null;
    // When `pending` was handed over by the inner detector, on the SAMPLE clock. The hold timeout is
    // measured from here rather than from the fixation's own end time; see executeAlgorithm. Set on
    // every assignment made by executeAlgorithm; concludeFinalFixations does not set it, and does not
    // need to, because it always drains `pending` before returning.
    this._pendingSince = null;
    // One number per concluded inner fixation (scatterOf), which is all the floor needs.
    this.scatterValues = [];
    // The floor that was in force when the last decision was taken, for the record.
    this.lastFloor = null;
    this.calibrationError = 0;
    this._calibForFloor = 0;
  }

  /**
   * Forwarded to the inner detector, and also the floor's seed until enough fixations exist to measure
   * the scatter directly.
   *
   * @param {number} calibError
   */
  setCalibrationError(calibError) {
    // Stored RAW, exactly as the inner detector stores it, because the host only runs a detector whose
    // `calibrationError` is truthy: a wrapper that sanitised it would
    // gate differently from the detector it wraps, and the difference would show up as a detector that
    // silently never runs.
    this.calibrationError = calibError;
    this._calibForFloor = typeof calibError === "number" && isFinite(calibError) && calibError > 0 ? calibError : 0;
    if (this.inner.setCalibrationError) {
      this.inner.setCalibrationError(calibError);
    }
  }

  /**
   * The floor for the next decision, and where it came from.
   *
   * @returns {Object} see fixationMerge.resolveFloor
   */
  currentFloor() {
    const f = resolveFloor(this.scatterValues, this._calibForFloor, this.opts);
    this.lastFloor = f;
    return f;
  }

  /**
   * How the merge is behaving this session, for the host's record: the parameters in force, the floor
   * and where it came from, and how many fixations went in against how many came out.
   *
   * @returns {Object}
   */
  mergeStats() {
    const f = this.lastFloor || resolveFloor(this.scatterValues, this._calibForFloor, this.opts);
    return {
      k: this.opts.k,
      maxGapMs: this.opts.maxGapMs,
      holdTimeoutMs: this.opts.holdTimeoutMs,
      floor: +f.floor.toFixed(4),
      floorSource: f.source,
      floorCapped: f.capped,
      scatter: +f.scatter.toFixed(4),
      nSeen: f.nFixations,
      nIn: this._nIn || 0,
      nOut: this._nOut || 0
    };
  }

  /**
   * One gaze sample in, at most one fixation out.
   *
   * Order matters. The timeout is checked BEFORE the inner detector runs, so a call can never both
   * release a timed-out fixation and emit a newly concluded one: the contract the other detectors keep
   * is one fixation per call, and the host's callback path assumes it.
   *
   * @param {Object} sample the gaze sample, as the inner detector takes it
   * @returns {Object} a concluded fixation, or {fixationStatus: "none-detected"}
   */
  executeAlgorithm(sample) {
    const none = { fixationStatus: "none-detected" };
    let released = null;

    // 1. A held fixation nobody came to join.
    //
    // Timed from when the fixation was HANDED OVER, not from its fixationEndTime. The inner detector
    // reports a fixation some time after the eye stopped, occasionally seconds, so measuring from the
    // end time spends that lag out of the same budget: a fixation handed over late would be released
    // on the very next sample, before its successor could possibly conclude. The budget is meant to
    // be "how long to wait for the NEXT fixation", which starts when this one arrives. It also makes
    // the wait bounded on slow participants, who are the ones merging helps most.
    const t = this._timeOf(sample);
    if (this.pending && t !== null && this._pendingSince !== null && t - this._pendingSince > this.opts.holdTimeoutMs) {
      released = this.pending;
      this.pending = null;
      this._pendingSince = null;
    }

    const r = this.inner.executeAlgorithm(sample);
    if (!r || r.fixationStatus !== "concluded") {
      return released ? this._emit(released) : none;
    }

    // 2. The inner detector concluded one. Its scatter feeds the floor whether or not it merges.
    this._noteInner(r);

    // 3. Join it to what is held, or start holding it instead.
    if (released) {
      // A timeout released the previous one on this very call, so there is nothing to merge into and
      // the new one simply becomes pending. The released fixation is what this call returns: at most
      // one, and the older of the two, so order is preserved.
      this.pending = r;
      this._pendingSince = t;
      return this._emit(released);
    }
    const floor = this.currentFloor();
    if (this.pending && shouldMerge(this.pending, r, floor.floor, this.opts)) {
      // Held, NOT emitted: the union is what the next piece will be tested against.
      // The union keeps the ORIGINAL handover stamp: the budget is for deciding one look, not one
      // that renews itself every time another piece joins.
      this.pending = mergeInto(this.pending, r);
      return none;
    }
    const out = this.pending;
    this.pending = r;
    this._pendingSince = t;
    return out ? this._emit(out) : none;
  }

  /**
   * Frame end and trial end: run whatever the inner detector still holds through the same machine,
   * flush the pending fixation, and return everything in chronological order.
   *
   * Several fixations arriving together is the NORMAL case here, not an edge case. The host already
   * iterates the array and calls the fixation callback per entry.
   *
   * @returns {Array<Object>} concluded fixations, oldest first
   */
  concludeFinalFixations() {
    const out = [];
    const finals = this.inner.concludeFinalFixations ? this.inner.concludeFinalFixations() || [] : [];
    finals.forEach((r) => {
      if (!r || r.fixationStatus !== "concluded") return;
      this._noteInner(r);
      const floor = this.currentFloor();
      if (this.pending && shouldMerge(this.pending, r, floor.floor, this.opts)) {
        this.pending = mergeInto(this.pending, r);
        return;
      }
      if (this.pending) out.push(this._emit(this.pending));
      // No handover stamp here, deliberately. _pendingSince is a SAMPLE time (see executeAlgorithm)
      // and this path has no sample: `r` is a concluded fixation, which carries fixationStartTime and
      // fixationEndTime, not the clock _timeOf reads. It needs none either, because the flush below
      // always drains `pending` before this method returns, so nothing can survive to be timed out.
      // An earlier attempt to stamp it here read _timeOf(r), which is always null for a fixation, so
      // the line was a no-op wearing a correctness comment.
      this.pending = r;
    });
    if (this.pending) {
      out.push(this._emit(this.pending));
      this.pending = null;
      this._pendingSince = null;
    }
    return out;
  }

  /**
   * The sample's timestamp, however the caller shaped it. The inner detector takes rows and objects
   * from different call sites, and the timeout must not silently stop working because a shape changed.
   *
   * @param {*} sample
   * @returns {number|null}
   */
  _timeOf(sample) {
    if (!sample) return null;
    if (Array.isArray(sample)) return isFinite(sample[0]) ? sample[0] : null;
    if (typeof sample.t === "number") return sample.t;
    if (typeof sample.timestamp === "number") return sample.timestamp;
    if (typeof sample.time === "number") return sample.time;
    return null;
  }

  _noteInner(r) {
    this._nIn = (this._nIn || 0) + 1;
    annotateFixation(r);
    const s = scatterOf(r);
    if (typeof s === "number" && isFinite(s)) {
      this.scatterValues.push(s);
      // Bounded: the floor is a median over the recent window, so a long session need not hold
      // thousands of numbers to compute the same value.
      if (this.scatterValues.length > this.opts.scatterWindow * 4) {
        this.scatterValues.splice(0, this.scatterValues.length - this.opts.scatterWindow * 2);
      }
    }
  }

  _emit(f) {
    this._nOut = (this._nOut || 0) + 1;
    return annotateFixation(f);
  }
}
