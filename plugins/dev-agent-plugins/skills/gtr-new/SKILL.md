---
name: gtr-new
description: gtr CLIでissue/PR対応のworktreeを作成し、実装・PR作成・レビュー修正まで一気通貫で行う（PR入力時は既存ブランチをチェックアウトしてrefineから続行）
# CROSS-TOOL-REVIEW-OFF: 再有効化時は allowed-tools に Bash(codex exec:*) と Bash(claude:*) を戻す。
allowed-tools: Bash(git gtr:*), Bash(gh issue:*), Bash(gh pr:*), Bash(git fetch:*), Bash(git log:*), Bash(git push:*), Bash(git -C:*), Bash(git add:*), Bash(git commit:*), Bash(git diff:*), Bash(printenv:*), Agent
---

# gtr: issue → worktree → 実装 → PR → refine

引数（$ARGUMENTS）からissue情報を取得し、以下を一貫して行う:
1. worktree作成
2. issue内容に基づくコード実装
3. コミット・push・draft PR作成
4. critics reviewerによるレビュー＆修正ループ（loop-critics-fix）

## 実行ルール

- このコマンドは **フェーズ1〜12をすべて完了して初めて完了扱い** とする（フェーズ12はバックグラウンドサブエージェントの起動完了をもって完了とする）
- 実行開始時に、以下のチェックリストを内部で作成して管理すること:
  - フェーズ1: セットアップ
  - フェーズ2: 実装
  - フェーズ3: PR作成
  - フェーズ4: refine（loop-critics-fix）
  - フェーズ5: 自動テスト追加（pr-test）
  - フェーズ6: CI チェック
  - フェーズ7: PR description更新
  - フェーズ8: Ready for Review
  - フェーズ9: AIレビュー依頼（request-ai-review）
  - フェーズ10: PR解説md作成（pr-explain）
  - フェーズ11: critics review の要約（summarize-resolved）
  - フェーズ12: AIレビュー出揃い監視 → review-comment-analysis 自動実行
- 中間報告では、**完了したフェーズ番号** と **未完了フェーズ番号** を明示すること
- フェーズ3（PR作成）完了時点では、**絶対に完了報告しない**。その時点は「中間報告」であり、必ず refine 以降へ進むこと
- `loop-critics-fix`、`pr-test`、`CI チェック`、`PR description更新`、`Ready for Review`、`request-ai-review`、`pr-explain`、`summarize-resolved` は省略不可。未実施のまま「完了」「done」「Ready for Review」と報告してはいけない
- 途中で中断・保留する場合は、「最後に完了したフェーズ」と「残っている必須フェーズ」を明示して終了すること

## フォローアップ issue の取り扱い（全フェーズ横断・必須）

### follow-up issue 作成ゲート（オーバーエンジニアリング防止）

このフローの途中で follow-up issue を作る前に、必ず `../followup-issue-gate/SKILL.md` を Read し、その作成条件・本文ルールに従うこと。条件を満たさないものは issue 化しない。

このフローの**どのフェーズでも follow-up issue を新規作成したら**（critics の「対応不要→別 issue」、型安全性/ドリフト検知の issue 化、review-comment-analysis 由来の別 issue 等）、その issue を以下の **3 つの成果物すべてに必ず明記**すること。記載漏れは完了扱いにしない。

1. **PR description**（フェーズ7 で更新）: 「フォローアップ issue」セクションに `#<番号> <タイトル>`（`https://github.com/<owner>/<repo>/issues/<番号>` のリンク付き）を列挙する。
2. **PR 解説 md**（フェーズ10 の pr-explain）: クリックで遷移できる Markdown リンク `[#<番号> <タイトル>](<issue URL>)` を専用セクションに書く。
3. **critics review md**（フェーズ4 の critics-reviewer / loop-critics-fix が書く `documents/critics-review-pr-<番号>*.md`）: 当該懸念点（多くは「対応不要」）に、クリックできる Markdown リンク `[#<番号>](<issue URL>)` を併記する。

