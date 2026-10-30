# インストール

[中文（完整版）](../INSTALL.md) · [English](INSTALL.en.md)

Video Summary は、Obsidian プラグインと、自分のパソコンの Docker で動くバックエンドの二つでできています。バックエンドは起動スクリプトだけで用意でき、プログラミングは不要です。

**全体で約 10 分です。** バックエンドは出来上がったイメージ（約 550 MB）で、初回のダウンロードは通常 1〜5 分です。

## 4 つの手順

### 1. プラグインと Docker

- **プラグイン：** Obsidian の **設定 → コミュニティプラグイン → 閲覧** で **Video Summary** を検索し、インストールして有効にします。まだ見つからない場合は[最新リリース](https://github.com/Rexxall/obsidian-video-summary/releases/latest)の `main.js`、`manifest.json`、`styles.css` を `<保管庫>/.obsidian/plugins/video-summary/` に置きます。
- **Docker：** [Docker Desktop](https://www.docker.com/products/docker-desktop/)（Windows・macOS）または [OrbStack](https://orbstack.dev)（macOS）を入れて起動します。
- **キー：** OpenAI 互換の要約モデルのキー（既定は DeepSeek の `deepseek-flash`）。字幕のない動画を文字起こしするなら [SiliconFlow](https://cloud.siliconflow.cn/account/ak) のキーも（SenseVoice は無料）。

### 2. バックエンドをダウンロードして起動

[最新リリース](https://github.com/Rexxall/obsidian-video-summary/releases/latest)の `video-summary-backend-<バージョン>.zip` を、保管庫の外の消さない場所に展開します。macOS は `start-mac.command` を右クリック →「開く」、Windows は `start-windows.cmd` をダブルクリック、Linux は `./vs-backend.sh` です。

初回は二つのキーを聞かれます。貼り付けても画面には出ません。Enter を押してください（Enter だけで後回しにもできます）。

<img src="screenshots/install-1-keys.png" width="720" alt="起動スクリプトがモデルと文字起こしのキーを聞いている画面">

続いてイメージをダウンロードして起動し、最後に**接続コード**を表示してクリップボードにコピーします。バックエンドのパスワードにあたるので、人に渡さないでください。`./vs-backend.sh code` で再表示できます。

<img src="screenshots/install-2-code.png" width="720" alt="準備完了と接続コード（画像では隠してあります）">

### 3. コードを貼り付け、チェックし、試運転

Obsidian の **設定 → Video Summary → First-run setup** で、コードを貼り付け、**Full check**、**Trial run** の順に進めます。問題があれば直し方が表示されます。Bilibili ログインは任意です。

<img src="screenshots/install-3-check-en.png" width="720" alt="初期設定：接続コードを貼り付け、すべてのチェックが通った画面">

<img src="screenshots/install-4-trial-en.png" width="720" alt="試運転の成功">

### 4. 動画を要約する

サイドパネルの入力欄に動画のリンクを貼り、**Start** を押します。ノートは要約と要点から始まり、節ごとの整理とタイムスタンプ付きの文字起こしが続きます。

<img src="screenshots/install-5-note-en.jpg" width="860" alt="最初の動画ノート">

## 日常のコマンド

`./vs-backend.sh`（Windows は `.\vs-backend.ps1`）に何も付けないと起動（`.env` の変更もこれで反映）、ほかに `check`、`code`、`keys`、`logs`、`stop`、`update`（このバージョンのイメージを取り直す。取れなければ作り直す）があります。新しいバージョンにするときは、新しいバックエンドの zip を古いフォルダーに上書き展開し（`.env` は残ります）、`update` を実行します。

ダウンロードが遅い・できないときは、スクリプトが自動で手元のビルドに切り替えます（約 10 分）。

モデルを変えるときは `.env` の `VS_CHAT_BASE_URL`、`VS_CHAT_MODEL`、`VS_CHAT_API_KEY` を書き換え、起動スクリプトをもう一度実行します。バックエンドは `127.0.0.1` だけで待ち受けます。外部に公開する前に [backend/SECURITY.md](../backend/SECURITY.md) を読んでください。

どの手順で失敗したかは、接続コードのアドレス（既定は <http://127.0.0.1:5678>）をブラウザで開いて確認できます。初回は n8n のアカウントを作ります（このパソコンのバックエンドにだけ保存されます）。上部の **Executions** で最新の実行を開き、**AI: Write Note** の出力を見てください。モデルやキーのエラーでも実行は Success と表示されます。

<img src="screenshots/n8n-workflow.jpg" width="860" alt="n8n の Video Summary ワークフロー">
