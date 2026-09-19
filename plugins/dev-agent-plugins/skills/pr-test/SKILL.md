---
name: pr-test
description: PRに入れるべき自動テストを洗い出し、承認待ちなしで実装・検証を新規発見がなくなるまで繰り返す
---

現在のブランチのPRの変更内容を分析し、追加すべき自動テストの項目を洗い出す。洗い出した項目はユーザーの承認を待たずにすべて実装し、再分析で新規の未カバー項目が出なくなるまでループする。

使用例:
```
/pr-test
/pr-test 123
```

## 引数

`$ARGUMENTS`

- **指定あり**: PR URL、番号、`#N`、`prN`のいずれかとして解決する
- **未指定**: `gh pr view --json number -q .number` で現在のブランチに紐づくPRを自動取得する

## 前提

- 自明なテスト（正常系の単純なCRUD確認、trivialなバリデーション、型だけで保証される安全性、フレームワークが保証する動作等）は**除外**する
- 既存テストでカバー済みの範囲は除外する
- 必要かつ未カバーと判断したテスト項目は、優先度に関係なく**ユーザー承認を待たずにすべて実装**する
- 実装判断に迷う場合は、既存テストの粒度・配置・モック方針・fixture方針に合わせた最小変更を選ぶ
- backendはVitest + 実DB（integration推奨）、frontendはVitest + Testing Library（AGENTS.md / CLAUDE.md等のテスト規約に従う）
- PR差分とテスト追加に必要な範囲を超える大規模リファクタは行わない
- 外部ループ不要。コマンド内部で「洗い出し → 実装 → 検証 → コミット・プッシュ → 再分析」を新規発見がなくなるまで繰り返す

## 実行フロー

### 0. PR番号の確定

URL、番号、`#N`、`prN`、引数なしのcurrent branchのいずれも、一意なPR URLへ解決する。明示URLはそのrepositoryを使い、番号系とcurrent branchはcurrent local repositoryのremote URLを`gh repo view <remote-url> --json nameWithOwner,url`で照合してbase repositoryを決める。候補が0件または複数件なら停止する。

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

current local repositoryのremoteをURL照合し、hostとnameWithOwnerの組が`PR_HOST` / `BASE_REPO`に一致する`BASE_REMOTE`を選ぶ。一致なしは停止し、複数なら`origin`が一致候補に1つだけ含まれる場合だけ`origin`を使う。base repositoryのpull refをfetchして取得OIDが`HEAD_OID`と一致することを確認し、forkでも`origin/$HEAD_REF`へfallbackしない。

```bash
git fetch "$BASE_REMOTE" "+refs/pull/$PR_NUMBER/head:refs/remotes/$BASE_REMOTE/pull/$PR_NUMBER/head"
```

`git worktree list --porcelain -z`をNUL区切りのまま解析する。`refs/heads/$HEAD_REF`を持つlocal branchはOIDの一致・不一致を問わず、最初にupstreamのremote URLとrefを両方取得・正規化し、repositoryが`HEAD_REPO`、refが`refs/heads/$HEAD_REF`と完全一致すると証明できた場合だけ候補にする。upstreamなし・取得不能・repository/ref不一致は、OIDが偶然`HEAD_OID`と一致していてもforkやuser branchのsame-name collisionとして候補から除外し、そのbranch pointerを動かさない。検証済みの`refs/heads/$HEAD_REF`、またはhost / immutable base repository ID / PR番号でnamespaceした`refs/heads/$DEDICATED_BRANCH`を持つworktreeのうち、branch / OIDが一致するcleanな1件へ移動する。対象PRに結び付く候補のdirty、local ahead、diverged、または複数候補は停止する。対象との紐付けを証明できたcleanなbehindだけは、local OIDが`HEAD_OID`のancestorであることを確認し、そのworktree内で`git merge --ff-only "$HEAD_OID"`して再検証してよい。`git branch -f`や`git update-ref`でcheckout中のbranchだけを動かさない。候補がなければ、新規worktreeは常に`LOCAL_BRANCH=$DEDICATED_BRANCH`で作る。専用名が既存branch / worktreeと衝突する場合は停止する。

```bash
git gtr new "$LOCAL_BRANCH" --from "$HEAD_OID" --track none --no-fetch --yes
```

作成後もpath / `LOCAL_BRANCH` / OID / clean / 一意性を再検証し、以降の分析・document/code編集・commit・pushをこのworktree内だけで行う。remote `HEAD_REF`とlocal `LOCAL_BRANCH`は分離する。

