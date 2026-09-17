# Third-party notices

## Honkoku OCR v19 model weights

Yuta Hashimoto, https://huggingface.co/yuta1984/honkoku-ocr

Model snapshot: b0bc83884980826b884a2cfde5ca4275b7d911db.
The model card declares Creative Commons Attribution-ShareAlike 4.0 International:
https://creativecommons.org/licenses/by-sa/4.0/
Weights are fetched from the publisher; they are not included in this repository.
The training corpus derives from Minna de Honkoku transcriptions and IIIF images
from holding institutions. This application is not the official Honkoku service.

## Honkoku browser inference reference and vocabulary

Copyright (c) 2025 Yuta Hashimoto.
https://github.com/yuta1984/honkoku-ocr-web/tree/24469701412edda5be26c89784a29c7525bbb899
CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
Adapted preprocessing and encoder/prefill/KV-cache decoding for this application's
Worker, integrity-checked asset cache, cancellation, tensor cleanup and metadata.
No endorsement by the author is implied.

## NDL Kotenseki OCR-Lite

National Diet Library, https://github.com/ndl-lab/ndlkotenocr-lite
CC BY 4.0. Used for RTMDet line detection and the selectable PARSeq recognition path.
Other software and data notices remain in README.md.

## ONNX Runtime Web

- Package: [`onnxruntime-web`](https://github.com/microsoft/onnxruntime)
- License: MIT
- The package is used for browser-side ONNX inference and remains subject to its own license and notices.

## Metom

- Service: [CODH Metom](https://codh.rois.ac.jp/char-shape/app/metom/)
- Runtime use: an explicitly selected public IIIF crop URL may be sent to the public Metom prediction endpoint for single-character recognition. It is not used for full-page OCR.
