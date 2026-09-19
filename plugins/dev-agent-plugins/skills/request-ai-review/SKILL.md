---
name: request-ai-review
description: PRの最終headにCopilot / Codex / GeminiのAIレビュー依頼境界を作成する
allowed-tools: Bash(gh *), Bash(git status:*), Bash(git rev-parse:*), Bash(git ls-remote:*), Bash(git remote:*), Bash(jq:*), Bash(shasum:*)
---

対象PRの変更がすべてpush済みであることを確認し、reviewer policyで有効なGitHub Copilot、OpenAI Codex、Gemini Code Assistへレビューを依頼する。依頼直前の全feedback channelをbaselineとして保存し、後続処理が過去レビューを今回の結果として数えないためのrequest boundaryを返す。

## 引数

`$ARGUMENTS`

- **推奨**: canonical PR URL
- **PR番号**: current repositoryを一意に特定できる場合だけ使用する
- **未指定**: current branchに紐づくPRがexactly 1件の場合だけ使用する

番号だけを別repositoryやdefault hostへ再解決しない。上位commandからidentityを渡された場合は、その値を優先して再取得値との完全一致を要求する。

reviewer policyも値として保持する。上位commandから明示されたpolicyを優先し、standalone既定値は次とする:

```
copilot: enabled
codex: enabled
gemini: disabled
```

`gtr-new`などが`copilot: disabled`を渡した場合はCopilotのrequest mutation、baseline、監視を行わず`status = disabled`を返す。暗黙にpolicyを変更しない。
上位commandまたはユーザーが`gemini: disabled`を指定した場合も、Geminiのavailability分類、baseline、request mutation、監視を行わず`status = disabled`を返す。

再レビューroundで上位commandから`TARGET_REVIEWERS`のexact setを渡された場合は、`copilot | codex | gemini`だけからなる重複なしのsetであることを検証し、そのsetを依頼対象の上限かつ`REQUIRED_REVIEWERS`のexact setとする。set外のreviewerはpolicyが`enabled` / `auto`でもtriggerせず`status = not_targeted`を返す。target内reviewerがpolicyでdisabledならmutation前に`incomplete`として停止する。

`REQUESTED_REVIEWERS`と`REQUIRED_REVIEWERS`は別々に返す。前者は`status == requested`になったtrigger成功reviewerだけ、後者はroundを完了するために解消が必要なreviewerである。`TARGET_REVIEWERS`未指定の初回roundでは、policyの対象になり`status == requested | incomplete`となったreviewerを`REQUIRED_REVIEWERS`へ含め、`disabled`、`not_targeted`、権限ある完全inventoryで証明した`not_installed`の`skipped`は除く。再レビューroundでは`REQUIRED_REVIEWERS == TARGET_REVIEWERS`を維持し、依頼失敗やavailability変化で集合を縮めない。`REQUESTED_REVIEWERS`が`REQUIRED_REVIEWERS`に満たないroundは`incomplete`だが、未解消reviewerを次roundで`not_targeted`へ落とさない。

## 1. PR identityと最終headを検証

canonical PR URLから`PR_HOST`を抽出し、`gh api graphql --hostname "$PR_HOST"`で以下を**同じ名称・順序**の12-field identity tupleとして取得する:

1. `BASE_REPO`
2. `PR_NUMBER`
3. `PR_URL`
4. `PR_STATE`
5. `HEAD_REPO`
6. `HEAD_REPO_URL`
7. `HEAD_REF`
8. `HEAD_OID`
9. `BASE_REF`
10. `BASE_OID`
11. `VIEWER_CAN_EDIT_FILES`
12. `IS_CROSS_REPOSITORY`

同じresponseから`baseRepository.id`を`BASE_REPO_NODE_ID`として保持する。検証済み`PR_HOST`、`BASE_REPO_NODE_ID`、`PR_NUMBER`から`DERIVED_DEDICATED_BRANCH=chore/pr-head/$PR_HOST/$BASE_REPO_NODE_ID/$PR_NUMBER`を必ず導出し、ref-safeな値であることを確認して`DEDICATED_BRANCH`とする。上位commandから`DEDICATED_BRANCH`が渡された場合はtrigger前に導出値とのexact一致を要求し、不一致ならbaseline取得やrequest mutationを行わず停止する。worktree path、local branch等の上位値は別途保持する。

