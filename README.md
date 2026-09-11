# 墨景 — Koten OCR Service

国文学研究資料館「国書データベース」などの IIIF Presentation API v2/v3 Manifest を読み込み、Canvas と Image Service を保ったまま古典籍画像を閲覧・OCR連携する Svelte 5 アプリです。

<img width="731" alt="image" src="https://github.com/user-attachments/assets/5ab7ba83-0972-47be-b869-e53864640322" />


## 技術スタック

- Svelte 5（runes）
- TypeScript
- Vite 8
- ONNX Runtime Web 1.29（WebGPU / WASM）
- OpenAI Sites / Cloudflare Worker 静的配信
- IIIF Presentation API v2/v3、IIIF Image API

## OCR連携

### NDL古典籍OCR-Lite — ページ自動OCR

画像ビューワーのツールバーにある「このページを自動OCR」を実行すると、国立国会図書館の [`ndlkotenocr-lite`](https://github.com/ndl-lab/ndlkotenocr-lite) をブラウザ内で動かします。「全コマをOCR」ではManifestの先頭から末尾まで順次処理し、コマごとのテキストをZIPに保存できます。

1. `info.json`で原寸・対応機能・配信上限を確認し、通常画像は縦横比を保って長辺2000px以内で取得。縦横比3以上の資料は元画像の領域から分割取得（各タイル最大2048px、15%重複）。Image Serviceがなければ取得可能な画像を使用
2. RTMDet（`rtmdet-s-1280x1280.onnx`）で文字行を検出し、プロファイル別閾値とglobal NMSで候補を整理
3. 紙面外という理由だけでは行を削除せず、見開きや書き入れを保持
4. 行矩形をfloor/ceilで外向きに切り出し、縦長の行を横向きに回転
5. PARSeq（`parseq-ndl-32x384-tiny-10.onnx`）で認識し、token score・top-2 margin・EOSを計算
6. 低信頼行だけpadding候補とIIIF高解像度cropを上限付きで再認識し、元画像候補を残して決定的に選択
7. 検出した実座標、検出スコア、未較正の認識スコア、翻刻を重ねて表示

新規OCRではGitHub APIでNDLリポジトリの`master`のコミットを確認し、その版のモデルを取得します。版の確認結果とモデル2本・文字集合はIndexedDBに7日間保存するため、新規実行へのupstream更新反映には最大7日かかります。全コマOCRは開始時の版を固定し、一時停止・再読み込み後も同じ版で再開します。版を確認できず有効な保存データもない場合は、別のモデルへ切り替えず停止します。モデル合計は検証時点で約82MBです。ストレージ容量不足、プライベートブラウジング、ユーザーによるサイトデータ削除、ブラウザのストレージ整理時は再ダウンロードします。RTMDetのファイル名は1280ですが、検証したONNXグラフの実入力は1024×1024です。対応ブラウザではWebGPUを優先し、初期化できない場合は単一スレッドのWASMへフォールバックします。画像は外部OCR APIへ送らず端末内で推論します。ただし、IIIF画像とNDLモデル自体は配信元からダウンロードします。

本サービスは、国立国会図書館がCC BY 4.0で公開する「NDL古典籍OCR-Liteアプリケーション」の学習済みモデルおよび処理方式を利用しています。ブラウザ向け実装は本サービス独自であり、国立国会図書館が提供・運営する公式サービスではありません。配布元と利用条件は [`ndl-lab/ndlkotenocr-lite`](https://github.com/ndl-lab/ndlkotenocr-lite) を参照してください。

既定の`balanced`は追加推論2回、`accurate`は6回です。全行を原画像で認識してから再処理対象を順位付けし、各対象行の最初の候補を試してから次候補へ進みます。原画像の候補、取得URL・領域、加工条件、採用理由を結果に保存します。認識スコアは未較正で、正解率を意味しません。不確かな行は「要確認」と表示し、絵や朱筆を画素の黒さだけで削除しません。

画像補正は`off / auto`で切り替えます。濃度補正・背景補正・Sauvola二値化は比較評価を実装していますが、独立した評価で採用条件を満たすまでは自動適用しません。現在の承認リストは空です。`accurate`では適応タイル検出や長行分割を追加します。読み順は認識順と分離して決めますが、公式Python版の完全な読み順解析の移植ではありません。

単ページと全コマOCRは共通の専用Workerで一件ずつ実行し、モデルを再利用します。WebGPU初期化失敗時はWorker内WASMへ切り替えます。全コマの結果はモデル版・パイプライン・画像URLと実寸・全設定をキーとしてIndexedDBへ保存・再利用します。単ページの「再OCR」は保存結果を使わず毎回推論します。`?debug=ocr`で候補を含むJSON/CSVの出力と原文CER・正規化CER・ページ全文CERなどの評価ができます。

### 全コマOCRとZIP保存

「全コマをOCR」で開始し、「一時停止」で現在コマの保存後に停止、「再開」で未処理から続けます。「中止」は実行中のWorkerと取得処理を止め、保存済み結果を保持します。再読み込み後も最後に保存されたジョブを復元します。ページの表示切り替えは一括処理を中断しません。

「処理済みをZIP保存」で`texts/00001.txt`などのUTF-8テキスト、全コマを記録する`index.csv`、失敗情報の`errors/00017.txt`を保存します。Canvas番号を詰めず、文字未検出は空のテキスト、画像なし・複合Canvasは未対応として記録します。異体字の正規化や自動校訂はしません。失敗コマだけ再試行できます。

`index.csv`の`ocrConfidencePercent`列は、各コマの全認識行のスコアを平均し、整数の%（例：`93`）にした値です。実測の正解率ではありません。失敗・未処理・文字未検出、または一部でも認識スコアがないコマは空欄になります。保存済み結果にもZIPの再保存で追加できます。

保存先へのストリーム出力に対応しないブラウザではBlobを使い、64MiBのページテキストまたは5,000エントリーを上限に分割します。タブを閉じた後やOSスリープ中の継続は保証しません。ブラウザの保存領域を消すと途中結果も失われます。Worker非対応環境では単ページOCRを使用してください。

実装・評価方法と確認できた範囲は [OCR検証記録](docs/ocr/verification.md) を参照してください。

### 国書データベース異体字リスト

「異体字」タブは国文学研究資料館の [`kokusho-itaiji-search`](https://github.com/kokubunken/kokusho-itaiji-search) が公開する `kokusho_itaiji.sql` を使用します。1,719件の異体字・正規化先を1,424組にまとめ、OCRで選択中の行または検索語と双方向に照合します。検索語がなくOCR行も未選択の場合は全一覧を表示します。

データは再現性のためコミット `0fe0da905053588627146e7f037457a64285a93c` に固定しています。`npm run update:itaiji` で固定版SQLからTypeScriptデータを再生成できます。ライセンスはMITです。

### Metom

右ペインの「一文字OCR」で画像上の一文字を矩形選択すると、Canvas座標を IIIF Image API の crop URL に変換し、CODH が公開クライアントで使用している次のエンドポイントへ直接送ります。

```http
POST https://mp.ex.nii.ac.jp/metom/api/predict
Content-Type: application/json

{
  "image_url": "https://.../iiif/.../x,y,w,h/!512,512/0/default.jpg",
  "k": 10,
  "return_probs": true
}
```

Metom は一文字分類器です。ページ全体のレイアウト解析や翻刻には使いません。実行時には選択した公開 IIIF crop URL が CODH のサービスへ渡ります。APIクライアントは `src/lib/ocr.ts` にあります。

### KuroNet / RURI

現在の Manifest URL を公式 KuroNet IIIF Curation Viewer の `manifest` パラメータに渡します。KuroNet は Firebase ログインとダッシュボード上の予約実行を必要とするため、このサイトが認証情報を代理取得したり非公開APIを直接呼んだりはしません。

## 閲覧UI

デスクトップでは、ページ一覧・画像ビューワー・OCR結果の3ペインで表示します。画面幅が狭い場合は、ページ一覧を横スクロールできるサムネイル列に切り替え、画像とOCR結果を切り替えて表示します。画像表示、OCR枠、文字検索、異体字検索、Metomの一文字選択はデスクトップとモバイルの両方で利用できます。

## 開発

Node.js 24 以降を使用します。

```bash
npm install
npm run dev
npm run check
npm run build
npm run test:browser
npm run test:all
```

`npm test` は型検査、単体テスト、本番ビルドを順に実行します。本番出力は `dist/client`、Sites 用 Worker は `dist/server/index.js` です。

ブラウザのsmoke testはPlaywright Chromiumを使用します。初回のみ `npx playwright install chromium` を実行してください。Manifest HTTPエラー、プロファイル選択、狭い画面、全コマの保存・再開・ZIP展開、模擬1,000コマの画像解放を検査します。通常のブラウザテストはOCRを模擬し、実モデル検証は別コマンドで実行します。

## 配信パス

本番配信時のアプリのベースパスは `vite.config.ts` の `base` で指定します。現在は `/ocr/` です。

```ts
export default defineConfig({
  base: "/ocr/",
});
```

例： `/biblio/ocr/` 配下へ配置する場合は、次のように変更してからビルドします。

```ts
base: "/biblio/ocr/",
```

この設定はアセットのURLと、書誌IDを含む共有URL（`/biblio/ocr/{bid}`）の生成に使用されます。Nginx側でも同じパスを `dist/client` に割り当て、`/biblio/ocr/{bid}` を `/biblio/ocr/index.html` にフォールバックさせてください。

## 書誌IDによるURL指定

アプリのベースパス（既定は`/ocr/`）の直後に国書データベースの書誌IDを付けると、その資料のManifestを起動時に読み込みます。

```text
https://DEV_URL/ocr/200021946
```

上記は `https://kokusho.nijl.ac.jp/biblio/200021946/manifest` を読み込みます。`?canvas=17`を付けると、1始まりのCanvas番号で17ページ目を指定できます。Manifest選択画面から国書データベースの資料を開いた場合やページを移動した場合も、同じ共有可能なURL形式へ更新します。

## 制限

- 外部 Manifest はブラウザから取得するため、配信元が CORS を許可している必要があります。
- 全頁OCRでは画像ピクセルをCanvasで読むため、IIIF Image APIもCORSを許可している必要があります。
- 初回OCRはNDLモデル約82MBとONNX Runtimeをダウンロードします。WASM動作はWebGPUより遅く、ページや端末によって数分かかる場合があります。WebGPU非対応または初期化失敗時はWASMへフォールバックします。
- WASMフォールバック時、cross-origin isolationを設定していない環境では、ブラウザの開発者コンソールに`SharedArrayBuffer`関連の警告が表示される場合があります。OCRは単一スレッドで実行します。
- Metom を使う Canvas には IIIF Image Service ID と原寸 `width` / `height` が必要です。
- OCR枠は行検出モデルが返した実座標だけを表示します。推測した固定枠はありません。

## ライセンス

本プロジェクトのソースコードは [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) の下で提供されています。ライセンス全文は [`LICENSE`](./LICENSE) を参照してください。

本プロジェクトで利用している外部ソフトウェア、学習済みモデル、データ、サービスには、それぞれの提供元が定めるライセンスおよび利用条件が適用されます。NDL古典籍OCR-Liteおよび国書データベース異体字リストのライセンス情報は、上記「OCR連携」節を参照してください。
