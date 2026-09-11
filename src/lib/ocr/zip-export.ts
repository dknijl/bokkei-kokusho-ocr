import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { indexedDbJobStore, type JobStore, type OcrJob, type OcrJobPage } from "./batch.ts";

export const ZIP_TEXT_LIMIT = 64 * 1024 * 1024;
export const ZIP_ENTRY_LIMIT = 5000;
export type ZipPart = { indices: number[]; textBytes: number };
const utf8Size = (text: string) => new TextEncoder().encode(text).byteLength;

export function pageExport(row: OcrJobPage, digits = 5): { name: string; text: string } | null {
  const number = String((row.page.canvasIndex ?? row.index) + 1).padStart(digits, "0");
  if (row.status === "pending") return null;
  if (row.status === "failed" || row.status === "unsupported") {
    return { name: `errors/${number}.txt`, text: `${row.status}\n${row.page.canvasId}\n${row.error ?? ""}\n` };
  }
  const lines = row.result?.lines ?? [];
  const text = lines.map((line) => line.text.replace(/\r\n?/g, "\n")).join("\n");
  return { name: `texts/${number}.txt`, text: text ? `${text}\n` : "" };
}

export async function planZipParts(job: OcrJob, store: JobStore = indexedDbJobStore, limits = { bytes: ZIP_TEXT_LIMIT, entries: ZIP_ENTRY_LIMIT }): Promise<ZipPart[]> {
  const parts: ZipPart[] = [];
  let part: ZipPart = { indices: [], textBytes: 0 };
  for (let index = 0; index < job.total; index++) {
    const entry = pageExport(await store.getPage(job.id, index));
    if (!entry) continue;
    const bytes = utf8Size(entry.text);
    if (bytes > limits.bytes) throw new Error(`Canvas ${index + 1} exceeds the Blob ZIP limit. Use a browser with streaming file saving.`);
    // Count the next page file and the one index.csv included in each archive.
    if (part.indices.length && (part.textBytes + bytes > limits.bytes || part.indices.length + 2 > limits.entries)) {
      parts.push(part); part = { indices: [], textBytes: 0 };
    }
    part.indices.push(index); part.textBytes += bytes;
  }
  if (part.indices.length || !parts.length) parts.push(part);
  return parts;
}

function csv(value: unknown): string {
  const text = String(value ?? "");
  // Keep spreadsheet applications from treating an external Manifest label as a formula.
  return `"${(/^[=+@\-\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
}

export async function writeJobZip(job: OcrJob, destination: WritableStream<Uint8Array> | BlobWriter, store: JobStore = indexedDbJobStore, part?: ZipPart): Promise<Blob | undefined> {
  const writer = new ZipWriter(destination, { level: 6, useWebWorkers: false });
  const include = part ? new Set(part.indices) : null;
  const indexRows = ["number,label,canvasId,status,file,inThisArchive"];
  const digits = Math.max(5, String(job.total).length);
  try {
    for (let index = 0; index < job.total; index++) {
      const row = await store.getPage(job.id, index);
      const entry = pageExport(row, digits);
      const included = Boolean(entry && (!include || include.has(index)));
      indexRows.push([(row.page.canvasIndex ?? index) + 1, row.page.label, row.page.canvasId, row.status, entry?.name ?? "", included].map(csv).join(","));
      if (entry && included) await writer.add(entry.name, new TextReader(entry.text));
    }
    await writer.add("index.csv", new TextReader(indexRows.join("\n") + "\n"));
    return await writer.close() as Blob | undefined;
  } catch (error) {
    // No source results are deleted: a failed ZIP can be generated again.
    if (destination instanceof WritableStream) {
      try { await destination.abort(error); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

type SaveHandle = { createWritable(): Promise<WritableStream<Uint8Array>> };
type SaveWindow = Window & { showSaveFilePicker?: (options: Record<string, unknown>) => Promise<SaveHandle> };

export function zipFilename(job: OcrJob, part?: number): string {
  const id = job.recordId === "EXTERNAL" ? job.id.slice(0, 8) : job.recordId;
  return `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}-ocr${part === undefined ? "" : `-${String(part + 1).padStart(3, "0")}`}.zip`;
}

/** Call directly inside a click handler, before any await consumes user activation. */
export function chooseZipDestination(job: OcrJob): Promise<SaveHandle> | null {
  const picker = (window as SaveWindow).showSaveFilePicker;
  return picker ? picker.call(window, { suggestedName: zipFilename(job), types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }] }) : null;
}

export async function downloadZipPart(job: OcrJob, part: ZipPart, index?: number): Promise<void> {
  const blob = await writeJobZip(job, new BlobWriter("application/zip"), indexedDbJobStore, part);
  if (!(blob instanceof Blob)) throw new Error("ZIP generation returned no file");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = zipFilename(job, index);
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
