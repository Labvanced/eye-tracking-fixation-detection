// Enum for interval types
const IntervalType = {
  FIXATION: 0,
  GAP: 1
};

// Class to represent an interval in the sequence (either fixation or gap)
class SequenceInterval {
  constructor(startIdx, endIdx, type, excludeIdx = null) {
    this.startIdx = startIdx;
    this.endIdx = endIdx;
    this.type = type; // IntervalType.FIXATION or IntervalType.GAP
    this.excludeIdx = excludeIdx;
  }

  isValid() {
    if (this.type === IntervalType.GAP && this.excludeIdx !== null) {
      return false;
    } else if (this.type === IntervalType.FIXATION && this.excludeIdx !== null) {
      if (this.getSize() <= 3) {
        return false;
      }
      if (this.excludeIdx <= this.startIdx || this.excludeIdx >= this.endIdx) {
        return false;
      }
    }
    return true;
  }

  getSize() {
    return this.endIdx - this.startIdx + 1;
  }

  clone() {
    return new SequenceInterval(this.startIdx, this.endIdx, this.type, this.excludeIdx);
  }
}

// Class to represent a sequence of intervals
class GazeSequence {
  constructor(intervals = []) {
    this.intervals = intervals;
  }

  clone() {
    return new GazeSequence(this.intervals.map((interval) => interval.clone()));
  }
}

export class FixationDetectorLaggedDispersion {
  constructor() {
    this.calibrationError = null;

    // Buffer to store all gaze points
    this.gazeBuffer = [];

    this.sampleThresh = 4; // minimum samples needed to create a fixation
    this.minFixTimeInMS = 120; // minimum time in ms for a fixation
    this.minSamplesForOutlierExclusion = 4; // minimum samples in fixation before allowing outlier exclusion
    this.outlierCostFactor = 1.07; // Cost factor for each outlier gaze sample
    this.gapCostFactor = 1.04; // Cost factor for each gap gaze sample
    this.fixationCostFactor = 1.1; // Cost factor for each fixation
    this.beamWidth = 6; // Number of candidates to keep at each step
    this.minFixationsBeforeConclusion = 3; // Minimum fixations detected before concluding first one (controls lag)

    // Performance optimization: run beam search only every N gaze points
    this.beamSearchInterval = 3; // Run beam search every 3rd gaze point (set to 1 to run on every point)
    this.gazePointsSinceLastSearch = 0;

    // Cost caching for performance optimization
    this.intervalCostCache = new Map(); // Cache for interval dispersion calculations
  }

  setCalibrationError(calib_error) {
    this.calibrationError = calib_error;
  }

  executeAlgorithm(data) {
    // Add new data point to buffer
    this.gazeBuffer.push(data);
    this.gazePointsSinceLastSearch++;

    // Run beam search only every beamSearchInterval points (sparse execution optimization)
    if (this.gazeBuffer.length >= this.sampleThresh * 2 && this.gazePointsSinceLastSearch >= this.beamSearchInterval) {
      this.gazePointsSinceLastSearch = 0;
      const bestSequence = this.findBestFixationSequence();

      let numFixationCandidates = bestSequence.intervals.filter(
        (interval) => interval.type === IntervalType.FIXATION
      ).length;

      // Only conclude and return a fixation if we have enough fixations in the sequence
      if (numFixationCandidates >= this.minFixationsBeforeConclusion) {
        const newFixations = this.concludeNextFixations(bestSequence, false);
        // CONCLUDING CAN FIND NOTHING even though the search found enough fixation intervals, and the
        // caller must still get an object. The two rules disagree by one sample: an interval may drop
        // an outlier at 4 samples (isValid: getSize() <= 3, minSamplesForOutlierExclusion = 4), while
        // concluding needs sampleThresh = 4 points AFTER that exclusion. A best sequence of 4-sample
        // intervals that each excluded one therefore concludes nothing, and this returned undefined.
        // Rare, but it does occur in recorded gaze.
        //
        // Returning a status rather than tightening the exclusion rule, deliberately: requiring 5
        // samples before an exclusion would re-segment every study that uses this detector, and that
        // needs its own replay check. Nothing here changes the detector's state or its output - the
        // fixation is simply concluded on a later search, or at the end of the trial, as before.
        return newFixations[0] || { fixationStatus: "none-detected" };
      }
    }

    return {
      fixationStatus: "none-detected"
    };
  }

