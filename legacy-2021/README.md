# Eye-tracking fixation detection, 2021 version

This folder holds the code and sample data published in this repository in November 2021, unchanged, so analyses that used it stay reproducible. For current Labvanced studies, use the algorithms in the repository root (see the [main README](../README.md)).

The algorithm here continues as **Real-Time Fixations** in [`../eyetracking/FixationDetectorRealTime.js`](../eyetracking/FixationDetectorRealTime.js), with the same constants. The differences are packaging: an ES module class, the calibration error set through `setCalibrationError()` instead of the constructor, and `concludeFinalFixations()` to flush an ongoing fixation at the end of a frame or trial.

The sample participant in `data/1/` is also the input of `npm run example` in the repository root.

## Original instructions

A dispersion based fixation detection algorithm for eye tracking data gathered with Labvanced.

Prerequisites: Node.js and npm.

1. Open this folder (`legacy-2021/`)
2. Execute `npm install`
3. Execute `node run.js`
4. This will generate a csv file of fixations for the sample data provided