- フォローアップ issue が **0 件なら**各成果物に「フォローアップ issue: なし」と明記する（セクション自体を省略しない）。
- issue は **URL（フルパス）でリンク**し、`#<番号>` だけのプレーンテキストで終わらせない（md は必ずクリックで遷移可能にする）。
- フェーズ12（review-comment-analysis）など **PR description / pr-explain md 確定後**に issue を作った場合は、**当該成果物へ戻って追記し commit/push** すること（「後から作った issue ほど記載漏れしやすい」ため特に注意）。
- 最終報告の「派生 issue」欄と上記 3 成果物の記載が一致していることを確認する。

## 入力パターン

$ARGUMENTS は以下のいずれか:
- GitHub PR URL（例: `https://github.com/owner/repo/pull/123`）
- PR番号に `pr` プレフィックス（例: `pr123`, `pr#123`）
- GitHub issue URL（例: `https://github.com/owner/repo/issues/78`）
- issue番号（例: `78`, `#78`）
- ブランチ名（例: `feat/my-feature`）
- **空（引数なし）**: 直前までの会話文脈からブランチ名を生成して進める。**issue は勝手に作らない**（ユーザーが明示的に依頼した場合のみ作成）

**PR入力の場合**: 既存PRのブランチをworktreeにチェックアウトし、フェーズ2（実装）・フェーズ3（PR作成）をスキップしてフェーズ4（refine）から続行する。

**引数なしの場合**: 直前のセッションでの作業文脈（ファイル変更・議論内容）からブランチ名を自動生成する。命名規則: `<prefix>/<descriptive-slug>`（例: `feat/podcast-gen-cli-line-preview`）。issue 紐付け無しで進む。途中で「issue 番号教えて」「issue 作る?」とユーザーに確認しない。

## フェーズ1: セットアップ

### 1. 入力の解析

- **PR URL or PR番号の場合**:
  1. `gh pr view <number> --json number,title,body,headRefName,baseRefName,state` でPR情報を取得
  2. ブランチ名: PRの `headRefName` をそのまま使用
  3. ベースブランチ: PRの `baseRefName` を使用（ユーザー確認不要）
  4. → フェーズ2・フェーズ3はスキップ（既にPRが存在するため）
- **issue URL or 番号の場合**:
  1. `gh issue view <number> --json number,title,body,labels` でissue情報を取得
  2. ブランチ名を生成: `<prefix>/<number>-<title-slug>`
     - プレフィックスはissueの内容・ラベルから判断: `feat/`（新機能）, `fix/`（バグ修正）, `refactor/`（リファクタリング）, `chore/`（雑務）等
     - title-slugはタイトルから英数字・ハイフンのみ、全体で50文字以内
- **ブランチ名の場合**: そのまま使用（issue情報なしで進む）
- **引数なしの場合**: 直前の会話文脈からブランチ名を生成（例: `feat/<descriptive-slug>`）。issue は作らず、ベースブランチは `origin/main` を自動使用する（確認待ちはしない）

### 2. ベースブランチの決定

- **PR入力の場合**: PRの `baseRefName` を自動使用
- **stack PR の場合**（$ARGUMENTS または直前の会話に「stack pr」「stacked」「スタック」「(ブランチを)積む」等の指示がある場合）: `origin/main` ではなく、**この作業が積み重なる関連ブランチ**を自動探索してベースにする（→ 後述「stack PR のベース探索」）。**確認待ちはしない**
- **それ以外**: デフォルトの `origin/main` を自動使用する。**ユーザーへの確認待ちはしない**。別ベースは $ARGUMENTS でベースブランチが明示的に指定されている場合のみ、それを使う

#### stack PR のベース探索

この新規作業が「どの既存ブランチ/PRの上に積まれるか（親ブランチ）」を、以下の優先順で特定する:

