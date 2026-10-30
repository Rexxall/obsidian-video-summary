# インストール

[中文（完整版）](../INSTALL.md) · [English](INSTALL.en.md)

Video Summary は、Obsidian プラグインと、自分のパソコンの Docker で動くバックエンドの二つでできています。バックエンドは起動スクリプトだけで用意でき、プログラミングは不要です。所要時間は約 20 分で、その大半は初回のイメージ作成です。

## 用意するもの

- Obsidian デスクトップ版
- 起動している Docker Desktop（Windows・macOS）または OrbStack（macOS）
- OpenAI 互換の要約モデルのキー（既定は DeepSeek の `deepseek-flash`。Gemini を含め、OpenAI 互換ならどれでも可）
- 任意：SiliconFlow のキー。字幕のない動画や手元の音声・動画の文字起こし（SenseVoice は無料）と画像の読み取りに使います。

## 手順

1. Obsidian のコミュニティプラグインから **Video Summary** を入れます。または[最新リリース](https://github.com/Rexxall/obsidian-video-summary/releases/latest)の `main.js`、`manifest.json`、`styles.css` を `<保管庫>/.obsidian/plugins/video-summary/` に置きます。
2. 同じリリースの `video-summary-backend-<バージョン>.zip` を、保管庫の外の消さない場所に展開します。
3. 起動します。macOS は `start-mac.command` を右クリック →「開く」、Windows は `start-windows.cmd` をダブルクリック、Linux は `./vs-backend.sh` です。キーを聞かれたら貼り付けます。初回は 5〜15 分かかります。
4. 最後に**接続コード**が表示され、クリップボードにコピーされます。バックエンドのパスワードにあたるので、人に渡さないでください。`./vs-backend.sh code` で再表示できます。
5. Obsidian の **設定 → Video Summary → 首次配置（初期設定）** で、コードを貼り付け、完全チェック、試運転の順に進めます。問題があれば直し方が表示されます。

## 日常のコマンド

`./vs-backend.sh`（Windows は `.\vs-backend.ps1`）に何も付けないと起動（`.env` の変更もこれで反映）、ほかに `check`、`code`、`keys`、`logs`、`stop`、`update`（サイトの取得が失敗し始めたら yt-dlp を更新）があります。

モデルを変えるときは `.env` の `VS_CHAT_BASE_URL`、`VS_CHAT_MODEL`、`VS_CHAT_API_KEY` を書き換え、起動スクリプトをもう一度実行します。バックエンドは `127.0.0.1` だけで待ち受けます。外部に公開する前に [backend/SECURITY.md](../backend/SECURITY.md) を読んでください。

どの手順で失敗したかは、接続コードのアドレス（既定は <http://127.0.0.1:5678>）をブラウザで開いて確認できます。初回は n8n のアカウントを作ります（このパソコンのバックエンドにだけ保存されます）。上部の **Executions** で最新の実行を開き、**AI: Write Note** の出力を見てください。モデルやキーのエラーでも実行は Success と表示されます。

<img src="screenshots/n8n-workflow.jpg" width="860" alt="n8n の Video Summary ワークフロー">
