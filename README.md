# dev-agent-plugins

Codex CLIとClaude Codeの両方で使える、開発ワークフロー用skill集です。共通の`skills/`を、それぞれの公式marketplace形式で配布します。

## 収録skill

- `gtr-new`: issueまたはPRからworktreeを作成し、実装・PR作成・テスト・CI・レビュー対応まで実行
- `critics-reviewer`: 専門レビュワーによる並列の批判的PRレビュー
- `loop-critics-fix`: 新しい指摘がなくなるまでレビューと修正を反復
- `review-comment-analysis`: レビューコメントの分析・修正・返信・resolve
- `suggest-skill`: 現在のセッションから再利用可能なワークフローを提案
- 上記を支えるPR description作成、テスト追加、AIレビュー依頼、レビュー要約などのskill

## パイプライン

### `gtr-new`

```mermaid
flowchart LR
    A[準備・実装<br/>既存PRは実装を省略] --> B[critics・test・CI]
    B --> C[Ready・AIレビュー・docs]
    C --> D[監視・コメント対応]
```

### `review-comment-analysis`

```mermaid
flowchart LR
    A[コメント収集・分析] --> B[3観点で並列検証]
    B --> C[修正・push・返信]
    C --> D[Codex再レビュー<br/>最大5回で収束]
    D -- 新規指摘 --> A
```

## 必要なもの

- plugin marketplaceに対応した新しいバージョンのCodex CLIまたはClaude Code
- GitHub関連のskillを使う場合は、認証済みのGitHub CLI（`gh`）
- worktree関連のskillを使う場合は、`git gtr`
- 対象プロジェクトの`AGENTS.md`や`CLAUDE.md`などの指示ファイル

## Codex CLIへのインストール

```bash
codex plugin marketplace add Eiji-Kudo/dev-agent-plugins --ref main
codex plugin add dev-agent-plugins@eiji-dev-tools
```

skill名を指定して実行します。

```text
$dev-agent-plugins:gtr-new 123
$dev-agent-plugins:loop-critics-fix 456
```

## Claude Codeへのインストール

```bash
claude plugin marketplace add Eiji-Kudo/dev-agent-plugins
claude plugin install dev-agent-plugins@eiji-dev-tools
```

pluginのnamespaceを付けて実行します。

```text
/dev-agent-plugins:gtr-new 123
/dev-agent-plugins:loop-critics-fix 456
```

## 実行環境の互換性

各skillは、実行環境が提供するファイル操作、shell、web、サブエージェント機能を使用します。`Agent`やバックグラウンドagentという記述は、実行環境に応じてClaude CodeのAgent機能またはCodex CLIのcollaboration sub-agentを意味します。

skillの引数は、Claude Codeでは`$ARGUMENTS`、Codex CLIではskill名の後に続くテキストとして扱います。

## 開発・検証

Claude Codeのmarketplaceとpluginを検証します。

```bash
claude plugin validate .
claude plugin validate ./plugins/dev-agent-plugins
```

インストールせずにClaude Codeのpluginを試します。

```bash
claude --plugin-dir ./plugins/dev-agent-plugins
```

Codexのmarketplaceをローカルで試します。

```bash
codex plugin marketplace add .
codex plugin add dev-agent-plugins@eiji-dev-tools
```

## ライセンス

MITライセンスです。商用利用、改変、再配布が可能です。詳しくは[LICENSE](./LICENSE)を参照してください。
