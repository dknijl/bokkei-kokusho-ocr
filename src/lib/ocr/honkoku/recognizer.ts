import { loadHonkokuManifest } from './default-manifest.ts';
import type { LineRecognizer, RecognizerContext, RecognizerInput, RecognizerOutput } from '../engine/types.ts';
import { HonkokuRuntime } from './runtime.ts';
import { HONKOKU_V19_UPSTREAM_COMMIT } from './manifest.ts';
import { honkokuEnabled, honkokuManifestUrl } from '../engine/registry.ts';
import { chooseHonkokuRuntime } from '../models/runtime.ts';
export class HonkokuRecognizer implements LineRecognizer {
  readonly id = 'honkoku-v19';
  readonly revision = HONKOKU_V19_UPSTREAM_COMMIT;
  private runtime = new HonkokuRuntime();
  async initialize(context: RecognizerContext): Promise<void> {
    const url = honkokuManifestUrl();
    if (!honkokuEnabled()) throw new Error('Honkoku is disabled in this build.');
    const { manifest } = await loadHonkokuManifest(url, context.signal);
    await this.runtime.initialize(manifest, await chooseHonkokuRuntime() === 'webgpu');
    if (context.signal?.aborted) { await this.dispose(); context.signal.throwIfAborted(); }
  }
  async recognize(input: RecognizerInput, context?: RecognizerContext): Promise<RecognizerOutput> {
    const line = await this.runtime.recognize(input.crop, context?.signal);
    return { text: line.text, rawKoji: line.rawKoji, outputFormat: 'koji', diagnostics: line };
  }
  dispose(): Promise<void> { return this.runtime.dispose(); }
}
