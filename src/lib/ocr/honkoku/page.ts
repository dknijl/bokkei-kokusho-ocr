import { detectPageLines, releaseNdlOcrModels } from '../../ndl-ocr.ts';
import { HonkokuRuntime } from './runtime.ts';
import { verifyPinnedHonkokuManifest } from '../engine/pin-request.ts';
import { assertResultIdentity } from '../engine/result.ts';
import { orderOcrLines } from '../reading-order.ts';
import { mapDetectionToHonkokuCrop, roundHonkokuCropRegion } from '../crop/honkoku-crop.ts';
import { resolvePageImageSource, imageSizeParameter } from '../image-source.ts';
import { fetchOcrResource } from '../network.ts';
import type { ViewerPage } from '../../iiif.ts';
import type { OcrLine } from '../types.ts';
import type { PageOcrProgress, PageOcrResult, PinnedPageOcrRequest } from '../engine/types.ts';

/** One runtime per page worker. Detection and recognition share this worker, never nested workers. */
export class HonkokuPageRuntime {
  private runtime = new HonkokuRuntime();
  private identity = '';
  async recognize(page: ViewerPage, request: PinnedPageOcrRequest, useGpu: boolean,
    progress: (p: PageOcrProgress) => void): Promise<PageOcrResult> {
    const started = Date.now();
    const manifest = await verifyPinnedHonkokuManifest(request);
    const detected = await detectPageLines(page, request.options, p => progress({ ...p, percent: Math.round(p.percent * 0.4) }));
    if (detected.detectorRevision !== request.expectedIdentity.detectorRevision) throw new Error('Detector identity mismatch.');
    // Release the detector before loading the much larger recognition sessions.
    await releaseNdlOcrModels();
    const key = `${request.expectedIdentity.modelManifestDigest}:${useGpu}`;
    if (this.identity !== key) {
      await this.runtime.dispose();
      progress({ stage: 'models', percent: 42, messageKey: 'progressModels' });
      await this.runtime.initialize(manifest, useGpu);
      this.identity = key;
    }
    const imageSource = await resolvePageImageSource(page, request.options);
    const full = { x: 0, y: 0, width: imageSource.width, height: imageSource.height };
    const imageUrl = imageSource.info
      ? `${imageSource.serviceId}/full/${imageSizeParameter(imageSource.info, full, 3500)}/0/default.jpg`
      : page.sourceImage || page.image;
    const response = await fetchOcrResource(imageUrl);
    const bitmap = await createImageBitmap(await response.blob());
    const source = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = source.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const lines: OcrLine[] = [];
    try {
      for (let index = 0; index < detected.detections.length; index++) {
        const box = detected.detections[index];
        const region = roundHonkokuCropRegion(mapDetectionToHonkokuCrop(box,
          { width: detected.imageWidth, height: detected.imageHeight }, source).region);
        const crop = new OffscreenCanvas(region.width, region.height);
        try {
          const ctx = crop.getContext('2d')!;
          ctx.fillStyle = 'white'; ctx.fillRect(0, 0, crop.width, crop.height);
          ctx.drawImage(source, -region.x, -region.y);
          const output = await this.runtime.recognize(ctx.getImageData(0, 0, crop.width, crop.height));
          lines.push({ ...output, detectionScore: box.detectionScore, detectionIndex: index,
            region: { x: box.x, y: box.y, width: box.width, height: box.height },
            recognizerRevision: request.expectedIdentity.recognizerRevision });
        } finally { crop.width = crop.height = 0; }
        progress({ stage: 'recognize', percent: 45 + Math.round(54 * (index + 1) / detected.detections.length),
          messageKey: 'progressRecognize', completed: index + 1, total: detected.detections.length,
          params: { completed: index + 1, total: detected.detections.length } });
      }
      const result: PageOcrResult = { identity: { ...request.expectedIdentity },
        imageWidth: detected.imageWidth, imageHeight: detected.imageHeight,
        lines: orderOcrLines(lines, { writingMode: request.options.writingMode, scattered: request.options.scattered }),
        provider: this.runtime.provider, revision: request.expectedIdentity.recognizerRevision,
        pipelineVersion: request.expectedIdentity.pipelineVersion, profile: request.options.profile, options: request.options,
        stats: { ...detected.stats, initialRecognitions: lines.length,
          modelInferenceCount: detected.stats.modelInferenceCount + lines.reduce((n, line) => n + 1 + (line.generatedTokens ?? 0), 0),
          durationMs: Date.now() - started } };
      assertResultIdentity(result, request);
      progress({ stage: 'done', percent: 100, messageKey: 'progressDone', params: { count: lines.length } });
      return result;
    } finally { source.width = source.height = 0; }
  }
  async dispose(): Promise<void> { this.identity = ''; await this.runtime.dispose(); await releaseNdlOcrModels(); }
}
