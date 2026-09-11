import { runOcrBenchmarkDataset, type OcrBenchmarkRunnerOptions, type OcrBenchmarkRun } from "./benchmark-runner.ts";
import { normalizeNdlOcrOptions } from "./profiles.ts";
import type { RecognitionPreprocessing } from "./types.ts";

/** Compare the same target rows and inference budget; image candidates are adopted only in the evaluation output. */
export async function runPreprocessingAblation(input: OcrBenchmarkRunnerOptions & {
  legacyRecognize?: OcrBenchmarkRunnerOptions["recognize"];
  onVariant: (name: string, run: OcrBenchmarkRun) => void | Promise<void>;
}): Promise<void> {
  const variants = ["original", "auto", "grayscale-contrast", "background-normalized", "sauvola", "adaptive-binary", ...(input.legacyRecognize ? ["legacy"] : [])];
  for (const name of variants) {
    const correction = !["original", "auto", "legacy"].includes(name);
    const options = normalizeNdlOcrOptions({ ...input.ocrOptions,
      preprocessing: name === "original" ? "off" : "auto",
      maxExtraRecognitions: name === "original" ? 0 : input.ocrOptions.maxExtraRecognitions,
      benchmarkPreprocessing: correction ? name as NonNullable<typeof input.ocrOptions.benchmarkPreprocessing> : undefined,
    });
    const recognize = name === "legacy" ? input.legacyRecognize! : input.recognize;
    const run = await runOcrBenchmarkDataset({ ...input, ocrOptions: options, recognize: async (...args) => {
      const result = await recognize(...args);
      if (!correction) return result;
      return { ...result, lines: result.lines.map(line => {
        const alternative = line.alternatives?.find(candidate => candidate.preprocessing === name as RecognitionPreprocessing);
        return alternative ? { ...line, ...alternative, selectionReason: "evaluation-only" as const } : line;
      }) };
    } });
    await input.onVariant(name, run);
  }
}
