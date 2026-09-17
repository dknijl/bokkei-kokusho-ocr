// v19 IO and preprocessing based on Yuta Hashimoto's honkoku-ocr-web (CC BY 4.0).
// Adapted: single runtime, bounded decoding, explicit tensor disposal and diagnostics.
import type * as Ort from 'onnxruntime-web';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import gpuWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import gpuMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { loadHonkokuAsset, ensureHonkokuStorage } from './model-cache.ts';
import type { HonkokuModelManifest } from './manifest.ts';
import type { OcrLine, OcrStopReason } from '../types.ts';

export function repeatPeriod(ids: number[]): number {
  if (ids.length < 12) return 0;
  for (let p = 1; p <= 4; p++) {
    let repeated = true;
    for (let i = ids.length - 12; i < ids.length - p; i++) if (ids[i] !== ids[i + p]) repeated = false;
    if (repeated) return p;
  }
  return 0;
}
export { rawKojiToPlainText } from '../koji/plain-text.ts';
import { rawKojiToPlainText } from '../koji/plain-text.ts';
function dispose(values: Record<string, Ort.Tensor> | null): void {
  if (values) for (const tensor of new Set(Object.values(values))) tensor.dispose();
}
type RuntimeDependencies = {
  loadOrt: (useGpu: boolean) => Promise<typeof Ort>;
  loadAsset: typeof loadHonkokuAsset;
  ensureStorage: typeof ensureHonkokuStorage;
};
export class HonkokuRuntime {
  constructor(private dependencies: RuntimeDependencies = {
    loadOrt: async useGpu => (useGpu ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')) as typeof Ort,
    loadAsset: loadHonkokuAsset, ensureStorage: ensureHonkokuStorage,
  }) {}
  ort!: typeof Ort;
  private encoder?: Ort.InferenceSession;
  private prefill?: Ort.InferenceSession;
  private step?: Ort.InferenceSession;
  private vocabulary: string[] = [];
  provider: 'WASM' | 'WebGPU / WASM' = 'WASM';
  async initialize(manifest: HonkokuModelManifest, useGpu: boolean): Promise<void> {
    await this.dispose();
    await this.dependencies.ensureStorage([manifest.files.vocab, manifest.files.decoderPrefillInt8, manifest.files.decoderStepInt8,
      useGpu ? manifest.files.encoderFp16 : manifest.files.encoderInt8]);
    this.ort = await this.dependencies.loadOrt(useGpu);
    this.ort.env.wasm.numThreads = 1;
    this.ort.env.wasm.proxy = false;
    this.ort.env.wasm.wasmPaths = useGpu ? { wasm: gpuWasmUrl, mjs: gpuMjsUrl } : { wasm: wasmUrl };
    const vocab = JSON.parse(new TextDecoder().decode(await this.dependencies.loadAsset(manifest.files.vocab)));
    if (!Array.isArray(vocab) || vocab.length !== 7710 || !vocab.every((v) => typeof v === 'string')
      || vocab[2] !== '<CLS>' || vocab[3] !== '<SEP>') throw new Error('Invalid v19 vocabulary.');
    this.vocabulary = vocab;
    try {
      // Downloads/integrity failures are not provider failures and must stop immediately.
      const encoder = await this.dependencies.loadAsset(useGpu ? manifest.files.encoderFp16 : manifest.files.encoderInt8);
      try {
        this.encoder = await this.session(encoder, useGpu ? 'webgpu' : 'wasm');
        this.provider = useGpu ? 'WebGPU / WASM' : 'WASM';
      } catch (error) {
        if (!useGpu) throw error;
        this.encoder = await this.session(await this.dependencies.loadAsset(manifest.files.encoderInt8), 'wasm');
        this.provider = 'WASM';
      }
      this.prefill = await this.session(await this.dependencies.loadAsset(manifest.files.decoderPrefillInt8), 'wasm');
      this.step = await this.session(await this.dependencies.loadAsset(manifest.files.decoderStepInt8), 'wasm');
      if (this.step.inputNames.filter((name) => name.startsWith('past_')).length !== 24) throw new Error('Invalid v19 KV cache inputs.');
    } catch (error) { await this.dispose(); throw error; }
  }
  session(bytes: Uint8Array<ArrayBuffer>, provider: 'webgpu' | 'wasm'): Promise<Ort.InferenceSession> {
    return this.ort.InferenceSession.create(bytes, { executionProviders: [provider], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false });
  }
  private pixels(crop: ImageData): Ort.Tensor {
    let source = new OffscreenCanvas(crop.width, crop.height);
    source.getContext('2d')!.putImageData(crop, 0, 0);
    if (crop.height > crop.width) {
      const rotated = new OffscreenCanvas(crop.height, crop.width);
      const ctx = rotated.getContext('2d')!;
      ctx.translate(crop.height, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(source, 0, 0);
      source.width = source.height = 0; source = rotated;
    }
    const canvas = new OffscreenCanvas(2048, 256);
    try {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 2048, 256);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const width = Math.max(1, Math.min(2048, Math.round(source.width * 256 / source.height)));
      ctx.drawImage(source, 0, 0, width, 256);
      const rgba = ctx.getImageData(0, 0, 2048, 256).data;
      const plane = 2048 * 256; const data = new Float32Array(plane * 3);
      const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
      for (let c = 0; c < 3; c++) for (let i = 0; i < plane; i++) data[c * plane + i] = (rgba[i * 4 + c] / 255 - mean[c]) / std[c];
      return new this.ort.Tensor('float32', data, [1, 3, 256, 2048]);
    } finally { source.width = source.height = canvas.width = canvas.height = 0; }
  }
  async recognize(crop: ImageData, signal?: AbortSignal): Promise<Partial<OcrLine> & { text: string }> {
    if (!this.encoder || !this.prefill || !this.step) throw new Error('Honkoku is not initialized.');
    signal?.throwIfAborted();
    const pixels = this.pixels(crop);
    let encoded: Record<string, Ort.Tensor> | null = null;
    let output: Record<string, Ort.Tensor> | null = null;
    const generated: number[] = []; let stopReason: OcrStopReason = 'max-length';
    let logSum = 0, minProbability = 1, count = 0;
    try {
      encoded = await this.encoder.run({ [this.encoder.inputNames[0]]: pixels });
      const hidden = encoded[this.encoder.outputNames[0]];
      let last = 2;
      for (let index = 0; index < 192; index++) {
        signal?.throwIfAborted();
        const input = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(last)]), [1, 1]);
        const feeds: Record<string, Ort.Tensor> = { input_ids: input, encoder_hidden_states: hidden };
        if (output) for (const name of this.step.inputNames.filter((v) => v.startsWith('past_'))) {
          const present = name.replace(/^past_/, 'present_');
          if (!output[present]) throw new Error(`Missing v19 KV output: ${present}`);
          feeds[name] = output[present];
        }
        let next: Record<string, Ort.Tensor>;
        try { next = await (index === 0 ? this.prefill : this.step).run(feeds); }
        finally { input.dispose(); }
        dispose(output); output = next;
        const logits = output.logits;
        if (!logits || logits.dims.at(-1) !== 7710) throw new Error('Invalid v19 logits shape.');
        const data = logits.data as Float32Array; const base = data.length - 7710;
        let max = -Infinity; last = 0;
        for (let i = 0; i < 7710; i++) { const value = data[base + i]; if (!Number.isFinite(value)) throw new Error('Non-finite v19 logits.'); if (value > max) { max = value; last = i; } }
        let sum = 0; for (let i = 0; i < 7710; i++) sum += Math.exp(data[base + i] - max);
        const log = -Math.log(sum); logSum += log; minProbability = Math.min(minProbability, Math.exp(log)); count++;
        if (last === 3) { stopReason = 'eos'; break; }
        // The v19 training target starts with CLS; consume it once without rendering it.
        if (last === 2 && index === 0) continue;
        if (last < 5 || !this.vocabulary[last]) { stopReason = 'invalid-token'; break; }
        generated.push(last);
        const period = repeatPeriod(generated);
        if (period) { generated.length -= 12 - period; stopReason = 'degenerate-repeat'; break; }
      }
      signal?.throwIfAborted();
      const rawKoji = generated.map((id) => this.vocabulary[id]).join('');
      return { text: rawKojiToPlainText(rawKoji), rawKoji, outputFormat: 'koji', recognizerId: 'honkoku-v19',
        confidenceKind: 'autoregressive-token', confidenceCalibrated: false, stopReason, endedWithEos: stopReason === 'eos',
        generatedTokens: count, meanLogProbability: logSum / Math.max(1, count), minimumTokenProbability: minProbability,
        uncertain: stopReason !== 'eos' };
    } finally { pixels.dispose(); dispose(output); dispose(encoded); }
  }
  async dispose(): Promise<void> {
    await Promise.allSettled([this.encoder?.release(), this.prefill?.release(), this.step?.release()]);
    this.encoder = this.prefill = this.step = undefined; this.vocabulary = [];
  }
}
