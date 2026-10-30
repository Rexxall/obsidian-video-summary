<div align="center">

# Video Summary

**動画のリンク、手元の録音・録画、または文字起こしから、要約・タイムスタンプ付き文字起こし・要点をまとめた Obsidian ノートを作ります。**

[English](README.md) · [中文](README.zh-CN.md) · 日本語

<img src="docs/screenshots/hero.png" width="860" alt="左は完成した例のノート、右はサイドパネルのノート一覧">

</div>

Obsidian が中国語以外の設定のとき、プラグインの画面は英語で表示されます。

## はじめかた

1. Video Summary を有効にし、コマンドパレットからサイドパネルを開きます。
2. **See an example note**（例のノートを見る）を押すと、完成したノートが 1 本作られます。何も設定せずに結果を確認できます。
3. 自分の動画を処理するには、[最新リリース](https://github.com/Rexxall/obsidian-video-summary/releases/latest)から `video-summary-backend-<version>.zip` をダウンロードし、保管庫の外に展開して `start-mac.command`（macOS）または `start-windows.cmd`（Windows）を実行します。キーを入力すると接続コードが表示されます。初回は約 10 分で、ほとんどは約 550 MB のイメージのダウンロードです。手順は[インストールガイド](docs/INSTALL.ja.md)。
4. **Settings → Video Summary → First-run setup** で接続コードを貼り付け、**Full check** と **Trial run** を押します。
5. サイドパネルにリンクを貼り、**Start** を押します。

## 必要なものと費用

- プラグイン：無料、アカウント不要、デスクトップ版のみ。
- バックエンド：自分のパソコンの Docker（Docker Desktop または OrbStack、個人利用は無料）で動きます。
- 文字起こし：SiliconFlow の `SenseVoiceSmall`。字幕のない動画と手元のファイルだけに使います。モデルは無料ですが、残高が 0 だと使えません。
- 要約モデル：既定は DeepSeek `deepseek-flash`。OpenAI 互換のモデルなら何でも使えます。料金は各社の従量課金です。

## データの行き先

リンクや文字起こしは自分のパソコンのバックエンド（`127.0.0.1`）にだけ送られます。キーはバックエンドの `.env` に置かれ、保管庫には入りません。テレメトリーや解析はなく、作者には何も送られません。再処理ではプラグインが管理するブロックだけを置き換え、自分で書いた部分は残ります。詳しくは [英語版 README](README.md#privacy-and-data)。

## ライセンス

MIT