1. $ARGUMENTS または会話文脈で親ブランチ・親PRが明示されていれば、それを使う
2. 明示がなければ、自分のオープンPRを取得して関連度の高いブランチを推定する:
   ```bash
   gh pr list --state open --author @me --json number,title,headRefName,baseRefName,updatedAt
   ```
   - ベースリポジトリで現在チェックアウト中のブランチ（`git -C <base-repo> rev-parse --abbrev-ref HEAD`、default branch でなければ有力候補）
   - 会話のトピック・対象ファイル・関連 issue との一致度
   - 最終更新（`updatedAt`）の新しさ
   を突き合わせ、最も関連の深いブランチを親候補とする
3. **候補が複数あって一意に絞れない場合も、最有力の1本を自動採用する**（候補一覧の提示やユーザー確認はしない）。どれを選んだか・他の候補は中間報告に記載する
4. 親候補が1つも見つからない場合のみ `origin/main` にフォールバックし、その旨を中間報告に記載する

stack PR モードでは、特定した親ブランチを **worktree の `--from`** と **フェーズ3のPR作成時の `--base`** の両方に使う。

### 3. worktree作成

- **PR入力の場合**: リモートブランチをfetchしてからworktreeを作成:
  ```bash
  git fetch origin <headRefName>
  git gtr new <headRefName> --from origin/<headRefName>
  ```
- **stack PR の場合**: 特定した親ブランチをfetchしてからベースに使う:
  ```bash
  git fetch origin <親ブランチ>
  git gtr new <branch-name> --from origin/<親ブランチ>
  ```
- **それ以外**:
  ```bash
  git gtr new <branch-name> --from <base>
  ```

`git gtr list` で既存のworktreeと被らないか事前確認する。同名が既に存在する場合はユーザーに確認。

## フェーズ2: 実装

> **PR入力の場合はスキップ**（既にPRにコードが存在するため）

### 4. issue内容の分析と実装

worktreeディレクトリに移動し、issue内容に基づいてコード実装を行う:

1. issue本文、ラベル、関連コードを分析して実装方針を把握する
2. プロジェクトのCLAUDE.md、AGENTS.md等のガイドラインを読んで遵守する
3. コードを実装する
4. 実装完了後、変更をコミットする:
   ```bash
   git -C <worktree-path> add <修正ファイル>
   git -C <worktree-path> commit -m "<修正内容を反映したメッセージ>"
   ```

## フェーズ3: PR作成

> **PR入力の場合はスキップ**（既にPRが存在するため。PR番号はフェーズ1で取得済み）

### 5. push & draft PR作成

1. リモートにpush:
   ```bash
   git -C <worktree-path> push -u origin <branch-name>
   ```
2. draft PRを作成:
   ```bash
   gh pr create --draft --title "<PRタイトル>" --body "$(cat <<'EOF'
   ## Summary
   <変更内容の要約>

   Closes #<number>
   EOF
   )" --head <branch-name>
   ```
   - issue番号がある場合、本文に `Closes #<number>` を含める
   - PRタイトルはissueタイトルを元に生成
   - **stack PR の場合**: `--base <親ブランチ>` を付けて、PRのベースを親ブランチに向ける（origin/main 向けにしない）

### 6. 中間報告

セットアップ完了時点で以下を報告:
- worktreeのパス
- ブランチ名
- PR URL（PR入力の場合は既存PR URL）
- これからrefineフェーズに入る旨
- 進捗状況（例: `完了: フェーズ1-3 / 残り: フェーズ4-12`、PR入力の場合: `完了: フェーズ1（2-3スキップ） / 残り: フェーズ4-12`）

## フェーズ4: refine（loop-critics-fix）— クロスツール委譲は現在オフ

<!-- CROSS-TOOL-REVIEW-OFF: `codex exec` / `claude -p` による2巡目は現在オフ。
     再有効化するときは、frontmatter の Bash(codex exec:*) と Bash(claude:*)、4.2 の委譲先、
     4.3 の完了条件、最終報告の refine 記載を元に戻す。 -->