`EXPECTED_REMOTE_OID=HEAD_OID`、`EXPECTED_LOCAL_OID=HEAD_OID`として開始する。最初のdocument/code編集前に、`PR_STATE == OPEN`、head repositoryがnonnull、`VIEWER_CAN_EDIT_FILES == true`を要求する。`git remote`でremote名を全件列挙し、各nameについて`git remote get-url --push --all "$remote"`を実行する。取得したraw effective push URLを保持したまま正規化先を`HEAD_REPO` / `HEAD_REPO_URL`と照合し、一致するraw URLをexact stringで重複排除する。候補がexactly 1件ならそのraw URL自体を`PUSH_TARGET`にし、0件、複数件、または1remoteでもURL取得失敗なら単一の`HEAD_REPO_URL`をdirect `PUSH_TARGET`にする。これによりfetch / push URLの取り違え、検証後のpushurl変更、multi-pushのpartial successを避ける。`git ls-remote "$PUSH_TARGET" "refs/heads/$HEAD_REF"`が`EXPECTED_REMOTE_OID`と一致し、`git push --dry-run "$PUSH_TARGET" "$HEAD_OID:refs/heads/$HEAD_REF"`が成功することを確認する。dry-runは新しいcommitのruleset通過を保証しない。

最初の編集、各commit、各push直前に、worktree path、`LOCAL_BRANCH`、local HEAD=`EXPECTED_LOCAL_OID`、再取得したGitHub tuple、remote OID=`EXPECTED_REMOTE_OID`、statusがその段階のexact scopeだけであることを再検証する。通常pushの直前は`EXPECTED_REMOTE_OID`がlocal HEADのancestorであることを確認し、dry-runと実pushの両方へexact `--force-with-lease`を付ける。このleaseはremote refのCASにだけ使い、history rewriteを許可しない。不一致ならlocal workを保持して停止し、reset / stash / force branch moveを行わない。明示的に分析のみを指定された場合はpull refまでのread-only処理だけを行い、worktreeの作成・document/code編集・commit・pushを行わない。

あわせて、作業対象リポジトリの `CLAUDE.md` / `AGENTS.md` / package scripts / 既存テスト規約を確認する。

### ループ開始（最大10イテレーション）

以下のステップ1〜9を、新規の未カバーテスト項目がなくなるか最大10イテレーションに達するまで繰り返す。

各イテレーションの冒頭で、イテレーション番号と前回の実装・検証状況を簡潔に報告する。

---

### 1. PR情報と差分の取得

- `gh pr view "$PR_URL" --json title,body,number,files` でPR情報と変更ファイル一覧を取得する
- `gh pr diff "$PR_URL"` で最新の差分を取得する
- 前回イテレーションでテストを追加している場合は、追加済みテストも含めて現在のPR差分として扱う

### 2. 変更内容の詳細分析

変更ファイルごとに差分を確認し、以下を分類する:

- **ビジネスロジックの追加・変更**: 条件分岐、計算、状態遷移
- **API変更**: 新規エンドポイント、リクエスト/レスポンス変更、バリデーション
- **データアクセスの変更**: クエリ、リポジトリ、DB操作
- **認証・認可の変更**: 権限チェック、アクセス制御
- **フロントエンドロジックの変更**: hooks、状態管理、データ変換

### 3. 既存テストの確認

- PR差分に含まれるテストファイルを確認し、既にカバーされている範囲を把握する
- 変更されたモジュールに関連する既存テストファイルを探索し、カバレッジの現状を理解する
- 追加済みテストがある場合は、それによってカバー済みになった項目を除外する

### 4. テスト項目の洗い出し

以下の観点で、テストが**必要かつ未カバー**の項目を特定する。自動テストとして実装できない確認事項はテスト項目に含めず、最終レポートの「確認事項」に分ける。

#### 優先度: 高
- **エッジケース・境界値**: 空配列、null/undefined、0件、上限値など、実装者が見落としやすいケース
- **条件分岐の網羅**: 追加された条件分岐のうち、片方のパスだけが自明でないもの
- **認可・権限チェック**: ロールによるアクセス制御が正しく機能するか
- **データ整合性**: 複数テーブルにまたがる操作、トランザクション境界

#### 優先度: 中
- **エラーハンドリング**: 外部サービスの障害、不正入力時の挙動
- **複合条件**: 複数の条件が組み合わさる場合のテスト
- **状態遷移**: ステータスの遷移パターンが仕様通りか