  concludeFinalFixations() {
    let fixations = [];
    if (this.gazeBuffer.length >= this.sampleThresh) {
      const bestSequence = this.findBestFixationSequence();
      fixations = this.concludeNextFixations(bestSequence, true);
    }
    this.gazeBuffer = [];
    this.gazePointsSinceLastSearch = 0;
    this.intervalCostCache.clear(); // Clear cache when finalizing
    return fixations;
  }

  concludeNextFixations(sequence, finalizeAll = false) {
    let fixations = [];
    for (const interval of sequence.intervals) {
      const points = this.getIntervalPoints(interval);
      const duration = this.gazeBuffer[interval.endIdx][0] - this.gazeBuffer[interval.startIdx][0];

      // Check both sample count and duration constraints
      if (points.length >= this.sampleThresh && duration >= this.minFixTimeInMS) {
        const centroid = this.calcCentroid(points);
        const fixation = {
          fixationStatus: "concluded",
          fixationStartTime: this.gazeBuffer[interval.startIdx][0],
          fixationEndTime: this.gazeBuffer[interval.endIdx][0],
          fixationDuration: duration,
          fixationCentroid: centroid,
          dispersion: this.calcDispersion(points),
          centroidXmean: centroid.xmean,
          centroidYmean: centroid.ymean,
          gazeData: points,
          conclusionCritria: "beam_search"
        };
        if (!finalizeAll) {
          // remove the points from the gaze buffer and return the fixation:
          this.gazeBuffer = this.gazeBuffer.slice(interval.endIdx + 1);
          // Clear cache since indices have changed
          this.intervalCostCache.clear();
          return [fixation];
        }
        fixations.push(fixation);
      }
    }
    if (finalizeAll) {
      this.gazeBuffer = [];
    }
    return fixations;
  }

  calcCentroid(candidateWindow) {
    //returns the centroid of the fixation
    var xtotal = 0;
    var ytotal = 0;

    for (var i = 0; i < candidateWindow.length; i++) {
      var xcorr = candidateWindow[i][1];
      var ycorr = candidateWindow[i][2];

      // calculate total for x and y
      xtotal += xcorr;
      ytotal += ycorr;
    }
    // // calculate mean for x and y
    var xmean = xtotal / candidateWindow.length;
    var ymean = ytotal / candidateWindow.length;

    return {
      xmean: xmean,
      ymean: ymean
    };
  }

  calcDispersion(candidateWindow) {
    //return the dispersion of the fixation
    var centroid = this.calcCentroid(candidateWindow);
    var centroidxMean = centroid.xmean;
    var centroidyMean = centroid.ymean;
    // calculate std for x
    var edistanceSum = 0;
    for (var i = 0; i < candidateWindow.length; i++) {
      var xcorr = candidateWindow[i][1];
      var ycorr = candidateWindow[i][2];

      // calc euclidan distance for x corr to y corr to x mean and y mean
      var edistance = Math.sqrt(Math.pow(xcorr - centroidxMean, 2) + Math.pow(ycorr - centroidyMean, 2));
      edistanceSum += edistance;
    }
    return edistanceSum / candidateWindow.length;
  }

  getNormalizedDispersion(candidateWindow) {
    let dispersion = this.calcDispersion(candidateWindow);
    let n = candidateWindow.length;

    // Calculate expected dispersion assuming gaze points are drawn from a
    // 2d gaussian with noise defined by calibrationError.
    // Then the expected dispersion as a function of the number of gaze points is:
    let expectedDispersion = Math.sqrt(1 - 1 / n) * this.calibrationError;
    let normalizedDispersion = dispersion / expectedDispersion;
    return normalizedDispersion;
  }

  findBestFixationSequence() {
    // Start with the entire buffer as one fixation
    const endIdx = this.gazeBuffer.length - 1;
    const type = this.calcIntervalType(0, endIdx);
    const initialInterval = new SequenceInterval(0, endIdx, type);
    const initialSequence = new GazeSequence([initialInterval]);

    // Calculate initial cost
    const initialCost = this.calculateSequenceCost(initialSequence);
    return this.beamSearch([{ sequence: initialSequence, cost: initialCost }]);
  }

