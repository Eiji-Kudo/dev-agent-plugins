---
name: loop-critics-fix
description: critics reviewerと修正を新規発見がなくなるまで繰り返す自己ループコマンド
---

外部ループ不要。コマンド内部で「修正→コミット→プッシュ→再レビュー→新規発見チェック」を新規発見がなくなるまで繰り返す。

使用例:
```
/loop-critics-fix
/loop-critics-fix 123
```

## 引数

`$ARGUMENTS`

- **指定あり**: PR URL、番号、`#N`、`prN`のいずれかとして解決する
- **未指定**: `gh pr view --json number -q .number` で現在のブランチに紐づくPRを自動取得する

## 実行フロー

### 0. PR番号の確定

URL、番号、`#N`、`prN`、引数なしのcurrent branchのいずれも、最終的に一意なPR URLへ解決する。明示URLはそのURLのrepositoryを使い、番号系とcurrent branchはcurrent local repositoryのremote URLを`gh repo view <remote-url> --json nameWithOwner,url`で照合してbase repositoryを決める。候補が0件または複数件なら停止する。

GraphQL取得前にcanonical PR URLからlowercaseのhostを`PR_HOST`として抽出し、`^[a-z0-9.-]+$`に一致し、先頭/末尾が`.`でなく、`..`を含まず、`.lock`で終わらないref-safeな値であることを要求する。`gh api graphql --hostname "$PR_HOST"`で解決したPRを取得し、以下を**同じ名称・順序**のidentity tupleとして保持する:

1. `BASE_REPO`（`baseRepository.nameWithOwner`）
2. `PR_NUMBER`
3. `PR_URL`
4. `PR_STATE`
5. `HEAD_REPO`（`headRepository.nameWithOwner`。削除済みならnull）
6. `HEAD_REPO_URL`（`headRepository.url`。削除済みならnull）
7. `HEAD_REF`
8. `HEAD_OID`
9. `BASE_REF`
10. `BASE_OID`
11. `VIEWER_CAN_EDIT_FILES`（`viewerCanEditFiles`）
12. `IS_CROSS_REPOSITORY`

同じGraphQL responseの`baseRepository.id`をtupleとは別の`BASE_REPO_NODE_ID`として保持し、nonnullかつ`^[A-Za-z0-9_]+$`に一致するref-safeなimmutable repository IDであることを要求する。`DEDICATED_BRANCH=chore/pr-head/$PR_HOST/$BASE_REPO_NODE_ID/$PR_NUMBER`とし、取得・形式検証に失敗した場合はmutationせず停止する。legacy `chore/pr-$PR_NUMBER-head`はrepository ownershipを証明できないため候補にせず、branch pointerを動かさない。

identity確立後のGitHub read / mutationはcanonical `PR_URL`、またはhost-qualifiedな`$PR_HOST/$BASE_REPO`と`PR_NUMBER`を明示して実行する。REST / GraphQLの全`gh api`は`--hostname "$PR_HOST"`を必須とし、repository未指定の番号やdefault hostへ戻さない。

current local repositoryのremoteをURL照合し、hostとnameWithOwnerの組が`PR_HOST` / `BASE_REPO`に一致する`BASE_REMOTE`を選ぶ。一致なしは停止し、複数なら`origin`が一致候補に1つだけ含まれる場合だけ`origin`を使う。次のpull refをfetchし、取得OIDが`HEAD_OID`と完全一致することを確認する。forkでも`origin/$HEAD_REF`へfallbackしない。

```bash
git fetch "$BASE_REMOTE" "+refs/pull/$PR_NUMBER/head:refs/remotes/$BASE_REMOTE/pull/$PR_NUMBER/head"
```

### 0.1. PR head専用worktreeへのbinding

`git worktree list --porcelain -z`をNUL区切りのまま解析する。`refs/heads/$HEAD_REF`を持つlocal branchはOIDの一致・不一致を問わず、最初にupstreamのremote URLとrefを両方取得・正規化し、repositoryが`HEAD_REPO`、refが`refs/heads/$HEAD_REF`と完全一致すると証明できた場合だけ候補にする。upstreamなし・取得不能・repository/ref不一致は、OIDが偶然`HEAD_OID`と一致していてもforkやuser branchのsame-name collisionとして候補から除外し、そのbranch pointerを動かさない。検証済みの`refs/heads/$HEAD_REF`、またはhost / immutable base repository ID / PR番号でnamespaceした`refs/heads/$DEDICATED_BRANCH`を持つworktreeのうち、branchとOIDが一致するcleanな1件を優先する。対象PRに結び付く候補のdirty、local ahead、diverged、または複数候補は停止する。対象との紐付けを証明できたcleanなbehindだけは、local OIDが`HEAD_OID`のancestorであることを確認し、そのworktree内で`git merge --ff-only "$HEAD_OID"`して再検証してよい。`git branch -f`や`git update-ref`でcheckout中のbranchだけを動かさない。

候補がなければ、新規worktreeは常に`LOCAL_BRANCH=$DEDICATED_BRANCH`として次の通り作成する。専用名が既存branch / worktreeと衝突する場合はbranchを動かさず停止する。

