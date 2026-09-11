# OCR前処理・全コマOCRの実装と検証

原画像を基本にし、検証を通過していない濃度補正・二値化を自動採用しない。全コマ処理とZIPはブラウザ内で完結する。学習モデルの追加・再学習、欠損文字の生成、図版の完全自動分離は行わない。

## 実装

| 対象 | 実装箇所・仕様 |
|---|---|
| IIIF | `image-source.ts`でImage API v2/v3の寸法、level、sizes、maxWidth/Height/Areaを読む。通常は長辺2000px以内。縦横比3以上は短辺×1.5を区画幅にし、15%重複、最大2048pxで元領域を取得 |
| 座標 | Canvas寸法・原画像画素・タイル画素を分離。検出は原画像座標に戻し、表示時だけCanvasへ変換。重複は別タイルの重なった観測だけ統合し、同一タイルで分離した行を再結合しない |
| 行認識 | 原画像の全行を認識後、解像度、局所濃度、背景むら、認識診断で再処理対象を順位付け。各行の第1候補を試してから第2候補へ進む。追加推論上限は標準2、高精度6 |
| 補正 | 穏やかな濃度補正（2–98%のストレッチを50%混合）、背景除算、Sauvola（半径12、k=0.2、R=128）、既存の局所平均×0.9。原画像候補と加工条件・取得領域・採用理由を保存。共通の余白処理や二値化を独立した複数票として扱わない |
| 採用制限 | `retry-policy.ts`の`APPROVED_IMAGE_CORRECTIONS`は空。画像補正autoでも未承認の補正は実行しない。原画像の切り出し・高解像度再取得は従来機能の改善として利用する |
| 実行 | 単ページ・全コマで`worker-client.ts`を共有し、同時推論1。Worker内のOffscreenCanvas、WebGPU優先・WASM fallback。モデルの初期化も直列化。Worker非対応時は単ページのみメイン側で実行 |
| 保存 | IndexedDB v2のjobs/job-pagesに入力を固定。コマ結果・完了数・キャッシュを同一トランザクションで保存。保存失敗で完了数を進めない。モデル・Worker・保存の障害は停止。画像の429/5xx/一時的通信障害は最大2回再試行後、失敗を保存して次へ |
| 再開 | 再読み込み後は最後のジョブを復元し、pendingから再開。pauseは現在コマの保存後、cancelは取得をabortしてWorkerを終了。保存済みは保持。異なるモデル／パイプラインのジョブは再開不可 |
| ZIP | zip.jsで保存済み結果を1件ずつ読む。UTF-8、BOMなし、LF、1検出行1行。番号は元Canvas番号。文字未検出は空txt、失敗・未対応はerrors、未処理はindexのみ。画像は含めない |

ZIP保存先の選択はクリック時に行う。対応環境ではWritableStreamへ、非対応環境ではBlobへ圧縮する。Blobはページテキスト64MiBまたは5,000エントリーを上限に分割し、各ZIPの保存ボタンを出す。途中の保存・圧縮失敗でIndexedDBの結果を消さない。

ZIPにはテキスト、一覧の`index.csv`、失敗時の`errors/*.txt`だけを含める。実行条件の`run.json`は通常利用に不要なため出力しない。再開に使う設定・モデル版・保存状態は引き続きIndexedDBに保持する。分割上限では各ZIPの`index.csv`1件を数える。

ブラウザのタブ終了、凍結、OSスリープ中の継続は保証しない。サイトデータ削除・ブラウザによるストレージ消去を越えた再開も保証できない。全コマはManifest配列順（v2は先頭sequence）であり、viewingDirectionでは逆転しない。画像なし・複合Canvasを欠番にせず未対応として保存する。

Image Serviceがない／メタデータを取得できない場合は直接画像を使う。追加解像度がないことを診断に残す。巨大な直接画像はデコード時に元画像分のメモリが必要になるため、IIIFの領域取得と同じメモリ上限を保証できない。各処理用Canvasは上限内で保持し、bitmap・Canvas・Tensorを使用後に解放する。

## 再現手順

通常の機能テストは外部OCRを呼ばない。

```sh
npm install
npm run test:unit
npm run check
npm run build
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npm run test:browser
```