このフェーズは、起動元にかかわらず **現在のセッション自身による loop-critics-fix（1巡目）のみ**を実行する。Claude Code 起点の `codex exec` と Codex 起点の `claude -p` はどちらも起動しない。

1巡目のループ管理・オーケストレーションは、現在の起動元セッションが行う。2巡目のクロスツール・オーケストレーションはトグルオフ中のため行わない。

PR番号は フェーズ3 で作成したPRの番号、またはPR入力の場合はフェーズ1で取得したPR番号を使用する（以降 `{PR番号}`）。以下のコマンドはすべて **worktreeディレクトリ**（フェーズ1で作成したパス）から実行する。

### 4.0. 起動元ツールの判定

`printenv CLAUDECODE` を実行して起動元を判定する:

- 出力が `1`（値あり） → **claude code 起点**
- 出力が空（未設定・終了コード非0） → **codex 起点**

クロスツール委譲は現在オフのため、起動元の判定結果にかかわらず4.2の2巡目は行わない。

### 4.1. 起動元ツール自身での loop-critics-fix（1巡目）

起動元がどちらでも、まず**いま動いているこのセッション自身で** `../loop-critics-fix/SKILL.md` を Read で読み込み、その手順に従ってレビュー＆修正ループを実行する。新規発見が0件で収束するまで回す。

### 4.2. もう一方のツールへ「小さなリーフ」で段階委譲（2巡目、親がオーケストレーション）

> **【クロスツール委譲オフ】** このセクションの2巡目はすべてスキップする。`codex exec`、`claude -p`、軽量プローブのいずれも実行しない。4.1が未対応0件・新規発見0件で収束していることを確認して4.3へ進む。

<!-- CROSS-TOOL-REVIEW-OFF: 以下は再有効化時のために保持している手順。

1巡目が収束したら、**親（このセッション）が critics-reviewer のパイプラインをオーケストレーションし**、その各並列フェーズを **Agent tool の代わりに「もう一方のツール」への小さなリーフ呼び出し**に置き換えて実行する。リードの職務（レビュワー構成の決定・統合・doc執筆・収束判定）は親が担う。

委譲先コマンド `OTHER` は起動元判定（4.0）で決める:

- **claude code 起点** → `OTHER` = `codex exec --dangerously-bypass-approvals-and-sandbox -C <worktree-path> "<prompt>"`
  - `--dangerously-bypass-approvals-and-sandbox` は **fix段階の**コミット・push（ネットワーク）を承認待ちなしで通すため（`workspace-write` のみだと push が通らない）。critics のリーフは読み取り＋一時ファイル書き込みのみ。
- **codex 起点** → `OTHER` = `claude -p --model opus "<prompt>"`

codex 起点で `OTHER = claude -p --model opus "<prompt>"` になる場合は、2巡目のリーフ委譲を始める前に以下の軽量プローブを実行する:

```bash
claude -p --model opus --output-format json "Return only OK."
```

プローブ出力に `type: "rate_limit_event"` かつ `rate_limit_info.status: "rejected"` かつ `rate_limit_info.rateLimitType: "five_hour"` が含まれる場合、Claude Code の5時間上限に到達していて `claude -p` が利用できないため、2巡目（もう一方のツールでの `claude -p` 評価）は一時的にスキップしてよい。この場合、フェーズ4は1巡目（起動元ツール）の `loop-critics-fix` が未対応0件・新規発見0件で収束していることを確認して完了扱いにする。最終報告の `refine` には `claude -p skipped: five_hour rate limit` と、取得できた場合は `resetsAt` の時刻を必ず含める。

**codex business 起点（4.0参照）の場合は、上記プローブ自体を実行せず 2巡目を最初からスキップする。** フェーズ4は1巡目（起動元ツール）の `loop-critics-fix` が未対応0件・新規発見0件で収束していることを確認して完了扱いにする。最終報告の `refine` には `claude -p skipped: codex business profile` と明記する。