#### 優先度: 低
- **パフォーマンス懸念**: N+1クエリ、大量データ処理の挙動
- **並行性**: 同時リクエスト時の挙動

### 5. テスト設計ドキュメントの作成・更新

`/resolve-concern` と互換性のある構造にする。サマリーテーブルでステータスを管理し、テスト項目を「未実装」「実装済み」「対応不要・確認事項」セクションで分ける。

初回の設計md作成・更新直前にもステップ0のmutation gateを通す。

- ファイル名: `temp-docs/test-design-pr-{PR番号}.md`
- `temp-docs/` が存在しない場合は、設計mdの保存直前に作成する
- 既存ファイルがある場合は追記ではなく、現在の分析結果に合わせて更新する
- 新規発見した項目は「未実装」に追加する
- 実装済みになった項目は「実装済み」へ移動し、実装ファイルと検証コマンドを記録する

```markdown
# 自動テスト設計: PR #{番号} {タイトル}

## 変更概要

[変更内容を2-3文で要約]

## 既存テストのカバレッジ状況

[既にカバーされている範囲を簡潔に記載]

## サマリー

| 優先度 | 項目数 | 実装済み | 未実装 | 対応不要 |
|--------|--------|----------|--------|----------|
| 高     | N      | N        | 0      | 0        |
| 中     | N      | N        | 0      | 0        |
| 低     | N      | N        | 0      | 0        |

## 未実装のテスト項目

（なし）

## 実装済みのテスト項目

<details>
<summary>{テスト名}（高 / 実装済み）</summary>

- **対象**: `path/to/file.ts` の `functionName`
- **種別**: unit / integration
- **意図**: [なぜこのテストが必要か]
- **シナリオ**:
  1. [前提条件]
  2. [操作]
  3. [期待結果]
- **配置先**: `path/to/__tests__/file.test.ts`
- **検証**: `pnpm test ...`

</details>

## 対応不要・確認事項

（なし）
```

### 6. 未実装テストの実装

「未実装のテスト項目」にある項目を、重要度順（高 → 中 → 低）にすべて実装する。

実装時の手順:

1. 既存テストファイル・fixture・factory・helperを読み、既存パターンに合わせる
2. 既存テストに追記できる場合は追記し、責務が分かれる場合のみ新規テストファイルを作る
3. 実装後、`temp-docs/test-design-pr-{PR番号}.md` の該当項目を「実装済み」に移動する
4. 実装が不可能、または自動テスト化すべきでないと判明した項目は「対応不要・確認事項」に移動し、理由を簡潔に記載する

**ユーザーへの承認確認は行わない。** 洗い出したテストはこのステップで直接実装する。

### 7. 検証と修正

- まず追加・変更したテストに対する最小範囲のテストコマンドを実行する
- 関連範囲に副作用があり得る場合は、該当パッケージや該当ワークスペースの広めのテストも実行する
- テストが失敗した場合は、テストまたは実装対象コードの不整合を調査し、必要な修正を行う
- 検証結果を `temp-docs/test-design-pr-{PR番号}.md` の各項目に記録する

### 8. コミット・プッシュ

実装・ドキュメント更新・検証修正がある場合は、変更内容を把握してコミットし、pushする。

- `git diff --staged` や実際の差分から、何を追加・修正したかを確認する
- コミットメッセージは「実際にどのテストを追加したか」を書く
- リポジトリの既存コミットメッセージのスタイルに合わせる
- **禁止事項**:
  - `pr-test`、`テスト洗い出し`、`iter2`、`再分析反映` のようなメタ情報だけを主語にしない
  - 実装内容が分からない抽象的なメッセージにしない
- 例:
  - ❌ `test: pr-test iter2 の指摘を反映`
  - ❌ `test: 自動テストを追加`
  - ✅ `test: 招待承認時の権限分岐を追加`
  - ✅ `test: 空配列入力時の集計結果を検証`

```bash
git add <修正ファイル>
git commit -m "<追加したテスト内容を反映したメッセージ>"
git push --force-with-lease="refs/heads/$HEAD_REF:$EXPECTED_REMOTE_OID" "$PUSH_TARGET" "HEAD:refs/heads/$HEAD_REF"
```

commit後は`EXPECTED_LOCAL_OID`をlocal HEADへ更新する。push後はGraphQLの`HEAD_OID`がlocal HEADと一致するまで成功扱いにせず、一致後に`EXPECTED_REMOTE_OID`もlocal HEADへ更新する。

