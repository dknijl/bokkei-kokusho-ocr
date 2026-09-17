# 墨景 — Koten OCR Service

古典籍の画像をブラウザで閲覧し、OCRで文字を読み取るアプリです。

NDL及びみんなで翻刻のAI OCRモデルを利用しております。

<img width="560" alt="bokkei image" src="https://github.com/user-attachments/assets/8af73d65-e74f-46d7-9690-2dd7d01c01cb" />

### デモURL

https://bokkei-kokusho-ocr.vercel.app/ocr/

## 使い方

1. 「資料」から書誌IDまたはIIIF Manifestを指定します。
2. 「このページを自動OCR」を押します。
3. 原画像と読取結果を照合します。異体字検索や一文字OCRも使えます。

ページOCRは端末内で処理します。一文字OCR（Metom）は選択領域の公開画像URLをCODHへ送信します。

## 開発

Node.js 24以降が必要です。

```sh
npm ci
npm run dev
```

`http://localhost:5173/ocr/` で開き、終了は `Ctrl+C`。
検証は `npm test`、ビルドは `npm run build` です。

## 国書データベース公開画像のAI OCR対応

国書データベースで公開されているCC-BY等のライセンスのmanifestファイルは、該当書誌の`bid`を指定することで閲覧可能です。

`http://localhost:5173/ocr/{bid}`

例： http://localhost:5173/ocr/200021552  (**古今和歌集**)

## ライセンス

- 本アプリ：[Apache License 2.0](LICENSE)
- [NDL古典籍OCR-Lite](https://github.com/ndl-lab/ndlkotenocr-lite)：CC BY 4.0
- [みんなで翻刻OCRのモデル](https://huggingface.co/yuta1984/honkoku-ocr/blob/b0bc83884980826b884a2cfde5ca4275b7d911db/README.md)：CC BY-SA 4.0
- [みんなで翻刻OCRの参照実装](https://github.com/yuta1984/honkoku-ocr-web/blob/24469701412edda5be26c89784a29c7525bbb899/LICENSE)：CC BY 4.0
- [国書データベース異体字リスト](https://github.com/kokubunken/kokusho-itaiji-search)：MIT

みんなで翻刻OCRの作者はYuta Hashimotoです。本アプリは各配布元の公式サービスではありません。