#### リーフ委譲の共通ルール

- **並列起動**: 同一フェーズのリーフは **1つのシェル実行内で `&` を付けて一括起動し、`wait` で全完了を待つ**。逐次に1本ずつ呼ばない。
- **結果は一時ファイルに書かせる**: 各リーフは結果を **指定の一時ファイル** に自分で書く（親は stdout を当てにしない）。一時ファイルは worktree 直下の `pr-{PR番号}-critics-tmp/` に置く。
- **各リーフプロンプトは自己完結させる**: PR番号・diffファイルのパス（`pr-{PR番号}-diff.txt`）・担当範囲・出力先パス・参照すべき context ファイルを必ず含める。
- **各リーフへの厳守事項を明記する**: 「**サブエージェント/Agent を起動しない・コードを修正しない・critics doc 本体を書かない・担当の一時ファイル1つだけを書く**」。これにより子は単機能・短時間・境界明確になる。

#### critics パイプライン（親がオーケストレーション。各フェーズ内は並列リーフ、フェーズ間はバリア）

親はまず `../critics-reviewer/SKILL.md` を Read し、その各フェーズの「内容」を踏襲する。ただし並列処理は Agent tool ではなく `OTHER` リーフで行う。

**A. 親の前処理（委譲なし・その場で実施）**: `pr-{PR番号}-critics-tmp/` を作成。`gh pr diff {PR番号}` を `pr-{PR番号}-diff.txt` に保存。既存 critics doc（`documents/critics-review-pr-{PR番号}*.md`）を読み込み、前回の対応済み/対応不要リストを把握。ガイドライン（CLAUDE.md / AGENTS.md 等）を収集。diff からレビュワー構成（M ドメイン）とコンテキスト収集領域を決定する。

**B. コンテキスト収集（並列リーフ）**: 領域ごとに `OTHER` リーフを一括起動。各リーフは担当領域の周辺コード（依存・呼び出し元・関連テスト・既存パターン）を調査し `pr-{PR番号}-critics-tmp/context-{area}.md` に簡潔にまとめる。→ `wait` → 親が全 context を読む。

**C. レビュー（並列リーフ）**: ドメインごとに `OTHER` リーフを一括起動。各リーフは diff＋該当ソース＋関連 context を読み、**自領域の懸念のみ**を `pr-{PR番号}-critics-tmp/review-{domain}.md` に出力（重要度 CRITICAL/HIGH/MEDIUM・file:line・問題点・該当コード・推奨対応、ultrathink で深く）。既存 doc の対応済み/対応不要（親がプロンプトに列挙して渡す）は再指摘しない。→ `wait` → 親が全 review を読む。

**D. 相互検証（並列リーフ）**: 検証観点ごと（矛盾検出 / 重複検出 / 確信度検証 / コード照合）に `OTHER` リーフを一括起動。各リーフは全 findings 一覧を受け取り、担当観点で検証して `pr-{PR番号}-critics-tmp/verify-{angle}.md` に判定を書く（必要ならソース直読）。→ `wait` → 親が統合（重複マージ・矛盾解決・確信度の採否・重要度順）。

**E. 解説充実（並列リーフ）**: 確定した懸念点をグループに分割し、グループごとに `OTHER` リーフを一括起動。各リーフは担当懸念点の「問題点」「推奨対応」を具体化（そのまま適用できるコードスニペット付き）して `pr-{PR番号}-critics-tmp/enrich-{group}.md` に書く。懸念点の追加/削除/重要度変更はしない。→ `wait` → 親が doc に反映。

**F. doc 執筆（親・委譲なし）**: 親が critics-reviewer.md の出力フォーマット・既存 doc 保持ルールに従って `documents/critics-review-pr-{PR番号}*.md` を更新する。完了後、`pr-{PR番号}-diff.txt` と `pr-{PR番号}-critics-tmp/` を削除する。

#### ループ（親が制御、最大5イテレーション）

