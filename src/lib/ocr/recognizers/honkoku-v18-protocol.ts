import type { HonkokuModelManifest } from "../models/manifest.ts";
import type { ModelLoadProgress, RecognizerOutput } from "../engine/types.ts";

export type HonkokuWorkerIn =
  | {
      type: "initialize";
      runId: string;
      manifestUrl: string;
      manifest: HonkokuModelManifest;
      useWebGpu: boolean;
    }
  | {
      type: "recognize";
      runId: string;
      lineId: string;
      crop: ImageData;
    }
  | { type: "cancel"; runId: string }
  | { type: "dispose"; runId: string };

export type HonkokuWorkerOut =
  | { type: "model-progress"; runId: string; progress: ModelLoadProgress }
  | { type: "ready"; runId: string; provider: string }
  | { type: "line-result"; runId: string; lineId: string; result: RecognizerOutput }
  | { type: "error"; runId: string; lineId?: string; error: string }
  | { type: "disposed"; runId: string };
