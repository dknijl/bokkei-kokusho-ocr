"""Import a public, PARTIAL annotation for diagnostic evaluation, never as held-out truth."""
import json
import zipfile
from pathlib import Path
root = Path('work/ocr-evaluation')
with zipfile.ZipFile(root / 'ndl-minhon.zip') as archive:
    path = 'ndl-minhon-ocrdataset_20240207/v2/kusazoushi/9D61092EC482751E687C188D44347857/004.json'
    words = json.loads(archive.read(path))['words']
info = json.loads((root / 'ndl-image-info.json').read_text())
lines = []
for word in words:
    if word.get('isTextline') not in (True, 'true') or not word.get('text'):
        continue
    xs, ys = zip(*word['boundingBox'])
    lines.append({'text': word['text'], 'region': {'x': min(xs), 'y': min(ys), 'width': max(xs)-min(xs), 'height': max(ys)-min(ys)}})
fixture = {
    'id': 'ndl-minhon-10301810-004', 'bookId': 'ndl:10301810', 'split': 'calibration',
    'trainingOverlap': 'known', 'annotationCoverage': 'partial',
    'sourceCitation': 'https://github.com/ndl-lab/ndl-minhon-ocrdataset (CC BY-SA 4.0; text: Minna de Honkoku; coordinates: NDL)',
    'manifestUrl': 'https://dl.ndl.go.jp/api/iiif/10301810/manifest.json',
    'canvasId': 'https://dl.ndl.go.jp/api/iiif/10301810/canvas/4',
    'imageServiceId': 'https://dl.ndl.go.jp/api/iiif/10301810/R0000004',
    'width': info['width'], 'height': info['height'], 'tags': ['printed', 'illustrated'], 'lines': lines,
}
(root / 'ground-truth.json').write_text(json.dumps([fixture], ensure_ascii=False, indent=2)+'\n')
print(f'Imported {len(lines)} partial annotated lines; ineligible for automatic correction approval.')
