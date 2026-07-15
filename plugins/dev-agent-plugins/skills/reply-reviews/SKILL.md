---
name: reply-reviews
description: PRレビューコメントへの返信
---
PRの未解決レビューコメントに返信する。

## 引数

`$ARGUMENTS`

- **指定あり**: その値をPR番号として使用する
- **未指定**: `gh pr view` で現在のブランチに紐づくPRを自動取得する

## 実行フロー

### 1. PR情報の取得

```bash
gh pr view [PR番号] --json number
```

PRが見つからない場合はその旨を伝え、処理を終了する。

### 2. 分析ドキュメントの確認

`documents/review-decisions-pr-{PR番号}.md` が存在するか確認する。

- **存在する場合**: ドキュメントから各コメントの「返信案」を読み取る
- **存在しない場合**: 先に `/review-comment-analysis` を実行するよう案内して終了

### 3. 未解決レビューコメントの取得

GitHub REST APIを使用して未解決コメントを取得する。

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

### 4. 返信の投稿

分析ドキュメントの「返信案」に基づき、各未解決スレッドに返信する。

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments \
  -X POST \
  -f body="返信内容" \
  -F in_reply_to={comment_id}
```

**注意**:
- 対応済み（✅マーク付き）の返信案はそのまま投稿
- CAN_IGNOREの返信案もそのまま投稿
- 既に返信済みのスレッドはスキップ
- 相手がAI reviewerの場合は敬語を使わず、PR descriptionのようなメモ調で返信する
- 相手がAI reviewerの場合、返信本文の先頭は必ず `対応済み:` / `対応不要:` / `一部対応:` のいずれかにする。分析ドキュメントの返信案がこの形式でない場合は、投稿前に意味を変えずに文体と先頭ステータスだけ補正する

### 5. スレッドのResolve

- **相手がAI reviewer（bot）の場合**: 返信後、該当スレッドをresolvedにする。
- **相手が人間のレビュアーの場合**: resolveしない。レビュアー本人が確認してresolveするのを待つ。

```bash
gh api graphql -f query='
  mutation {
    resolveReviewThread(input: {threadId: "{thread_node_id}"}) {
      thread {
        isResolved
      }
    }
  }
'
```

`thread_node_id` はステップ3で取得したコメントの `node_id` から対応するスレッドIDを特定する。

### 6. 結果報告

投稿した返信の一覧を表示する。

| スレッド | 返信内容 |
|---------|---------|
| ファイル:行番号 | 返信内容（省略） |

## 制約事項

- 分析ドキュメントが存在しない場合は返信しない
- 返信内容は分析ドキュメントの「返信案」をそのまま使用する。ただしAI reviewer宛てで先頭ステータスや文体が不適切な場合は、意味を変えずに `対応済み:` / `対応不要:` / `一部対応:` で始まるメモ調へ補正してから投稿する
- 既に返信があるスレッドには二重投稿しない