実モデル検証には公開モデル約82MBと公開画像を取得する。出力はGit管理外の`work/ocr-evaluation`。既存の未統合Honkoku用テストとは別設定にしている。

```sh
npm run prepare:ocr-evaluation
curl -fL 'https://lab.ndl.go.jp/dataset/ndlkotensekiocr/ndl-minhon-ocrdataset_20240207.zip' -o work/ocr-evaluation/ndl-minhon.zip
curl -fL 'https://dl.ndl.go.jp/api/iiif/10301810/R0000004/info.json' -o work/ocr-evaluation/ndl-image-info.json
python3 scripts/import-ndl-evaluation.py
OCR_REQUIRE_WEBGPU=1 PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npm run test:ocr-evaluation
npm run build
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npx playwright test --config playwright.ocr-production.config.ts
node scripts/summarize-ocr-evaluation.mjs
```

GPUを利用できない環境では`OCR_REQUIRE_WEBGPU=1`を外す。その場合autoテストの成功はWebGPUの成功を意味しない。レポートのproviderを確認する。テスト用ChromiumのMetal/WebGPU設定は本番アプリの必須条件ではない。

`prepare:ocr-evaluation`は現在HEADの追跡済みライブラリをwork/legacyへ保存し、現行処理の比較対象とする。実装後にコミットした場合、比較用のHEADも変わるため`legacy/revision.txt`を必ず確認する。元のパイプラインは幅2000px取得、変更後は長辺2000px取得であり、legacy比較には取得・検出の変更も含む。補正単独比較は変更後の共通検出と同じ追加推論枠を使用する。

独自の正解データ配列は`OCR_GROUND_TRUTH=/absolute/path/data.json`で指定できる。各要素に`id`, `bookId`, `manifestUrl`, `canvasId`, `imageServiceId`（直接画像なら`imageUrl`）, 原画像`width/height`, `lines:[{text,region:{x,y,width,height}}]`, `tags`, `split`, `trainingOverlap`, `annotationCoverage`を入れる。全文の行順で記録し、必要なら`normalizedText`と非文字領域`nonTextRegions`を付ける。異体字正規化を実運用のOCR出力には適用しない。

`runPreprocessingAblation`は原画像のみ、自動再認識、濃度補正、背景補正、Sauvola、局所平均二値化、legacyを比較する。補正候補を採用するのは比較用レコードだけ。ページ全行への補正ではなく、同じ追加推論枠に入る行だけの比較である。

```sh
node scripts/assess-ocr-correction.mjs \
  work/ocr-evaluation/ablation-original.json \
  work/ocr-evaluation/ablation-sauvola.json \
  docs/ocr/calibration-book-ids.json
```

採用判定は原文CER改善、資料群別Recall・誤挿入・脱落の非悪化、全資料群の存在、完全な注釈、資料単位の調整／評価分離、学習資料との重複除外を要求する。条件不足なら終了コード1。判定に通っても承認リストを自動変更しない。評価結果と適用条件をレビューしてから、承認リストと方針バージョンを更新する。

## 正解データと研究の限界

公開取得した資料は、既存の写本サンプル、繪本松のしらへ、光悦筆和歌帖、東京大学の百鬼夜行図、およびNDL公開の化物世帯氣質の部分注釈。薄墨・裏写り・朱筆の完全な正解付き評価集合は未整備である。資料群ごとの未知資料評価を満たしたとは扱わない。

