# design

公開しない元データを置く場所です（GitHub Pages で公開されるのは `app/` だけです）。

## og.svg

OGP画像 `app/og.png` の元データです。文言やデザインを変えるときは、この SVG を直してから PNG を書き出し直してください。PNG を直接書き換えないでください。

- サイズ：1200×630
- 書体：M PLUS Rounded 1c（SVG の中で Google Fonts から読み込みます。書き出しにはネット接続が必要です）
- 地球儀の陸地と点は `app/countries.json` と `seed/curated-seed.json` をもとに、d3-geo の正射図法（経度125°・緯度25°が中心）で描いています

### 書き出し方法

リポジトリのルートで次を実行します。

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --screenshot="$PWD/app/og.png" --window-size=1200,630 --hide-scrollbars \
  --virtual-time-budget=5000 "file://$PWD/design/og.svg"
```

書き出したら PNG を開いて、文字のはみ出しや書体の置き換わりがないか確かめてください。文言を変えたときは、`app/index.html` の `og:image:alt` も合わせて直してください。

## favicon

地球儀のアイコンです。日本を中心にした地球儀に、日本の位置を赤い点で示しています。

| ファイル | 使われる場所 |
|---|---|
| `app/favicon.svg` | ブラウザのタブ（ほとんどのブラウザ） |
| `app/favicon.ico` | SVG に対応していない古いブラウザ（16・32・48px） |
| `app/apple-touch-icon.png` | iPhone・iPad でホーム画面に追加したとき（180×180、夜空の背景つき） |

元データは `tools/favicon/make.mjs` です。陸地は Natural Earth の 110m（`world-atlas`）、日本の形は `app/countries.json` を使い、小さく表示しても見える程度に輪郭を簡略化しています。色や中心の位置を変えるときは、このスクリプトを直してから次を実行し、`app/favicon.svg` を作り直してください。SVG を直接書き換えないでください。

```sh
npm run favicon
```

### PNG・ICO の書き出し方法

`app/favicon.svg` を作り直したら、PNG と ICO も書き出し直します。Chrome と ImageMagick を使います。

1. `app/favicon.svg` を Chrome で 16・32・48px と、夜空のグラデーション（`#1a2648`→`#202f55`→`#26386a`）の上に 150px で置いた 180×180px を、それぞれ PNG で書き出す
2. 180×180 を `app/apple-touch-icon.png` として保存する（iPhone は透明な部分を黒くするため、背景を塗ったものにする）
3. 16・32・48px をまとめて ICO にする

```sh
magick icon-16.png icon-32.png icon-48.png app/favicon.ico
```
