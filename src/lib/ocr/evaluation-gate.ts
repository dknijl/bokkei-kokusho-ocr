import type { OcrBenchmarkRecord } from "./benchmark.ts";
import type { OcrGroundTruthPage } from "./metrics.ts";

export const EVALUATION_GROUPS = ["manuscript", "printed", "illustrated", "scroll", "degraded", "scattered-or-red"] as const;
type Group = typeof EVALUATION_GROUPS[number];
function belongs(page: OcrGroundTruthPage, group: Group) {
  return group === "degraded" ? page.tags.some(tag => tag === "faded" || tag === "bleed-through")
    : group === "scattered-or-red" ? page.tags.some(tag => tag === "scattered" || tag === "red-ink")
    : page.tags.includes(group);
}

/** A report is evidence for review. It never edits the automatic-correction allowlist. */
export function assessCorrection(baseline: OcrBenchmarkRecord[], candidate: OcrBenchmarkRecord[], calibrationBookIds: string[] = []) {
  const reasons: string[] = [];
  const candidates = new Map(candidate.map(record => [record.page.canvasId, record]));
  if (!baseline.length || baseline.length !== candidate.length || candidates.size !== candidate.length) reasons.push("Missing or duplicate pages");
  const pairs = baseline.flatMap(before => {
    const after = candidates.get(before.page.canvasId), truth = before.groundTruth;
    if (!after || !truth || !before.metrics || !after.metrics) { reasons.push(`Missing reference or metrics: ${before.page.canvasId}`); return []; }
    if (!truth.bookId || truth.split !== "evaluation" || calibrationBookIds.includes(truth.bookId)) reasons.push(`Not book-disjoint evaluation: ${truth.id}`);
    if (truth.trainingOverlap !== "excluded") reasons.push(`Training overlap is not excluded: ${truth.id}`);
    if (truth.annotationCoverage !== "complete") reasons.push(`Incomplete page annotation: ${truth.id}`);
    if (!truth.lines.length) reasons.push(`No reference characters: ${truth.id}`);
    if (JSON.stringify(truth) !== JSON.stringify(after.groundTruth) || before.modelRevision !== after.modelRevision
      || before.execution.provider !== after.execution.provider || before.page.manifestUrl !== after.page.manifestUrl
      || before.page.imageServiceId !== after.page.imageServiceId) reasons.push(`Incomparable runs: ${truth.id}`);
    return [{ before, after, truth }];
  });
  const aggregate = (rows: typeof pairs, side: "before" | "after") => {
    const sum = rows.reduce((acc, pair) => {
      const m = pair[side].metrics!;
      acc.characters += m.raw.totalReferenceCharacters; acc.edits += m.raw.totalEditDistance;
      acc.insertions += m.pageErrors.insertions; acc.deletions += m.pageErrors.deletions;
      acc.tp += m.detection.truePositive; acc.reference += m.detection.reference;
      return acc;
    }, { characters: 0, edits: 0, insertions: 0, deletions: 0, tp: 0, reference: 0 });
    return { cer: sum.edits / Math.max(1, sum.characters), recall: sum.tp / Math.max(1, sum.reference),
      insertionRate: sum.insertions / Math.max(1, sum.characters), deletionRate: sum.deletions / Math.max(1, sum.characters) };
  };
  const before = aggregate(pairs, "before"), after = aggregate(pairs, "after");
  if (!(after.cer < before.cer)) reasons.push("CER did not improve");
  const groups = EVALUATION_GROUPS.map(group => {
    const rows = pairs.filter(pair => belongs(pair.truth, group));
    const b = aggregate(rows, "before"), a = aggregate(rows, "after");
    if (!rows.length) reasons.push(`Missing material group: ${group}`);
    if (a.recall < b.recall || a.insertionRate > b.insertionRate || a.deletionRate > b.deletionRate) reasons.push(`Recall or character loss/insertion regressed: ${group}`);
    return { group, pages: rows.length, before: b, after: a };
  });
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], before, after, groups };
}
