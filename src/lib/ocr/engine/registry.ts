import type { OcrEngineId } from '../types.ts';
import type { TranslationKey } from '../../i18n.ts';
export function honkokuEnabled(value = import.meta.env?.VITE_ENABLE_HONKOKU): boolean { return value !== 'false'; }
export function honkokuManifestUrl(): string | undefined { return import.meta.env?.VITE_HONKOKU_MODEL_MANIFEST_URL?.trim() || undefined; }
export function canRunHonkoku(): boolean {
  return honkokuEnabled() && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}
export function normalizeOcrEngine(value: unknown, available = canRunHonkoku()): OcrEngineId {
  return value === 'honkoku-v19' && available ? value : 'ndl-parseq';
}
export const OCR_ENGINES: ReadonlyArray<{ id: OcrEngineId; labelKey: TranslationKey; detailKey: TranslationKey }> = [
  { id: 'ndl-parseq', labelKey: 'ocrEngineNdl', detailKey: 'ocrEngineNdlDetail' },
  { id: 'honkoku-v19', labelKey: 'ocrEngineHonkoku', detailKey: 'ocrEngineHonkokuDetail' },
];

export const OCR_ENGINE_DESCRIPTORS = OCR_ENGINES.map((engine) => ({ ...engine,
  enabled: engine.id === 'ndl-parseq' || honkokuEnabled(),
}));
export function isOcrEngineId(value: unknown): value is OcrEngineId {
  return value === 'ndl-parseq' || value === 'honkoku-v19';
}
export async function createRecognizer(id: OcrEngineId) {
  if (id === 'ndl-parseq') { const { ParseqRecognizer } = await import('../recognizers/parseq.ts'); return new ParseqRecognizer(); }
  const { HonkokuRecognizer } = await import('../honkoku/recognizer.ts'); return new HonkokuRecognizer();
}