レビュー依頼前に次をすべて満たすこと。不一致ならコメントを1件も投稿せず停止する:

- `PR_STATE == OPEN`で、12-field identityと`BASE_REPO_NODE_ID`が保持値に一致する
- worktreeがcleanで、local `HEAD`が`HEAD_OID`に一致する
- `git ls-remote <検証済みraw push URLまたはHEAD_REPO_URL> "refs/heads/$HEAD_REF"`のOIDが`HEAD_OID`に一致する
- `BASE_REF` / `BASE_OID`が保持値に一致する

一致した完全長OIDを`REQUEST_HEAD_OID`、baseを`REQUEST_BASE_REF` / `REQUEST_BASE_OID`、tupleと補助identityの`PR_HOST`、`BASE_REPO_NODE_ID`、導出・検証済み`DEDICATED_BRANCH`を`REQUEST_IDENTITY`として必ず凍結する。standalone実行でも`DEDICATED_BRANCH`を省略しない。上位Aのsaved baseからcandidate Bのbaseが進んでいる場合、base ref同一かつ各saved→latest OIDがnormal descendantだとcommit graphで証明し、(a) Aを`invalidated_base_advanced`として保存した通常経路、または (b) Aが`outcome=incomplete` / reason `retry_after_incomplete` / successor Bを保持し、append-only `rotation_evidence`にverified P→C、`base_advance_evidence`に`transition_prepared | non_idle_recovery | post_rotation_idle`各観測のA/B/P/C proofと`coalesced_retry_rotation`が欠落なくある経路だけ続行する。(b)のpost-rotation evidenceはoperation nullでもよいが、観測時にB ledger / candidate / baseline / writeが未作成だった証跡を要求する。いずれもC後のlatest base / identity / expected OIDが再凍結済み、`GIT_MUTATION_STATE.state=idle` / operation null、`pending_base_advance=null`、candidate keyがB、rotation childがCの1件だけで2回目のrotationがないことを検証する。base retarget、force rewrite、ancestry取得不能、base以外のidentity変更は停止する。

## 2. reviewer別baselineを取得

各reviewerのtriggerを投稿する**直前**に、以下を全page取得する。`gh api --paginate --slurp`を使う場合は`--jq`を同じ呼び出しに混ぜず、取得したpage配列を後段でflattenする。最初の100件だけで判定しない。

- REST top-level reviews: `repos/$BASE_REPO/pulls/$PR_NUMBER/reviews?per_page=100`
- REST review comments: `repos/$BASE_REPO/pulls/$PR_NUMBER/comments?per_page=100`
- REST issue comments: `repos/$BASE_REPO/issues/$PR_NUMBER/comments?per_page=100`
- REST timeline events: `repos/$BASE_REPO/issues/$PR_NUMBER/timeline?per_page=100`
- GraphQLのresolved / unresolvedを含む全reviewThreadsと、各threadの全comments

各channelを別namespaceにし、ID setだけでなくcanonical snapshotも保存する。snapshotには利用可能な範囲で次を含める:

- namespaced ID、node ID、review ID、thread ID、parent ID
- actor loginとactor type
- `created_at` / `submitted_at` / `publishedAt`
- `updated_at` / `lastEditedAt`
- 改行を正規化したbodyのSHA-256
- `commit_id` / `original_commit_id` / GraphQL `commit.oid` / `originalCommit.oid`
- timeline event type、reviewer、requested reviewer

同じIDのplaceholderが依頼後に編集された場合も検出できるよう、body hashと更新時刻を省略しない。nested GraphQL connectionもcursorがなくなるまで取得する。

baselineはreviewerごとに独立して取得し、`AI_REQUESTS.<reviewer>.baseline`へ次のchannel名で保存する:

