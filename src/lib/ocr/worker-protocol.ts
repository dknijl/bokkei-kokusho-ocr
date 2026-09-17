import type { ViewerPage } from "../iiif.ts";
import type { PinnedPageOcrRequest, PageOcrResult, PageOcrProgress } from "./engine/types.ts";

import type { OcrFailure } from "./network.ts";

export type WorkerRequest = { id: number; page: ViewerPage; request: PinnedPageOcrRequest; useGpu?: boolean };
export type WorkerResponse = { id: number } & (
  { type: "progress"; progress: PageOcrProgress }
  | { type: "result"; result: PageOcrResult }
  | { type: "error"; error: { message: string; kind: OcrFailure["kind"] } }
);
