# Third-Party Notices

This project is distributed under the Apache License 2.0. The following external software, models, data, and services retain their own licenses and terms.

## Honkoku OCR v18

- Upstream project: [`yuta1984/honkoku-ocr-web`](https://github.com/yuta1984/honkoku-ocr-web)
- Pinned upstream commit: [`f0b0388a2744daaec4c92979e86516e4f8b3f8fd`](https://github.com/yuta1984/honkoku-ocr-web/tree/f0b0388a2744daaec4c92979e86516e4f8b3f8fd)
- License declared by the model manifest: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Runtime files: Honkoku encoder, decoder prefill, decoder step, and vocabulary files are fetched from the HTTPS manifest configured by `VITE_HONKOKU_MODEL_MANIFEST_URL`. They are not bundled in this repository.
- Attribution: Honkoku OCR v18 is an optional, feature-gated browser OCR engine integrated from the pinned upstream project. The manifest must provide SHA-256 and byte-length metadata for every model file.

## NDL Koten OCR-Lite

- Upstream project: [`ndl-lab/ndlkotenocr-lite`](https://github.com/ndl-lab/ndlkotenocr-lite)
- Pinned model/source revision: `ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8`
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- The browser implementation is independent and is not an official service provided or operated by the National Diet Library.

## Kokusho Database Variant Character Data

- Upstream project: [`kokubunken/kokusho-itaiji-search`](https://github.com/kokubunken/kokusho-itaiji-search)
- Pinned revision: `0fe0da905053588627146e7f037457a64285a93c`
- License: MIT
- Local license text: [`public/licenses/kokusho-itaiji-search.txt`](./public/licenses/kokusho-itaiji-search.txt)

## ONNX Runtime Web

- Package: [`onnxruntime-web`](https://github.com/microsoft/onnxruntime)
- License: MIT
- The package is used for browser-side ONNX inference and remains subject to its own license and notices.

## Metom

- Service: [CODH Metom](https://codh.rois.ac.jp/char-shape/app/metom/)
- Runtime use: an explicitly selected public IIIF crop URL may be sent to the public Metom prediction endpoint for single-character recognition. It is not used for full-page OCR.