[NDLデータセット](https://github.com/ndl-lab/ndl-minhon-ocrdataset)の24行を取り込んで比較手順を実行した。ただし学習用データに含まれ、座標対応は機械的で欠落を含む。`trainingOverlap=known`, `split=calibration`, `annotationCoverage=partial`として保存し、自動補正の採用根拠から除外する。元テキスト・注釈はCC BY-SA 4.0であり、データを再配布する場合はその表示を維持する。全文CER・余分な検出の値は、不完全な注釈では精度の推定値として使わない。

[KuroNet](https://arxiv.org/abs/1910.09433)と[固定版NDLの後処理](https://raw.githubusercontent.com/ndl-lab/ndlkotenocr-lite/ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8/src/rtmdet.py)を踏まえ、画素の黒さによる絵の除去は実装していない。[DKDS](https://ruiyangju.github.io/DKDS/pdf/paper.pdf)のmiwo向け二値化改善や[RG-KCR](https://arxiv.org/html/2602.19086v1)の印影復元を、NDL行認識の一般的な改善保証に転用しない。

仕様参照: [IIIF Image API](https://iiif.io/api/image/3.0/)、[Presentation API](https://iiif.io/api/presentation/3.0/)、[ONNX Worker制約](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)、[zip.js](https://gildas-lormeau.github.io/zip.js/)、[保存先選択の操作要件](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)。

## 検証結果

初回の比較結果は同ディレクトリの`results.json`、誤結合修正後の実モデル結果は`layout-regression-results.json`と下記の記録を参照する。

- 修正前の型検査エラー: 未統合のHonkoku関連6ファイルに16件。`confidence.ts`, `registry.ts`, `engine/types.ts`, `models/manifest.ts`, `recognizers/honkoku-v18.ts`, `page-ocr.ts`。下記の「Honkoku型整合性と応答処理を修正」で解消した。
- 機能テストのOCRは模擬。実モデルの認識率の証拠としては使わない。
- 模擬1,000コマでは実OffscreenCanvasとSauvola処理を使い、保存時点の未解放Canvas数0を確認する。1,000コマを実ONNXで処理した試験ではない。
- 実モデル試験では通常・絵入・細長い資料をWASM/WebGPUで実行し、実行後のCanvas数0、追加推論枠、取得領域数を検証する。GPU/CPU Tensorは推論ごとのfinallyでdisposeする。GPUドライバ内部のメモリ常駐量を測定したものではない。
- 試験中に検出したWebGPUの同時モデル初期化失敗と、同じ余白処理の誤文字列を二票で採用する問題を修正した。

### 2026-09-11 初回実装時の確認結果（パイプラインv1）

単体テスト47件、通常ブラウザテスト13件、本番ビルドの実OCRテスト1件、実モデル比較・WASM・WebGPUテスト3件が成功。ビルドも成功。型検査は開始時と同じ16件の既存エラーで失敗し、変更対象に新規エラーはない。

実モデルは固定版NDL-Lite、Playwright Chromium 151 / macOS arm64。以下の時間はモデル取得・画像取得・初期化を含む各実行の記録であり、同時に動いていた他の検証の影響もあるため速度比較の結論には使わない。

| 資料 | WASM | WebGPU | 検出行数 | 元領域数 |
|---|---:|---:|---:|---:|
| 古今和歌集・サンプル第1コマ | 21.4秒 | 23.3秒 | 各12 | 1 |
| 繪本松のしらへ・第4コマ | 17.1秒 | 23.1秒 | 各30 | 1 |
| 百鬼夜行図・79,508×3,082px | 171.4秒 | 59.6秒 | 各80 | 21 |

全実行で処理後の未解放Canvas数0、同時保持の最大5、各Canvas最大2048×2048px以内。絵巻の80行には誤検出の可能性があり、80行の正解があると確認した結果ではない。

部分注釈24行に対する診断では、原画像のCER値0.3633、自動再認識0.3633、穏やかな濃度補正0.3525、背景補正0.3633、Sauvola/局所平均二値化0.3489、legacy0.4424だった。これは不完全な注釈と対応させた数値で、未知資料の認識率改善として解釈しない。補正はそれぞれ2回の追加推論だけであり、全行を補正した比較でもない。全自動採用判定は不合格のまま維持した。

### 2026-09-11 進捗表示と注記の誤結合を修正（パイプラインv2）

進捗欄が暗色テーマの文字色を継承し、明るい背景上で読めなくなっていた。欄自体の前景色を指定し、保存済み件数に基づく全体割合、現在コマの進捗、完了・失敗あり・一時停止・中止・中断を明示する。全体割合はOCRの推定残り時間ではなく、失敗記録も含む保存済みコマの割合。失敗の再実行中は保存済み100%でも「処理中」と表示し、成功完了とは扱わない。

古今和歌集第1コマは、RTMDet直後には14枠あり、上部の注記2行と下部の本文は別々に検出されていた。`areAdjacent`が横方向の重なりを「小さい方の幅」で割っていたため、注記が太い本文の幅に収まるだけで同じ行と判定し、12枠に結合していた。両方の領域が十分に同じ幅を覆うことを条件に変更した。原画像や空白分割のしきい値は変更していない。

`frontend-ocr-source-worker-v2`へ更新し、旧版のキャッシュを再利用しない。旧ジョブの結果は保持してZIP保存可能にし、旧結果の画面への自動復元と異なる方式での再開を禁止する。新しい結果を得るには新規に全コマOCRを実行する。

責務と検証契約：`batchProgress`は保存済み件数と実行状態から表示状態だけを決める。`areAdjacent`は同じ書字列の断片かを幾何条件で判断し、入力枠を変更しない。`code.domain.v1` / `code.verification.v1`、画面は`ui.async.v1` / `ui.accessibility.v1`を適用。実画像の検出枠、縦横を反転した枠、幅が少し違う同じ行の断片を単体テストし、保存失敗・停止・旧版復元は実IndexedDBとブラウザで検証する。

単体51件とブラウザ18件が成功。1280px・390pxの完成画面を目視し、状態・割合・件数・補足文の文字コントラストが4.5:1以上であることをブラウザで検査した。実モデルのWASM/WebGPU双方で、同資料の注記2行と本文1行がそれぞれ独立して認識され、全体14枠となることを確認した。絵入資料は31枠、絵巻は83枠となり、全6実行で解放後Canvas数0、追加推論上限内だった。検出枠数の増加を一般的な精度向上の証拠とは扱わない。型検査は既存Honkoku関連16件のまま、新規エラーなし。

ZIP簡素化前の本番ビルドの実OCRテスト1件も成功（29.0秒）。古今和歌集3/3コマの保存、全コマOCR完了・100%の表示、ZIPのBlobダウンロードと展開、第1コマ14行、当時のrun.jsonの未処理0とパイプラインv2を確認。画像は`work/production-results/real-ocr.png`、完了欄は`batch-complete.png`、展開テキストは`first-page.txt`。初回のダウンロード待ちはネイティブ保存経路を通っていたためタイムアウトした。自動試験では保存先選択APIを未提供にしてBlob経路を指定し直した。ネイティブ保存ダイアログの自動操作を実証したものではない。

その後、利用者の要望によりrun.jsonをZIPから除外。単体51件、ZIP関連のブラウザ2件、ビルドが成功。通常・分割ZIPの収録ファイル、分割上限、UTF-8文字列、失敗情報を展開して検証した。OCR処理とIndexedDBの保存形式は変更していないため、保存済み結果から再OCRなしで新しいZIPを生成できる。

### 2026-09-11 モデル自動更新・キャッシュとのrebase競合を解消

`af092a3`へ全コマOCRの変更をrebaseする際の4ファイルの競合を解消。マージ先のモデル資産キャッシュと単ページの再推論を維持し、全コマの結果キャッシュ・保存・再開と統合した。依存関係ファイルのJSON構文も修正し、ONNX Runtime Web 1.29.0、Svelte 5.57.0、Playwright 1.63.0で検証した。

新しい単ページ実行・全コマジョブでは`master`を40桁のコミットSHAに解決する。確認結果は7日間キャッシュし、モデル取得URLとジョブ設定・結果キャッシュキーには確定したSHAを使う。再開時は最新を再解決せず、保存時の版を使用する。異なる版の結果を受け取った場合は保存件数を進めず停止する。旧ジョブの未指定版は従来の固定SHAとして扱う。別の版の実行へ切り替えるときは、古いセッションを解放してから初期化する。

- 単体テスト55件、ブラウザテスト20件、ビルドが成功。ブラウザでは再開中にupstreamの版が変わっても元の版で完走すること、新規ジョブでは新しい版を使用すること、単ページの再OCRが全コマの保存結果で省略されないことを確認。
- 本番ビルドの実OCRテスト1件が成功（41.4秒）。3/3コマ・100%・完了表示、ZIP展開、`index.csv`とテキスト3本だけの収録、第1コマ14行を確認。再読み込みでWorkerを作り直した後も実推論でき、モデル2本・文字集合の取得要求は初回の計3回から増えなかった。
- WASM/WebGPUの実モデル試験はともに通常14行・絵入31行・絵巻83行（21領域）で成功。全6実行で解放後Canvas数0、追加推論上限内。実測は`work/ocr-evaluation/real-wasm.json`と`real-auto.json`。検出行数は文字認識精度の保証ではない。
- WASM試験では従来のWorker本文を書き換える方法で画像取得が2度失敗した。GPUを無効にしたブラウザ用fixtureへ変更後、WebGPU初期化失敗からWASMへ切り替わり、全3資料の試験が成功した（計1.7分）。OCR結果の模擬やアプリの画像取得処理の変更は行っていない。WebGPU試験は別実行で成功を確認した。
- 型検査は未統合Honkoku関連6ファイルの既存16件で失敗。該当ファイルを削除・検査除外せず維持し、今回の変更による新規エラーはなかった。

### 2026-09-11 Honkoku型整合性と応答処理を修正

共通のエンジンID・信頼度種別・Koji原文・生成診断の型を定義し、実装も利用箇所もない型の再exportを除去した。欠けていたエラー文言も追加。エンジンを削除せず、型アサーションや検査除外で回避せずに型検査16件を解消した。

`detectPageLines`はNDLの既存取得・タイル検出・重複統合処理を共用し、原画像座標の検出枠と実寸を返す。画像資源は関数内で解放する。検出だけの実行ではPARSeqと文字集合を取得せず、その後の通常OCRでは認識モデルを追加した構成に切り替える。Honkokuの切り出しはこの原画像座標を使用する。ページOCRのモデル版表示・キャッシュ識別子も実行版に合わせた。

Honkoku Workerの認識結果が初期化時のrun ID判定で無視され、待機が終わらなかった問題を修正。run IDと行IDで応答を照合し、同時認識を拒否する。初期化・推論中の中止と破棄、Worker異常、メッセージ解読失敗は待機を解除し、Workerを終了する。破棄済みWorkerの遅れた応答・異常を新しい実行へ反映しない。結果のManifestダイジェストは実際にロードした値を保持し、認識後に再取得した別の値で置き換えない。Kojiの平文変換規則は変更していない。

検証結果：

- `npm test`が成功。型検査0件・警告0件、単体57件、本番ビルド。
- 通常ブラウザ20件、Honkoku接続処理のブラウザ9件が成功。後者はモデル応答を模擬し、ID不一致・競合・失敗・中止・初期化中の破棄・再初期化・ページへのKoji受け渡しを確認。
- NDL実モデル3テストが成功。通常・絵入・絵巻をWASM/WebGPUで再検証し、14・31・83行、解放後Canvas数0。追加の検出専用試験ではCanvasの寸法を100×150に変えても原画像3744×5616の14枠を返し、PARSeq未取得・文字認識0回を確認。同じ実行環境から通常OCRへ切り替えると14行を認識し、検出モデルの追加ダウンロードはなかった。
- 本番ビルドの実OCR・ZIP試験1件も成功（33.6秒）。3/3コマの完了、ZIP展開、再読み込み後のモデルキャッシュ利用を確認。

Honkoku実モデルの配信Manifestはこの環境で未設定であり、Honkokuの実推論・認識精度は未検証。既存の実モデルsmoke testは、存在しない画面のエンジン選択欄から、実装されている`recognizePage` APIを呼ぶ方法へ修正した。通常の画面は引き続きNDLを使用する。

修正の契約：共通型は`code.domain.v1`、検出モデル・画像の解放とWorker待機の所有は`code.effects.v1`、各不具合の再現・回帰検証は`code.verification.v1`を適用。

```sh
npm test
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npm run test:browser
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npx playwright test --config playwright.honkoku-adapter.config.ts
OCR_REQUIRE_WEBGPU=1 PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npx playwright test --config playwright.ocr-evaluation.config.ts pipeline.spec.ts detector.spec.ts
```

再現コマンド：

```sh
npm run test:unit
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npm run test:browser
OCR_REQUIRE_WEBGPU=1 PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npx playwright test --config playwright.ocr-evaluation.config.ts pipeline.spec.ts
npm run check
npm run build
PLAYWRIGHT_BROWSERS_PATH="$PWD/work/playwright-browsers" npx playwright test --config playwright.ocr-production.config.ts
```
