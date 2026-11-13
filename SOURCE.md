# Source of the detector files

The files below come from Labvanced eye tracking **2.0.15** (commit `607936d493472cef1a8e56ff93293a8f1c2d33c4`, 2026-10-07). This is the code the Labvanced player runs in the participant's browser.

The program code is unchanged. In three files some comments were shortened, removing references to internal systems and unpublished measurements. We checked that the code is identical by comparing each file with the original after removing all comments and whitespace (`esbuild --minify-whitespace`); the outputs match byte for byte.

| File | Comments | SHA-256 of the published file |
| --- | --- | --- |
| `eyetracking/FixationDetectorRealTime.js` | unchanged | `0cae18f99becee940ef2489b969466e63763f9ccadb48bb773376060528c3b8b` |
| `eyetracking/FixationDetectorLaggedDispersion.js` | shortened | `5fa5f094ec7e3f14f88c15a78973d2dc33946d4db0d8364884454f2220646158` |
| `eyetracking/FixationDetectorMerged.js` | shortened | `81fce8ac4246598cfc6f7ad379260679723f6fe8baddb4b5f9171b147366d472` |
| `eyetracking/fixationMerge.js` | shortened | `50f5eaa0c7f795f0f53fd827eae6ecab4758ae7a31a8d804328955b2098f4564` |
| `tests/fixationMerge.test.mjs` | unchanged | `f26a70218baf42687cff6d7199208d37500558518c731550f10db244ef2bf40b` |

Check them with `sha256sum eyetracking/*.js tests/fixationMerge.test.mjs`.

Everything else in this repository was written for it: `run.mjs` (the command-line runner), `tests/syntheticGroundTruth.test.mjs`, and the documentation.

Where the comments mention "the host", they mean the Labvanced player, which is not published here. It feeds the detectors one gaze sample at a time and calls `concludeFinalFixations()` at frame or trial ends; `run.mjs` makes the same calls.

When a later eye-tracking version changes any of these files, the files are copied again, this table and the `version` in `package.json` are updated, and the release is tagged with that version.
