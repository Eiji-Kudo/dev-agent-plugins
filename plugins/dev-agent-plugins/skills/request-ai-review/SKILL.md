---
name: request-ai-review
description: PRにCopilot / Codex / Gemini のAIレビューを一括で依頼する
allowed-tools: Bash(gh *)
---

現在のPR（または引数で指定したPR）に対して、GitHub Copilot / OpenAI Codex / Gemini Code Assist の3つのAIレビュアーへ一括でレビューリクエストを送る。

## 引数

`$ARGUMENTS`

- **指定あり**: PR番号（例: `123`）
- **未指定**: 現在のブランチに紐づくPRを `gh pr view` で取得

## 実行フロー

### 1. PR番号の特定

引数があればそれを使う。無ければ:

```bash
gh pr view --json number,headRefName,baseRefName,url
```

PRが見つからない場合はその旨を伝え終了。

### 2. Copilot を正式レビュアーに追加（review request）

PRの「Reviewers」欄にCopilotを正式なレビュアーとして登録する（GitHubの "Request review from..." と同じ動作）。実証済みの方法は **REST API 直叩き**:

```bash
gh api -X POST "repos/<owner>/<repo>/pulls/<PR番号>/requested_reviewers" \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

- `<owner>/<repo>` はカレントリポジトリから判別する。`gh repo view --json nameWithOwner --jq .nameWithOwner` で取得可能。
- `[bot]` suffix を含めること。これがないと 422 "Reviews may only be requested from collaborators" になる。
- ローカルの認証済み `gh`（ユーザー PAT）から呼ぶ前提。GitHub Actions の `GITHUB_TOKEN` から呼ぶと HTTP success が返るのに reviewer が追加されない silent failure になるため、本 skill のような対話的・手動実行で使う。
- 既に request 済みの場合は HTTP 422 が返るが、致命的ではないので結果報告に「既に追加済み」と出して継続する。

参考: 動かない経路（採用しないこと）
- `gh pr edit <PR番号> --add-reviewer @copilot` は exit 0 で PR URL を出すが silent no-op になることがある。
- `gh pr edit <PR番号> --add-reviewer copilot-pull-request-reviewer`（`[bot]` 抜き）は 422。

### 3. Codex にレビュー依頼コメント投稿

```bash
gh pr comment <PR番号> --body "@codex review"
```

### 4. Gemini Code Assist の利用可否を判定してから依頼

Gemini Code Assist の GitHub App がリポジトリにインストールされていない組織では `/gemini review` コメントを投げても無反応・無意味なノイズになるため、**事前に利用可否を判定**してから依頼する。

#### 4.1. 利用可否の判定

以下のいずれかで Gemini App の存在を確認する（順に試し、どれかで確認できればOK）:

1. PR上に過去 `gemini-code-assist[bot]` のレビュー or コメントが存在するか確認:
   ```bash
   gh api "repos/{owner}/{repo}/issues/<PR番号>/comments" --jq '[.[] | select(.user.login | test("gemini-code-assist"; "i"))] | length'
   gh api "repos/{owner}/{repo}/pulls/<PR番号>/reviews" --jq '[.[] | select(.user.login | test("gemini-code-assist"; "i"))] | length'
   ```
2. リポジトリにインストール済みのGitHub Appsを確認:
   ```bash
   gh api "repos/{owner}/{repo}/installation" 2>/dev/null
   ```
   または同リポジトリ内の他PR（最近のもの数件）で `gemini-code-assist[bot]` の活動があるかを確認:
   ```bash
   gh pr list --state all --limit 10 --json number --jq '.[].number' | while read n; do
     gh api "repos/{owner}/{repo}/issues/${n}/comments" --jq '.[].user.login' 2>/dev/null
   done | grep -i 'gemini-code-assist' | head -1
   ```

過去活動が1件でも見つかれば「利用可能」と判定する。1件も見つからなければ「未導入」と判定する。

#### 4.2. 依頼 or スキップ

- **利用可能と判定**: コメントを投稿する
  ```bash
  gh pr comment <PR番号> --body "/gemini review"
  ```
- **未導入と判定**: コメントを投稿せずスキップし、結果報告に「未導入のためスキップ」と明示する

判定が不確実な場合（API 権限不足等）は、**スキップ側に倒す**（無駄なコメントを残さない方針）。

### 5. 結果報告

各レビュアーごとに依頼の成否を1行で報告し、最後にPR URLを出す:

```
- Copilot: 追加済み / 既に追加済み / 失敗
- Codex: コメント投稿済み（URL）
- Gemini: コメント投稿済み（URL） / 未導入のためスキップ / 判定不能のためスキップ

PR: <PR URL>
```

## 制約

- コードの変更は一切行わない
- PR description の変更は行わない
- 3つのうち一部だけ依頼する場合はこのコマンドを使わず、個別に `gh` を呼ぶこと（このコマンドは常に3つすべて試行する。Gemini未導入のスキップは「試行した結果」として扱う）
- 失敗したものがあっても他のレビュアーへの依頼は続行する（途中で止めない）
- Gemini が未導入の組織で誤って `/gemini review` を残さない（無反応で混乱の元になるため）
