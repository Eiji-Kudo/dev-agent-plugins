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
flowchart TD
    A[入力を解析] --> B{既存PRが入力されたか}
    B -- はい --> C[PRのheadブランチからworktreeを作成]
    B -- いいえ --> D[issue・ブランチ・会話文脈からworktreeを作成]
    D --> E[実装してcommit]
    E --> F[pushしてdraft PRを作成]
    C --> G[loop-critics-fix]
    F --> G
    G --> H{未対応・新規懸念が0件か}
    H -- いいえ --> G
    H -- はい --> I[pr-testで未カバーのテストを実装]
    I --> J{未実装テストが0件か}
    J -- いいえ --> I
    J -- はい --> K[CIチェックと修正]
    K --> L{すべて成功したか}
    L -- いいえ --> K
    L -- はい --> M[PR descriptionを更新]
    M --> N[draftを解除してReady for Review]
    N --> O[Codex・GeminiへAIレビューを依頼]
    O --> P[PR解説mdを作成]
    P --> Q[critics reviewを要約]
    Q --> R[AIレビュー監視サブエージェントを起動]
    R --> S[gtr-new本体は完了]
    R -. 非同期 .-> T{依頼したレビューが揃ったか}
    T -- 揃った、または30分経過 --> U[review-comment-analysisを実行]
```

### `review-comment-analysis`

```mermaid
flowchart TD
    A[PR情報を取得] --> B[headブランチの作業ディレクトリを選択]
    B --> C[critics reviewを確認・初回のみ]
    C --> D[未解決レビューコメントを取得]
    D --> E[PRの目的とdiffを確認して各コメントを初期判定]
    E --> F[分析mdを保存]
    F --> G[コード精査・PR文脈・プロジェクト慣習の3エージェントで並列検証]
    G --> H[検証結果を統合して最終判定を更新]
    H --> I{分析のみの指定か}
    I -- はい --> Q[最終報告]
    I -- いいえ --> J[MUST_FIXと対象のSHOULD_CONSIDERを修正]
    J --> K[分析mdをtriageしcommit・push]
    K --> L[レビューへ返信しbotの対象threadをresolve]
    L --> M[Codexへ再レビューを依頼]
    M --> N[最大10分、新しいCodex応答を監視]
    N --> O{新しい指摘があるか}
    O -- なし --> Q
    O -- あり --> P{5イテレーション未満か}
    P -- はい --> D
    P -- いいえ --> R[残った新規指摘を列挙]
    R --> Q
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