```
top_level_reviews
review_comments
issue_comments
timeline_events
review_threads
```

### 2.5. request transition checkpoint（trigger mutationの必須境界）

Phase12 / review-comment-analysisから呼ばれた場合は、上位のfull `PHASE12_CHECKPOINT.REQUEST_TRANSITION_STATE`とappend-only `REQUEST_ATTEMPT_LEDGER`を同じ名称で受け取り、各transition後にfull checkpointを上位へ返す。standaloneでも同じstate / ledgerを戻すが、呼び出しcontextを失った後にcheckpointなしでresumeしてはならない。`REQUEST_TRANSITION_STATE`は常に`REQUEST_ATTEMPT_LEDGER.entries[-1].transition`とexactに一致させ、entryを削除・並替えたり、current / previous boundary上書き後に古いattemptを失ったりしない。

Phase11からは`PHASE11_MODE=initial | resume_no_boundary`を必須入力として受け取る。`initial`はledgerが空の最初のattemptだけ、`resume_no_boundary`は最新entryが成功trigger 0件、`boundary=null`、`outcome=incomplete_no_boundary`、nonnull full `incomplete_evidence`でtransitionとexact一致し、全create writeが`proven_not_created`と検証できる場合だけ許可する。Phase12 checkpointからのresumeではさらにglobal `ROUND_OUTCOME=incomplete` / `ROUND_STATE=incomplete_no_boundary`との同一post-checkpoint tupleを要求する。後者は同じcandidate roundのattemptを1増やしてfresh baselineを取得する。結果不明・複数・曖昧writeを含むentry、または有効boundary成立済みのentryを`resume_no_boundary`で再実行しない。standalone初回だけmode未指定を`initial`として扱えるが、resumeを推測しない。

最初のtrigger mutationより前に、番号順にかかわらずステップ5のread-only availability分類を完了し、candidateのhead / base / full identity、reviewer policy、`TARGET_REVIEWERS`、上記規則で導出した`REQUIRED_REVIEWERS`、candidate `REQUEST_ROUND`、単調増加する`REQUEST_ATTEMPT`を凍結する。candidate `REQUEST_STARTED_AT=null`、`REQUESTED_REVIEWERS=[]`、`REQUEST_TRANSITION_STATE.state=in_progress`とし、同じtransitionをround / attempt key付き、`rotation_evidence=[]`、`base_advance_evidence=[]`、`terminal_evidence=null`、`incomplete_evidence=null`としたentryを`REQUEST_ATTEMPT_LEDGER`末尾へappendする。先行attemptが無効化済みならその`successor`を新keyへ単調更新し、ledger chainを検証してから全reviewerを`not_started`から開始する。disabled / not_targeted / 初回roundで証明済みnot_installedのreviewerはmutationせず`skipped`、availability / policy上依頼不能だがrequiredのreviewerは`incomplete`としてfull evidenceを保存する。

依頼対象reviewerごとに次を順守する:

1. candidate identity / head / baseとcurrent local / raw remote / GitHub stateを再検証し、全channel / 全pageのfull baselineを取得する
2. baselineを`AI_REQUESTS.<reviewer>.baseline`とtransition reviewer entryへ同じ値で保存し、entryを`baseline_captured`にする。exact method / endpoint / body-or-reviewer / actorを`expected_trigger`、round / attempt / reviewerへbindingしたstable IDを`write_operation_id`として凍結する
3. entryを`write_prepared`、`write_state=prepared`へ更新したfull checkpointを上位へ返す。このprepared stateを作成した同一のlive executorだけが、hard interruptionなしに上位のexact ackを受け取った直後にcreate POSTを1回行える。ack tokenはexecutorを跨いで再構成・移譲しない
4. POST responseが作成成功を一意に示せば`write_state=created` / `requested`、server非作成を明示すれば`proven_not_created`、responseが不明なら`write_state=outcome_unknown` / `write_outcome_unknown`としてfull server response / evidenceを含むfull checkpointを即時に返す

