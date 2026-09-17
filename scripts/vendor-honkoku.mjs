// Fetch pinned reference data only; never execute downloaded source.
import { mkdir, writeFile } from 'node:fs/promises';
const commit = '24469701412edda5be26c89784a29c7525bbb899';
async function get(url) { const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`); return response; }
const paths = ['LICENSE', 'src/ocr/text-recognizer.ts', 'src/ocr/model-loader.ts', 'src/ocr/recognition.worker.ts', 'src/ocr/onnx-config.ts', 'src/ocr/layout-detector.ts', 'src/lib/koji.ts', 'public/config/kuzushiji-vocab-v19.json'];
const files = {};
for (const path of paths) files[path] = await (await get(`https://raw.githubusercontent.com/yuta1984/honkoku-ocr-web/${commit}/${path}`)).text();
const hfRoot = 'https://huggingface.co/yuta1984/honkoku-ocr/resolve/b0bc83884980826b884a2cfde5ca4275b7d911db';
for (const path of ['examples/infer_onnx.py', 'image_processing_kuzushiji.py', 'config.json']) files[path] = await (await get(`${hfRoot}/${path}`)).text();
await mkdir('.honkoku-reference', { recursive: true });
await writeFile('.honkoku-reference/runtime.json', JSON.stringify(files, null, 2));
console.log(Object.keys(files));