各イテレーションで以下を順に行う:

1. **critics パイプライン実行**: 上記 A〜F を実行する（各並列フェーズは小さなリーフを `OTHER` で一括起動し `wait`）。
2. **親が収束判定**: 親が `documents/critics-review-pr-{PR番号}*.md` を Read し、「未対応の懸念点」セクションを確認する。
   - 未対応が0件、かつ前イテレーションから**新規発見なし** → ループ終了（4.3 へ）
   - 未対応が残っている → ステップ3へ
3. **fix を委譲（修正・1パス）**: `OTHER` に次の `<prompt>` を渡して実行させる。
   > `../loop-critics-fix/SKILL.md` のステップ2（未対応懸念点の修正 → 対応済みに更新 → コミット → push）の手順に従って、PR #{PR番号} の critics-review doc の未対応懸念点を**1巡だけ**修正・コミット・pushして。**再レビューやループはしない**（ループは親が管理する）。Skill tool は使わず手順を直接実行すること。
4. ステップ1に戻る。

最大イテレーション（5回）到達、または収束（未対応0件かつ新規発見なし）で 4.2 を終了する。委譲先ツール名・各イテレーションのレビュー件数/修正件数/起動したリーフ数を親が記録する。
-->

### 4.3. フェーズ4の完了条件

- 起動元セッション自身による1巡目が、最終的に**未対応の懸念点0件・新規発見0件**で収束していること
- `codex exec` / `claude -p` の2巡目は実行せず、最終報告の `refine` に `cross-tool review skipped: toggle off` と明記すること

これらを満たして初めてフェーズ4完了とする。1巡目のイテレーション数・修正件数・新規発見件数を最終報告に含める。

## フェーズ5: 自動テスト追加（pr-test）

`../pr-test/SKILL.md` を Read で読み込み、その手順に従って PR に必要な自動テストの洗い出し・実装・検証ループを実行する。

PR番号は フェーズ3 で作成したPR、またはPR入力の場合はフェーズ1で取得したPR番号を使用する。

- ユーザー承認は待たず、未カバー項目はすべて実装する
- 実装したテストは pr-test の手順に従ってコミット・push する
- 設計md（`documents/test-design-pr-{PR番号}.md`）と報告md（`documents/test-implementation-report-pr-{PR番号}.md`）の生成・更新も pr-test の手順に従う
- 新規発見が0件、未実装テスト項目が0件になった時点でフェーズ完了とする（最大10イテレーションで打ち切り）

## フェーズ6: CI チェック

`../ci/SKILL.md` を Read で読み込み、その手順に従ってCI チェック（lint, type check, test）を実行する。

問題があれば修正し、コミット・pushする。すべてのチェックがパスするまで繰り返す。

## フェーズ7: PR description更新

`../pr-description/SKILL.md` を Read で読み込み、その手順に従ってPR descriptionを生成・更新する。

CI結果や最終的な差分を反映した状態で実行し、PR本文・タイトル・動作確認チェックリストを最新化する。追加した自動テスト（フェーズ5）の内容も description に反映する。

## フェーズ8: Ready for Review

全チェック通過後、PRのdraftを外す:

```bash
gh pr ready <PR番号>
```

## フェーズ9: AIレビュー依頼（request-ai-review）

<!-- COPILOT-REVIEW-OFF: Copilot へのレビュー依頼は現在オフ（コメントアウト中）。
     再有効化するときは、この注記ブロックと下記 ">【Copilot オフ】" の引用、
     フェーズ12のCopilot注記、最終報告の取り消し線を元に戻す。 -->

> **【Copilot オフ】** request-ai-review の手順を実行する際、**Copilot へのレビュー依頼はスキップ**し、**Codex / Gemini のみ**に依頼する。Copilot を「依頼済みレビュアー」に含めないこと（→ フェーズ12の監視対象からも自動的に外れる）。

`../request-ai-review/SKILL.md` を Read で読み込み、その手順に従って <!-- Copilot / -->Codex / Gemini に一括でレビュー依頼を送る。