fresh / resume executorが保存済み`write_state=prepared`を受け取った場合、POST前かPOST後かを区別できないため、そのstateをPOST許可として再利用しない。即座に`write_outcome_unknown`へ単調遷移してfull checkpointを返し、create mutationを行わず、保存baseline以後の全channel / 全pageをbounded read-only convergenceとして再取得する。保存済み`outcome_unknown`も同じread-only経路だけを使う。baselineに存在しないartifactのうち、保存済み`expected_trigger`のmethod / endpoint / exact body-or-reviewer / actorとcandidate identity / head / baseに一致するserver response / eventを抽出する。

- exactly 1件なら、そのserver response / eventを今回attemptのtriggerとして`write_state=adopted` / `requested`へ進め、再POSTしない
- 0件、複数件、expected triggerとの曖昧な一致、full identity / head / base変更、baseline欠落なら`incomplete`で安全停止し、自動再POSTも既存triggerの推測採用も行わない
- retryはHTTP error response等でserver非作成を一意に証明して`write_state=proven_not_created`にできた場合だけ候補にできる。成功trigger 0件かつ全create writeが`proven_not_created`でも、先にboundary null、transition / ledger `incomplete_no_boundary`、nonnull full incomplete evidence、上位用global `ROUND_OUTCOME=incomplete` / `ROUND_STATE=incomplete_no_boundary`のresult tupleを返す。上位が同じpost-checkpointへ保存した完全tupleを検証した`resume_no_boundary`だけ、同じcandidate roundの`REQUEST_ATTEMPT`を増やし、fresh baselineを持つ新ledger entryをappendして最初から試行する。outcome unknown / 複数 / 曖昧writeが1件でもあれば自動retryしない
- `prepared` / `requested` / `created` / `adopted` / `outcome_unknown` entryはfresh / resume executorから再POSTしない。`baseline_captured`なら保存済みbaselineを維持したまま、そのexecutor自身が新しい`write_prepared` checkpointを作成し、同一live executionでackを受けた場合だけ最初のPOSTへ進める

POST許可に使う前の`write_prepared` checkpointが親へ届かなかったhard interruptionでは、uncheckpointed triggerの有無をGitHubの現在値から推測せず停止する。親がpreparedを保持済みでも、POST結果checkpoint前にexecutorが失われた場合は上記read-only convergenceだけを行い、0件・複数・曖昧なら`incomplete`として自動retryしない。candidate baselineはrequest attempt全体を通してimmutableとし、resume後やPOST後のsnapshotで置き換えない。これにより、baselineと同じIDがtrigger前のraceで更新されても、後続処理が単発のbody hash差だけを今回responseへ誤分類することを防ぐ。

全reviewer entryが`requested | skipped | incomplete | proven_not_created`のterminal stateになり、candidate identity / head / baseとrequest集合規則を再検証できた場合だけrequest resultを確定する。上位は成功triggerが1件以上ある有効なcandidateだけを`CURRENT_REQUEST_BOUNDARY`へ昇格し、`REQUEST_TRANSITION_STATE.state=complete`、ledger entryの`boundary` / `outcome`を更新する。そのcandidateでrequiredに不足がある場合は集合を縮めず、未依頼required reviewerごとのrequest failure / quota / permission / availabilityを網羅するnonnull `incomplete_evidence`とledger最新entry `outcome=incomplete`を返し、上位はglobal `ROUND_OUTCOME=incomplete`と同じatomic post-checkpointへ保存する。成功triggerが0件なら、`REQUEST_TRANSITION_STATE.state=incomplete_no_boundary`とlatest entry transitionをexact一致させ、entry `boundary=null`、`outcome=incomplete_no_boundary`、全reviewer write resultと成功trigger 0件を示すnonnull `incomplete_evidence`を返す。上位は同じpost-checkpointで`ROUND_STATE=incomplete_no_boundary`、global `ROUND_OUTCOME=incomplete`、このtransition / ledger tupleを保存し、旧current boundaryを置き換えない。全writeの非作成が証明済みの場合だけ後続`retry_without_boundary`を許可し、結果不明・複数・曖昧writeでは自動retryしない。

