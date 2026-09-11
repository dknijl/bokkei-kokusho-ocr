export const NDL_MODEL_REVISION = "ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8";
export const NDL_MODEL_REF = "master";

export function isNdlModelRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

/** Legacy jobs and explicit benchmarks keep their original pinned model. */
export function ndlModelRevision(value?: string): string {
  if (value === undefined) return NDL_MODEL_REVISION;
  if (!isNdlModelRevision(value)) throw new Error("OCR model revision must be a full commit SHA.");
  return value;
}