  beamSearch(sortedCandidates) {
    if (sortedCandidates.length === 0) return null;

    // Keep track of best candidate seen so far
    const bestCandidate = sortedCandidates[0];

    // Generate new candidates from the best ones
    const newCandidates = [];
    for (const { sequence } of sortedCandidates.slice(0, this.beamWidth)) {
      // Generate split candidates and calculate their costs
      const splitCandidates = this.generateSplitCandidates(sequence).map((seq) => ({
        sequence: seq,
        cost: this.calculateSequenceCost(seq)
      }));
      newCandidates.push(...splitCandidates);

      // Generate exclusion candidates and calculate their costs
      const exclusionCandidates = this.generateExclusionCandidates(sequence).map((seq) => ({
        sequence: seq,
        cost: this.calculateSequenceCost(seq)
      }));
      newCandidates.push(...exclusionCandidates);
    }

    // If no new candidates were generated, return the best sequence
    if (newCandidates.length === 0) {
      return bestCandidate.sequence;
    }

    // Find best new candidate
    const bestNewCandidate = newCandidates.reduce(
      (best, current) => (current.cost < best.cost ? current : best),
      newCandidates[0]
    );

    // If the best new candidate is not better than the best previous candidate,
    // or if the improvement is very small (less than 1%),
    // return the best previous sequence
    if (bestNewCandidate.cost >= bestCandidate.cost) {
      return bestCandidate.sequence;
    }

    // Continue beam search with only the best new candidates
    return this.beamSearch(newCandidates.sort((a, b) => a.cost - b.cost).slice(0, this.beamWidth));
  }

  generateSplitCandidates(sequence) {
    const candidates = [];

    // For each interval in the sequence
    for (let i = 0; i < sequence.intervals.length; i++) {
      const interval = sequence.intervals[i];

      // Only try to split fixations, not gaps
      if (interval.type !== IntervalType.FIXATION) continue;

      // Try splitting at each point within the interval
      for (let splitIdx = interval.startIdx + 1; splitIdx < interval.endIdx; splitIdx++) {
        // Calculate boundaries for the new intervals
        let leftStart = interval.startIdx;
        let leftEnd = splitIdx - 1;
        let leftExclude = null;
        let rightStart = splitIdx;
        let rightEnd = interval.endIdx;
        let rightExclude = null;
        let middleStart = null;
        let middleEnd = null;

        // If the original interval had an excluded point, carry it over to the correct split
        if (interval.excludeIdx !== null) {
          if (interval.excludeIdx === splitIdx - 1) {
            // split is just before the excludeIdx:
            leftEnd--;
            middleStart = interval.excludeIdx;
            middleEnd = interval.excludeIdx;
          } else if (interval.excludeIdx === splitIdx) {
            // split is just after the excludeIdx:
            rightStart++;
            middleStart = interval.excludeIdx;
            middleEnd = interval.excludeIdx;
          } else if (interval.excludeIdx < splitIdx - 1) {
            // carry over the excluded point to the left interval
            leftExclude = interval.excludeIdx;
          } else if (interval.excludeIdx > splitIdx) {
            // carry over the excluded point to the right interval
            rightExclude = interval.excludeIdx;
          }
        }

        // Create intervals with calculated types
        const leftType = this.calcIntervalType(leftStart, leftEnd);
        const leftInterval = new SequenceInterval(leftStart, leftEnd, leftType, leftExclude);

        const rightType = this.calcIntervalType(rightStart, rightEnd);
        const rightInterval = new SequenceInterval(rightStart, rightEnd, rightType, rightExclude);

        let middleInterval = null;
        if (middleStart !== null) {
          const middleType = this.calcIntervalType(middleStart, middleEnd);
          middleInterval = new SequenceInterval(middleStart, middleEnd, middleType);
        }

        // Check if the intervals are valid
        if (!leftInterval.isValid() || !rightInterval.isValid()) {
          continue;
        }
        if (middleInterval !== null) {
          if (!middleInterval.isValid()) {
            continue;
          }
          // middleInterval is gap, so make sure that left and right are not also gaps:
          if (leftInterval.type === IntervalType.GAP || rightInterval.type === IntervalType.GAP) {
            continue;
          }
        }

        // Check if this split would create consecutive gaps
        if (i > 0) {
          const prevInterval = sequence.intervals[i - 1];
          if (prevInterval.type === IntervalType.GAP && leftInterval.type === IntervalType.GAP) {
            continue;
          }
        }
        if (i < sequence.intervals.length - 1) {
          const nextInterval = sequence.intervals[i + 1];
          if (nextInterval.type === IntervalType.GAP && rightInterval.type === IntervalType.GAP) {
            continue;
          }
        }
        if (leftInterval.type === IntervalType.GAP && rightInterval.type === IntervalType.GAP) {
          continue;
        }

        // Create new sequence
        const newIntervals = [...sequence.intervals];
        const toAdd = [leftInterval, middleInterval, rightInterval].filter((interval) => interval !== null);
        // Remove the current interval and insert the new intervals
        newIntervals.splice(i, 1, ...toAdd);

        // Create and add the new candidate sequence
        candidates.push(new GazeSequence(newIntervals));
      }
    }

    return candidates;
  }