## 3. Copilotへ依頼（policyがenabledで、target未指定またはtarget内の場合）

`TARGET_REVIEWERS`が未指定またはCopilotがtarget内なら、上記transition protocolでCopilot用baselineと`write_prepared` checkpointを確定し、親の保持確認後にだけ正式reviewer requestを送る:

```bash
gh api --hostname "$PR_HOST" \
  -X POST "repos/$BASE_REPO/pulls/$PR_NUMBER/requested_reviewers" \
  -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

POST前のtimeline baselineと比較し、POST後に新しく作成された`review_requested` eventを全pageから取得する。`requested_reviewer.login == copilot-pull-request-reviewer[bot]`かつ`requested_reviewer.type == Bot`を厳密に確認する。eventの`actor`はBotではなく依頼操作したuserなので、取得可能ならcurrent viewerとの一致を相関証拠にする。そのeventの`id`、API URL、canonical event body、GitHub server `created_at`をtrigger evidenceとして保存し、`requested_at = created_at`とする。

HTTP successだけ、既存pending request、過去の`review_requested` eventを今回のtriggerとして再利用しない。fresh eventを一意に証明できなければ`status = incomplete`とする。成功時は`status = requested`。policyがdisabledなら`status = disabled`、`TARGET_REVIEWERS`のset外なら`status = not_targeted`とし、依頼も監視も行わない。

## 4. Codexへ依頼（target未指定またはtarget内の場合）

`TARGET_REVIEWERS`が未指定またはCodexがtarget内なら上記transition protocolでbaselineと`write_prepared` checkpointを確定し、identity、base、local/raw remote/GitHub headを再検証してからREST APIで新しいtrigger commentを投稿する。`gh pr comment`の表示結果から時刻を推測せず、POST responseそのものを保存する:

```bash
gh api --hostname "$PR_HOST" \
  -X POST "repos/$BASE_REPO/issues/$PR_NUMBER/comments" \
  -f body='@codex review'
```

responseの`id`、`html_url`、`body`、`created_at`を保存し、`requested_at = created_at`とする。loginの識別には後続処理でREST `chatgpt-codex-connector[bot]`、GraphQL `chatgpt-codex-connector`との完全一致とBot typeを使う。substring一致は禁止する。

POST成功時は`AI_REQUESTS.codex.status = requested`、失敗時は`incomplete`としてHTTP errorを記録する。`TARGET_REVIEWERS`のset外なら投稿せず`status = not_targeted`とする。既存の古いtriggerやレビューを再利用しない。

## 5. Geminiのavailabilityを分類

Geminiは次の5 stateのどれか1つに分類する:

```
available | not_installed | unknown_permission | temporarily_unavailable | retired
```

判定規則:

- `available`: 権限あるinstallation inventoryまたは明示的な現在のservice responseにより、このrepositoryでGemini Code Assistを利用可能と証明できた
- `not_installed`: 権限あるinstallation inventoryを**全page**取得でき、このrepositoryを対象にするGemini installationが存在しないことを証明できた
- `unknown_permission`: 401 / 403、通常PATでは利用できないGitHub App endpoint、page取得不能、不完全inventory、またはconsumer / enterprise variantを判別できない
- `temporarily_unavailable`: 429、5xx、network error、quotaなど一時的な失敗
- `retired`: serviceからの明示的なretirement signalがある場合、またはinstallation variantがconsumer版だと証明でき、かつ公式shutdown境界を過ぎている場合だけ。日付だけ、consumer証明だけのどちらか一方でretiredと推測しない

`repos/$BASE_REPO/installation`はauthenticated GitHub App自身のJWTを要求するendpointであり、通常PATの401を「未導入」に読み替えない。`user/installations`もGitHub App user access tokenが必要であり、token種別不適合の403は`unknown_permission`とする。過去activityが見つからないことや検索対象数件だけを根拠に`not_installed`へ分類しない。

consumer版のcode review終了後もGemini Code Assist Enterpriseは影響を受けないため、現在日付だけでは`retired`にしない。判定時は次の一次資料を基準にする:

- [GitHub REST API: GitHub App installations](https://docs.github.com/en/rest/apps/installations)
- [GitHub REST API: GitHub Apps](https://docs.github.com/en/rest/apps/apps)
- [Gemini Code Assist consumer code review deprecation](https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review)
- [Gemini Code Assist code review variants](https://docs.cloud.google.com/gemini/docs/code-review/review-repo-code)

## 6. Geminiへ依頼

`available`かつ`TARGET_REVIEWERS`が未指定またはGeminiがtarget内の場合だけ、上記transition protocolでGemini用baselineと`write_prepared` checkpointを確定し、identity/head/baseを再検証してから新しいtriggerをREST APIで投稿する:

```bash
gh api --hostname "$PR_HOST" \
  -X POST "repos/$BASE_REPO/issues/$PR_NUMBER/comments" \
  -f body='/gemini review'
