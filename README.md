# 墨景 — Koten OCR Service

国文学研究資料館「国書データベース」などの IIIF Presentation API v2/v3 Manifest を読み込み、Canvas と Image Service を保ったまま古典籍画像を閲覧・OCR連携する Svelte 5 アプリです。

## 技術スタック

- Svelte 5（runes）
- TypeScript
- Vite 8
- ONNX Runtime Web 1.27（WebGPU / WASM）
- OpenAI Sites / Cloudflare Worker 静的配信
- IIIF Presentation API v2/v3、IIIF Image API

React、Next.js、Vinext、Tailwind、Drizzle は使用していません。

## OCR連携

### NDL古典籍OCR-Lite — ページ自動OCR

画像ビューワーのツールバーにある「このページを自動OCR」を実行すると、国立国会図書館の [`ndlkotenocr-lite`](https://github.com/ndl-lab/ndlkotenocr-lite) をブラウザ内で動かします。OCR対象は現在選択中の1ページです。

1. IIIF Image Serviceから長辺2000pxの画像を取得（Image Serviceがない場合はManifestの画像URLを使用）
2. RTMDet（`rtmdet-s-1280x1280.onnx`）で文字行を検出し、プロファイル別閾値とglobal NMSで候補を整理
3. 紙面外という理由だけでは行を削除せず、見開きや書き入れを保持
4. 行矩形をfloor/ceilで外向きに切り出し、縦長の行を横向きに回転
5. PARSeq（`parseq-ndl-32x384-tiny-10.onnx`）で認識し、token score・top-2 margin・EOSを計算
6. 低信頼行だけpadding候補とIIIF高解像度cropを上限付きで再認識し、元画像候補を残して決定的に選択
7. 検出した実座標、検出スコア、未較正の認識スコア、翻刻を重ねて表示

モデルは再現性のため `ede4283845cdc0ba2bda8b7ebfc3dc80b33c92c8` に固定しています。モデル合計は約82MBです。RTMDetのファイル名は1280ですが、固定したONNXグラフの実入力はメタデータどおり1024×1024です。対応ブラウザではWebGPUを優先し、初期化できない場合は単一スレッドのWASMへフォールバックします。画像は外部OCR APIへ送らず端末内で推論します。ただし、IIIF画像とNDLモデル自体は配信元からダウンロードします。

本サービスは、国立国会図書館がCC BY 4.0で公開する「NDL古典籍OCR-Liteアプリケーション」の学習済みモデルおよび処理方式を利用しています。ブラウザ向け実装は本サービス独自であり、国立国会図書館が提供・運営する公式サービスではありません。配布元と利用条件は [`ndl-lab/ndlkotenocr-lite`](https://github.com/ndl-lab/ndlkotenocr-lite) を参照してください。

既定のOCRプロファイルは`balanced`です。低信頼行の追加認識は1ページあたりの上限を持ち、WASMでも無制限に増えません。画面またはAPIで`accurate`を選んだ場合だけ、grayscale-contrast、background-normalized、ink-channel、adaptive-binaryの候補、適応タイル検出、長行分割候補を追加できます。画面の認識スコアはtoken尤度から作る未較正の候補比較値で、文字ごとの正解確率ではありません。検出スコアとは別に保存します。結果はモデルリビジョン、パイプライン、Manifest、Canvas、optionsを含むIndexedDBへ保存し、同じ条件では再推論を避けます。`?debug=ocr`で現在ページの結果をJSON/CSVへ書き出せ、正解JSONを貼り付けてCER、完全一致行率、検出Recall/F1を計算できます。読み順は認識順と分離し、縦書きの列または横書きの行をXY-Cut相当の決定的な規則で並べ替えます。NDLのPython版に含まれる完全な読み順解析を移植したものではありません。実資料による精度改善はまだ測定していません。

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

`npm test` は Svelte の型・アクセシビリティ検査後に本番ビルドを実行します。本番出力は `dist/client`、Sites 用 Worker は `dist/server/index.js` です。

ブラウザのsmoke testはPlaywright Chromiumを使用します。初回のみ `npx playwright install chromium` を実行してください。Manifest HTTPエラー、OCRプロファイル選択、狭い画面のペイン切り替えを検査しますが、実モデルのWebGPU/WASM精度評価は含みません。

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