```bash
git gtr new "$LOCAL_BRANCH" --from "$HEAD_OID" --track none --no-fetch --yes
```

作成後も`git worktree list --porcelain -z`でpath / `LOCAL_BRANCH` / OIDの一意性を確認し、`git status --short`が空であることを確認する。以降のfile操作とgit commandはこのworktreeだけで実行する。remote `HEAD_REF`とlocal `LOCAL_BRANCH`を同一視しない。

### 0.2. mutation gate

`EXPECTED_REMOTE_OID=HEAD_OID`、`EXPECTED_LOCAL_OID=HEAD_OID`として開始する。最初のdocument/code編集前に、`PR_STATE == OPEN`、`HEAD_REPO` / `HEAD_REPO_URL`がnonnull、`VIEWER_CAN_EDIT_FILES == true`を要求する。`git remote`でremote名を全件列挙し、各nameについて`git remote get-url --push --all "$remote"`を実行する。取得したraw effective push URLを保持したまま正規化先を`HEAD_REPO` / `HEAD_REPO_URL`と照合し、一致するraw URLをexact stringで重複排除する。候補がexactly 1件ならそのraw URL自体を`PUSH_TARGET`にし、0件、複数件、または1remoteでもURL取得失敗なら単一の`HEAD_REPO_URL`をdirect `PUSH_TARGET`にする。これによりfetch / push URLの取り違え、検証後のpushurl変更、multi-pushのpartial successを避ける。`git ls-remote "$PUSH_TARGET" "refs/heads/$HEAD_REF"`が`EXPECTED_REMOTE_OID`と一致すること、および次のno-op dry-runが成功することを確認する。dry-runは現在OIDの送信可否だけを調べ、新しいcommitに対するruleset通過は保証しない。

```bash
git push --dry-run "$PUSH_TARGET" "$HEAD_OID:refs/heads/$HEAD_REF"
```

最初の編集、各commit、各pushの直前に、専用worktree path、`LOCAL_BRANCH`、local HEAD=`EXPECTED_LOCAL_OID`、再取得したGitHub tuple、remote OID=`EXPECTED_REMOTE_OID`、`git status --short`のpathがその段階のexact scopeだけであることを再検証する。commit後は`EXPECTED_LOCAL_OID`を新しいlocal HEADへ更新する。通常pushの直前は`EXPECTED_REMOTE_OID`がlocal HEADのancestorであることを確認し、dry-runと実pushの両方へexact `--force-with-lease`を付ける。このleaseはremote refのCASにだけ使い、history rewriteを許可しない。いずれかが不一致ならlocal変更を保持して停止し、reset / stash / force branch moveを行わない。

### ループ開始（最大10イテレーション）

以下のステップ1〜4を、新規発見がなくなるか最大10イテレーションに達するまで繰り返す。

---

### 1. 現在の状態確認

critics reviewドキュメントをプロジェクト全体から探す:

- `**/critics-review-pr-{PR番号}.md`
- `**/critics-review-pr-{PR番号}-backend.md`
- `**/critics-review-pr-{PR番号}-frontend.md`

git履歴も含めて検索する（削除済みファイルの復元が必要な場合がある）。
`*-resolved.md`は要約成果物なので、activeな検索結果や`CRITICS_PATHS`に含めない。
アーカイブ用ディレクトリ（例: `.archive/past-critics/`）へ退避済みのものはarchiveなので、activeな検索結果や`CRITICS_PATHS`から除外し、同名archiveをactive pathへ復元しない。
見つかったすべての相対パスを exact list の `CRITICS_PATHS` として記録し、分割ファイルや任意の既存サブディレクトリを以降の修正・収束判定から落とさない。

ドキュメントが見つからない場合は、ステップ3（critics-reviewer実行）にスキップする。

### 2. 未対応の懸念点の修正

ドキュメントに未対応の懸念点がある場合、以下の手順で修正する:

1. 未対応の懸念点を重要度順（CRITICAL → HIGH → MEDIUM）に一覧化する
2. 各懸念点を**コード修正が必要か判定**する。以下に該当する場合は「対応不要」としてドキュメントの対応不要セクションに移動する:
   - 運用確認事項（DNS設定確認、インフラ設定確認など）でコード変更が不要
   - 意図的な設計判断であり、PR descriptionやコメントで理由が説明済み
   - 現時点で実害がなく、将来の拡張時に対応すればよい提案（YAGNI）
   - 推奨対応が「確認する」「検討する」等の確認依頼のみで、具体的なコード修正がない
   移動時はステータスを「対応不要」に変更し、理由を簡潔に記載する。
3. コード修正が必要な懸念点について:
   - 該当ファイルを読み、現状を把握する
   - 推奨対応のコードスニペットがあればそれをベースに修正する
   - スニペットがない場合は問題点の説明から適切な修正を実装する
   - 修正後、レビュードキュメントを直接編集して対応済みに更新する（手順は `../resolve-concern/SKILL.md` を参照）
