import { HONKOKU_RUNTIME, HONKOKU_UPSTREAM_REPOSITORY, HONKOKU_V19_UPSTREAM_COMMIT, fetchHonkokuManifest, validateHonkokuManifest, honkokuManifestDigest, type HonkokuModelManifest } from './manifest.ts';
// Hugging Face v19 snapshot, checked against its model card and LFS metadata.
export const HONKOKU_WEIGHTS_REVISION = 'b0bc83884980826b884a2cfde5ca4275b7d911db';
const root = `https://huggingface.co/yuta1984/honkoku-ocr/resolve/${HONKOKU_WEIGHTS_REVISION}/onnx`;
export const DEFAULT_HONKOKU_MANIFEST: HonkokuModelManifest = {
  schemaVersion: 2, engineId: 'honkoku-v19', modelVersion: 'v19',
  upstreamRepository: HONKOKU_UPSTREAM_REPOSITORY, upstreamCommit: HONKOKU_V19_UPSTREAM_COMMIT,
  license: 'CC-BY-SA-4.0', runtime: HONKOKU_RUNTIME,
  files: {
    encoderInt8: { url: `${root}/encoder.int8.onnx`, bytes: 89795130, sha256: 'de0d9c88004b1dfe2099f479aed19d631ffafa72d2774c4c9ac6ed62d7b2d318' },
    encoderFp16: { url: `${root}/encoder.fp16.onnx`, bytes: 183086925, sha256: 'a783edb25180a0aaf148b4561d4d742a403b3823a8de38d97f94f7c8567894f3' },
    decoderPrefillInt8: { url: `${root}/decoder_prefill.int8.onnx`, bytes: 34286083, sha256: 'aadbd475d00052ed7a99fd51653fa8d218a5c382eaa089f9766cd9cb24333318' },
    decoderStepInt8: { url: `${root}/decoder_step.int8.onnx`, bytes: 31050707, sha256: '2907b39c8de6041a0645b23a30c57bd9ea55a2d91ef9aa06b425102a069411f4' },
    vocab: { url: `https://raw.githubusercontent.com/${HONKOKU_UPSTREAM_REPOSITORY}/${HONKOKU_V19_UPSTREAM_COMMIT}/public/config/kuzushiji-vocab-v19.json`, bytes: 53919, sha256: 'cf0621e68b0997ea8a9815b156f55c5481084b3c7a8d763fd8753178e0a56f25' },
  },
};

/** Localhost and unmerged branches use the same bundled identity as published builds. */
export async function loadHonkokuManifest(url?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (url !== undefined) return fetchHonkokuManifest(url, signal);
  const manifest = validateHonkokuManifest(DEFAULT_HONKOKU_MANIFEST, DEFAULT_HONKOKU_MANIFEST.files.vocab.url);
  const digest = await honkokuManifestDigest(manifest);
  signal?.throwIfAborted();
  return { manifest, digest };
}
