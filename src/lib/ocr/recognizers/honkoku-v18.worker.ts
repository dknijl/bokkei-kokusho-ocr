import * as ort from "onnxruntime-web/webgpu";
import { createHonkokuInputTensorData } from "../crop/honkoku-input.ts";
import { loadHonkokuModelFile } from "../models/model-cache.ts";
import type { HonkokuModelManifest } from "../models/manifest.ts";
import type { RecognizerDiagnostics, RecognizerOutput } from "../engine/types.ts";
import type { HonkokuWorkerIn, HonkokuWorkerOut } from "./honkoku-v18-protocol.ts";

const CLS = 2;
const SEP = 3;
const MAX_GENERATED_TOKENS = 192;
const REPEAT_WINDOW = 12;
const DECODER_LAYER_COUNT = 6;

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

type TensorMap = ort.InferenceSession.OnnxValueMapType;

let encoder: ort.InferenceSession | null = null;
let decoderPrefill: ort.InferenceSession | null = null;
let decoderStep: ort.InferenceSession | null = null;
let vocab: string[] = [];
let provider = "WASM";
let activeRunId = "";
const cancelledRuns = new Set<string>();

function post(message: HonkokuWorkerOut): void {
  self.postMessage(message);
}

function throwIfCancelled(runId: string): void {
  if (cancelledRuns.has(runId) || activeRunId !== runId) {
    throw new DOMException("ocrCancelled", "AbortError");
  }
}

function disposeTensorMap(values: TensorMap | null | undefined, keep = new Set<ort.Tensor>()): void {
  if (!values) return;
  for (const value of Object.values(values)) {
    if (value instanceof ort.Tensor && !keep.has(value)) value.dispose();
  }
}

async function createSession(data: ArrayBuffer, useWebGpu: boolean): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(data, {
    executionProviders: useWebGpu ? ["webgpu"] : ["wasm"],
    graphOptimizationLevel: "all",
  });
}

function parseVocab(data: ArrayBuffer): string[] {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  if (!Array.isArray(parsed) || !parsed.every((token) => typeof token === "string")) {
    throw new Error("Honkoku v18 vocab must be a string array.");
  }
  if (parsed.length !== 7710) throw new Error("Honkoku v18 vocab size does not match the manifest.");
  return parsed;
}

function argmaxLast(logits: ort.Tensor): { id: number; probability: number; logProbability: number } {
  const sequenceLength = logits.dims.at(-2) ?? 0;
  const vocabularySize = logits.dims.at(-1) ?? 0;
  const values = logits.data as ArrayLike<number>;
  const offset = Math.max(0, sequenceLength - 1) * vocabularySize;
  let bestId = 0;
  let bestValue = -Infinity;
  let denominator = 0;
  for (let index = 0; index < vocabularySize; index += 1) {
    const value = Number(values[offset + index] ?? -Infinity);
    if (value > bestValue) {
      bestValue = value;
      bestId = index;
    }
  }
  for (let index = 0; index < vocabularySize; index += 1) {
    denominator += Math.exp(Number(values[offset + index] ?? -Infinity) - bestValue);
  }
  const logProbability = bestValue - Math.log(Math.max(Number.MIN_VALUE, denominator));
  return { id: bestId, probability: Math.exp(logProbability), logProbability };
}

