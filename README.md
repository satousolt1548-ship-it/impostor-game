# AIアートインポスター 本番形サーバー

依存なしの Node.js アプリ（Node 18+）。ルーム管理・フェーズの自律駆動・Floyo API 実生成・投票/得点までを1ファイル（server.mjs）で実装。フロントは public/index.html。

## ローカル起動

```bash
FLOYO_API_KEY=<キー> PORT=3000 node server.mjs
```

## デプロイ（Render 無料枠の例）

1. このフォルダを GitHub リポジトリに入れる（server.mjs / workflow.json / package.json / public/）。
2. Render にサインアップ（Google/GitHub ログイン可）→ New > Web Service → リポジトリを接続。
3. 設定：Build Command は空（依存なし）、Start Command は `node server.mjs`、Instance Type は Free。
4. Environment Variables に `FLOYO_API_KEY` を追加（キーはここにだけ置く。コードやリポジトリには入れない）。
   - 注意：現在テストで使っているキーはチャットに一度出たもの。本番では Floyo で新しいキーを発行し直し、古いキーを削除してから登録するのが安全。
5. デプロイ完了後、発行された URL（https://xxxx.onrender.com）を友達に共有。参加は「合言葉」だけ、ログイン不要。
6. 無料枠の注意：Render の無料 Web Service は無操作でスリープし、再起動に30〜60秒かかる。遊ぶ前にホストが一度開いて起こしておくとスムーズ。

## 仕様メモ

- 合言葉ルーム（5文字）、3〜6人想定（ダミー2人の同梱も可）。
- 進行：ロビー → 指示文（90秒、時間切れは自動の指示文で補充）→ 生成（Floyo、並行実行）→ 投票（60秒）→ 公開 → 次ラウンド or 最終順位。
- 得点：インポスター的中で投票者 +2、逃げ切りでインポスター +3。
- 生成ワークフローは workflow.json（Z-Image Turbo、8ステップ、1024×1024）。プロンプトには英字の画風サフィックスを自動付加。
- ルームはメモリ保持のため、サーバー再起動で消える（パーティ用途として許容）。
