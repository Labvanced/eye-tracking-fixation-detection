// Detect fixations in recorded gaze data with the same detector classes Labvanced runs live.
//
//   node run.mjs <gaze.csv> [<more gaze.csv> ...] [options]
//
// Input: one or more CSV files with the columns T, X, Y and optionally C (gaze confidence), in any
// letter case. A Labvanced gaze export ("gaze_<variable>.csv") works as it is. Rows are grouped by
// Rec_Session_Id (one detector per participant session) and by Task_Name + Trial_Nr (the detector is
// flushed at the end of each trial, as the player does), when those columns exist.
//
// Options:
//   --algorithm merged|lagged|realtime  default: merged (the Labvanced 2.0 default)
//   --calibration-error <n>             the participant's calibration error in the units of X/Y
//   --calibration-pct <n>               calibration error in % of the window diagonal, converted to
//                                       the units of X/Y with the window and frame size
//   --window <W>x<H>                    the participant's browser window in px (with --calibration-pct)
//   --sessions <sessions.csv>           a Labvanced session export, to take the window size from
//   --frame <W>x<H>                     the study's frame size, i.e. the units of X/Y (default 800x450)
//   --task <name>                       only rows of this Task_Name
//   --out <file.csv>                    write here instead of stdout
//
// Every detector needs a calibration error > 0 before it emits anything. Lagged Optimized does not
// depend on its value (it divides every fixation's cost by the same number); Real-Time scales its
// dispersion threshold with it; Merged uses it to seed and cap the merge floor (see README).
import { readFileSync, writeFileSync } from "fs";
import { FixationDetectorRealTime } from "./eyetracking/FixationDetectorRealTime.js";
import { FixationDetectorLaggedDispersion } from "./eyetracking/FixationDetectorLaggedDispersion.js";
import { FixationDetectorMerged } from "./eyetracking/FixationDetectorMerged.js";
import { annotateFixation } from "./eyetracking/fixationMerge.js";

const DETECTORS = {
  realtime: () => new FixationDetectorRealTime(),
  lagged: () => new FixationDetectorLaggedDispersion(),
  merged: () => new FixationDetectorMerged()
};

const OUTPUT_COLUMNS = [
  "Rec_Session_Id",
  "Task_Name",
  "Trial_Nr",
  "Start",
  "End",
  "Duration",
  "X",
  "Y",
  "Dispersion",
  "nSamples",
  "rateHz",
  "meanConfidence",
  "mergedCount",
  "conclusionCriteria"
];

