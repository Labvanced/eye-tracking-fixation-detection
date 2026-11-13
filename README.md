# Eye-tracking fixation detection (Labvanced)

The fixation detection algorithms of Labvanced webcam eye tracking, published so that anyone can read them, run them on their own data, and check the fixations Labvanced reports.

The detector files in [`eyetracking/`](eyetracking/) are the unmodified source of Labvanced eye tracking **2.0.15** (provenance and checksums in [SOURCE.md](SOURCE.md)). In a study they run live in the participant's browser. This repository runs the same classes in Node.js on recorded gaze data, with no dependencies.

## The three algorithms

A study selects one algorithm in its eye-tracking settings and can override it per task. All three run live during the study. The names describe how soon after the eye stops a fixation is reported, not whether anything is computed afterwards.

| Labvanced setting | Source | Reported after the fixation ends | Typical use |
| --- | --- | --- | --- |
| Real-Time Fixations | `FixationDetectorRealTime.js` | about 50 ms | gaze-contingent displays, immediate feedback |
| Lagged Optimized Fixations | `FixationDetectorLaggedDispersion.js` | about 500 ms | fixation events that tolerate a delay |
| Merged Fixations (default in eye tracking 2.0) | `FixationDetectorMerged.js`, `fixationMerge.js` | about 1 s | fixation counts, durations, dwell times, areas of interest |

All three share one interface:

- `setCalibrationError(e)` must be called first. No detector emits a fixation before it has a calibration error above 0. Gaze coordinates and `e` must be in the same units; no other unit matters.
- `executeAlgorithm([t, x, y, confidence])` takes one gaze sample (`t` in ms) and returns at most one concluded fixation (`fixationStatus: "concluded"`).
- `concludeFinalFixations()` returns whatever is still open, in time order. Labvanced 2.0 calls it at the end of every frame (the default) or every trial, so no fixation crosses a trial boundary.

### Real-Time Fixations

A sliding-window dispersion detector. Dispersion is the mean distance of the window's samples from their centroid. A fixation starts once at least four samples have a dispersion below 3.25 × the calibration error. It ends when the next sample would push the dispersion above that limit, or would raise it by more than a relative allowance that depends on the fixation's duration: +160 % at 100 ms, falling linearly to 0 at 280 ms and below zero after that (−52 % at 5 s). A gap of more than 150 ms between samples also ends it, and a sample identical to the previous one (the same camera frame twice) is skipped.

Because the limit is a multiple of the calibration error rather than of the noise, two looks a short distance apart can occasionally be reported as one fixation. This is the algorithm published here in 2021 (see [`legacy-2021/`](legacy-2021/)), with the same constants.

### Lagged Optimized Fixations

Segments a buffer of recent samples into fixations and gaps by beam search. The cost of a segmentation is

```
mean normalized dispersion of its fixations × 1.10^(fixations) × 1.04^(gap samples) × 1.07^(excluded outliers)
normalized dispersion = dispersion / (sqrt(1 − 1/n) × calibration error)
```

The denominator is the dispersion that `n` samples scattered by the calibration error would show. Starting from the whole buffer as one fixation, the search tries every split point and every single-sample outlier exclusion, keeps the 6 cheapest candidates, and repeats until no candidate is cheaper. A fixation needs at least 4 samples and at least 120 ms, and may exclude one outlier sample. The search runs on every third sample. Once the best segmentation holds at least 3 fixations, the first one is reported, and it and everything before it leave the buffer; waiting for that is where the delay comes from.

Every fixation's cost is divided by the same calibration error, so the segmentation does not depend on the error's value, only on it being above 0.

This detector does not join separate looks, but it splits one long look into several fixations (typically about three on a steady look of one second).

### Merged Fixations

Lagged Optimized with a merge step, run live. Each fixation from the lagged detector is held until the next one arrives. The two are joined when both conditions hold:

