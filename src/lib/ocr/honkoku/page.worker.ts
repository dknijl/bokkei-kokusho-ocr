import { HonkokuPageRuntime } from './page.ts';
import { OcrFailure } from '../network.ts';
import type { WorkerRequest, WorkerResponse } from '../worker-protocol.ts';
const runtime = new HonkokuPageRuntime();
let busy = false;
const send = (message: WorkerResponse) => self.postMessage(message);
self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (busy) { send({ id: data.id, type: 'error', error: { kind: 'worker', message: 'OCR worker is busy.' } }); return; }
  busy = true;
  try {
    const result = await runtime.recognize(data.page, data.request, data.useGpu === true,
      progress => send({ id: data.id, type: 'progress', progress }));
    send({ id: data.id, type: 'result', result });
  } catch (error) {
    await runtime.dispose();
    send({ id: data.id, type: 'error', error: { kind: error instanceof OcrFailure ? error.kind : 'model',
      message: error instanceof Error ? error.message : String(error) } });
  } finally { busy = false; }
};