function parseArgs(argv) {
  const files = [];
  const opts = { algorithm: "merged", frame: "800x450" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      opts[a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = argv[++i];
    } else {
      files.push(a);
    }
  }
  return { files, opts };
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes inside them, commas inside quotes. Labvanced exports
 * carry JSON in quoted cells, so a naive split breaks on them.
 *
 * @param {string} path
 * @returns {Array<Object>} one object per row, keyed by the header
 */
function readCsv(path) {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function column(row, name) {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : row[key];
}

function size(spec, what) {
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(spec || "");
  if (!m) throw new Error(`${what} must look like 800x450, got "${spec}"`);
  return [Number(m[1]), Number(m[2])];
}

/**
 * The calibration error in the units of X/Y.
 *
 * Labvanced reports it in % of the window diagonal, while the exported gaze is in frame units: the
 * study's frame (800x450 by default) scaled to fit the participant's window. One frame unit is
 * therefore min(W / frameW, H / frameH) window pixels.
 */
function resolveCalibrationError(opts) {
  if (opts.calibrationError !== undefined) return Number(opts.calibrationError);
  if (opts.calibrationPct === undefined) {
    throw new Error("no calibration error: pass --calibration-error, or --calibration-pct with --window or --sessions");
  }
  const pct = Number(opts.calibrationPct);
  let win = opts.window ? size(opts.window, "--window") : null;
  if (!win && opts.sessions) {
    const s = readCsv(opts.sessions)[0];
    win = [Number(s.Window_Width_In_Pixels), Number(s.Window_Height_In_Pixels)];
  }
  if (!win) throw new Error("--calibration-pct needs the window size: --window <W>x<H> or --sessions");
  const [fw, fh] = size(opts.frame, "--frame");
  const pxPerUnit = Math.min(win[0] / fw, win[1] / fh);
  return ((pct / 100) * Math.hypot(win[0], win[1])) / pxPerUnit;
}

function main() {
  const { files, opts } = parseArgs(process.argv.slice(2));
  if (!files.length || !DETECTORS[opts.algorithm]) {
    console.error(
      "usage: node run.mjs <gaze.csv> [...] [--algorithm merged|lagged|realtime] [--calibration-error n] ..."
    );
    console.error("see the comment at the top of run.mjs for all options");
    process.exit(1);
  }
  const calibrationError = resolveCalibrationError(opts);
  if (!(calibrationError > 0)) throw new Error(`calibration error must be > 0, got ${calibrationError}`);

  // session -> trial key -> samples
  const sessions = new Map();
  for (const file of files) {
    for (const r of readCsv(file)) {
      const t = Number(column(r, "T"));
      const x = Number(column(r, "X"));
      const y = Number(column(r, "Y"));
      const cRaw = column(r, "C");
      if ([column(r, "T"), column(r, "X"), column(r, "Y")].some((v) => v === undefined || v === "")) continue;
      if (![t, x, y].every(Number.isFinite)) continue;
      const task = column(r, "Task_Name") || "";
      if (opts.task && task !== opts.task) continue;
      const session = column(r, "Rec_Session_Id") || "";
      const trial = column(r, "Trial_Nr") || "";
      if (!sessions.has(session)) sessions.set(session, new Map());
      const trials = sessions.get(session);
      const key = `${task}\u0000${trial}`;
      if (!trials.has(key)) trials.set(key, { task, trial, samples: [] });
      trials.get(key).samples.push([t, x, y, cRaw === undefined || cRaw === "" ? null : Number(cRaw)]);
    }
  }

  const lines = [OUTPUT_COLUMNS.join(",")];
  for (const [session, trials] of sessions) {
    // One detector for the whole session, as in the player: the merge floor is measured from the
    // participant's fixations across trials, so a fresh detector per trial would never leave its seed.
    const det = DETECTORS[opts.algorithm]();
    det.setCalibrationError(calibrationError);
    const ordered = [...trials.values()].map((tr) => {
      tr.samples.sort((a, b) => a[0] - b[0]);
      return tr;
    });
    ordered.sort((a, b) => a.samples[0][0] - b.samples[0][0]);
    let nFix = 0;
    for (const tr of ordered) {
      const emit = (f) => {
        if (!f || f.fixationStatus !== "concluded") return;
        annotateFixation(f);
        nFix++;
        lines.push(
          [
            session,
            tr.task,
            tr.trial,
            f.fixationStartTime,
            f.fixationEndTime,
            f.fixationDuration,
            f.centroidXmean,
            f.centroidYmean,
            f.dispersion,
            f.nSamples,
            f.rateHz,
            f.meanConfidence,
            f.mergedCount || 1,
            f.conclusionCritria
          ]
            .map((v) =>
              v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v
            )
            .join(",")
        );
      };
      for (const sample of tr.samples) emit(det.executeAlgorithm(sample));
      (det.concludeFinalFixations() || []).forEach(emit);
    }
    const stats = det.mergeStats ? det.mergeStats() : null;
    console.error(
      `session ${session || "(all rows)"}: ${ordered.length} trials, ${nFix} fixations (${opts.algorithm}, ` +
        `calibration error ${calibrationError.toFixed(2)})` +
        (stats ? `, merge floor ${stats.floor} (${stats.floorSource}), ${stats.nIn} inner -> ${stats.nOut} out` : "")
    );
  }

  if (opts.out) {
    writeFileSync(opts.out, lines.join("\n") + "\n");
    console.error(`wrote ${lines.length - 1} fixations to ${opts.out}`);
  } else {
    process.stdout.write(lines.join("\n") + "\n");
  }
}

try {
  main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
