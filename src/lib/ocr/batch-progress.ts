import type { OcrJob } from "./batch.ts";

export type BatchPhase = "processing" | "pausing" | "completed" | "completed-with-errors" | "paused" | "cancelled" | "interrupted" | "ready";

/** The percentage measures durable page records, including recorded failures, never elapsed time. */
export function batchProgress(
  job: Pick<OcrJob, "completed" | "total" | "failed" | "status">,
  running: boolean,
  pausing: boolean,
): { percent: number; phase: BatchPhase } {
  const percent = job.total > 0 ? Math.floor(Math.max(0, Math.min(1, job.completed / job.total)) * 100) : 0;
  if (running) return { percent, phase: pausing ? "pausing" : "processing" };
  if (job.completed === job.total && (job.status === "completed" || job.status === "completed-with-errors")) {
    return { percent, phase: job.failed ? "completed-with-errors" : "completed" };
  }
  const phase = job.status === "cancelled" ? "cancelled"
    : job.status === "paused" ? "paused" : job.status === "ready" ? "ready" : "interrupted";
  return { percent, phase };
}
