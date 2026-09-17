import { readFile, writeFile } from "node:fs/promises";
import { evaluateOcrPage } from "../src/lib/ocr/metrics.ts";
import { assessCorrection } from "../src/lib/ocr/evaluation-gate.ts";
import { KOKUSHO_ITAIJI_ENTRIES } from "../src/lib/kokusho-itaiji-data.ts";
const root = "work/ocr-evaluation";
const pairs = KOKUSHO_ITAIJI_ENTRIES.flatMap(([normalized, variants]) => variants.map(variant => ({ variant, normalized })))
  .filter(pair => pair.variant !== pair.normalized).sort((a, b) => Array.from(b.variant).length - Array.from(a.variant).length);
const normalize = value => pairs.reduce((text, pair) => text.replaceAll(pair.variant, pair.normalized), value);
const load = async file => JSON.parse(await readFile(`${root}/${file}`, "utf8"));
const runs = {}, ablation = [];
for (const name of ["original", "auto", "grayscale-contrast", "background-normalized", "sauvola", "adaptive-binary", "legacy"]) {
  const run = await load(`ablation-${name}.json`);
  for (const record of run.records) {
    const truth = record.groundTruth;
    const predicted = record.output.lines.map(line => ({ ...line, ...(line.region ? { region: {
      x: line.region.x * truth.width / record.page.width, y: line.region.y * truth.height / record.page.height,
      width: line.region.width * truth.width / record.page.width, height: line.region.height * truth.height / record.page.height,
    } } : {}) }));
    record.metrics = evaluateOcrPage({ predicted, reference: truth, normalizedText: normalize });
    ablation.push({ variant: name, canvasId: record.page.canvasId, annotationCoverage: truth.annotationCoverage, trainingOverlap: truth.trainingOverlap,
      metrics: record.metrics, stats: record.execution.stats, provider: record.execution.provider });
  }
  // These metrics are computed from already saved text. No extra model inference or text correction occurs.
  run.baseline.records = run.records;
  await writeFile(`${root}/ablation-${name}.json`, JSON.stringify(run, null, 2) + "\n");
  runs[name] = run.records;
}
const calibration = JSON.parse(await readFile("docs/ocr/calibration-book-ids.json", "utf8"));
const gates = Object.fromEntries(Object.entries(runs).filter(([name]) => name !== "original" && name !== "legacy").map(([name, records]) => [name, assessCorrection(runs.original, records, calibration)]));
const providers = [];
for (const requested of ["wasm", "auto"]) {
  const run = await load(`real-${requested}.json`);
  providers.push(...run.reports.map(({ name, result }) => ({ requested, name, provider: result.provider, modelRevision: result.revision,
    manifestUrl: result.manifestUrl, canvasId: result.canvasId, imageWidth: result.imageWidth, imageHeight: result.imageHeight,
    lineCount: result.lines.length, stats: result.stats })));
}
const output = { measuredAt: new Date().toISOString(), accuracyStatus: "Not approved: training-overlap and partial ground truth; independent material groups incomplete.",
  legacyRevision: (await readFile(`${root}/legacy/revision.txt`, "utf8")).trim(), providers, ablation, gates };
await writeFile("docs/ocr/results.json", JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ providers: providers.map(({ name, requested, provider, lineCount }) => ({ name, requested, provider, lineCount })),
  gates: Object.fromEntries(Object.entries(gates).map(([name, gate]) => [name, { eligible: gate.eligible, reasons: gate.reasons }])) }, null, 2));
