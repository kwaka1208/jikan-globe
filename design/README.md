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
