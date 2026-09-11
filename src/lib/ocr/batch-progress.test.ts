import test from "node:test";
import assert from "node:assert/strict";
import { batchProgress } from "./batch-progress.ts";

test("batch percentage measures saved records and reaches 100 only at all records", () => {
  const job = { completed: 1, total: 3, failed: 0, status: "running" as const };
  assert.deepEqual(batchProgress(job, true, false), { percent: 33, phase: "processing" });
  assert.equal(batchProgress({ ...job, completed: 999, total: 1000 }, true, false).percent, 99);
  assert.deepEqual(batchProgress({ ...job, completed: 3, status: "completed" }, false, false), { percent: 100, phase: "completed" });
  assert.equal(batchProgress({ ...job, total: 0, completed: 0 }, false, false).percent, 0);
});

test("saved failures, retries, pause, cancel and interrupted runs are never labelled successful completion", () => {
  const job = { completed: 3, total: 3, failed: 1, status: "completed-with-errors" as const };
  assert.equal(batchProgress(job, false, false).phase, "completed-with-errors");
  assert.deepEqual(batchProgress(job, true, false), { percent: 100, phase: "processing" });
  assert.equal(batchProgress(job, true, true).phase, "pausing");
  for (const status of ["paused", "cancelled", "ready"] as const) assert.equal(batchProgress({ ...job, status }, false, false).phase, status);
  assert.equal(batchProgress({ ...job, status: "running" }, false, false).phase, "interrupted");
  assert.equal(batchProgress({ ...job, completed: 2, status: "completed" }, false, false).phase, "interrupted");
});
