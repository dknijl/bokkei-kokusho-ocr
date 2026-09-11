import type { OcrEngineId } from "../types.ts";

export const HONKOKU_V18_UPSTREAM_COMMIT = "f0b0388a2744daaec4c92979e86516e4f8b3f8fd";
export const HONKOKU_V18_MANIFEST_SCHEMA_VERSION = 1;

export const HONKOKU_V18_RUNTIME = {
  inputHeight: 256,
  inputWidth: 2048,
  maxGeneratedTokens: 192,
  decoderLayers: 6,
  vocabularySize: 7710,
} as const;

export type HonkokuModelFileRole =
  | "encoderInt8"
  | "encoderFp16"
  | "decoderPrefillInt8"
  | "decoderStepInt8"
  | "vocab";

export type HonkokuModelFile = {
  url: string;
  sha256: string;
  bytes: number;
};

export type HonkokuModelManifest = {
  schemaVersion: typeof HONKOKU_V18_MANIFEST_SCHEMA_VERSION;
  engineId: "honkoku-v18";
  upstreamRepository: "yuta1984/honkoku-ocr-web";
  upstreamCommit: string;
  license: "CC-BY-4.0";
  runtime: typeof HONKOKU_V18_RUNTIME;
  files: Record<HonkokuModelFileRole, HonkokuModelFile>;
};

export class HonkokuManifestError extends Error {
  constructor(
    readonly code:
      | "invalid-json"
      | "schema-version"
      | "engine-id"
      | "upstream"
      | "license"
      | "runtime"
      | "files"
      | "file-url"
      | "file-sha256"
      | "file-bytes",
    message: string,
  ) {
    super(message);
    this.name = "HonkokuManifestError";
  }
}

const FILE_ROLES: HonkokuModelFileRole[] = [
  "encoderInt8",
  "encoderFp16",
  "decoderPrefillInt8",
  "decoderStepInt8",
  "vocab",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value: unknown, code: HonkokuManifestError["code"], message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HonkokuManifestError(code, message);
  return value;
}

function requireFiniteInteger(
  value: unknown,
  code: HonkokuManifestError["code"],
  message: string,
  minimum = 0,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new HonkokuManifestError(code, message);
  }
  return value;
}

function validateRuntime(value: unknown): typeof HONKOKU_V18_RUNTIME {
  const runtime = requireRecord(value, "runtime", "Honkoku manifest runtime must be an object.");
  for (const [key, expected] of Object.entries(HONKOKU_V18_RUNTIME)) {
    if (runtime[key] !== expected) {
      throw new HonkokuManifestError(
        "runtime",
        `Honkoku v18 runtime.${key} must be ${String(expected)}.`,
      );
    }
  }
  return { ...HONKOKU_V18_RUNTIME };
}

function validateFile(value: unknown, role: HonkokuModelFileRole): HonkokuModelFile {
  const file = requireRecord(value, "files", `Honkoku manifest file ${role} is missing.`);
  if (typeof file.url !== "string" || !file.url.trim()) {
    throw new HonkokuManifestError("file-url", `Honkoku manifest file ${role} requires a URL.`);
  }
  if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new HonkokuManifestError("file-sha256", `Honkoku manifest file ${role} has an invalid SHA-256.`);
  }
  const bytes = requireFiniteInteger(file.bytes, "file-bytes", `Honkoku manifest file ${role} requires byte length.`, 1);
  return { url: file.url.trim(), sha256: file.sha256, bytes };
}

export function validateHonkokuModelManifest(value: unknown): HonkokuModelManifest {
  const manifest = requireRecord(value, "invalid-json", "Honkoku model manifest must be a JSON object.");
  if (manifest.schemaVersion !== HONKOKU_V18_MANIFEST_SCHEMA_VERSION) {
    throw new HonkokuManifestError("schema-version", "Unsupported Honkoku model manifest schema version.");
  }
  if (manifest.engineId !== "honkoku-v18") {
    throw new HonkokuManifestError("engine-id", "Honkoku model manifest engineId must be honkoku-v18.");
  }
  if (manifest.upstreamRepository !== "yuta1984/honkoku-ocr-web" || typeof manifest.upstreamCommit !== "string") {
    throw new HonkokuManifestError("upstream", "Honkoku model manifest must identify the pinned upstream repository and commit.");
  }
  if (manifest.license !== "CC-BY-4.0") {
    throw new HonkokuManifestError("license", "Honkoku model manifest must declare CC-BY-4.0.");
  }

  const files = requireRecord(manifest.files, "files", "Honkoku model manifest files must be an object.");
  const validatedFiles = Object.fromEntries(
    FILE_ROLES.map((role) => [role, validateFile(files[role], role)]),
  ) as Record<HonkokuModelFileRole, HonkokuModelFile>;

  return {
    schemaVersion: HONKOKU_V18_MANIFEST_SCHEMA_VERSION,
    engineId: "honkoku-v18",
    upstreamRepository: "yuta1984/honkoku-ocr-web",
    upstreamCommit: manifest.upstreamCommit,
    license: "CC-BY-4.0",
    runtime: validateRuntime(manifest.runtime),
    files: validatedFiles,
  };
}

export function parseHonkokuModelManifest(value: string): HonkokuModelManifest {
  try {
    return validateHonkokuModelManifest(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof HonkokuManifestError) throw error;
    throw new HonkokuManifestError("invalid-json", "Honkoku model manifest is not valid JSON.");
  }
}

export function resolveHonkokuModelFileUrl(
  manifestUrl: string,
  file: HonkokuModelFile,
): string {
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(manifestUrl);
    resolved = new URL(file.url, base);
  } catch {
    throw new HonkokuManifestError("file-url", "Honkoku model URLs must be valid URLs.");
  }
  if (base.protocol !== "https:" || resolved.protocol !== "https:") {
    throw new HonkokuManifestError("file-url", "Honkoku model URLs must use HTTPS.");
  }
  return resolved.toString();
}

export function stableManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableManifestValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => [key, stableManifestValue(item)]),
  );
}

export function canonicalManifestJson(manifest: HonkokuModelManifest): string {
  return JSON.stringify(stableManifestValue(manifest));
}

export async function manifestSha256(manifest: HonkokuModelManifest): Promise<string> {
  const data = new TextEncoder().encode(canonicalManifestJson(manifest));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchHonkokuModelManifest(
  manifestUrl: string,
  signal?: AbortSignal,
): Promise<{ manifest: HonkokuModelManifest; digest: string }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(manifestUrl);
  } catch {
    throw new HonkokuManifestError("file-url", "Honkoku model manifest URL is invalid.");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new HonkokuManifestError("file-url", "Honkoku model manifest URL must use HTTPS.");
  }
  const response = await fetch(parsedUrl, { signal, cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Honkoku model manifest request failed (HTTP ${response.status}).`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) throw new Error("Honkoku model manifest request returned HTML instead of JSON.");
  const manifest = validateHonkokuModelManifest(await response.json() as unknown);
  return { manifest, digest: await manifestSha256(manifest) };
}

export function totalHonkokuModelBytes(manifest: HonkokuModelManifest): number {
  return FILE_ROLES.reduce((total, role) => total + manifest.files[role].bytes, 0);
}

export function isHonkokuModelFileRole(value: string): value is HonkokuModelFileRole {
  return FILE_ROLES.includes(value as HonkokuModelFileRole);
}

export function honkokuEngineId(): OcrEngineId {
  return "honkoku-v18";
}
