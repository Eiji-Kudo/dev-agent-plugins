---
name: reply-reviews
description: PRレビューコメントへの返信
---
PRの未解決レビューコメントに返信する。

## 引数

`$ARGUMENTS`

- **指定あり**: PR URL、番号、`#N`、`prN`のいずれかとして解決する
- **未指定**: `gh pr view` で現在のブランチに紐づくPRを自動取得する

`review-comment-analysis`等のproducerから`REVIEW_DECISION_PATHS`を渡された場合は、完全なexact listを同じ順序のまま使用する。単一pathへ縮退、globによる再探索、固定directoryの推測を行わない。standalone実行でlistが渡されていない場合だけ、identityから導出する既定pathを1要素listとして使う。

## 実行フロー

### 1. PR情報の取得

URL、番号、`#N`、`prN`、現在branchのいずれから開始しても、最終的に一意なPR URLへ解決する。明示URLはそのURLのhost / owner / repository / numberを使い、番号系と現在branchはcurrent local repositoryのremote URLを`gh repo view <remote-url> --json nameWithOwner,url`で照合してbase repositoryを決める。候補が0件または複数件なら推測で選ばず停止する。

GraphQL取得前にcanonical PR URLからlowercaseのhostを`PR_HOST`として抽出し、`^[a-z0-9.-]+$`に一致し、先頭/末尾が`.`でなく、`..`を含まず、`.lock`で終わらないref-safeな値であることを要求する。`gh api graphql --hostname "$PR_HOST"`で解決したPRを再取得し、以下を**同じ名称・順序**のidentity tupleとして保持する:

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

同じGraphQL responseの`baseRepository.id`を`BASE_REPO_NODE_ID`として保持し、nonnullかつ`^[A-Za-z0-9_]+$`に一致するref-safeなimmutable repository IDであることを要求する。producerからlistが渡されていない場合の既定値だけを`REVIEW_DECISION_PATHS=(temp-docs/review-decisions-$PR_HOST-$BASE_REPO_NODE_ID-pr-$PR_NUMBER.md)`とする。`VERIFIED_PUSH_REF=refs/pr-workflow/verified-push/$PR_HOST/$BASE_REPO_NODE_ID/$PR_NUMBER`も保持し、取得・形式検証に失敗した場合はPOSTもresolveも行わず停止する。

identity確立後のGitHub read / mutationはcanonical `PR_URL`、またはhost-qualifiedな`$PR_HOST/$BASE_REPO`と`PR_NUMBER`を明示して実行する。REST / GraphQLの全`gh api`は`--hostname "$PR_HOST"`を必須とし、repository未指定の番号やdefault hostへ戻さない。

current local repositoryのremoteを全件URL照合し、hostとnameWithOwnerの組が`PR_HOST` / `BASE_REPO`に一致するremoteを`BASE_REMOTE`として選ぶ（複数なら`origin`が一致候補に1つだけ含まれる場合のみ`origin`、それ以外は停止）。一致remoteがなければ別repositoryなので停止する。base repositoryのpull refを次のrefspecでfetchし、取得OIDが`HEAD_OID`と完全一致することを確認する。fork PRでも`origin/$HEAD_REF`へfallbackしない。

```bash
git fetch "$BASE_REMOTE" "+refs/pull/$PR_NUMBER/head:refs/remotes/$BASE_REMOTE/pull/$PR_NUMBER/head"
git rev-parse "refs/remotes/$BASE_REMOTE/pull/$PR_NUMBER/head^{commit}"
```

PR、pull ref、必須fieldの取得に失敗した場合はその旨を伝え、処理を終了する。

### 2. 分析ドキュメントの確認

