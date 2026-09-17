import { readFile } from "node:fs/promises";
import { assessCorrection } from "../src/lib/ocr/evaluation-gate.ts";
const [beforePath, afterPath, calibrationPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("Usage: node scripts/assess-ocr-correction.mjs original.json candidate.json [calibration-book-ids.json]");
const load = async path => JSON.parse(await readFile(path, "utf8"));
const before = await load(beforePath), after = await load(afterPath);
const result = assessCorrection(before.records ?? before, after.records ?? after, calibrationPath ? await load(calibrationPath) : []);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.eligible ? 0 : 1;
