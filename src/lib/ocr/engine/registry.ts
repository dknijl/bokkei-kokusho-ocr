import { isHonkokuV18Configured } from "./feature.ts";
import type { EngineDescriptor, LineRecognizer } from "./types.ts";
import type { OcrEngineId } from "../types.ts";
import { ParseqRecognizer } from "../recognizers/parseq.ts";
import { HonkokuV18Recognizer } from "../recognizers/honkoku-v18.ts";

export const OCR_ENGINE_DESCRIPTORS: EngineDescriptor[] = [
  {
    id: "ndl-parseq",
    label: "NDL古典籍OCR-Lite",
    enabled: true,
  },
  {
    id: "honkoku-v18",
    label: "みんなで翻刻 v18",
    enabled: isHonkokuV18Configured(),
    reason: isHonkokuV18Configured()
      ? undefined
      : "Honkoku v18 is disabled or its model manifest is not configured.",
  },
];

export function isOcrEngineId(value: string): value is OcrEngineId {
  return value === "ndl-parseq" || value === "honkoku-v18";
}

export function createRecognizer(id: OcrEngineId): LineRecognizer {
  if (id === "ndl-parseq") return new ParseqRecognizer();
  if (!isHonkokuV18Configured()) {
    throw new Error("Honkoku v18 is not enabled or its model manifest is unavailable.");
  }
  return new HonkokuV18Recognizer();
}