  generateExclusionCandidates(sequence) {
    const candidates = [];

    // For each interval in the sequence
    for (let i = 0; i < sequence.intervals.length; i++) {
      const interval = sequence.intervals[i];
      // Skip if interval already has an excluded point
      if (
        interval.type === IntervalType.FIXATION &&
        !interval.excludeIdx &&
        interval.getSize() >= this.minSamplesForOutlierExclusion
      ) {
        // Try excluding each point within the interval
        for (let excludeIdx = interval.startIdx + 1; excludeIdx < interval.endIdx; excludeIdx++) {
          // Create new sequence with excluded point marked
          const newSequence = sequence.clone();
          newSequence.intervals[i].excludeIdx = excludeIdx;

          candidates.push(newSequence);
        }
      }
    }

    return candidates;
  }

  calculateSequenceCost(sequence) {
    let totalCost = 0;
    let numGazeGap = 0;
    let numGazeOutliers = 0;
    let numFixations = 0;
    for (const interval of sequence.intervals) {
      const numGazePoints = interval.getSize();
      if (interval.type === IntervalType.FIXATION) {
        // Use cache key based on interval boundaries and exclusion
        const cacheKey = `${interval.startIdx}-${interval.endIdx}-${interval.excludeIdx}`;

        let fixationCost;
        if (this.intervalCostCache.has(cacheKey)) {
          // Use cached cost
          fixationCost = this.intervalCostCache.get(cacheKey);
        } else {
          // Calculate and cache the cost
          const points = this.getIntervalPoints(interval);
          fixationCost = this.getNormalizedDispersion(points);
          this.intervalCostCache.set(cacheKey, fixationCost);
        }

        totalCost += fixationCost;
        if (interval.excludeIdx) {
          numGazeOutliers++;
        }
        numFixations++;
      } else if (interval.type === IntervalType.GAP) {
        numGazeGap += numGazePoints;
      }
    }
    totalCost /= numFixations;
    totalCost *= Math.pow(this.fixationCostFactor, numFixations);
    totalCost *= Math.pow(this.gapCostFactor, numGazeGap);
    totalCost *= Math.pow(this.outlierCostFactor, numGazeOutliers);
    return totalCost;
  }

  getIntervalPoints(interval) {
    const points = [];
    for (let i = interval.startIdx; i <= interval.endIdx; i++) {
      if (i !== interval.excludeIdx) {
        points.push(this.gazeBuffer[i]);
      }
    }
    return points;
  }

  calcIntervalType(startIdx, endIdx) {
    // Check sample count threshold
    const size = endIdx - startIdx + 1;
    if (size < this.sampleThresh) {
      return IntervalType.GAP;
    }

    // Check time duration threshold
    const duration = this.gazeBuffer[endIdx][0] - this.gazeBuffer[startIdx][0];
    if (duration < this.minFixTimeInMS) {
      return IntervalType.GAP;
    }

    return IntervalType.FIXATION;
  }
}