PR番号は フェーズ3 で作成したPR、またはPR入力の場合はフェーズ1で取得したPR番号を使用する。

各レビュアーへの依頼結果（成功・既存・失敗）を確認し、最終報告に含める。

## フェーズ10: PR解説md作成（pr-explain）

`../pr-explain/SKILL.md` を Read で読み込み、その手順に従ってPR解説md（mermaid図含む）を作成する。

PR番号は フェーズ3 で作成したPR、またはPR入力の場合はフェーズ1で取得したPR番号を使用する。最新のCI結果・PR descriptionが反映された状態で実行する。

作成後、解説mdをコミット・pushしてPRに含める:

```bash
git -C <worktree-path> add <解説mdのパス>
git -C <worktree-path> commit -m "docs: add PR explanation"
git -C <worktree-path> push
```

## フェーズ11: critics review の要約（summarize-resolved）

`../summarize-resolved/SKILL.md` を Read で読み込み、その手順に従って critics review ファイル（`documents/critics-review-pr-{PR番号}*.md` 等）を要約・整理する。

PR番号は フェーズ3 で作成したPR、またはPR入力の場合はフェーズ1で取得したPR番号を使用する。

要約後、変更をコミット・push する:

```bash
git -C <worktree-path> add <要約した critics ファイルのパス>
git -C <worktree-path> commit -m "docs: summarize critics review"
git -C <worktree-path> push
```

要約対象ファイルが見つからない場合（critics ファイルが存在しない等）はスキップし、その旨を最終報告に含める。

## フェーズ12: AIレビュー出揃い監視 → review-comment-analysis 自動実行

実行環境のバックグラウンドサブエージェントを起動し、Copilot / Codex / Gemini の3つのレビューが揃った時点で `review-comment-analysis` を自動実行させる。

### 12.1. 監視サブエージェントの起動

Claude Codeではbackground Agent、Codex CLIではcollaboration sub-agentなど、実行環境が提供する非同期サブエージェントを起動する。プロンプトは以下の内容を含めて自己完結させる:

