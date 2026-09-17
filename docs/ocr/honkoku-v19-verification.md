# Honkoku v19 integration verification

## Scope and provenance

- Integrated against `origin/main` at `95a5b65d6996f0b1c365a68981d3f7a36cff4af2`.
- Preserved the existing local v19 prototype before integrating main's NDL worker, source-image handling, batch jobs and ZIP export.
- Checked upstream HEAD: `yuta1984/honkoku-ocr-web` at `24469701412edda5be26c89784a29c7525bbb899`.
- Publisher weights: Hugging Face snapshot `b0bc83884980826b884a2cfde5ca4275b7d911db`.
- The model card specifies **CC BY-SA 4.0**, correcting PLAN.md's assumption of CC BY 4.0 for the weights. The browser reference implementation and vocabulary use CC BY 4.0.
- The small manifest is committed under `public/honkoku/v19/`; model binaries remain on immutable publisher URLs.

## Contracts checked

- Model selection → pinned request → engine-specific page worker → viewer, persisted page result, batch checkpoint and ZIP/benchmark provenance.
- Resume uses the saved request. A replaced manifest or conflicting detector/recognizer/pipeline identity is rejected before cached results or inference can be used.
- Legacy NDL jobs require a full matching revision and compatible pipeline. Legacy page-cache dual reads apply to NDL only. Incompatible jobs remain exportable.
- SHA-256 and byte length are checked on both downloads and cache reads. Downloads are deduplicated; size mismatch permits one retry, hash mismatch does not. IndexedDB stores model bytes as Blobs to avoid Chromium's approximately 127 MiB serialized-value limit for the 183 MB FP16 encoder.
- No nested workers. Single-page and batch OCR share one execution slot. Abort and idle/engine disposal terminate the worker.
- Honkoku's initial CLS token is consumed rather than treated as invalid text. Koji tags are retained; generation diagnostics are never displayed as recognition accuracy.
- UI selection persists, is locked while OCR runs, and does not relabel an existing result. Disabled explanation and batch controls fit the 390 px viewport.

Skills applied: `code.boundary.v1` for manifest/request validation; `code.effects.v1` for IndexedDB/model lifetime; `code.protocol.v1` for pinned worker/job identities; `ui.forms.v1` and `ui.async.v1` for selection, progress and recovery. No recalled project memory was supplied.

## Automated checks

- `npm ci`: completed with main's lockfile.
- `npm run check`: 0 errors / 0 warnings.
- `npm run test:unit`: 69 passed.
- `npm run build`: passed with Honkoku disabled and enabled.
- `npm run test:browser`: 27 passed; 1 explicitly manual real-model test skipped.
- `npm run test:honkoku-adapter`: 6 passed, including actual page-worker messaging with mocked inference, cache corruption, decoder error/reinitialization, mobile provider selection and GPU fallback.
- `npm run test:honkoku-line-smoke`: passed with actual publisher INT8 encoder/prefill/step and vocabulary. Sample result: `一尺二尺二寸二寸二分二厘`, EOS, 14 generated tokens. Elapsed test time 32.8 s, including first downloads/initialization; this is a compatibility check, not an accuracy benchmark.

- Real page smoke: passed against a public NIJL IIIF page, 14 lines, actual NDL detector plus Honkoku encoder/prefill/step. First run 192,578 ms; fresh worker using IndexedDB 157,352 ms. Cached run fetched **0 model files**. Identity and manifest digest matched across runs.
- This real-page run exercised missing-GPU fallback and validated both encoder artifacts (5 initial model requests). The final client checks adapter availability before choosing WebGPU, covered by the provider test, so an unavailable adapter chooses INT8 without requesting FP16.
- Environment: macOS arm64, Playwright Chromium 153.0.8010.12, WASM. Times include image retrieval/model initialization and are observations, not a portable performance guarantee.

## Reproduction and limits

Use Node 24+ and `npx playwright install chromium`. `npm test` runs ordinary checks without large model downloads. External real-model smoke is separate.

Before main contains the manifest, the page smoke can serve the committed manifest through its test-only HTTPS route while fetching every model file from the real publisher:

```sh
VITE_ENABLE_HONKOKU=true \
VITE_HONKOKU_MODEL_MANIFEST_URL=https://models.example.test/manifest.json \
HONKOKU_SMOKE_BUNDLED_MANIFEST=1 \
npm run test:honkoku-smoke
```

`HONKOKU_SMOKE_BUNDLED_MANIFEST` affects only the test fixture; production code uses its bundled manifest unless an external HTTPS manifest is explicitly configured. Model hash/size checks are not bypassed. Model smoke uses its own server and output directory.

Physical iOS/Android devices, native screen-reader interaction, peak GPU memory and real hardware WebGPU performance are not established by the mock/mobile tests. A production deployment has not been published by this change. Honkoku is now available by default through the bundled manifest. `.env.example` documents optional disabling and external manifest overrides.

## Default activation correction

The initial integration left Honkoku disabled without two environment settings, so a normal local start still showed an unusable model selector. That did not complete the requested workflow. The default now loads the pinned manifest already bundled with the app, including in workers and resumed jobs; no unpublished main-branch URL is needed. NDL remains the initial selection. An explicit `VITE_ENABLE_HONKOKU=false` still disables Honkoku; external HTTPS manifests remain optional and fail closed if unavailable or changed.

Regression coverage exercises startup with no Honkoku environment variables, saved selection restoration, an actual selected request reaching the worker, the bundled digest on resume, and continued rejection of changed external manifests. Prior memory describing required opt-in settings was checked against the source and is superseded by this correction.

Verification after the activation fix: type check passed; 70 unit tests, 27 browser tests and 6 adapter tests passed; normal build passed. The adapter server explicitly unsets both Honkoku environment variables. In the user's existing Safari tab at `localhost:5173/ocr/`, normal startup restored Honkoku selection and the actual page button completed OCR with 14 lines. The visible result identified `みんなで翻刻OCR v19 · 24469701 / WebGPU / WASM`; no environment setup or external manifest deployment was needed. This confirms native Safari WebGPU/WASM compatibility for that page, not a cross-device performance benchmark.