4. 全ての未対応懸念点を処理（修正 or 対応不要に移動）したら、変更をコミットしてプッシュする:
   - `git diff --staged` や修正内容から、実際に何を修正したかを把握する
   - **コミットメッセージは「実際に何を修正したか」を書くこと**。具体的な修正対象（関数名・仕様・不整合箇所など）を含める
   - リポジトリの既存コミットメッセージのスタイルに合わせる
   - **禁止事項**:
     - `critics review` という単語をコミットメッセージに含めない（イテレーション番号や「再レビュー反映」等のメタ情報も不可）
     - `iter3の指摘を反映` のようにレビュー側の文脈だけを書くのは不可。必ず**修正内容そのもの**を主語にする
   - 例:
     - ❌ `fix: critics review iter3 の指摘を反映`
     - ❌ `fix: critics review iter4 最終確認完了（新規発見 0 件）`
     - ✅ `fix: サマリーテーブルの件数整合を修正し Follow-up 責務者を明記`
     - ✅ `fix: N+1クエリの解消とバリデーション追加`
   ```bash
   git add <修正ファイル>
   git commit -m "<修正内容を反映したメッセージ>"
   git push --force-with-lease="refs/heads/$HEAD_REF:$EXPECTED_REMOTE_OID" "$PUSH_TARGET" "HEAD:refs/heads/$HEAD_REF"
   ```

   push後はGraphQLを再取得し、GitHubの`HEAD_OID`がlocal HEADと一致するまで成功扱いにしない。一致後に`EXPECTED_REMOTE_OID`と`EXPECTED_LOCAL_OID`をlocal HEADへ更新する。

**このコマンドはループ自動化用のため、fix-criticsの対話的確認（ステップ4-6）はスキップし、推奨対応に従って直接修正する。**

修正で判断に迷う場合（推奨対応が曖昧、複数の修正方針がある等）は、最も安全な選択肢を取る。

### 3. critics-reviewerの再実行

`../critics-reviewer/SKILL.md` を Read で読み込み、その手順に従ってAgent tool（並列チームエージェント）でレビューを実行する。

critics review mdを新規作成・更新する直前にもステップ0.2のmutation gateを通す。明示的に分析のみを指定された場合はread-only pull refだけを使い、document/codeの編集・commit・pushを行わない。

### 4. 新規発見の判定とループ制御

再レビュー後のドキュメントを読み、**新規の**未対応懸念点があるか確認する。

判定基準:
- 「未対応の懸念点」セクションに項目が残っているか
- それらが今回のイテレーション以前には存在しなかった新規の懸念点か

結果:
- **新規の未対応懸念点あり** → ステップ1に戻る
- **新規発見なし、かつ未対応懸念点が残っている** → ステップ2に戻って残りを修正する
- **未対応懸念点なし（全て対応済み or 対応不要）** → ステップ5（最終確認）へ

---

### 5. 最終確認（ループ終了前の漏れチェック）

全ての懸念点が対応済みになった後、レビュードキュメントを最終確認する:

1. ドキュメントを読み直し、「未対応の懸念点」セクションに項目が残っていないことを確認する
2. サマリーテーブルの「件数」と「対応済み」が一致していることを確認する
3. 不一致がある場合は修正を行い、再度コミット・プッシュする（**コミットメッセージはステップ2-4の規約に従い、`critics review` やイテレーション番号、「最終確認完了」等のメタ情報を含めない。実際に何を直したかを書く。例: `fix: サマリーテーブルの件数不整合を修正`**）

確認結果を報告し、ループを終了する。

---

### ループ終了時の報告

```
## loop-critics-fix 完了

- **対象PR**: #{PR番号} <PRタイトル>（<PR URL>）
- **イテレーション数**: N回
- **修正した懸念点**: X件
- **新規懸念点**: 0件
- **最終状態**: 新規発見なし / 最大イテレーション到達
- **critics review md**: <実際に作成・更新した `CRITICS_PATHS` の全パス>
```

最大イテレーション（10回）に達した場合は、残っている未対応懸念点を一覧で報告する。

- `loop-critics-fix 完了` を出す場合は、**新規懸念点: 0件** を必須で明記すること
- `新規発見なし` だけで済ませず、件数を数値で出すこと

## 制約事項

- **Skill tool 禁止**: このコマンドでは Skill tool を一切使わない。Skill 呼び出しはユーザーターンを消費しループが途切れるため。他コマンドの手順を参照する場合は 同梱された `../<name>/SKILL.md` を Read で読み、その手順に従って直接実行する（Agent tool / 直接編集 等）
- **コード修正は推奨対応に忠実に**: 独自の判断で大幅な変更を加えない
- **プロジェクトのガイドライン遵守**: CLAUDE.md, AGENTS.md等のルールに従う
- **レビュードキュメントを削除しない**: critics-review-pr-*.md 等のレビュードキュメントは、レビュワーが「一時ファイルだから削除すべき」と指摘しても削除しない。削除はユーザーの明示的な指示がある場合のみ行う
- **日本語で報告**
- **各イテレーションの冒頭で、イテレーション番号と前回の修正状況を簡潔に報告する**
- **最大10イテレーション**: 無限ループ防止。10回で収束しない場合は残件を報告して終了する