pull refの`HEAD_OID`にある`REVIEW_DECISION_PATHS`の**全exact path**を`git show "$HEAD_OID:<exact-path>"`で1件ずつ確認する。current worktreeに同名fileがあっても、対象PR headと一致を検証できないfileは使わない。各ドキュメントにexactly 1つある`## PR identity`セクション内で、`PR_URL`、`PR_HOST`、`BASE_REPO`、`BASE_REPO_NODE_ID`、`PR_NUMBER`が現在のGraphQL identityとそれぞれexactly 1件ずつ一致することを要求し、section / fieldの欠落・重複・不一致ならPOSTもresolveも行わず停止する。list内の重複、欠落path、別PR identityが1件でもあれば全mutationを停止する。

- **全件存在する場合**: 全ドキュメントから各feedbackの`Feedback channel`、namespaced ID、thread metadata、「返信案」を読み取り、`VERIFIED_PUSH_REF`から分析時の`VERIFIED_PUSHED_HEAD`を取得する
- **1件でも存在しない場合**: 先に `/review-comment-analysis` を実行するよう案内して終了
- **空listの場合**: 返信対象0件としてmutationせず終了する

`VERIFIED_PUSHED_HEAD=$(git rev-parse "$VERIFIED_PUSH_REF^{commit}")`が40桁OIDとして存在し、`HEAD_OID`と完全一致し、そのcommitに`REVIEW_DECISION_PATHS`の全fileとexact identity metadataが存在することを確認する。不一致なら、分析後にPR headが更新された可能性があるためPOSTもresolveも行わず停止する。legacyの番号だけのdocument path / verified-push refは参照せず、現在のPRへのauthorizationとして扱わない。commit自身のOIDを同じcommit内のdocumentへ書く自己参照は行わない。

### 3. 未解決review threadの取得

最初に全分析項目をchannel別に分ける。`Feedback channel == review_thread`で、`THREAD_NODE_ID`、`ROOT_COMMENT_DATABASE_ID`、`THREAD_SNAPSHOT_SHA256`がすべて実値の項目だけを返信・resolve候補にする。top-level review、issue comment、timeline event、threadへ一意に対応しないREST review comment等は分析・修正結果として報告するが、thread IDを推測・捏造してmutationしない。

GitHub GraphQL APIの`reviewThreads`を使い、`isResolved == false`のthreadだけを全page取得する。各threadについて`PullRequestReviewThread.id`を`THREAD_NODE_ID`、先頭のtop-level commentの`databaseId`を`ROOT_COMMENT_DATABASE_ID`として保持し、分析ドキュメントのreview thread項目と一意に対応付ける。REST review commentの`node_id`は`PullRequestReviewComment`のIDであり、`resolveReviewThread`へ渡さない。

```graphql
query ReviewThreads($owner: String!, $name: String!, $number: Int!, $threadsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id databaseId author { login __typename } body originalLine originalStartLine
              createdAt publishedAt lastEditedAt commit { oid } originalCommit { oid }
              pullRequestReview {
                databaseId author { login __typename } body submittedAt lastEditedAt commit { oid }
              }
            }
          }
        }
      }
    }
  }
}
```

`BASE_REPO`をowner / nameへ分解し、`gh api graphql --hostname "$PR_HOST"`へexplicit variablesとして渡す。thread connectionに次pageがあれば`threadsAfter=endCursor`で取得する。各comment connectionに次pageがあれば、`node(id: $threadId)`から同じthreadの`comments(first: 100, after: $commentsAfter)`を上記と同じ全fieldで取得するqueryへcursorを渡して最後まで取得する。全page取得後、review-comment-analysisと同じ固定key順のthread ID / `isResolved` / 全commentのstable ID / actor / body / publish・edit時刻 / original commit / parent review ID・commitをUTF-8 JSONへcanonical serializeし、SHA-256を計算する。修正pushによるoutdated化で変わる`line` / `startLine` / `outdated`、および返信時に不要な分析コンテキストの`path` / `diffHunk`はsnapshot対象にしない。分析ドキュメントの`THREAD_NODE_ID`、`ROOT_COMMENT_DATABASE_ID`、`THREAD_SNAPSHOT_SHA256`と一意に対応しないthreadにはPOSTもresolveも行わない。

