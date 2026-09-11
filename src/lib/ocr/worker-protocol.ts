import type { ViewerPage } from "../iiif.ts";
import type { NdlOcrOptions } from "./profiles.ts";
import type { NdlOcrResult, NdlOcrProgress } from "../ndl-ocr.ts";
import type { OcrFailure } from "./network.ts";

export type WorkerRequest = { id: number; page: ViewerPage; options: NdlOcrOptions };
export type WorkerResponse = { id: number } & (
  { type: "progress"; progress: NdlOcrProgress }
  | { type: "result"; result: NdlOcrResult }
  | { type: "error"; error: { message: string; kind: OcrFailure["kind"] } }
);