function repeatPeriod(tokens: number[]): number {
  if (tokens.length < REPEAT_WINDOW) return 0;
  const start = tokens.length - REPEAT_WINDOW;
  for (let period = 1; period <= 4; period += 1) {
    let repeats = true;
    for (let index = start; index < tokens.length - period; index += 1) {
      if (tokens[index] !== tokens[index + period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return period;
  }
  return 0;
}

function hiraToKata(value: string): string {
  return value.replace(/[ぁ-ゖ]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0x60));
}

function decodeTokens(tokens: number[]): { rawKoji: string; invalidToken: boolean } {
  let rawKoji = "";
  let invalidToken = false;
  for (const token of tokens) {
    if (token >= 0 && token < 5) continue;
    const value = vocab[token];
    if (value === undefined) {
      invalidToken = true;
      continue;
    }
    rawKoji += value;
  }
  rawKoji = rawKoji
    .replace(/<rt2>.*?<\/rt2>/g, "")
    .replace(/<\/?rt2>/g, "")
    .replace(/<OKURI>(.*?)<\/OKURI>/g, (_match, value: string) => `<OKURI>${hiraToKata(value)}</OKURI>`)
    .replace(/<KAERI>(.*?)<\/KAERI>/g, (_match, value: string) => `<KAERI>${hiraToKata(value)}</KAERI>`)
    .replace(/＿([ぁ-ゖ]+)/g, (_match, value: string) => `＿${hiraToKata(value)}`);
  return { rawKoji, invalidToken };
}

function outputFromTokens(
  tokens: number[],
  diagnostics: RecognizerDiagnostics,
): RecognizerOutput {
  const decoded = decodeTokens(tokens);
  return {
    text: decoded.rawKoji,
    rawKoji: decoded.rawKoji,
    outputFormat: "koji",
    diagnostics: {
      ...diagnostics,
      ...(decoded.invalidToken ? { stopReason: "degenerate-repeat" as const } : {}),
    },
  };
}

async function recognizeCrop(runId: string, crop: ImageData): Promise<RecognizerOutput> {
  if (!encoder || !decoderPrefill || !decoderStep) throw new Error("Honkoku v18 recognizer is not initialized.");
  throwIfCancelled(runId);
  const inputData = createHonkokuInputTensorData(crop);
  const input = new ort.Tensor("float32", inputData.data, inputData.dims);
  let encoderOutput: TensorMap | null = null;
  let prefillOutput: TensorMap | null = null;
  let encoderHidden: ort.Tensor | null = null;
  const generated: number[] = [];
  let logProbabilityTotal = 0;
  let minimumProbability = 1;
  let stopReason: NonNullable<RecognizerDiagnostics["stopReason"]> = "max-length";
  try {
    encoderOutput = await encoder.run({ [encoder.inputNames[0]]: input });
    throwIfCancelled(runId);
    encoderHidden = encoderOutput[encoder.outputNames[0]] as ort.Tensor;
    const ids = new ort.Tensor("int64", BigInt64Array.from([BigInt(CLS)]), [1, 1]);
    prefillOutput = await decoderPrefill.run({
      [decoderPrefill.inputNames.find((name) => name.includes("input_ids")) ?? decoderPrefill.inputNames[0]]: ids,
      [decoderPrefill.inputNames.find((name) => name.includes("encoder")) ?? decoderPrefill.inputNames[1]]: encoderHidden,
    });
    ids.dispose();
    throwIfCancelled(runId);
    let choice = argmaxLast(prefillOutput.logits as ort.Tensor);
    if (choice.id === SEP) {
      stopReason = "eos";
    } else {
      generated.push(choice.id);
      logProbabilityTotal += choice.logProbability;
      minimumProbability = Math.min(minimumProbability, choice.probability);
      const pastNames = decoderStep.inputNames.filter((name) => name.startsWith("past_"));
      const presentNames = decoderStep.outputNames.filter((name) => name.startsWith("present_"));
      if (pastNames.length !== DECODER_LAYER_COUNT * 4 || presentNames.length !== pastNames.length) {
        throw new Error("Honkoku v18 decoder KV cache does not expose 24 past/present tensors.");
      }
      let past: Record<string, ort.Tensor> = {};
      for (let index = 0; index < presentNames.length; index += 1) {
        past[pastNames[index]!] = prefillOutput[presentNames[index]!] as ort.Tensor;
      }
      for (let step = 1; step < MAX_GENERATED_TOKENS; step += 1) {
        throwIfCancelled(runId);
        const stepIds = new ort.Tensor("int64", BigInt64Array.from([BigInt(choice.id)]), [1, 1]);
        const feeds: TensorMap = {
          [decoderStep.inputNames.find((name) => name.includes("input_ids")) ?? decoderStep.inputNames[0]]: stepIds,
          [decoderStep.inputNames.find((name) => name.includes("encoder")) ?? decoderStep.inputNames[1]]: encoderHidden,
          ...past,
        };
        const output = await decoderStep.run(feeds);
        stepIds.dispose();
        const nextChoice = argmaxLast(output.logits as ort.Tensor);
        const nextPast: Record<string, ort.Tensor> = {};
        for (let index = 0; index < presentNames.length; index += 1) {
          nextPast[pastNames[index]!] = output[presentNames[index]!] as ort.Tensor;
        }
        for (const value of Object.values(past)) value.dispose();
        disposeTensorMap(output, new Set(Object.values(nextPast)));
        choice = nextChoice;
        if (choice.id === SEP) {
          stopReason = "eos";
          past = nextPast;
          break;
        }
        generated.push(choice.id);
        logProbabilityTotal += choice.logProbability;
        minimumProbability = Math.min(minimumProbability, choice.probability);
        past = nextPast;
        if (repeatPeriod(generated)) {
          stopReason = "degenerate-repeat";
          break;
        }
      }
      for (const value of Object.values(past)) value.dispose();
    }
    return outputFromTokens(generated, {
      generatedTokens: generated.length,
      stopReason,
      meanLogProbability: generated.length ? logProbabilityTotal / generated.length : 0,
      minimumTokenProbability: generated.length ? minimumProbability : 0,
    });
  } finally {
    input.dispose();
    disposeTensorMap(prefillOutput, new Set(prefillOutput?.["logits"] instanceof ort.Tensor ? [prefillOutput["logits"] as ort.Tensor] : []));
    disposeTensorMap(encoderOutput);
  }
}

async function initialize(
  runId: string,
  manifestUrl: string,
  manifest: HonkokuModelManifest,
  useWebGpu: boolean,
): Promise<void> {
  const report = (role: string) => (progress: { percent: number; loadedBytes?: number; totalBytes?: number; cached?: boolean }) => {
    post({
      type: "model-progress",
      runId,
      progress: { fileRole: role, ...progress },
    });
  };
  const encoderRole = useWebGpu ? "encoderFp16" as const : "encoderInt8" as const;
  const [encoderData, prefillData, stepData, vocabData] = await Promise.all([
    loadHonkokuModelFile({ manifest, manifestUrl, role: encoderRole, onProgress: report(encoderRole) }),
    loadHonkokuModelFile({ manifest, manifestUrl, role: "decoderPrefillInt8", onProgress: report("decoderPrefillInt8") }),
    loadHonkokuModelFile({ manifest, manifestUrl, role: "decoderStepInt8", onProgress: report("decoderStepInt8") }),
    loadHonkokuModelFile({ manifest, manifestUrl, role: "vocab", onProgress: report("vocab") }),
  ]);
  encoder = await createSession(encoderData, useWebGpu);
  decoderPrefill = await createSession(prefillData, false);
  decoderStep = await createSession(stepData, false);
  vocab = parseVocab(vocabData);
  provider = useWebGpu ? "WebGPU / WASM" : "WASM";
  post({ type: "ready", runId, provider });
}

async function dispose(runId: string): Promise<void> {
  await Promise.allSettled([
    encoder?.release() ?? Promise.resolve(),
    decoderPrefill?.release() ?? Promise.resolve(),
    decoderStep?.release() ?? Promise.resolve(),
  ]);
  encoder = null;
  decoderPrefill = null;
  decoderStep = null;
  vocab = [];
  post({ type: "disposed", runId });
}

self.onmessage = (event: MessageEvent<HonkokuWorkerIn>) => {
  const message = event.data;
  if (message.type === "dispose") {
    void dispose(message.runId).then(() => self.close());
    return;
  }
  if (message.type === "cancel") {
    cancelledRuns.add(message.runId);
    return;
  }
  activeRunId = message.runId;
  if (message.type === "initialize") {
    void initialize(message.runId, message.manifestUrl, message.manifest, message.useWebGpu).catch((error: unknown) => {
      post({ type: "error", runId: message.runId, error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  void recognizeCrop(message.runId, message.crop).then(
    (result) => post({ type: "line-result", runId: message.runId, lineId: message.lineId, result }),
    (error: unknown) => post({ type: "error", runId: message.runId, lineId: message.lineId, error: error instanceof Error ? error.message : String(error) }),
  );
};