```

responseの`id`、`html_url`、`body`、`created_at`を保存し、`requested_at = created_at`とする。REST bot loginは`gemini-code-assist[bot]`、GraphQL loginは`gemini-code-assist`との完全一致とBot typeで識別する。

- `available`かつPOST成功: `status = requested`
- `TARGET_REVIEWERS`のset外: triggerせず`status = not_targeted`
- 完全inventoryで証明した`not_installed`: `status = skipped`。初回roundでは監視対象外かつ`REQUIRED_REVIEWERS` / `incomplete`には含めない。再roundで`TARGET_REVIEWERS`に含まれていたreviewerならrequired集合から落とさず、再依頼不能なroundを`incomplete`とする
- `unknown_permission` / `temporarily_unavailable` / `retired`: `status = incomplete`。指摘0件には数えない
- POST失敗: `status = incomplete`

availabilityが`available`以外、またはGeminiがtarget外なら`/gemini review`を投稿しない。

## 7. request boundaryを確定

全reviewer transitionがterminalになった後にfull 12-field identity、`BASE_REPO_NODE_ID`、base、local `HEAD`、raw remote OID、GitHub `HEAD_OID`を再取得する。いずれかが凍結値と違えば、このラウンドを無効として報告し、別PRへ再解決しない。reviewer entryが`not_started | baseline_captured | write_prepared | write_outcome_unknown`の間はrequest boundaryを確定しない。

実際に成功したtrigger comment responseまたはfresh `review_requested` eventのGitHub server `created_at`の最小値を`REQUEST_STARTED_AT`とする。local clock、command開始時刻、既存comment/event時刻で代用しない。成功triggerが0件ならrequest boundaryは成立せず`incomplete`とする。

`status == requested`のreviewer exact setを`REQUESTED_REVIEWERS`として確定し、上記規則で`REQUIRED_REVIEWERS`を別に確定する。`TARGET_REVIEWERS`が渡されている場合は`REQUIRED_REVIEWERS == TARGET_REVIEWERS`を要求する。`REQUESTED_REVIEWERS`が`REQUIRED_REVIEWERS`に満たない場合はround全体を`incomplete`とするが、required集合そのものは成功集合へ縮めない。availability自体は証明済み`not_installed`の`skipped`でも、直前roundでrequiredだったreviewerを再依頼できなかった事実は省略しない。成功trigger 0件なら`REQUEST_STARTED_AT=null`、boundary null、transition / ledger `incomplete_no_boundary`、nonnull incomplete evidence、上位用global `ROUND_OUTCOME=incomplete` / `ROUND_STATE=incomplete_no_boundary`を1つのresult tupleとして返し、Phase12 initialを起動しない。

reviewerごとに次の構造を完全に返す。baselineのID set / snapshotを省略した要約だけでは完了にしない:

```
REQUEST_HEAD_OID: <40-character OID>
REQUEST_BASE_REF: <base ref>
REQUEST_BASE_OID: <40-character OID>
REQUEST_STARTED_AT: <GitHub server timestamp>
REQUEST_IDENTITY: <12-field tuple + PR_HOST + BASE_REPO_NODE_ID + DEDICATED_BRANCH>
REVIEWER_POLICY: <実際に適用したreviewer policy>
TARGET_REVIEWERS: <上位commandから渡されたexact set / 初回はnull>
REQUIRED_REVIEWERS: <round完了に必要なreviewerのexact set>
REQUESTED_REVIEWERS: <status == requestedのreviewer exact set>
REQUEST_TRANSITION_STATE: <REQUEST_ATTEMPT_LEDGER最新entry.transitionとexact一致するcandidate / REQUEST_ATTEMPT / REQUEST_ROUND / reviewer別write state・full baseline・expected trigger・trigger response/evidence>
REQUEST_ATTEMPT_LEDGER: <全attemptのcandidate / reviewer evidence / boundary / outcome / invalidation reason / successor / rotation / base advance / terminal / incomplete evidenceを保持するappend-only entries>
AI_REQUESTS:
  copilot:
    policy: enabled | disabled
    status: requested | disabled | not_targeted | incomplete
    rest_login: copilot-pull-request-reviewer[bot]
    trigger: {kind: review_requested, id, url, body, created_at} | null
    requested_at: <trigger created_at> | null
    request_head_oid: <REQUEST_HEAD_OID>
    request_base_ref: <REQUEST_BASE_REF>
    request_base_oid: <REQUEST_BASE_OID>
    baseline: <channel別ID sets + canonical snapshots> | null
  codex:
    status: requested | not_targeted | incomplete
    rest_login: chatgpt-codex-connector[bot]
    graphql_login: chatgpt-codex-connector
    trigger: {id, url, body, created_at} | null
    requested_at: <trigger created_at> | null
    request_head_oid: <REQUEST_HEAD_OID>
    request_base_ref: <REQUEST_BASE_REF>
    request_base_oid: <REQUEST_BASE_OID>
    baseline: <channel別ID sets + canonical snapshots> | null
  gemini:
    availability: available | not_installed | unknown_permission | temporarily_unavailable | retired
    status: requested | skipped | not_targeted | incomplete
    evidence: <判定根拠と取得範囲>
    rest_login: gemini-code-assist[bot]
    graphql_login: gemini-code-assist
    trigger: {id, url, body, created_at} | null
    requested_at: <trigger created_at> | null
    request_head_oid: <REQUEST_HEAD_OID>
    request_base_ref: <REQUEST_BASE_REF>
    request_base_oid: <REQUEST_BASE_OID>
    baseline: <channel別ID sets + canonical snapshots> | null