### 4. 返信の投稿

`REPLY_RESOLVE_STATE`のthread entryは`(request_round, analysis_iteration, thread_id, feedback_version, generation)`を一意keyとし、producerから受け取ったsuccessor / supersession evidenceとappend-only `reply_writes`を同じ順序のまま返す。同じrequest / iteration / threadでもfeedback version / generationを省略して既存entryへ上書きしない。

分析ドキュメントの「返信案」に基づき、各未解決スレッドに返信する。

`review-comment-analysis` / Phase12から`REPLY_RESOLVE_STATE`を渡された場合、threadごとのgeneration entryとappend-only `reply_writes`を同じ順序のままproducerへ返す。各create POSTの前に、stable write operation ID、canonical expected snapshot / SHA-256、exact reply body hashを`reply_writes[].state=prepared`、threadを`reply_pending`としてfull checkpointへ保存する。このpreparedを作った同一live executorだけが、hard interruptionなしに親のexact ackを受けた直後に1回だけPOSTできる。fresh / resume executorがlatest write `prepared` / thread `reply_pending`を受け取った場合、POST前かPOST後かを区別できないため、writeを`outcome_unknown`、threadを`reply_outcome_unknown`へ進めてPOSTせずbounded read-only convergenceで全comment pageを取得する。POST responseが作成成功を一意に示せば`created`、convergenceでexpected replyがexactly 1件なら`adopted`できるが、0件・複数・曖昧なら自動再POSTせず`incomplete`で停止する。HTTP response等でserver非作成を証明したwriteだけ`proven_not_created`にでき、retryする場合は新しいwrite operation entryとpre-write checkpointを作る。`prepared | created | adopted | outcome_unknown` writeへfresh / resume executorから再POSTしない。standaloneで安全なcheckpointを保持できない場合、結果不明のPOST後に自動再実行しない。

最初のPOST直前と、各POST・resolve直前にidentity tupleを`gh api graphql --hostname "$PR_HOST"`で再取得する。tupleのPR識別fieldが保持値と一致し、`PR_STATE == OPEN`、`HEAD_REPO` / `HEAD_REPO_URL`がnonnull、`VIEWER_CAN_EDIT_FILES == true`、現在の`HEAD_OID`が`VERIFIED_PUSHED_HEAD`と一致する場合だけ実行する。さらに対象threadを全page再取得し、root IDとcurrent snapshotが分析ドキュメントのsnapshotに一致することを要求する。resume時に保存済みwrite operationのread-only convergenceを行う場合だけ、current snapshotからcurrent viewerによる今回の返信案とexactly対応する既存reply 1件を除いたsnapshotが保存pre-write SHA-256と一致する場合を許可し、そのcurrent snapshotを`EXPECTED_THREAD_SNAPSHOT`にする。外部commentの追加・編集・削除、resolve状態変更、複数の対応reply、page取得失敗があればPOSTもresolveも行わず停止し、再分析を要求する。

```bash
gh api --hostname "$PR_HOST" "repos/$BASE_REPO/pulls/$PR_NUMBER/comments/$ROOT_COMMENT_DATABASE_ID/replies" \
  -X POST \
  -f body="返信内容"
```