```
PR #<PR番号> の AIレビュー出揃いを監視し、3つすべて揃った時点（または30分タイムアウト時点）で `/review-comment-analysis <PR番号>` 相当の処理を実行するタスク。

## 監視対象（出揃ったかの判定）

フェーズ9で「依頼を実際に送ったレビュアー」のみを監視対象とする（Gemini未導入でスキップした場合はGeminiは監視しない。**Copilot は現在オフのため依頼せず、監視対象にも含めない**）。各レビュアーがPRにレビュー or コメントを投稿済みかをポーリングで確認する:

<!-- COPILOT-REVIEW-OFF: 1. **Copilot**: `gh api repos/{owner}/{repo}/pulls/<PR番号>/reviews` の中に `user.login == "copilot-pull-request-reviewer[bot]"` または login に `copilot` を含むレビューがあるか -->
2. **Codex**: `gh api repos/{owner}/{repo}/issues/<PR番号>/comments` または reviews の中に `chatgpt-codex-connector` 系のbotコメント／レビューがあるか
3. **Gemini**（依頼した場合のみ）: 同上で `gemini-code-assist[bot]` のレビュー or コメントがあるか

`gh pr view <PR番号> --json reviews,comments,latestReviews` を活用してもよい。

依頼したレビュアーがすべて揃った時点で次へ進む（Geminiをスキップした場合はCopilot+Codexの2つで揃い扱い）。

## ポーリング

- 間隔: 約3分（180秒）
- タイムアウト: 30分（10回ポーリング）
- 各ポーリングで揃ったレビュアーを記録し、3つすべて揃ったら次へ進む
- タイムアウト時点で揃っていなくても、その時点で次に進む（揃わなかったレビュアーは記録）

## 揃った後の処理

`../review-comment-analysis/SKILL.md` を Read で読み込み、その手順に従って PR #<PR番号> に対する分析を実行する。

その際、Skillツールは使わずに review-comment-analysis.md の手順を直接実行すること。

## follow-up issue 作成ゲート（オーバーエンジニアリング防止）

review-comment-analysis 中に follow-up issue を作る前に、必ず `../followup-issue-gate/SKILL.md` を Read し、その作成条件・本文ルールに従うこと。条件を満たさないものは issue 化しない。

## フォローアップ issue の明記（必須）

この分析中に follow-up issue を新規作成した場合、その issue を以下の 3 つの成果物すべてに **クリックで遷移できる Markdown リンク** `[#<番号> <タイトル>](https://github.com/<owner>/<repo>/issues/<番号>)` で追記し、commit/push すること（`#<番号>` だけのプレーンテキストにしない）:

1. PR description の「フォローアップ issue」セクション（`gh pr edit` で更新）
2. PR 解説 md（`documents/**/pr-<PR番号>-*.md`）の「フォローアップ issue」セクション
3. critics review md（`documents/critics-review-pr-<PR番号>*.md`）の該当懸念点

これらは review-comment-analysis 実行時点で既に確定済みだが、**後から作った issue ほど記載漏れしやすい**ため、必ず戻って追記する。最終報告に「作成した follow-up issue と 3 成果物への反映状況」を含める。

## 制約

- このサブエージェントは独立して動作する。親セッションには結果を文字列で返すだけで、他のステートは持たない
- 監視中は他のことをしない
- 揃ったレビュアー、タイムアウト有無、最終的に review-comment-analysis を実行したかどうかを最終報告に含める
```

### 12.2. 起動完了の確認

サブエージェントがバックグラウンドで起動されたことを確認したら、フェーズ12は完了とする。実行結果を待つ必要はない。

## 最終報告

**フェーズ1〜12をすべて実行し、各フェーズの完了を確認した後にのみ** 以下を表示:

```
## gtr-new 完了

- **issue**: #<number> <title>
- **worktree**: <path>
- **ブランチ**: <branch-name>
- **PR**: <PR URL> (Ready for Review)
- **refine**: 起動元セッション自身による1巡目のイテレーション数・修正件数・新規発見件数（0件であること）。`cross-tool review skipped: toggle off` と明記
- **new findings**: 0件
- **pr-test**: N回のイテレーション、X件のテストを追加（設計md・報告mdのパス）
- **CI**: all passed
- **PR解説md**: <docs配下のパス>
- **critics 要約**: 要約済み / スキップ（理由）
- **フォローアップ issue**: #<番号> <タイトル>（URL） … / なし。※PR description・PR解説md・critics md の 3 成果物すべてにクリック可能リンクで反映済みであることを併記
- **AIレビュー依頼**: ~~Copilot（オフ）~~ / Codex / Gemini （各成否）
- **AIレビュー監視サブエージェント**: 起動済み（バックグラウンド）／ 揃い次第 review-comment-analysis を自動実行
- **次のステップ**:
  - `git gtr ai <branch-name>` でClaude Code起動
  - `git gtr editor <branch-name>` でエディタ起動
```

- `gtr-new 完了` を出す条件として、`loop-critics-fix` の最終結果で **新規懸念点が 0 件** であることを確認すること
- `new findings` は必須項目。0件でない場合は `完了` を出してはいけない

## 制約事項

- **フローを中断しない**: 他スキルの手順が必要な場合は、同梱された `../<name>/SKILL.md` を読み、このセッション内で直接実行する
- **サブエージェントの利用**: フェーズ12の監視タスクのみ、実行環境が提供するバックグラウンドサブエージェントを使用してよい。他フェーズではサブエージェントを使わない
- **プロジェクトのガイドライン遵守**: CLAUDE.md, AGENTS.md等のルールに従う
- **日本語で報告**
- **フェーズ未完了で完了扱い禁止**: いずれかの必須フェーズが未実施・未確認なら、完了報告をしてはいけない