```

対象PRは番号だけでなく`#<PR番号> <PRタイトル>（<PR URL>）`として報告する。

## 制約

- コード、文書、PR description、branchは変更しない
- GitHub mutationはreviewer policyで許可されたCopilot reviewer requestとreview trigger commentだけに限定する
- trigger投稿後に通常の編集・commit・pushを行わない
- 一部reviewerの依頼失敗を、他reviewerの成功や指摘0件で相殺しない
- `REQUESTED_REVIEWERS`を`REQUIRED_REVIEWERS`の代用にせず、未解消reviewerを再roundのtargetから落とさない
- `DEDICATED_BRANCH`は検証済みidentityから毎回導出し、上位値の不一致やstandalone実行を理由に省略・推測しない
- `write_prepared` checkpointの親保持確認前にPOSTせず、同一live executorだけがack直後に最初のPOSTを行う。fresh / resume executorがpreparedを受け取った場合とcreate POSTの結果不明時はread-only convergenceだけを行う。0件・複数・曖昧なら自動再POSTせず、server非作成を証明できる場合だけ新attemptを許可する。checkpointが届かなかったhard interruptionや曖昧なtrigger evidenceから継続を推測しない
- reviewer policyでdisabledのreviewerは依頼も監視も行わない。standalone既定policyを暗黙に変更しない