1. the gap between them is at most 100 ms, and
2. the distance between their centroids is at most `max(3 × SE, floor)`, where `SE = sqrt(sd₁² / n₁ + sd₂² / n₂)` is the standard error of the difference between the two centroids (`sd` is the RMS distance of a fixation's samples from its centroid, `n` its sample count).

The joined fixation is recomputed from the union of the samples and stays held, so a look split into three pieces becomes one fixation. A held fixation is reported when the next one does not join it, when 2000 ms pass without a successor (it is then reported unmerged), or at the end of the frame or trial. The hold comes on top of the lagged detector's own delay.

The floor gives the test an absolute scale, measured from the participant's own data: 3 × the median `sd` of their last 50 fixations, once 10 fixations exist. Before that it is 0.6 × the calibration error, and it never exceeds 2 × the calibration error. A real saccade moves the centroid far beyond this tolerance, so nothing merges across one.

| Parameter (`MERGE_DEFAULTS` in `fixationMerge.js`)    | Value |
| ----------------------------------------------------- | ----- |
| `k` (standard errors)                                 | 3     |
| `maxGapMs`                                            | 100   |
| `holdTimeoutMs`                                       | 2000  |
| `scatterMult` (floor = scatterMult × median sd)       | 3     |
| `minFixationsForScatter`                              | 10    |
| `scatterWindow` (fixations in the median)             | 50    |
| `floorSeedMult` (× calibration error, until measured) | 0.6   |
| `floorCalibrationCap` (× calibration error)           | 2     |

The reasoning and measurements behind each constant are documented next to the code in `fixationMerge.js` and `FixationDetectorMerged.js`.

### Fields of a concluded fixation

`fixationStartTime`, `fixationEndTime`, `fixationDuration` (ms); `centroidXmean`, `centroidYmean`; `dispersion` (mean distance from the centroid); `gazeData` (the samples); `nSamples`, `rateHz` and `meanConfidence` (mean gaze confidence of its samples); `conclusionCritria` (sic, the field name in the code: why it ended, or `merged`); and on a merged fixation `mergedCount`, the number of lagged fixations it joins.

## Try it

Requires Node.js 18 or later. There is nothing to install.

```sh
npm test          # the merge unit tests, then the synthetic ground-truth test
npm run example   # the 2021 sample participant -> fixations_example.csv
```

`tests/syntheticGroundTruth.test.mjs` generates webcam-like gaze (about 30 Hz, noise SD 8 units, 48 fixations of 250 to 1500 ms with saccades between them) where every sample's true fixation is known, runs all three detectors, and checks the claims above. With the default seed:

| Algorithm | Detected | Per true fixation | True fixations found | Found as exactly one | Joining two true fixations | Median centroid error |
| --- | --- | --- | --- | --- | --- | --- |
| Real-Time | 109 | 2.27 | 48 of 48 | 13 | 0 | 3.60 |
| Lagged Optimized | 78 | 1.63 | 48 of 48 | 25 | 0 | 3.41 |
| Merged | 48 | 1.00 | 48 of 48 | 48 | 0 | 2.22 |

Change `SEED` and `NOISE` at the top of the file to explore. Synthetic gaze is stationary noise around fixed points; real webcam gaze also drifts and has bias, so treat the table as a demonstration of the mechanisms, not as an accuracy figure.

## Run it on your own data

```sh
node run.mjs "gaze_Eyetracking Gaze.csv" --calibration-pct 5.1 --sessions sessions.csv --out fixations.csv
```

The input is any CSV with the columns `T` (ms), `X`, `Y` and optionally `C` (confidence), in any letter case. A Labvanced gaze export (`gaze_<variable name>.csv`) works as it is. Pass several gaze files of one participant at once if the study records gaze in several variables. Rows are grouped by `Rec_Session_Id` (one detector per session, as in the player) and by `Task_Name` + `Trial_Nr` (the detector is flushed at the end of each trial).

The calibration error is given in one of two ways:

- `--calibration-pct <n>`: the participant's calibration error in % of the window diagonal, as Labvanced reports it. `run.mjs` converts it into the units of `X`/`Y` using the window size, from `--window <W>x<H>` or from the session export (`--sessions sessions.csv`, columns `Window_Width_In_Pixels` and `Window_Height_In_Pixels`).
- `--calibration-error <n>`: directly in the units of `X`/`Y`. Use this for data from other eye trackers too.

How much the value matters depends on the algorithm: Lagged Optimized does not depend on it at all, Real-Time scales its threshold with it, and Merged Fixations uses it only to seed the merge floor for the first 10 fixations and to cap it.

Labvanced exports gaze in the units of the study's frame, which is scaled to fit the window. The default frame is 800x450; if your study uses another frame size, pass `--frame <W>x<H>`.

Other options: `--algorithm merged|lagged|realtime` (default `merged`), `--task <Task_Name>`.

The output has one row per fixation: `Rec_Session_Id, Task_Name, Trial_Nr, Start, End, Duration, X, Y, Dispersion, nSamples, rateHz, meanConfidence, mergedCount, conclusionCriteria`. A summary per session, including the merge floor, goes to stderr.

## What a re-run reproduces

A re-run applies exactly the algorithm Labvanced applied. It will still not, in general, reproduce Labvanced's exported fixation rows one for one. We have seen re-runs reproduce whole trials exactly (identical centroids, start and end times a few milliseconds apart) and other trials differ. The causes we know:

- **Clock.** Live, the detector receives each sample with the prediction's own timestamp, which is a few milliseconds off the `T` in the gaze export. Start and end times differ by that much even when the segmentation is identical.
- **Stream.** Live, the detector also runs during frames that do not record gaze. With Merged Fixations, its floor is measured from every fixation it saw, so it can differ from the floor measured on the exported gaze alone.
- **Flush points.** Live, open fixations are flushed at the end of every frame. The export marks trials, not frames, so `run.mjs` flushes per trial.
- **Calibration error.** The value the live detector used can differ slightly from the one reported for the session. This only matters for Real-Time, and for the first fixations of Merged Fixations.

## The 2021 version

The detector published here in 2021 is in [`legacy-2021/`](legacy-2021/), unchanged, with its sample data and instructions. It continues as Real-Time Fixations.

## Related

- Accuracy of Labvanced webcam eye tracking 2.0, with data: [Lab note](https://www.labvanced.com/content/research/en/lab-notes/2026-10-webcam-eyetracking-2-0/), dataset [doi:10.17605/OSF.IO/VTA7B](https://doi.org/10.17605/OSF.IO/VTA7B)

When you report fixations from Labvanced, please name the algorithm and the eye-tracking version, and link this repository.

## License

MIT, see [LICENSE](LICENSE).