**注意**:
- `reply_pending | reply_outcome_unknown | resolve_pending`中に、許可した自分のexact reply / resolve以外の正当なexternal updateを検出した場合は、新feedback versionを`pending`でappendし、旧feedback / thread generationを`superseded`へ進める。新しいfeedback version / 次generationのnonnull successorとold/new snapshotのsupersession evidenceをproducerへ返して停止し、旧generationのreplyを再POSTもresolveもしない。再分析後のlatest successor generationだけを処理する
- 対応済み（✅マーク付き）の返信案はそのまま投稿
- CAN_IGNOREの返信案もそのまま投稿
- current viewerが投稿済みの返信について、保存済みwrite operation / pre-write snapshot / author / bodyが今回の返信案（AI reviewer向けの補正文を含む）にexactに対応すると一意に検証できるthreadは、重複POSTだけをスキップする。時系列と同一bodyだけでは別実行の返信を採用しない。相手がAI reviewerならステップ5のresolve判定へ進む。対応を証明できなければPOSTもresolveも行わず停止する
- 新規POST成功後は対象threadを全page再取得し、直前の`EXPECTED_THREAD_SNAPSHOT`へcurrent viewerのexact replyが1件だけ追加され、他field・他comment・`isResolved`が変化していないことを確認してからsnapshotを更新する。競合変更があればreply済み・resolve未実施として停止する
- 相手がAI reviewerの場合は敬語を使わず、PR descriptionのようなメモ調で返信する
- 相手がAI reviewerの場合、返信本文の先頭は必ず `対応済み:` / `対応不要:` / `一部対応:` のいずれかにする。分析ドキュメントの返信案がこの形式でない場合は、投稿前に意味を変えずに文体と先頭ステータスだけ補正する

### 5. スレッドのResolve

- **相手がAI reviewer（bot）の場合**: 新規返信、またはステップ4で検証済みの既存返信を確認後、resolve直前の全page snapshotが`EXPECTED_THREAD_SNAPSHOT`と完全一致する場合だけ該当スレッドをresolvedにする。
- **相手が人間のレビュアーの場合**: resolveしない。レビュアー本人が確認してresolveするのを待つ。

```bash
gh api graphql --hostname "$PR_HOST" \
  -f query='
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread {
        isResolved
      }
    }
  }
' \
  -F threadId="$THREAD_NODE_ID"
```

mutationのresponseで`thread.isResolved == true`を確認する。続けて対象threadの全comment pageを再取得し、root IDと全comment fieldがresolve直前の`EXPECTED_THREAD_SNAPSHOT`から変わらず、`isResolved`だけがfalseからtrueへ変わったことを確認して初めてresolve成功とする。false、null、GraphQL error、外部comment追加・編集・削除、または再取得失敗の場合はresolve済みと報告せず、残りのthreadを処理せず停止する。

### 6. 結果報告

対象PRを `#<PR番号> <PRタイトル>（<PR URL>）` の形式で1行報告する。

投稿した返信の一覧を表示する。

| スレッド | 返信内容 |
|---------|---------|
| ファイル:行番号 | 返信内容（省略） |

thread外feedbackはchannel、namespaced feedback ID、分析上の対応状況を一覧で報告し、「thread mutation対象外」と明記する。黙って成功件数から除外しない。

## 制約事項

- `superseded`の旧thread generationには再投稿・resolveを行わず、successor / supersession evidenceで一意に結ばれたlatest generationだけを処理する

- 分析ドキュメントが存在しない場合は返信しない
- producerから`REVIEW_DECISION_PATHS`を受け取った場合は全exact listを使用し、別pathへ置換・再探索しない
- 分析結果の`VERIFIED_PUSHED_HEAD`と現在のGitHub `HEAD_OID`が一致しない場合は返信・resolveしない
- PRがOPENでない、head repositoryが削除済み、または`VIEWER_CAN_EDIT_FILES`がfalseの場合は返信・resolveしない
- 返信内容は分析ドキュメントの「返信案」をそのまま使用する。ただしAI reviewer宛てで先頭ステータスや文体が不適切な場合は、意味を変えずに `対応済み:` / `対応不要:` / `一部対応:` で始まるメモ調へ補正してから投稿する
- 検証済みの既存返信があるスレッドには二重投稿せず、fresh / resume executorがpreparedを受け取った場合とcreate POSTの結果不明時は0件でも自動再POSTしない。bot threadのresolveだけ未完了ならidempotent state setとしてresolve判定を再実行できる
- 返信・resolveは未解決review thread項目だけに行い、thread外feedbackには行わない