### 9. 新規発見の判定とループ制御

コミット・プッシュ後にステップ1へ戻り、最新PR差分を再分析する。

判定基準:

- `temp-docs/test-design-pr-{PR番号}.md` の「未実装のテスト項目」に項目が残っているか
- それらが今回のイテレーション以前には存在しなかった新規の未カバー項目か
- 追加したテストによって見えた仕様分岐・境界値・データ整合性リスクが新たにあるか

結果:

- **新規の未カバーテスト項目あり** → ステップ1に戻る
- **新規発見なし、かつ未実装項目が残っている** → ステップ6に戻って残りを実装する
- **未実装項目なし（全て実装済み or 対応不要）** → ステップ10へ

---

### 10. 最終確認

ループ終了前に以下を確認する:

1. `temp-docs/test-design-pr-{PR番号}.md` の「未実装のテスト項目」が空であること
2. サマリーテーブルの「項目数」「実装済み」「未実装」「対応不要」の件数が一致していること
3. 実装したテストの検証コマンドと結果が記録されていること
4. 最終イテレーションで新規の未カバーテスト項目が0件であること

不一致がある場合は修正し、必要に応じて再度コミット・プッシュする。コミットメッセージはステップ8の規約に従い、実際に直した内容を書く。

### 11. 報告・解説用mdの作成

完了時に、実施内容を説明する報告・解説用mdを作成する。

- ファイル名: `temp-docs/test-implementation-report-pr-{PR番号}.md`
- 既存ファイルがある場合は、今回の最終状態に合わせて更新する
- 変更がある場合はコミット・プッシュする

```markdown
# 自動テスト実装レポート: PR #{番号} {タイトル}

## 概要

[今回追加したテストと守る仕様を簡潔に説明]

## ループ結果

| イテレーション | 新規発見 | 実装 | 検証 | 備考 |
|----------------|----------|------|------|------|
| 1              | N件      | N件  | pass |      |

## 実装したテスト

| 優先度 | テスト名 | 配置先 | 守る仕様 |
|--------|----------|--------|----------|
| 高     | ...      | `...`  | ...      |

## 実行した検証

| コマンド | 結果 |
|----------|------|
| `...`    | pass |

## 対応不要・確認事項

[自動テスト化しなかった項目があれば理由を記載。なければ「なし」]

## 変更ファイル

- `path/to/test.ts`
- `temp-docs/test-design-pr-{PR番号}.md`

## 最終状態

- 新規テスト項目: 0件
- 未実装テスト項目: 0件
- 最大イテレーション到達: いいえ
```

### ループ終了時の報告

```
## pr-test 完了

- **対象PR**: #{PR番号} <PRタイトル>（<PR URL>）
- **イテレーション数**: N回
- **実装したテスト項目**: X件
- **新規テスト項目**: 0件
- **未実装テスト項目**: 0件
- **検証**: pass / 一部未実行（理由）
- **設計md**: `temp-docs/test-design-pr-{PR番号}.md`
- **報告md**: `temp-docs/test-implementation-report-pr-{PR番号}.md`
- **最終状態**: 新規発見なし / 最大イテレーション到達
```

最大イテレーション（10回）に達した場合は、残っている未実装テスト項目と理由を一覧で報告する。

- `pr-test 完了` を出す場合は、**新規テスト項目: 0件** と **未実装テスト項目: 0件** を必須で明記すること
- `新規発見なし` だけで済ませず、件数を数値で出すこと
- 報告・解説用mdのパスを必ず明記すること

## 制約事項

- **Skill tool 禁止**: このコマンドでは Skill tool を一切使わない。Skill呼び出しはユーザーターンを消費しループが途切れるため。他コマンドの手順を参照する場合は 同梱された `../<name>/SKILL.md` を Read で読み、その手順に従って直接実行する
- **ユーザー承認待ち禁止**: 未カバーのテスト項目を洗い出した後に「実装してよいか」を確認しない。必要な項目は直接実装する
- **既存規約優先**: CLAUDE.md, AGENTS.md, 既存テスト、package scripts等のプロジェクト規約に従う
- **ドキュメントを削除しない**: `temp-docs/test-design-pr-*.md` と `temp-docs/test-implementation-report-pr-*.md` はユーザーの明示的な指示がある場合を除き削除しない
- **日本語で報告**
- **最大10イテレーション**: 無限ループ防止。10回で収束しない場合は残件を報告して終了する
