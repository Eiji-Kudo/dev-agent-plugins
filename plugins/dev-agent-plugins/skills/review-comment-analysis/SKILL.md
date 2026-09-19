---
name: review-comment-analysis
description: PRの全review channelを依頼境界と照合し、必要な修正・push・返信・resolveまで行う
---

PRのコードレビューアとして、review thread、top-level review、review comment、issue comment、timeline eventを収集・分析し、各feedbackが妥当かどうか、修正すべきかどうかを評価した一覧を作成する。

このコマンドは、分析結果を保存したうえで、最終判定が修正対象のfeedbackを修正し、push・返信・resolve・全required reviewerの再レビュー監視まで行う。分析だけで止めたい場合は、ユーザーが明示的に「分析のみ」と指定したときに限る。

**重要: このタスクは複雑な判断を伴うため、ultrathink を使用して深く思考すること。**

## 引数

`$ARGUMENTS`

- **指定あり**: PR URL、番号、`#N`、`prN`のいずれかとして解決する
- **未指定**: 会話コンテキスト内のPR番号・PR URLから候補を収集する。候補がなければ`gh pr view`で現在のブランチに紐づくPRを解決する
- **候補が複数ある場合**: 直近性などから推測で選ばず、mutationを開始せずに停止する

## 実行フロー

このコマンドは**自己ループ**で動作する。下記ステップ2〜9.5（全channel取得→分析→検証→修正→push→返信）を1イテレーションの本体とし、pushで現在のrequest boundaryを無効化した場合はステップ9.6でレビュー対象を全員再依頼する。**最終headにbindingされた明示的な最終responseで未対応指摘0件になるまで、または最大5イテレーションに達するまで**、ステップ2に戻って繰り返す。

ループ制御の要点:

- `request-ai-review`から`REQUEST_HEAD_OID`、`REQUEST_BASE_REF` / `REQUEST_BASE_OID`、`REQUEST_STARTED_AT`、`REQUEST_IDENTITY`、`REVIEWER_POLICY`、`TARGET_REVIEWERS`、`REQUIRED_REVIEWERS`、`REQUESTED_REVIEWERS`、reviewer別`AI_REQUESTS`を渡された場合を**boundary mode**とする。全値が揃わない部分的なboundary、`REQUESTED_REVIEWERS`と`status == requested`の集合不一致、または下記required集合規則に反するboundaryは使用せず`incomplete`として停止する。初回roundの`TARGET_REVIEWERS = null`は欠落ではなく明示値として扱う。
- boundary modeではreviewer別baseline後かつ`requested_at`以後の新規・更新feedbackだけを今回のarrival候補にし、head/base/full identityへbindingできた明示的な最終responseだけをterminalにする。
- boundaryなしのstandalone実行では現在の全feedbackを分析できるが、そのboundaryless roundだけから「今回のレビュー到着」「最終headの指摘0件」「AIレビューround完了」は認定しない。分析のみでなければ、既存feedbackが0件の場合も含めて修正・返信・cleanupを終えた最終headへstandalone既定policy・`TARGET_REVIEWERS = null`で初回request boundaryを作り、boundary modeへ移行する。
- 1件でも対応・文書化・cleanupによるcommit/pushがあれば全reviewer分のroundを無効化する。他reviewerのterminal responseも再利用せず、全処理後のheadに対して直前roundの`REQUIRED_REVIEWERS`全員へ再依頼する。
- timeout、quota、permission、依頼失敗、Geminiの`unknown_permission` / `temporarily_unavailable` / `retired`は`incomplete`であり0件扱いしない。権限ある完全inventoryで証明した`not_installed`の`skipped`だけは監視対象外・`incomplete`外にできる。
- 無限ループ防止のため**最大5イテレーション**。5周しても未対応指摘または`incomplete`が残る場合は完了扱いせず、その内容を報告して終了する。

ステップ1・1.5（PR情報取得・作業ディレクトリ選択）はループ外で1回だけ実行する。ステップ3.5（critics reviewドキュメント確認）も初回のみでよい。

### 1. PR情報の取得

URL、番号、`#N`、`prN`、会話から抽出した候補、current branchのいずれも、最終的に一意なPR URLへ解決する。候補が0件または複数件なら停止する。明示URLはそのrepositoryを使い、番号系とcurrent branchはcurrent local repositoryのremote URLを`gh repo view <remote-url> --json nameWithOwner,url`で照合してbase repositoryを決める。

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

分析成果物とpush検証refも同じidentityでnamespaceする。既定の出力pathを`temp-docs/review-decisions-$PR_HOST-$BASE_REPO_NODE_ID-pr-$PR_NUMBER.md`とし、`VERIFIED_PUSH_REF=refs/pr-workflow/verified-push/$PR_HOST/$BASE_REPO_NODE_ID/$PR_NUMBER`も保持する。legacyの番号だけのpath / refは読み書きせず、現在のPRに対するauthorizationとして扱わない。`temp-docs/`が存在しない場合は、成果物の保存直前に作成する。

Phase12から実行するときは`PHASE12_MODE=initial | resume`を必須入力とする。Phase12 inputや`PHASE12_CHECKPOINT`を受け取ったのにmodeがない場合はstandaloneと推測せず停止する。直接起動され、Phase12 inputもcheckpointもない場合だけ`standalone`として扱う。

- `standalone`: この場合だけ`ROUND_STATE=boundaryless`、`ROUND_OUTCOME=monitoring`、`REVIEW_DECISION_PATHS=[]`、`CREATED_REVIEW_DECISION_PATHS=[]`、`CURRENT_REQUEST_BOUNDARY=null`、`PREVIOUS_REQUEST_BOUNDARY=null`、`PREVIOUS_REQUIRED_REVIEWERS=[]`、`ANALYSIS_ITERATION=0`、`REQUEST_ROUND=1`、request / feedback ledger、cleanup obligations / reply-resolve threadsを空、git mutationをidleで初期化する。`REQUEST_TRANSITION_STATE.state=idle`とする
- `PHASE12_MODE=initial`: Phase11から成功trigger 1件以上の有効boundary、full transition、append-only request attempt ledgerを受け取った場合だけ許可する。この場合だけ`ROUND_STATE=active`、`ROUND_OUTCOME=monitoring`と上記の空初期値を使い、request ledgerは受領値を順序のまま保持する。Phase12 initialは`PHASE12_CHECKPOINT = null`を要求する
- `PHASE12_MODE=resume`: 直前に返されたfull `PHASE12_CHECKPOINT`を必須とし、次の同名fieldをすべてexactに復元する。両path list、current / previous boundary、round state / outcome、previous required reviewers、iteration / round、request / feedback ledger、cleanup generation、git mutation、thread substate、request transitionを空resetしない。GitHubの現在値、glob、既定path、単一path、file存在から欠落stateを再構成しない

```
PHASE12_CHECKPOINT:
  CHECKPOINT_VERSION: 9
  CHECKPOINT_IDENTITY: <checkpoint時点の12-field identity + PR_HOST + BASE_REPO_NODE_ID + DEDICATED_BRANCH>
  CODEX_EXTERNAL_REVIEW_AUTHORIZED: <true | false。trueの場合は許可発言・確認時刻・対象PR_URLのexact evidenceを必須とする>
  CODEX_LOCAL_REVIEW: <gtr-newのlocal fallback構造 | null>
  CODEX_REVIEW_SKIP: <gtr-newのusage limitスキップ構造 | null>
  ROUND_STATE: boundaryless | active | invalidated | retry_after_incomplete | incomplete_no_boundary | retry_without_boundary | invalidated_base_advanced
  ROUND_OUTCOME: monitoring | findings | zero | incomplete
  EXPECTED_LOCAL_OID: <40-character OID>
  EXPECTED_REMOTE_OID: <40-character OID>
  REVIEW_DECISION_PATHS: <current roundのexact list>
  CREATED_REVIEW_DECISION_PATHS: <append-only dedup exact path history>
  CURRENT_REQUEST_BOUNDARY: <full request boundary structure | null>
  PREVIOUS_REQUEST_BOUNDARY: <同じfull structure | null>
  PREVIOUS_REQUIRED_REVIEWERS: <exact set>
  ANALYSIS_ITERATION: <0..5>
  REQUEST_ROUND: <1以上>
  REQUEST_TRANSITION_STATE:
    state: idle | in_progress | complete | incomplete_no_boundary | retry_without_boundary
    ledger_key: {request_round: <1以上>, request_attempt: <1以上>} | null
    candidate:
      REQUEST_HEAD_OID: <OID | null>
      REQUEST_BASE_REF: <base ref | null>
      REQUEST_BASE_OID: <base OID | null>
      REQUEST_STARTED_AT: <GitHub server timestamp | null>
      REQUEST_IDENTITY: <full identity | null>
      REVIEWER_POLICY: <policy | null>
      TARGET_REVIEWERS: <exact set | null>
      REQUIRED_REVIEWERS: <exact set | null>
      REQUESTED_REVIEWERS: <exact set>
      REQUEST_ATTEMPT: <0以上>
      REQUEST_ROUND: <1以上>
    reviewers:
      <copilot | codex | gemini>:
        state: not_started | baseline_captured | write_prepared | write_outcome_unknown | requested | skipped | incomplete | proven_not_created
        baseline: <全channelのfull ID set + canonical snapshot | null>
        expected_trigger: <exact method / endpoint / body-or-reviewer / actor | null>
        write_operation_id: <round / attempt / reviewerへbindingしたstable ID | null>
        write_state: not_started | prepared | outcome_unknown | created | adopted | proven_not_created
        trigger_response: <full server response | null>
        trigger_evidence: <full event / response / proven-not-created evidence | null>
  REQUEST_ATTEMPT_LEDGER:
    entries:
      - request_round: <1以上>
        request_attempt: <1以上>
        transition: <同じkeyのfull REQUEST_TRANSITION_STATE>
        boundary: <full request boundary | null>
        outcome: in_progress | monitoring | findings | zero | incomplete | incomplete_no_boundary | invalidated | invalidated_base_advanced
        invalidation_reason: <exact reason | null>
        successor: {request_round: <1以上>, request_attempt: <1以上>} | null
        rotation_evidence: <operation ID・P/C・push・satisfied transitionを持つappend-only verified evidence list。初期値[]>
        base_advance_evidence: <saved/latest base・normal descendant proof・observation window・A/B/C binding・dispositionを持つappend-only evidence list。初期値[]>
        terminal_evidence: <reviewer別の明示head / requested_at / bot identity / current attempt bindingを含むfull terminal evidence | null>
        incomplete_evidence: <reviewer別のservice-state / timeout / request failure evidence | null>
  FEEDBACK_LEDGER:
    entries:
      - feedback_id: <channel namespace付きstable ID>
        version: <1以上>
        channel: review_thread | review_comment | top_level_review | issue_comment | timeline_event
        snapshot_hash: <canonical snapshot SHA-256>
        binding: current_arrival | carryover | external_update | ambiguous_service_state
        request_round: <1以上 | null>
        request_attempt: <1以上 | null>
        state: pending | action_pending | handled_analyzed | handled_waiting_human | handled_resolved | superseded
        evidence: <analysis / reply / resolve / external update evidence | null>
  GIT_MUTATION_STATE:
    state: idle | prepared | commit_observed | push_observed
    pending_base_advance: <same BASE_REF・saved/latest BASE_OID・full identity・normal descendant proof・window=transition_prepared | non_idle_recovery | post_rotation_idle・operation ID/kindまたはnull・A/B/P/C binding | null>
    operation:
      operation_id: <stable unique ID>
      kind: findings | followup | cleanup | boundary_rotation | other_phase12
      source_attempt: {request_round: <1以上>, request_attempt: <1以上>} | null
      successor_attempt: {request_round: <1以上>, request_attempt: <1以上>} | null
      rotation_reason: retry_after_incomplete | base_advanced | null
      parent_oid: <OID>
      remote_before_oid: <OID>
      remote_ref: <exact refs/heads/...>
      exact_paths: <順序付きexact list>
      planned_tree_oid: <OID | null>
      planned_diff_sha256: <SHA-256>
      commit_subject: <exact subject>
      child_oid: <OID | null>
      commit_evidence: <exact commit observation | null>
      push_evidence: <raw remote / GitHub head observation | null>
    # state == idle のとき operation == null。pending_base_advanceはledger evidence・latest identity/base・round state反映完了まで保持できる
  CLEANUP_STATE:
    obligations:
      - request_round: <1以上>
        analysis_iteration: <1..5>
        path: <exact path>
        creation_head_oid: <OID>
        state: pending | completed | retained
        operation_id: <GIT_MUTATION_STATE operation ID | null>
        mutation_substate: not_started | prepared | commit_observed | push_observed | retained
        cleanup_head_oid: <OID | null>
        evidence: <exact cleanup / retention evidence | null>
  REPLY_RESOLVE_STATE:
    threads:
      - request_round: <1以上>
        analysis_iteration: <1..5>
        thread_id: <GraphQL thread ID>
        feedback_version: <1以上>
        generation: <1以上>
        reviewer_kind: bot | human
        state: reply_pending | reply_outcome_unknown | resolve_pending | complete | superseded
        expected_snapshot: <canonical thread snapshot>
        expected_snapshot_hash: <SHA-256>
        expected_reply_body_hash: <SHA-256>
        reply_writes:
          - write_operation_id: <stable unique ID>
            state: prepared | outcome_unknown | created | adopted | proven_not_created
            expected_snapshot_hash: <SHA-256>
            expected_reply_body_hash: <SHA-256>
            response_evidence: <reply response / convergence / proven-not-created evidence | null>
        resolve_attempt_count: <0..2>
        reply_evidence: <reply ID / URL / body hash / server timestamp | null>
        resolve_evidence: <resolve mutation response / server observation | null>
        successor: {request_round: <1以上>, analysis_iteration: <1..5>, thread_id: <GraphQL thread ID>, feedback_version: <1以上>, generation: <1以上>} | null
        supersession_evidence: <external updateのold/new snapshot・feedback version対応 | null>
```

resumeでは`CHECKPOINT_VERSION == 9`、全fieldの存在、型、list順序・重複なし、OID形式、全ledgerとrotation / base advance evidence listのappend-only性、cleanup generation keyとthread generation chain keyの一意性、current / previous boundaryのfull request fieldを検証する。`REQUEST_TRANSITION_STATE`は`REQUEST_ATTEMPT_LEDGER.entries[-1].transition`とexactに一致させ、current / previous boundaryの上書き後も全attemptをledgerから再構成できなければ停止する。`ROUND_STATE=boundaryless`では`CURRENT_REQUEST_BOUNDARY=null`、`active`ではnonnullかつledger最新entryのnonnull boundaryとexact一致を要求する。`incomplete_no_boundary | retry_without_boundary`ではledger最新entryのboundaryをnullとし、先行する有効boundaryがなければcurrentもnull、あればcurrentをledger上で直近の先行nonnull boundaryとexact一致させ、失敗candidateで上書きしない。`ROUND_STATE=retry_after_incomplete`はboundary rotation / resume中だけのtransient current stateとし、その間はretry元entryの`outcome=incomplete`、`invalidation_reason=retry_after_incomplete`、nonnull `successor`のexact pairを要求してenum外outcomeを作らない。successor boundaryがactiveになった後はglobal stateを`active`へ戻し、retry履歴は旧ledger entryとrotation evidenceだけで検証する。request / feedback ledger entryは削除・並替えず、同一entryは定義済みの単調遷移だけ、外部feedback更新は同じstable IDのversionを増やした新entryとしてappendする。cleanup obligationsは`pending -> completed | retained`とする。thread generation keyは`(request_round, analysis_iteration, thread_id, feedback_version, generation)`とし、botは`reply_pending | reply_outcome_unknown -> resolve_pending -> complete`、humanは`reply_pending | reply_outcome_unknown -> complete`、どのpending stateからも正当なexternal update時だけ`superseded`へ進める。chainの旧generationは`complete | superseded`だけとし、`superseded`には新しいfeedback version / generationを指すnonnull `successor`とsnapshot対応を示す`supersession_evidence`を必須にする。`CHECKPOINT_IDENTITY`の`DEDICATED_BRANCH`は上で常に導出した値と完全一致させる。

current active boundaryのterminal transitionは`ROUND_OUTCOME`とledger最新current attemptを1つのatomic tupleとして扱う。transition前checkpointは旧tuple、transition後checkpointは`findings / zero / incomplete`の同じ値をglobalとlatest entry `outcome`へ同時に設定し、対応するfull evidenceも同じcheckpointへ保存するため、片方だけ更新したcheckpointを返さない。`findings | zero`では全`REQUIRED_REVIEWERS`のcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`、`incomplete`では取得済みterminalを欠落なく保持したうえで未到着・timeout・request failure・quota / permission / availabilityの対象reviewerと原因を網羅するnonnull `incomplete_evidence`を要求する。後続self-push / base advance / retryでhistorical entryを`invalidated | invalidated_base_advanced`またはreason付き`incomplete`として扱う場合だけcurrent globalとの一致から除外できるが、先行するatomic terminal tupleとevidenceを削除・上書きしてはならない。

incomplete retry lifecycleはA=current source、B=予約済みsuccessor key、C=verified rotation childに固定する。active Aのterminal `incomplete`から`ROUND_STATE=retry_after_incomplete`へ進むpost-checkpointは、Aのoutcome / reason / successor Bと、`GIT_MUTATION_STATE.state=prepared`かつ`kind=boundary_rotation`、source A、successor B、reason `retry_after_incomplete`、P、remote-before、exact empty paths / planned tree、subjectを同時に凍結するatomic transitionであり、retry stateとgit mutation idleのgapを作らない。このtransition観測でbaseが進んでいれば、same ref・saved→latest normal descendant proof・他identity不変を`pending_base_advance(window=transition_prepared, A/B/P, C=null)`とlatest operational baseへ同じcheckpointで結合する。C push前のretry stateはこのprepared / commit_observed / push_observed operationを必須とし、C push後だけverified rotation evidenceを持つA、未開始B、operation nullのidleを許可する。

成功trigger 0件のrequest terminalはcurrent active terminalとは別のboundaryless atomic tupleとする。同じpost-checkpointで`ROUND_OUTCOME=incomplete`、`ROUND_STATE=incomplete_no_boundary`、ledger最新entry `outcome=incomplete_no_boundary` / `boundary=null` / nonnull full `incomplete_evidence`、`REQUEST_TRANSITION_STATE.state=incomplete_no_boundary`と同entry transitionのexact一致を保存し、current boundaryは既定規則どおり保持する。全writeが`proven_not_created`の場合だけ、この完全tupleから後続`retry_without_boundary`へ進める。

`GIT_MUTATION_STATE.state != idle`のresumeでは、current active / operational expected-OID gateより先にoperation-specific recoveryを行う。保存`parent_oid=P`と、parent / subject / exact paths / planned treeまたはdiff hashへexact一致する直系childを`C`とする。`prepared`はlocal HEADが`P`またはexactly 1件の`C`、raw remote / GitHub headがそれぞれ`P | C`であることを検証し、child 0件で全headが`P`なら保存index / worktree planを再検証してcommit前から続ける。`commit_observed`は保存`child_oid=C`とcommit evidenceがexactでlocal HEAD=`C`、raw remote / GitHub headがそれぞれ`P | C`であることを要求する。`push_observed`はbounded convergence後にlocal / raw remote / GitHub headがすべて`C`であることを要求する。前段stateでexact childまたはpush済み`C`を発見した場合は単調にadoptし、`EXPECTED_LOCAL_OID`、`EXPECTED_REMOTE_OID`、関連ledger / cleanup obligation、commit / push evidenceを実観測へ収束させて`idle`へ戻す。複数child、plan不一致、`P | C`外、raw remote / GitHubの収束不能は停止する。

identity差分は原則停止するが、`BASE_REF`が同一、latest `BASE_OID`が保存base OIDのnormal descendantであることをbase commit graphからcryptographically証明でき、base OID以外の全identity fieldが不変な場合だけ、full proof、`window=non_idle_recovery`、operation ID / kind、A / B / Pと観測済みCまたはnullを`pending_base_advance`へcheckpointしてP/C recoveryを続ける。transition時点のpendingがあればwindow / saved proofを保持し、commit観測時にexact Cを追記する。operationがretry rotation A→Bとexact一致する場合、`prepared`ではpending保存後にCのcommit、`commit_observed`ではexact Cのpush、`push_observed`では3 headのC収束を行い、各checkpoint直後の中断も同じoperationからresumeする。C push後はAのappend-only `rotation_evidence`へoperation / P/C / pushを、`base_advance_evidence`へproof / window / `coalesced_retry_rotation`をappendし、A tupleとtransient stateを維持して2回目のrotationを作らない。B candidate前にlatest base / identityとexpected Cを再凍結し、その全更新後だけpendingをclearする。binding不一致または他operationではidle収束後に従来どおり`invalidated_base_advanced`と必要な別rotationを処理する。

full checkpointなし、部分的field、identity / OID / request ledger / feedback ledger / git mutation / path generation / thread substate / request transition不一致、またはhard interruptionにより安全なcheckpointを受け取れない場合は、poll以外のmutation、新boundary作成、cleanup / reply済み主張、最終zero判定を行わずblockerとして停止する。

Phase12 executionでは、停止 / `incomplete` / 最大周到達 / 正常完了と、request / feedback ledger appendまたはstate更新、git mutation、cleanup pending / completed、reply / resolve、request boundary更新の各transition前後で、この同名fieldをすべて含むfull checkpointを更新して親へ返す。同じAgent context内で続行するときも省略せず、親はresume時に加工せず戻す。checkpoint用のtracked / untracked fileやbranch artifactは作らない。

identity確立後のGitHub read / mutationはcanonical `PR_URL`、またはhost-qualifiedな`$PR_HOST/$BASE_REPO`と`PR_NUMBER`を明示して実行する。REST / GraphQLの全`gh api`は`--hostname "$PR_HOST"`を必須とし、repository未指定の番号やdefault hostへ戻さない。

boundary modeでは、`REQUESTED_REVIEWERS`が`AI_REQUESTS`の`status == requested`集合と一致することを要求する。初回round（`TARGET_REVIEWERS = null`）の`REQUIRED_REVIEWERS`はpolicy対象の`status == requested | incomplete`集合と一致し、`disabled`、`not_targeted`、証明済み`not_installed`の`skipped`を含めない。再roundでは`REQUIRED_REVIEWERS == TARGET_REVIEWERS`を要求する。`REQUESTED_REVIEWERS`は`REQUIRED_REVIEWERS`の部分集合であり、不足reviewerは`incomplete`として保持する。

initialでboundaryを受け取った時点だけ`ROUND_STATE = active`、`ROUND_OUTCOME = monitoring`としてcurrent boundaryを構築する。standaloneは`boundaryless`のまま開始し、resumeでは`ROUND_STATE`、`ROUND_OUTCOME`、`CURRENT_REQUEST_BOUNDARY`をcheckpointから復元する。resume時に`GIT_MUTATION_STATE.state != idle`なら次段のoperation-specific recoveryを先に完了し、以下のgeneric active gateは`idle`へ収束するまで適用しない。active中の開始時・各poll・arrival分析直前・旧roundによる最終zero判定直前は、current boundaryの`REQUEST_IDENTITY`が上記12-field tupleと補助identityに完全一致し、現在の`HEAD_OID == REQUEST_HEAD_OID`、`BASE_REF == REQUEST_BASE_REF`、`BASE_OID == REQUEST_BASE_OID`であることを要求する。このidle時generic gateでは次段のretry lifecycle 2 windowを先に判定し、いずれにも一致せず、base refと他identityが同一、最新`BASE_OID`が保存base OIDの通常のdescendant advanceだとbase repositoryのcommit graphで証明できた場合だけ、current attemptを理由付きでledgerへ`invalidated_base_advanced`として保存し、`ROUND_STATE=invalidated_base_advanced`へ進めてlatest base / identityを再凍結できる。non-idle incomplete-retry rotation中に観測してcoalesced処理したbase advanceは、既にlatest base / identityへ再凍結済みであるためこのgeneric分岐へ入れず、source Aを上書きしない。base retarget、force rewrite、ancestry取得不能、base以外のidentity変更は別PRへ再解決せず停止する。以前に成功triggerがある通常base advance / incomplete retryは、`GIT_MUTATION_STATE`で検証するboundary rotation commitをpushしてheadを必ず変えてからfresh requestを作る。

idleでbase差分を観測した場合は上記generic invalidationより先にretry lifecycleの2つのwindowを検査する。第一に、`ROUND_STATE=active`、`GIT_MUTATION_STATE.state=idle` / operation null、latest current Aのterminal `outcome=incomplete`・full evidence・transitionがexactで、successor B / Bのledger entry / candidate / baseline / writeが未作成なら、Bとfull prepared rotation operationを予約し、same ref・saved→latest normal descendant・他identity不変のproofを`pending_base_advance(window=transition_prepared, operation ID/kind, A/B/P、C=null)`へ含め、Aのreason / successor、`ROUND_STATE=retry_after_incomplete`、`GIT_MUTATION_STATE.state=prepared`と同じcheckpointで保存する。latest baseをそのoperationのoperational baseとして束縛し、generic invalidationやretry + idle checkpointを挟まない。第二に、`ROUND_STATE=retry_after_incomplete`、`GIT_MUTATION_STATE.state=idle` / operation null、Aのincomplete tupleとsuccessor B、append-only rotation evidenceのverified P→C、local / raw remote / GitHub head=C、Bのledger entry / candidate / baseline / writeが未作成であることがexactなら、same ref・saved→latest normal descendant・他identity不変のproofを`pending_base_advance(window=post_rotation_idle, operation=null, A/B/P/C)`としてまずcheckpointする。次のfull checkpointでCを新base advanceにも満たすrotation evidenceと`coalesced_retry_rotation` base evidenceをAへappendし、latest base / identityを再凍結し、expected head C、A tuple、transient stateを維持する。pendingは全更新後だけclearするため、各checkpoint直後の中断はpendingまたはappend済みevidenceからresumeし、2回目のrotationを禁止する。B request開始済み、evidence / head / identity不一致、または他lifecycleだけが前段のgeneric `invalidated_base_advanced`分岐へ進む。

このコマンド自身の修正をpushする経路だけはactive boundaryからの明示的なoperational transitionとする。Phase12中の全commit / push（findings、follow-up、cleanup、boundary rotationを含む）は、commit前にoperation ID、kind、source / successor attempt、rotation reason、parent OID、remote-before、exact paths、planned treeまたはdiff hash、commit subjectを`GIT_MUTATION_STATE=prepared`として親が保持してから実行する。non-rotationはsource / successor / reasonをnull、retry rotationはA / B / `retry_after_incomplete`、通常base rotationは対応attempt / successor / `base_advanced`とする。commit観測後はexact child OID / evidenceを保存して`commit_observed`、raw remote / GitHub headの一致後はpush evidenceを保存して`push_observed`とし、関連ledger / obligation / expected OID更新後だけ`idle`へ戻す。resumeでstateがnon-idleなら上記operation-specific tupleを最初に検証し、exact child / pushをadoptするか保存段階から継続する。state-first recovery中はgeneric active / operational expected-OID gateを先に適用せず、複数child、別content、unexpected path、`P | C`外のremote / GitHub headなら停止する。

exact-lease push前はHEAD以外のidentityとoperational baseが凍結値から不変、GitHub / raw remote headが`EXPECTED_REMOTE_OID`、local HEADが検証済み`EXPECTED_LOCAL_OID`であることを通常gateとする。例外はretry rotationの`GIT_MUTATION_STATE.state=commit_observed`と`pending_base_advance(window=transition_prepared | non_idle_recovery)`が同じoperation ID、A / B / P / exact C、same `BASE_REF`、saved→latest baseのnormal descendant proof、base以外の全identity不変へexact bindingされ、Aが`outcome=incomplete` / reason `retry_after_incomplete` / successor B、local HEAD=C、raw remote / GitHub head=Pである場合だけとする。このexact pushではpendingに保存したlatest baseをoperational baseとしてlease P→Cを行う。field欠落、operation / pending / ledger不一致、別window、non-descendant、他identity差分は停止し、Aをinvalidatedへ変更しない。

findings / follow-up / cleanup push後にlocal / raw remote / GitHub headが`EXPECTED_LOCAL_OID`で一致したら、先行するatomic findings tuple / evidenceを保持したまま旧round全体とrequest ledger entryを理由付きで`invalidated`にする。retry rotationではsource Aのincomplete tupleとglobal `ROUND_STATE=retry_after_incomplete`を維持し、exact Cのrotation evidenceをappendする。同じoperation中のnormal base advanceがpendingなら、descendant proofをAの`base_advance_evidence`へ`coalesced_retry_rotation`としてappendし、Cを両方のhead-changeに使って2回目のrotationを禁止する。それ以外のbase advanceは従来どおり`outcome=invalidated_base_advanced`と対応reason / successor / evidenceを保持する。retry / base advance中は`ROUND_OUTCOME=incomplete`のまま、`EXPECTED_REMOTE_OID`をlocal HEADへ更新する。以後の返信・resolve・follow-up反映・cleanup・再依頼前mutationでは、旧`REQUEST_HEAD_OID`との一致を要求せず、このoperational identity/base、local HEADが`EXPECTED_LOCAL_OID`、raw remote / GitHub headが`EXPECTED_REMOTE_OID`と一致するgateを使う。

`outcome=invalidated`、`outcome=incomplete`かつ`invalidation_reason=retry_after_incomplete`、または`outcome=invalidated_base_advanced`の旧attemptに属するfeedbackやterminal状態を最終zeroへ再利用してはならない。返信・cleanup・必要なboundary rotationを完了したcurrent headへ新しいrequest boundaryを作成したときだけ`ROUND_STATE = active`、`ROUND_OUTCOME = monitoring`へ戻し、以後は新しい`REQUEST_HEAD_OID`とrequest attempt baselineでarrivalとterminalを判定する。

current local repositoryのremoteをURL照合し、hostとnameWithOwnerの組が`PR_HOST` / `BASE_REPO`に一致する`BASE_REMOTE`を選ぶ。一致なしは停止し、複数なら`origin`が一致候補に1つだけ含まれる場合だけ`origin`を使う。base repositoryのpull refをfetchして取得OIDが`HEAD_OID`と完全一致することを確認する。forkでも`origin/$HEAD_REF`へfallbackしない。

```bash
git fetch "$BASE_REMOTE" "+refs/pull/$PR_NUMBER/head:refs/remotes/$BASE_REMOTE/pull/$PR_NUMBER/head"
```

明示的に「分析のみ」と指定された場合は、このpull refとGitHub APIだけを読み、document/code編集・worktree作成・commit・push・返信・resolve・review trigger投稿を行わない。

### 1.5. PR head専用worktreeへのbinding（mutationする全入力）

`git worktree list --porcelain -z`をNUL区切りのまま解析する。`refs/heads/$HEAD_REF`を持つlocal branchはOIDの一致・不一致を問わず、最初にupstreamのremote URLとrefを両方取得・正規化し、repositoryが`HEAD_REPO`、refが`refs/heads/$HEAD_REF`と完全一致すると証明できた場合だけ候補にする。upstreamなし・取得不能・repository/ref不一致は、OIDが偶然`HEAD_OID`と一致していてもforkやuser branchのsame-name collisionとして候補から除外し、そのbranch pointerを動かさない。検証済みの`refs/heads/$HEAD_REF`、またはhost / immutable base repository ID / PR番号でnamespaceした`refs/heads/$DEDICATED_BRANCH`を持つworktreeのうち、branch / OIDが一致するcleanな1件へ移動する。対象PRに結び付く候補のdirty、local ahead、diverged、または複数候補は停止する。対象との紐付けを証明できたcleanなbehindだけは、local OIDが`HEAD_OID`のancestorであることを確認し、そのworktree内で`git merge --ff-only "$HEAD_OID"`して再検証してよい。`git branch -f`や`git update-ref`でcheckout中のbranchだけを動かさない。

候補がなければ、新規worktreeは常に`LOCAL_BRANCH=$DEDICATED_BRANCH`とする。専用名が既存branch / worktreeと衝突する場合は停止する。

```bash
git gtr new "$LOCAL_BRANCH" --from "$HEAD_OID" --track none --no-fetch --yes
```

作成後もpath / `LOCAL_BRANCH` / OID / clean / 一意性を再検証し、以降の全file操作とgit commandをこのworktree内だけで実行する。remote `HEAD_REF`とlocal `LOCAL_BRANCH`を分離する。

standalone / initialだけ`EXPECTED_REMOTE_OID=HEAD_OID`、`EXPECTED_LOCAL_OID=HEAD_OID`として開始する。resumeではcheckpointから復元した両expected OIDを上書きせず、`GIT_MUTATION_STATE.state != idle`なら先にoperation-specific recoveryで実観測へ収束し、`idle`になった後だけ上記active / invalidated規則でlocal / raw remote / GitHub headと照合する。最初のdocument/code編集前に、`PR_STATE == OPEN`、head repositoryがnonnull、`VIEWER_CAN_EDIT_FILES == true`を要求する。`git remote`でremote名を全件列挙し、各nameについて`git remote get-url --push --all "$remote"`を実行する。取得したraw effective push URLを保持したまま正規化先を`HEAD_REPO` / `HEAD_REPO_URL`と照合し、一致するraw URLをexact stringで重複排除する。候補がexactly 1件ならそのraw URL自体を`PUSH_TARGET`にし、0件、複数件、または1remoteでもURL取得失敗なら単一の`HEAD_REPO_URL`をdirect `PUSH_TARGET`にする。これによりfetch / push URLの取り違え、検証後のpushurl変更、multi-push remoteのpartial successを避ける。`git ls-remote "$PUSH_TARGET" "refs/heads/$HEAD_REF"`が`EXPECTED_REMOTE_OID`と一致し、`git push --dry-run "$PUSH_TARGET" "$HEAD_OID:refs/heads/$HEAD_REF"`が成功することを確認する。dry-runは新しいcommitのruleset通過を保証しない。

最初の編集、各commit、各push、各GitHub mutationの直前に、`GIT_MUTATION_STATE.state=idle`から新operationを始める場合だけgeneric gateとしてworktree path、`LOCAL_BRANCH`、local HEAD=`EXPECTED_LOCAL_OID`、再取得したGitHub tuple、remote OID=`EXPECTED_REMOTE_OID`、statusがその段階のexact scopeだけであることを再検証する。non-idle resumeは先にoperation-specific tupleで回復し、generic gateを理由にexact child / pushを拒否しない。通常pushの直前はrecoveryで収束済みの`EXPECTED_REMOTE_OID`がlocal HEADのancestorであることを確認し、dry-runと実pushの両方へexact `--force-with-lease`を付ける。このleaseはremote refのCASにだけ使い、history rewriteを許可しない。不一致ならlocal workを保持して停止し、reset / stash / force branch moveを行わない。

### 2. レビューコメントの取得

到着・分析判定ではresolved / unresolvedを問わず、次の全channelを全page取得する。unresolved filterは返信・resolve mutation対象を選ぶときだけ使う。

- GraphQLの全`reviewThreads`と各threadの全comments
- REST review comments
- REST top-level reviewsとそのbody
- REST issue comments
- REST timelineの`reviewed` / `review_requested` events

RESTは各endpointへ`per_page=100`を指定してlast pageまで取得する。`gh api --paginate --slurp`を使う場合は同じ呼び出しに`--jq`を混ぜず、page配列を後段でflattenする。GraphQLはthread connectionと各comments connectionのcursorをそれぞれ最後まで辿る。

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
              id
              databaseId
              author { login __typename }
              body
              path
              originalLine
              originalStartLine
              diffHunk
              createdAt
              publishedAt
              lastEditedAt
              commit { oid }
              originalCommit { oid }
              pullRequestReview {
                databaseId
                author { login __typename }
                body
                submittedAt
                lastEditedAt
                commit { oid }
              }
            }
          }
        }
      }
    }
  }
}
```

`BASE_REPO`をowner / nameへ分解し、`gh api graphql --hostname "$PR_HOST"`の`owner`、`name`、`number=$PR_NUMBER`へexplicit variablesとして渡す。

`reviewThreads.pageInfo.hasNextPage`がtrueなら`threadsAfter=endCursor`で全pageを取得する。各`comments`に次pageがある場合は、次のqueryへ`threadId`と`commentsAfter=endCursor`を渡して全pageを取得する:

```graphql
query ReviewThreadComments($threadId: ID!, $commentsAfter: String) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id databaseId author { login __typename } body path originalLine originalStartLine diffHunk
          createdAt publishedAt lastEditedAt commit { oid } originalCommit { oid }
          pullRequestReview { databaseId author { login __typename } body submittedAt lastEditedAt commit { oid } }
        }
      }
    }
  }
}
```

threadの`id`をresolve用の`THREAD_NODE_ID`、先頭のtop-level commentの`databaseId`を返信用の`ROOT_COMMENT_DATABASE_ID`として同じthreadに対応付けて保持する。全comment page取得後、固定key順の`THREAD_NODE_ID`、`isResolved`、取得順の全commentのstable ID / actor / body / publish・edit時刻 / original commit / parent review ID・commitをUTF-8 JSONへcanonical serializeし、そのSHA-256を`THREAD_SNAPSHOT_SHA256`として保持する。`path` / `diffHunk`は分析コンテキストとして取得するがsnapshotへ含めない。修正pushによるoutdated化で変わる`line` / `startLine` / `outdated`もsnapshot対象にしない。未解決かどうか、thread ID、top-level comment ID、または全page snapshotを一意に取得できない場合、read-only分析ではその旨を明記して参照してよいが、返信・resolve対象には含めない。

#### 2.1. actorの厳密な識別

AI reviewerはlogin完全一致とBot typeの両方で識別し、substring一致を禁止する:

- Copilot: REST `copilot-pull-request-reviewer[bot]` / GraphQL `copilot-pull-request-reviewer`
- Codex: REST `chatgpt-codex-connector[bot]` / GraphQL `chatgpt-codex-connector`
- Gemini: REST `gemini-code-assist[bot]` / GraphQL `gemini-code-assist`

人間reviewerのfeedbackも通常の分析対象に含めるが、`AI_REQUESTS`のterminal arrivalとしては数えない。

#### 2.2. channel namespaceとdedupe

取得項目には`review:<id>`、`review_comment:<id>`、`issue_comment:<id>`、`timeline_event:<id>`、`thread:<node-id>`、`thread_comment:<database-id-or-node-id>`のようなchannel namespace付きIDを付ける。次のstable relationで同一feedbackをcross-channel dedupeする:

- GraphQL thread commentとREST review comment: database ID / node ID
- top-level reviewとtimeline `reviewed`: review ID
- thread commentとparent review body: parent review IDを保持し、bodyが別feedbackなら別項目のままにする

timeline `review_requested`は依頼相関のcontextであり、それ自体を指摘やterminal reviewとして数えない。reviewer/channel別のraw response artifact件数、新規・更新artifact件数、抽出した指摘件数、cross-channel dedupe後の指摘総数を分けて記録する。「指摘なし」のterminal responseはarrival artifact 1件・指摘0件とする。

全page inventoryの各canonical itemをstable namespaced IDとsnapshot hashでappend-only `FEEDBACK_LEDGER`へ記録する。current arrivalだけでなく、baseline内の未処理carryoverも一度は必ず分析し、特に全unresolved human / bot threadとthread外feedbackを黙って除外しない。初見はversion 1、外部編集・追加・削除は同じstable IDのversionを増やしたcanonical snapshotまたはtombstoneの`pending` entryとしてappendし、旧versionを`superseded`へ単調遷移させる。分析・必要対応へ進む項目は`action_pending`、人間threadは返信済み`handled_waiting_human`、bot threadはresolve確認済み`handled_resolved`、thread外feedbackは分析・必要対応済み`handled_analyzed`とする。同じsnapshot hashのhandled旧人間threadをroundごとに再分析・再返信せず、外部更新で新versionになった場合だけ再びpendingとして扱う。

#### 2.3. request boundaryとの比較

boundary modeでは各reviewerの`AI_REQUESTS.<reviewer>.baseline`と`requested_at`を使用し、次だけを今回のarrival候補にする:

- request attemptの保存baselineに存在しないIDで、`requested_at`以後に作成・公開されたもの
- baselineと同じIDでは、server `updated_at` / `lastEditedAt`が`requested_at`より厳密に後（`>`）であるか、最初のpost-trigger canonical snapshotから後続pollまでの間にbody SHA-256が変化したことを2つのpost-trigger snapshotで証明できるもの。同時刻やtrigger前baselineとの差がpost-triggerの1回の観測で見つかっただけでは、baseline取得後・POST前の更新raceを排除できないため今回responseへ分類しない

今回roundのreviewer feedback件数とterminal判定には、このarrival候補だけを使う。baselineに存在する過去reviewを現在roundの指摘へ再分類しない。ただし境界外の未処理項目は必ず`carryover`として`FEEDBACK_LEDGER`へ入れて分析し、requested reviewerのarrival・terminalには数えなくても最終zero gateのpending確認には含める。carryover対応でpushした場合も現在roundは無効化する。

trigger comment自身、reaction、placeholder、agent-start通知を除く。同一IDのplaceholderが後から最終本文へ編集された場合はsnapshot差分をarrival evidenceにできるが、開始通知だけではterminalにしない。

明示的なquota / permission / temporarily unavailable / retired等のservice-state issue commentはreview terminalとは別の`headless service-state response`として分類する。本文またはserver metadataがservice stateを明示し、server作成・公開時刻がreviewerの`requested_at`より厳密に後、actor login / typeがexact bot identityと一致することを前提とする。reviewed headなしでcurrent attemptへ即時bindingできるのは、server metadataがcurrent round / attempt / trigger IDへexact causal linkを持つ場合、またはbaseline後の全channel / 全page trigger inventoryによりcurrent triggerからresponseまで同reviewerの競合triggerが0件で、かつ遅延headless responseを返し得る未解決の先行successful attemptが0件と証明できる場合だけとする。このときだけ該当attemptのnonnull `incomplete_evidence`へ保存し、latest `outcome=incomplete` / `ROUND_OUTCOME=incomplete`を同じatomic post-checkpointで確定して即時停止できる。どちらの因果証明もないresponseは`FEEDBACK_LEDGER.binding=ambiguous_service_state`として記録・分析し、current terminalまたはtimeoutまで待つ。headless response自体はterminal response、findings、zeroのいずれにも絶対に使用しない。

arrival候補には次のhead binding evidenceを要求する:

- top-level review: REST `commit_id == REQUEST_HEAD_OID`またはGraphQL parent review `commit.oid == REQUEST_HEAD_OID`
- inline root: REST `original_commit_id == REQUEST_HEAD_OID`かつparent review `commit_id`も一致。移動し得る現在`commit_id`だけに依存しない
- GraphQL thread/comment: `originalCommit.oid == REQUEST_HEAD_OID`かつparent review `commit.oid`も一致
- issue comment: 本文の`Reviewed commit`等またはserver metadataに、reviewed commitが`REQUEST_HEAD_OID`へ一意に解決できる明示値があり、server作成・公開時刻がreviewerの`requested_at`より厳密に後で、actor login / typeがexact bot identityと一致すること。さらにrequest ledger上、そのreviewerのsuccessful triggerを持ち同じreviewed headを使うattemptがexactly 1件で、そのkeyがcurrent boundaryのround / attemptと一致することを要求する。issue commentに存在しないtrigger comment ID / round metadataは要求しない。同じheadのsuccessful attemptがledgerに複数あればambiguous `incomplete`とし、時系列とstable headだけではterminalにしない。成功triggerを含むsame-head retryは禁止を維持し、成功trigger 0件で全writeが`proven_not_created`のretryだけは同じheadでもunique successful-attempt数を増やさない。旧headの遅延responseはcarryoverとして分析できるが、新terminalへ流用しない

明示的な指摘本文、承認、または「指摘なし」と示す最終本文だけをterminal responseとし、request ledgerの該当attemptへ明示reviewed head、response timestamp、requested_at、exact bot identity、unique successful-attempt keyをfull evidenceとして保存する。placeholder、agent-start、reaction、review-request eventはterminalではない。`REQUIRED_REVIEWERS`の全員が`status == requested`かつterminalになる前のtimeoutや依頼失敗は`incomplete`であり、指摘0件にしない。

boundaryなしのstandalone実行では全channelを分析するが、baselineとの差分やhead-bound terminal判定を推測で補わない。

### 3. PRの目的把握

レビューコメントを評価する前に、PRのタイトル・本文・diffを読み、以下を理解する:

- このPRが何を目的とした変更なのか（新機能、バグ修正、リファクタリング等）
- PRの前提条件やスコープ
- 既存のコーディングスタイルや設計パターン

これらの理解に基づいて、各コメントがPRの意図と整合しているかも判断材料に含める。

### 3.5. critics reviewドキュメントの確認

レビューコメントの分析に先立ち、同一PRに対するcritics reviewドキュメントが存在するか確認する。

#### 検索対象

Globで`**/critics-review-pr-<PR番号>.md`、`**/critics-review-pr-<PR番号>-backend.md`、`**/critics-review-pr-<PR番号>-frontend.md`を検索し、見つかった全active成果物を確認する。root、任意の既存サブディレクトリ、backend / frontend splitのいずれも除外しないが、`*-resolved.md`の要約とアーカイブ用ディレクトリ（例: `.archive/past-critics/`）配下のarchiveはactiveな検索結果と`CRITICS_PATHS`から除外する。見つかった相対pathはexact listの`CRITICS_PATHS`として記録し、後続の判断で同じリストを使う。

ファイルシステム上の件数にかかわらず、splitの一部が欠けていないかgit履歴も確認する:

```bash
git log --oneline -- ':(glob)**/critics-review-pr-<PR番号>.md' ':(glob)**/critics-review-pr-<PR番号>-backend.md' ':(glob)**/critics-review-pr-<PR番号>-frontend.md'
```

コミット履歴がある場合は、履歴上の実際の保存pathをすべて特定する。active pathが0件なら最新の削除直前にactiveだったpath setを、1件以上なら現存pathと過去に同時存在した欠落pathだけを`git show <commit>:<path>`で直接読んで参照する。参照した相対pathは`CRITICS_PATHS`に含めるが、分析には読み取りだけで足りるためworktreeへファイルを復元しない。現存pathと同時存在しなかった旧レイアウトや、アーカイブ用ディレクトリのarchiveは含めない。

#### 見つかった場合

- ドキュメントを全文読み込み、各懸念点の状況（未対応・対応不要・修正済み）と「チーム内議論」を把握する
- 特に「対応不要」と判断された懸念点とその理由を抽出する
- この情報をステップ4の分析で参照する

#### 見つからなかった場合

- 通常通りステップ4に進む

### 4. コメントの分析

各コメントについて以下の観点で評価する:

- 指摘内容が技術的に正しいか
- PRの目的・スコープに照らして妥当か
- プロジェクトの方針や既存の書き方と整合しているか
- **critics reviewで同一箇所・同一論点について意思決定がある場合、その判断との整合性を考慮する**（例: critics reviewで「対応不要」と判断された論点に対応するレビューコメントは、その理由を踏まえて評価する）

## 出力フォーマット

dedupe後のすべてのfeedbackを個別の `<details>` トグル形式で出力し、判定ごとにセクション分けする。thread外feedbackも省略しない。

```markdown
# PR #[番号] レビューコメント分析

## PR identity

- **PR_URL**: [canonical PR URL]
- **PR_HOST**: [canonical PR URLのlowercase host]
- **BASE_REPO**: [baseRepository.nameWithOwner]
- **BASE_REPO_NODE_ID**: [baseRepository.id]
- **PR_NUMBER**: [PR番号]

## Request boundary

- **REQUEST_HEAD_OID**: [完全長OID / boundaryなし]
- **REQUEST_BASE_REF**: [base ref / boundaryなし]
- **REQUEST_BASE_OID**: [完全長OID / boundaryなし]
- **REQUEST_STARTED_AT**: [GitHub server timestamp / boundaryなし]
- **REVIEWER_POLICY**: [適用policy / boundaryなし]
- **TARGET_REVIEWERS**: [再roundのtarget exact set / 初回またはboundaryなしはnull]
- **REQUIRED_REVIEWERS**: [round完了に必要なexact set / boundaryなし]
- **REQUESTED_REVIEWERS**: [status == requestedのexact set / boundaryなし]
- **terminal reviewers**: [reviewer一覧]
- **incomplete reviewers**: [reviewer一覧 / なし]

## 概要

- **PR**: [タイトル]
- **分析日**: YYYY-MM-DD

## サマリー

| 判定 | 件数 |
|------|------|
| MUST_FIX | N |
| SHOULD_CONSIDER | N |
| CAN_IGNORE | N |

### Channel counts

| Reviewer | Channel | Raw artifacts | New/updated artifacts | Extracted findings | Deduped findings |
|----------|---------|---------------|-----------------------|--------------------|------------------|
| @username | review_thread | N | N | N | N |

## MUST_FIX

<details>
<summary>1. [簡潔なタイトル]（MUST_FIX）</summary>

| 項目 | 内容 |
|------|------|
| 判定 | **MUST_FIX** |
| レビュアー | @username |
| Feedback channel | `review_thread` / `review_comment` / `top_level_review` / `issue_comment` / `timeline_event` |
| Namespaced feedback ID | `channel:id` |
| Request attempt | round / attempt、`requested_at`、trigger evidence |
| Head binding evidence | `REQUEST_HEAD_OID`との照合根拠。issue commentはexplicit reviewed head / exact bot / unique successful-attempt key |
| ファイル | `ファイル名` (行番号) ※ディレクトリパスは含めない |
| 種別 | bug / spec / perf / security / test / style / 好み |
| Thread node ID | `THREAD_NODE_ID` / thread外なら `N/A` |
| Root comment database ID | `ROOT_COMMENT_DATABASE_ID` / thread外なら `N/A` |
| Thread snapshot SHA-256 | `THREAD_SNAPSHOT_SHA256` / thread外なら `N/A` |

**原文**:
> レビューコメントの原文をそのまま引用

**返信**:（返信がある場合のみ記載）
> **@username**: 返信内容をそのまま引用

**要旨**: コメントが何を指摘しているかを簡潔に記載

**理由**: なぜその判定にしたかを説明する。箇条書きや構造化された形式を使って、以下の観点を含めて詳しく記載する:
- 指摘内容の技術的正確性
- PRの目的・スコープとの整合性
- プロジェクトの方針や既存コードとの整合性
- 判定基準に照らした判断根拠
- critics reviewで関連する意思決定がある場合、その判断内容と整合性（例: 「critics reviewで対応不要と判断済み（理由: ...）」）

**返信案**: レビューコメントへの返信文章を、レビュー投稿者に応じた文体で構造化して作成する。
- AI reviewer / bot（例: Copilot, codex, chatgpt-codex-connector 等）への返信案は敬語を使わず、PR description の追記メモのような簡潔な常体で書く
- AI reviewer / bot への返信案は必ず先頭で対応状況を明示する。修正した場合は `対応済み:`、修正しない場合は `対応不要:`、一部のみ対応した場合は `一部対応:` で始める（例: `対応済み: step 名を Terraform tests 全体を表す名前に更新した。` / `対応不要: terraform test は既存 state と分離して実行されるため、lock 無効化は追加しない。`）
- 人間レビュアーへの返信案は丁寧な提案調で書く
- reply-reviews では返信案をそのまま投稿するため、ここで投稿先に適した文体にしておく

以下の点を含める:
- レビュアーの指摘に対する明確な対応方針（修正する/検討する/対応しない等）
- 対応方針の理由や背景
- 修正する場合は具体的な対応内容、対応しない場合はその理由
- 必要に応じて代替案や補足説明
- 他のコメントへの参照（例: "mustfix #1で対応済み"）は含めず、このコメントに対して独立した返信文書として作成する

</details>

## SHOULD_CONSIDER

<details>
<summary>2. [簡潔なタイトル]（SHOULD_CONSIDER）</summary>

（同様のフォーマット）

</details>

## CAN_IGNORE

<details>
<summary>3. [簡潔なタイトル]（CAN_IGNORE）</summary>

（同様のフォーマット）

</details>
```

## 判定基準

| 判定 | 意味 | 例 |
|------|------|-----|
| MUST_FIX | 必ず修正すべき問題 | バグ、セキュリティ脆弱性、データ破損の可能性 |
| SHOULD_CONSIDER | 妥当な指摘だが検証・検討が必要 | パフォーマンス懸念、エッジケース、設計上の考慮点 |
| CAN_IGNORE | 修正不要または好みの問題 | コーディングスタイルの好み、PR作成者自身のメモ |

## ファイル保存（初版）

新しいrequest boundaryに対するround分析開始transitionを初めて記録するときだけ`REVIEW_DECISION_PATHS=[]`へresetし、Phase12 checkpointも直ちに更新する。同じround途中のresumeではcheckpointのcurrent listを維持し、再度resetしない。boundary modeのcurrent active attemptで分析完了後にfeedbackが1件以上ある場合は、全`REQUIRED_REVIEWERS`のcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`を確定し、global `ROUND_OUTCOME=findings`とledger最新current entry `outcome=findings`を同じatomic post-checkpointへ保存してから結果を既定pathへ自動保存する。boundaryless standaloneの既存feedback分析はcurrent attempt terminalではないためledger entryを捏造せず、分析結果保存後に初回boundary確立へ進む。そのroundで作成・更新した完全なexact listを`REVIEW_DECISION_PATHS`として返し、各pathを`CREATED_REVIEW_DECISION_PATHS`へ初出順でappendして既存要素との重複を除く。artifact commit後は各pathについて`(REQUEST_ROUND, ANALYSIS_ITERATION, path, creation_head_oid)`を一意keyとする`CLEANUP_STATE.obligations` entryを`pending`でappendし、checkpointを更新する。同じpathを後続finding roundで再生成した場合は新generation entryを追加し、過去generationの`completed`を理由にskipしない。ドキュメントにはexactly 1つの`## PR identity`セクションと`## Request boundary`セクションを設け、上記field名のexact valueを検証・triage更新後も保持する。

boundary modeの最終roundで全`REQUIRED_REVIEWERS`のterminal responseが揃い、dedupe後の抽出指摘が0件でも、zero直前に全channel / 全pageを再取得して`FEEDBACK_LEDGER`へ反映し、各stable IDのlatest versionで`pending | action_pending`が0件になった場合だけ、全required reviewerのcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`を確定し、global `ROUND_OUTCOME=zero`とledger最新current entry `outcome=zero`を同じatomic post-checkpointへ保存する。空の分析mdは作成・commitせず、`REVIEW_DECISION_PATHS=[]`のまま、`CREATED_REVIEW_DECISION_PATHS`は過去roundのhistoryを保持する。reviewer/channel別artifact件数・抽出指摘0件、明示head / requested_at / exact bot / unique successful-attempt evidence、carryover処理結果を直接報告する。terminal未到着、`incomplete`、未処理carryoverを0件としてこの分岐へ入れない。

boundaryなしのstandalone roundでfeedbackが0件の場合も空の分析mdは作らず`REVIEW_DECISION_PATHS=[]`とするが、最終zeroは認定せずステップ9.6の初回boundary確立へ進む。

保存した場合はexact listを簡潔に報告し、「検証フェーズに進みます」と宣言する。
保存直前にステップ1.5のmutation gateを再検証する。

### 5. Team Agentによる判定検証

初版の各判定が正しいかを、必要な分だけの独立エージェントで検証する。
**エージェント数は判定ごとに「残っている不確実性」に比例させ、事実確認が済んだ判定に一律3体を投入しない。**

#### 5.0. 検証規模の決定

各判定について、メインエージェント自身がステップ2〜4で一次ソース（diff・実コード・CI/CD設定・commit履歴・GitHub API）により事実関係を直接確認済みかを先に整理し、次の規模を選ぶ:

| 規模 | 適用条件 |
|------|---------|
| 検証省略（0体） | 事実関係を一次ソースで確認済みで、初版判定がMUST_FIXでなく、残る論点が「ユーザーの方針判断」（親PRの決定を覆すか等）だけ。ドキュメントには「検証省略（事実確認済み）」と根拠を記録し、方針判断は最終報告で提示する |
| 1体 | SHOULD_CONSIDER / CAN_IGNOREで、技術的・スコープ的な未確認点が1つ残る。その論点に合う観点（コード精査 / PR文脈 / プロジェクト慣習）を1つ選んで起動する |
| 3体 | 初版判定がMUST_FIX、判定がコード変更を伴いその正しさをメインエージェントが直接検証できていない、または1体の検証結果が初版と不一致だった場合だけ |

過去roundで同一内容が既に3票判定済みのfeedback（snapshot hashが同じcarryover）にはエージェントを起動しない。

#### 5.1. 検証用Team Agentの作成

TeamCreateで検証チームを作成する。チーム名は `review-verify-pr-<PR番号>` とする。

#### 5.2. 各判定の独立検証

初版ドキュメントの判定を1件ずつ処理し、5.0で決めた規模のエージェントを**並列で**起動する。3体の場合は以下の3つの専門エージェントをすべて、1体の場合は該当する観点だけを使う:

##### エージェント1: コード精査エージェント（Code Accuracy Verifier）

以下の指示でAgentを起動する:

```
あなたはコードレビューの判定を検証する専門家です。
以下の判定が技術的に正しいか、コードを徹底的に精査してください。

## 検証対象
- PR番号: #<PR番号>
- 判定番号: <N>
- 判定: <MUST_FIX / SHOULD_CONSIDER / CAN_IGNORE>
- ファイル: <対象ファイルのパス>
- 行番号: <該当行>
- レビューコメント原文: <原文>
- 初版の理由: <初版で記載された理由>

## あなたの任務
1. 対象ファイルの該当箇所を実際に読み、コードの文脈を完全に理解する
2. レビューコメントが指摘している問題が**実際にコード上で存在するか**を確認する
3. 関連するファイル（型定義、呼び出し元、テストなど）も必要に応じて調査する
4. 指摘が正しい場合、その影響範囲（バグの深刻度、影響するユーザー数など）を評価する
5. 指摘が誤りの場合、なぜ誤りなのかを具体的なコード根拠とともに説明する

## 出力フォーマット
- **あなたの独立判定**: MUST_FIX / SHOULD_CONSIDER / CAN_IGNORE
- **初版との一致**: 一致 / 不一致
- **技術的根拠**: コードの具体的な箇所を引用しながら詳細に説明（最低300字）
- **確信度**: 高 / 中 / 低（理由も記載）
```

##### エージェント2: PR文脈エージェント（PR Context Verifier）

以下の指示でAgentを起動する:

```
あなたはPRの目的とスコープの観点から判定を検証する専門家です。

## 検証対象
- PR番号: #<PR番号>
- 判定番号: <N>
- 判定: <MUST_FIX / SHOULD_CONSIDER / CAN_IGNORE>
- レビューコメント原文: <原文>
- 初版の理由: <初版で記載された理由>

## あなたの任務
1. PRのタイトル・説明・全diffを読み、PRの目的とスコープを正確に把握する
   - `gh pr view "$PR_URL" --json title,body` でPR情報を取得
   - `gh pr diff "$PR_URL"` でdiffを取得
2. レビューコメントがPRのスコープ内の指摘か、スコープ外の指摘かを判断する
3. PRの変更意図に照らして、この指摘への対応がPRの品質に影響するかを評価する
4. 類似の変更パターンがPR内の他の箇所にもあるか確認し、指摘の一貫性を検証する
5. PRのベースブランチとの差分を確認し、既存コードとの整合性を評価する

## 出力フォーマット
- **あなたの独立判定**: MUST_FIX / SHOULD_CONSIDER / CAN_IGNORE
- **初版との一致**: 一致 / 不一致
- **スコープ分析**: PRの目的に照らした指摘の妥当性を詳細に説明（最低300字）
- **確信度**: 高 / 中 / 低（理由も記載）
```

##### エージェント3: プロジェクト慣習エージェント（Project Standards Verifier）

以下の指示でAgentを起動する:

```
あなたはプロジェクトの慣習・規約の観点から判定を検証する専門家です。

## 検証対象
- PR番号: #<PR番号>
- 判定番号: <N>
- 判定: <MUST_FIX / SHOULD_CONSIDER / CAN_IGNORE>
- ファイル: <対象ファイルのパス>
- レビューコメント原文: <原文>
- 初版の理由: <初版で記載された理由>

## あなたの任務
1. 対象ファイルと同じディレクトリ・モジュール内の既存コードを読み、プロジェクトのコーディングスタイルとパターンを把握する
2. CLAUDE.md、ESLint設定、tsconfig、その他の設定ファイルからプロジェクトの規約を確認する
3. レビューコメントの指摘がプロジェクトの慣習に基づいた妥当な指摘かを判断する
4. 同様のパターンがプロジェクト内の他の箇所でどのように扱われているかを調査する
5. 指摘が「好み」レベルか「プロジェクト規約違反」レベルかを区別する

## 出力フォーマット
- **あなたの独立判定**: MUST_FIX / SHOULD_CONSIDER / CAN_IGNORE
- **初版との一致**: 一致 / 不一致
- **慣習分析**: プロジェクトの慣習に照らした評価を詳細に説明（最低300字）
- **確信度**: 高 / 中 / 低（理由も記載）
```

#### 5.3. 検証結果の統合判定

起動したエージェントの結果が揃ったら、各判定について以下のロジックで最終判定を決定する:

**検証省略（0体）の場合:**
- 初版を確定し、検証ステータスを「✅ 確定（検証省略）」とする

**1体の場合:**
- 初版と一致 → 初版を確定（検証ステータス: ✅ 確定）
- 初版と不一致 → 残り2観点のエージェントを追加起動して3体の規則へ移る

**3体・全員一致の場合:**
- 3エージェント全員が初版と同じ判定 → 初版を確定（検証ステータス: ✅ 確定）
- 3エージェント全員が初版と異なる同一判定 → エージェント側の判定に変更（検証ステータス: 🔄 変更）

**多数決の場合:**
- 2エージェント以上が初版と一致 → 初版を維持（検証ステータス: ✅ 確定）
- 2エージェント以上が初版と異なる同一判定 → その判定に変更（検証ステータス: 🔄 変更）

**意見が割れた場合（3者とも異なる判定）:**
- 各エージェントの確信度を重み付けして総合判断する
- 確信度「高」の判定を優先する
- それでも決まらない場合は、より保守的（MUST_FIX寄り）な判定を採用する（検証ステータス: ⚠️ 要注意）

### 6. 検証済みドキュメントの更新

検証完了後、`REVIEW_DECISION_PATHS`の該当するexact pathだけを更新する。

#### 更新内容

1. **サマリーテーブルの更新**: 検証による変更があった場合、件数を更新する

2. **各判定に検証セクションを追加**: 各判定の `</details>` 直前に以下を追加する:

```markdown
---

**🔍 検証結果**: ✅ 確定 / 🔄 変更 / ⚠️ 要注意

| 検証エージェント | 独立判定 | 初版との一致 | 確信度 |
|-----------------|---------|-------------|--------|
| コード精査 | MUST_FIX | 一致 | 高 |
| PR文脈 | MUST_FIX | 一致 | 高 |
| プロジェクト慣習 | SHOULD_CONSIDER | 不一致 | 中 |

（起動したエージェントの行だけを書く。検証省略の場合は表の代わりに「検証省略（事実確認済み）: <確認した一次ソース>」を1行書く）

**検証の要点**:
- コード精査: [エージェントの主要な根拠を要約]
- PR文脈: [エージェントの主要な根拠を要約]
- プロジェクト慣習: [エージェントの主要な根拠を要約]

**最終判定**: [初版を維持 or 変更後の判定]（変更理由: ...）
```

3. **判定が変更された場合**: 該当する判定のセクション移動（例: CAN_IGNORE → SHOULD_CONSIDERに変更された場合、そのアイテムをSHOULD_CONSIDERセクションに移動）と、返信案の再作成を行う

4. **検証サマリーの追加**: ドキュメント末尾に以下を追加する:

```markdown
## 検証サマリー

| # | 初版判定 | 検証結果 | 最終判定 | ステータス |
|---|---------|---------|---------|-----------|
| 1 | MUST_FIX | 全員一致 | MUST_FIX | ✅ 確定 |
| 2 | CAN_IGNORE | 2:1で変更 | SHOULD_CONSIDER | 🔄 変更 |
| ... | ... | ... | ... | ... |

- **確定**: N件
- **変更**: N件
- **要注意**: N件
```

5. 更新後のドキュメントのパスと、検証で判定が変更された件数を報告する。

### 7. 該当コメントの修正実施

検証済みドキュメントを元に、最終判定が **MUST_FIX** および **SHOULD_CONSIDER** の項目のうち、修正が妥当と判断されるものを実際にコード修正する。

#### 7.1. 修正対象の選定

- **MUST_FIX**: 原則すべて修正する。
- **SHOULD_CONSIDER**: 以下の観点で修正要否を個別に判断する:
  - 指摘内容が明確で修正方針が確定できるか
  - PRのスコープ内で修正可能か
  - 修正により他の箇所への副作用が発生しないか
  - 返信案で「対応する」としていた場合は修正する
  - 「検討のみ」「議論が必要」と判断した場合は修正をスキップする

#### 7.2. 修正の実施

対象の項目を1件ずつ順番に処理する。各修正では以下を守る:

- ドキュメントの「返信案」で示した対応方針に沿って修正する
- ユーザーのグローバルルールに従い、修正時にコメントは追加しない（ただし既存コメントは削除しない）
- 修正後、関連する型チェック・Lintが通ることを確認する
  - 必要に応じて `npx tsc --noEmit` や `npx eslint . --fix` を実行
- 修正が広範囲に及ぶ場合は、項目単位で論理的にまとまったコミットに分ける

#### 7.3. コミット

修正が完了したら、変更をコミットする。コミットメッセージは日本語で作成し、以下の形式を目安とする:

```
fix: レビュー指摘に基づく修正（PR #<PR番号>）

- MUST_FIX #1: [簡潔な説明]
- MUST_FIX #2: [簡潔な説明]
- SHOULD_CONSIDER #3: [簡潔な説明]
```

項目数が多い場合は、論点ごとに複数コミットに分割してもよい。

### 8. ドキュメントの triage 更新

修正・コミット完了後、`REVIEW_DECISION_PATHS`の各exact pathを **triage スタイル**で再構成する。「未対応」と「対応済み」のセクションに分けて `<details>` トグル化する。

#### 8.1. 各項目の対応状況マーキング

修正・対応完了した項目には、項目内に `**対応状況**: 修正済み` を追記する。修正スキップの SHOULD_CONSIDER には `**対応状況**: 対応不要` と `**スキップ理由**:` を追記する。CAN_IGNORE は `**対応状況**: 対応不要` とする。

#### 8.2. セクション再構成

triage の変換ルールに沿って、以下の構造に書き換える:

```markdown
## 未対応のレビューコメント

<details>
<summary>2. [タイトル]（SHOULD_CONSIDER / 未対応）</summary>
（元の内容をそのまま維持）
</details>

---

## 対応済みのレビューコメント

<details>
<summary>1. [タイトル]（MUST_FIX / 修正済み）</summary>
（元の内容をそのまま維持）
</details>

<details>
<summary>3. [タイトル]（CAN_IGNORE / 対応不要）</summary>
（元の内容をそのまま維持）
</details>
```

- `<summary>` 書式: `{番号}. {タイトル}（{判定} / {対応状況}）`
- 番号は振り直さない（元の番号を維持）
- 既存の検証結果セクションはトグル内にそのまま残す
- 内容（原文・返信案・理由・検証結果）は一切変更しない。構造の並び替えとマークアップの追加のみ行う

#### 8.3. サマリーテーブルの更新

既存のサマリーテーブルに「対応済み」列を追加する:

```markdown
| 判定 | 件数 | 対応済み |
|------|------|----------|
| MUST_FIX | N | N |
| SHOULD_CONSIDER | N | M |
| CAN_IGNORE | N | N |
```

### 9. リモートへのpush

non-idle recovery中のbase差分は、same `BASE_REF`、saved→latest normal descendant proof、他identity不変を満たす場合だけ、`window=non_idle_recovery`、operation ID / kind、A / B / P / Cを`pending_base_advance`へ記録する。transition時のpendingがあれば保持し、`prepared`ならpending保存後にcommit、`commit_observed`ならexact Cをbindingしてpush、`push_observed`なら3 headのC収束を採用する。各checkpoint直後の中断は同じP/C operationからresumeする。

retry rotation A→BならC push後にA tupleを維持し、append-only rotation / base evidenceへCとproof / window / `coalesced_retry_rotation`を追記する。pre-pushはoperation / pending / ledgerがA/B/P/C、same ref descendant proof、他identity不変へexact一致する場合だけpending latest baseをoperational baseとしてP→Cを許可する。B candidate前にlatest base / identityとexpected Cを再凍結し、全反映後だけpendingをclearして2回目のrotationを禁止する。他operation / binding不一致は従来の`invalidated_base_advanced`規則を使う。

ドキュメント更新分も含めてコミットし、現在のブランチをリモートへpushする。

commit前に、今回のexact pathsだけをstageしてplanned tree OIDまたはcanonical staged diff SHA-256を計算し、operation ID、`kind=findings | followup | other_phase12`、nullのsource / successor attempt / rotation reason、parent OID、remote-before OID、remote ref、exact paths、planned tree / diff、exact commit subjectを`GIT_MUTATION_STATE=prepared`へ凍結する。Phase12 executionでは親がこのfull checkpointを保持した確認後だけcommitする。commit直後はchild OID、parent、subject、tree / diff、pathsを再取得して一致を証明し`commit_observed`、push後にraw remote / GraphQL head一致を証明して`push_observed`へ進める。expected OID、request / feedback ledger等の関連stateを更新した後だけ`idle`へ戻す。

resumeで`GIT_MUTATION_STATE.state != idle`ならgeneric expected-OID gateより先にstate-first recoveryを行う。保存parentを`P`、parent / subject / exact paths / planned treeまたはdiff hashにexact一致する一意なchildを`C`とする。`prepared`はlocal HEAD=`P | C`、raw remote / GitHub headが各`P | C`であることを検証し、Cが0件かつ全headがPなら保存index / worktree planを再検証してcommit前を続け、Cがexactly 1件なら`commit_observed`へadoptする。`commit_observed`は保存`child_oid=C`、local HEAD=C、raw remote / GitHub headが各`P | C`を要求し、両server headがPならexact leaseでpush、Cならpushをadoptする。`push_observed`はbounded convergence後にlocal / raw remote / GitHub headがすべてCであることを要求する。各adoptでexpected OID、関連ledger / obligation、commit / push evidenceを実観測へ更新し、全収束後にだけ`idle`へ戻して通常gateへ進む。複数child、plan / evidence不一致、unexpected path、`P | C`外、server head収束不能なら停止し、checkpoint前後のwindowをGitHub current headだけから推測しない。

```bash
git push --force-with-lease="refs/heads/$HEAD_REF:$EXPECTED_REMOTE_OID" "$PUSH_TARGET" "HEAD:refs/heads/$HEAD_REF"
```

- **history rewriteを行わない**（明示的に要求された場合を除く）。通常pushのexact leaseはancestry gateを通したCASとして使う
- commit後は`EXPECTED_LOCAL_OID`をlocal HEADへ更新する。push後はGraphQLの`HEAD_OID`とraw remote OIDがlocal HEADに一致するまで成功扱いにしない。一致後に`EXPECTED_REMOTE_OID`もlocal HEADへ更新し、boundary modeなら旧round全体とrequest attempt ledger entryを理由付きで`ROUND_STATE = invalidated`へ遷移させる。Phase12 executionではcurrent `CHECKPOINT_IDENTITY`、両expected OID、`ROUND_STATE`、両boundary、全ledger、両path list、`GIT_MUTATION_STATE`を含むfull `PHASE12_CHECKPOINT`を各transitionで更新して返す。`git update-ref "$VERIFIED_PUSH_REF" "$EXPECTED_LOCAL_OID"`でこのhost / immutable base repository ID / PR番号に対応する検証済みpush headを記録する。このlocal refはcommit内容を変えずに最終headを固定できるため、分析mdへ自己参照OIDを書かない
- push先のbranchとコミット数を報告する。内部検証ではremote `HEAD_REF`とlocal `LOCAL_BRANCH`を混同しない

### 9.5. レビューコメントへの返信（reply-reviews）

push 完了後、分析・修正結果に基づいて未解決レビューコメントへ返信する。

返信・resolve直前に、non-idle git mutationがあればoperation-specific recoveryを先に完了し、`GIT_MUTATION_STATE.state=idle`へ収束した後だけoperational gateを再検証する。HEAD以外のidentityとoperational baseは上記凍結値から不変、current GitHub `HEAD_OID`・raw remote OID・検証済みlocal HEADは`EXPECTED_LOCAL_OID == EXPECTED_REMOTE_OID`で一致し、`ROUND_STATE == invalidated | invalidated_base_advanced`またはboundaryless standaloneであることを要求する。不一致、permission/state変更、push後OID未確認の場合は返信・resolveせず停止する。旧`REQUEST_HEAD_OID`との不一致だけを理由に、検証済みself-push後の処理を停止しない。

`../reply-reviews/SKILL.md` を Read で読み込み、その手順に従って PR #<PR番号> の未解決レビューコメントへ返信する。

- 返信内容はproducerが返した`REVIEW_DECISION_PATHS`の完全なexact listから「返信案」を使用する。consumerへ同じlistをそのまま渡し、単一pathへ縮退または再探索しない。AI reviewer / bot 宛ては、分析ドキュメント作成時点で敬語なしのメモ調にし、先頭を `対応済み:` / `対応不要:` / `一部対応:` のいずれかにしておく
- AI reviewer（bot）への返信後はスレッドを resolve し、人間レビュアーのスレッドは resolve しない（reply-reviews.md の手順に従う）
- 既に返信済みのスレッドには二重投稿しない
- 返信・resolve mutationは`Feedback channel == review_thread`かつcurrent `isResolved == false`の項目だけに行う。top-level review body、issue comment、timeline event等のthread外feedbackは分析・修正対象には含めるが、thread IDを捏造して返信・resolveしない
- **Skill tool は使わず、reply-reviews.md の手順を直接実行すること**（gtr-new フェーズ12のバックグラウンド実行でも動くようにするため）

Phase12 executionでは返信対象ごとに`(REQUEST_ROUND, ANALYSIS_ITERATION, thread_id, feedback_version, generation)`で識別するthread entryを作る。mutation前のcanonical thread snapshot / SHA-256、reviewer kind、投稿予定reply body hash、stable write operation IDを持つ`reply_writes[].state=prepared`を保存し、threadを`reply_pending`にする。このpreparedを作った同一live executorだけが、hard interruptionなしに親のexact ackを受け取った直後にcreate POSTを1回行える。fresh / resume executorがlatest write `prepared` / thread `reply_pending`を受け取った場合は、write / threadを`outcome_unknown` / `reply_outcome_unknown`へ進めてPOSTせずread-only convergenceだけを行う。

- reply POST responseが作成成功を一意に示せばwriteを`created`としてreply ID / URL / body hash / server timestampを保存する。responseが不明なら`state=reply_outcome_unknown` / write `outcome_unknown`をcheckpointし、bounded read-only convergenceで保存snapshot以後の全commentsを取得する。exact expected replyが1件だけなら`adopted`、0件・複数・曖昧なら自動再POSTせず`incomplete`で停止する
- HTTP response等でserver非作成を明示できるwriteだけ`proven_not_created`へ進められる。retryする場合は新しいwrite operation IDのentryをappendし、最新snapshotを外部変更なしと検証してpre-write checkpointからやり直す。`prepared` / `outcome_unknown` / `created` / `adopted` writeへfresh / resume executorから再POSTしない
- bot reviewerはpost-reply snapshotへexpected snapshotを更新し、`resolve_pending`、`resolve_attempt_count=1`のfull checkpointを親が保持してからだけ最初のresolveを行う。human reviewerは`complete` / feedback `handled_waiting_human`としてfull checkpointを返す
- bot resolve成功直後はresolve responseとserver側`isResolved == true`の観測を保存してthreadを`complete`、feedbackを`handled_resolved`とする。`resolve_pending`からresumeしたentryはreplyを再投稿せず、必ずresolve recoveryだけを続行する
- `resolve_pending` resumeでserver `isResolved == true`かつpost-reply expected snapshot以外の差分がなければresolve成功を採用して`complete`へ進む。resolveはidempotent state setなので、`isResolved == false`かつsnapshot不変ならcountをcheckpointした後に上限内で再実行できる。曖昧なresolve evidence、外部snapshot差分なら停止する
- `reply_pending | reply_outcome_unknown | resolve_pending`で保存expected snapshot/hashと、許可した自分のreply / resolve以外の正当なcurrent snapshot差分があれば、同じstable feedback IDの新versionを`pending`でappendし、旧feedback versionを`superseded`へ進める。旧thread generationも`superseded`へ進め、新しいfeedback version / 次generationのnonnull `successor`とold/new snapshotの`supersession_evidence`を保存して停止する。旧generationのreplyを再POSTもresolveもせず、再分析でsuccessor keyの新generationを作る。欠落substateをcurrent threadだけから推測しない

### 9.6. request boundaryの更新と全required reviewer再監視

#### 9.6.1. 現在roundの無効化

boundary modeでコード、分析md、follow-up issue反映、またはcleanupによるcommit/pushが1件でもあれば、現在の`REQUEST_HEAD_OID`に対する**全reviewer分のroundを無効化**し、`ROUND_STATE = invalidated`を維持する。他reviewerが既にterminalでも再利用しない。boundaryless standaloneには無効化対象の旧roundはない。

`REVIEW_DECISION_PATHS`を返信等のcurrent consumerで使い終えた後、artifact-excluded repositoryなら、次のreview requestより前に`CLEANUP_STATE.obligations`のcurrent `pending` generationをすべて除外する。`CREATED_REVIEW_DECISION_PATHS`はdedup path historyとして報告・diff検証に使うだけで、cleanup済み判定には使わない:

- 各generation key `(request_round, analysis_iteration, path, creation_head_oid)`が一意で、pathがbase treeに存在せず、そのgenerationの保存処理で追加されたファイルであることを確認する
- current `pending` entryに対応する現在treeのexact pathだけを削除・commit・exact-lease pushし、別fileやuser fileを巻き込まない。同じpathの過去generationが`completed`でも、current generationをskipしない
- cleanupのcommit前にgenerationへstable `operation_id`を結び付け、`GIT_MUTATION_STATE`へ`kind=cleanup`、parent / remote-before、exact paths、planned tree / diff hash、subjectをwrite-ahead保存する。`prepared -> commit_observed -> push_observed -> idle`をステップ9と同じstate-first resume規則で進め、generic operational gateより先にoperation-specific tupleを検証して、commit後 / push後のcheckpoint前に中断してもexact child / remoteを一意に採用できるようにする
- cleanup pushの前後もoperational gateを使い、成功後に`EXPECTED_LOCAL_OID` / `EXPECTED_REMOTE_OID`をcurrent local / raw remote / GitHub headへ更新する
- cleanup後のPR diffにcurrent generation pathが残っていないことを確認し、entryを`completed`、`mutation_substate=push_observed`へ更新して`cleanup_head_oid`とcommit / push / diff evidenceを保存してからgit mutationをidleへ戻す

Phase12 executionでは各generationのcleanup mutation前とprepared / commit_observed / push_observed / completed更新後に上記同名fieldをすべて含むfull checkpointを返す。resume時はobligation historyを空resetせず、`GIT_MUTATION_STATE`とcurrent `pending` generationをexactに対応させて続行する。glob、既定path、単一path、現在のdiffからgenerationや進捗を推測しない。cleanup途中で安全なfull checkpointを返せないhard interruptionなら、新boundary作成、cleanup完了、最終zeroを主張せず停止する。

normal repositoryでは作成済み分析mdを削除せず、各pending obligationをgenerationごとに`retained`へ更新してretention evidenceを保存し、`CREATED_REVIEW_DECISION_PATHS`でdedup path historyを最終報告する。cleanup obligationが`pending`の状態で再依頼を先に行ってはならない。最終roundの抽出指摘が0件なら空の分析md・obligation・cleanup commitを作らず、current listだけを空にしてhistoryを保持する。

#### 9.6.2. 初回boundaryの確立または全required reviewerへの再依頼

全修正、返信、follow-up issue反映、分析md cleanupを完了し、cleanup obligationに`pending`、thread entryに`reply_pending | reply_outcome_unknown | resolve_pending`、feedback latest versionに`pending | action_pending`がなく、`GIT_MUTATION_STATE.state=idle`であることを確認する。各thread chainのlatest feedback version / generationは`complete`、旧generationは`complete | superseded`だけとし、`superseded`にはnonnull successor / supersession evidenceを要求する。その後worktree clean、HEAD以外のfull identityとoperational baseが上記凍結値から不変、local/raw remote/GitHub headが検証済みcurrent OIDで一致することをgateで確認する。`../request-ai-review/SKILL.md`をReadして直接実行し、次のいずれかで最終headへrequest boundary candidateを作る:

- boundaryなしのstandalone実行（分析のみを除く）: 既存feedbackが0件でも、standalone既定policyと`TARGET_REVIEWERS = null`を渡して`REQUEST_ROUND=1`、`REQUEST_ATTEMPT=1`の初回依頼を作る
- `ROUND_STATE == invalidated`の再round: 旧boundaryの`REQUIRED_REVIEWERS`を`PREVIOUS_REQUIRED_REVIEWERS`として退避し、そのexact setを`TARGET_REVIEWERS`へ渡す。旧policyのdisabled reviewerはdisabledのまま明示し、Codexだけなど成功済みsubsetへ縮めない
- resumeで有効boundaryが`incomplete`になったretry: 成功triggerを含むattemptのsame-head retryは禁止する。active Aのterminal atomic tupleを保存後、B keyとempty rotationのP / remote-before / exact paths / planned tree / subjectを先に予約し、base / full identityを再観測する。同じpost-checkpointでAを`outcome=incomplete`、`invalidation_reason=retry_after_incomplete`、`successor=B`、global `ROUND_STATE=retry_after_incomplete`とし、`GIT_MUTATION_STATE.state=prepared`、`kind=boundary_rotation`、source A、successor B、reason `retry_after_incomplete`のfull operationも保存する。観測時のsame-ref normal base advanceは他identity不変を証明して`pending_base_advance(window=transition_prepared, A/B/P, C=null)`とlatest operational baseへ同時にbindingする。prepared前のidle retry checkpointを作らず、中断時はprepared / commit_observed / push_observedのexact stateからresumeする。operation中またはC push後B開始前のnormal base advanceはCへcoalesceし、別rotationを作らない。旧`REQUIRED_REVIEWERS` exact setを維持したfresh Bを新head / latest baseへ作り、旧terminal / responseを再利用しない
- `ROUND_STATE == invalidated_base_advanced`: coalesced retry rotation以外のbase advanceだけをこのstateで扱い、base ref同一かつ通常descendant advanceを証明してlatest base / identityを凍結する。以前に成功triggerがあれば上記とは別の`rotation_reason=base_advanced` boundary rotation後、なければ下記no-boundary retry条件を満たすfresh attemptで依頼する。base retarget / force rewrite / identity changeは停止する
- `ROUND_STATE == incomplete_no_boundary | retry_without_boundary`: 直前attemptがglobal `ROUND_OUTCOME=incomplete`、成功trigger 0件、ledger `boundary=null` / `outcome=incomplete_no_boundary` / nonnull full `incomplete_evidence`、`REQUEST_TRANSITION_STATE.state=incomplete_no_boundary`とexact一致するatomic tupleで、全create writeがHTTP response等により`proven_not_created`、pending mutationなし、同じcandidate head / latest base / full identityを再検証できる場合だけ`retry_without_boundary`へ進める。同じcandidate `REQUEST_ROUND`の`REQUEST_ATTEMPT`だけを増やしfresh baselineから再試行する。outcome unknown / 複数 / 曖昧writeが1件でもあれば自動retryしない

POST前にcandidate head / base / full identity、policy、target / required set、candidate `REQUEST_ROUND`、単調増加する`REQUEST_ATTEMPT`を`REQUEST_TRANSITION_STATE.state=in_progress`へ凍結し、同じtransitionのentryをappend-only `REQUEST_ATTEMPT_LEDGER`末尾へ追加する。先行attemptが無効化済みなら、そのentryの`successor`を新keyへ単調更新して双方向の連鎖を検証する。reviewerごとのtrigger直前に全channel・全pageのbaselineを取り、entryを`baseline_captured`、exact expected trigger / write operation ID / `write_state=prepared`を保存した`write_prepared`へ進める。このpreparedを作った同一live executorだけが、hard interruptionなしに親のexact ackを受けた直後にcreate POSTを1回行える。fresh / resume executorがpreparedを受け取った場合はPOSTせず即`write_outcome_unknown`へ進め、read-only convergenceだけを行う。response / evidence取得直後もcheckpointする。初回はpolicy対象の`requested | incomplete`をrequired集合にし、disabled / not_targeted / 証明済みnot_installed skippedを除く。再roundはcandidate `REQUIRED_REVIEWERS == TARGET_REVIEWERS == PREVIOUS_REQUIRED_REVIEWERS`を要求する。

create POSTのresponseが不明な場合とfresh / resume executorがpreparedを受け取った場合は`write_outcome_unknown`を保存し、保存baseline以後の全pageをbounded read-only convergenceする。exact expected triggerが1件なら`adopted`、0件・複数・曖昧なら自動再POSTせず`incomplete`で停止する。HTTP response等でserver非作成を明示できる場合だけ`proven_not_created`にする。`prepared` / `requested` / `created` / `adopted` / `outcome_unknown` writeへfresh / resume executorから再POSTせず、pre-write checkpointが親へ届かなかったhard interruptionではuncheckpointed triggerを推測しない。

全reviewer entryが`requested | skipped | incomplete | proven_not_created`になり、candidate identity / head / baseと集合規則を再検証できた場合だけrequest resultを確定する。`REQUESTED_REVIEWERS`はtrigger成功集合のままとし、成功triggerが1件以上あるcandidateでrequired reviewerが1件でもrequestedにならなければ集合を縮めず、対象reviewerごとのrequest failure / quota / permission / availabilityを網羅するnonnull `incomplete_evidence`とledger最新entry `outcome=incomplete`、global `ROUND_OUTCOME=incomplete`を同じatomic post-checkpointへ保存する。成功trigger 0件は後述のboundaryless state / outcome規則を使う。trigger時刻にはPOST responseまたはfresh request eventのGitHub server `created_at`を使う。

成功triggerが1件以上ある有効な新boundaryだけ、旧`CURRENT_REQUEST_BOUNDARY`をfull structureのまま`PREVIOUS_REQUEST_BOUNDARY`へ移し、旧required setを`PREVIOUS_REQUIRED_REVIEWERS`へ保持したうえで、candidate full structureへ`CURRENT_REQUEST_BOUNDARY`を置き換え、`REQUEST_ROUND`をcandidate roundへ進め、`REQUEST_TRANSITION_STATE.state=complete`、`ROUND_STATE=active`へ戻す。transitionはledger最新entryとexact一致させ、entryへ成立boundary / outcomeを保存する。`REQUESTED_REVIEWERS == REQUIRED_REVIEWERS`ならglobal / ledger最新entryを同じpost-checkpointで`ROUND_OUTCOME=monitoring` / `outcome=monitoring`にする。不足なら上記atomic incomplete tupleを保持して昇格直後に安全停止する。成功trigger 0件ではcurrent boundaryを置き換えず、同じpost-checkpointでglobal `ROUND_OUTCOME=incomplete`、`ROUND_STATE=incomplete_no_boundary`、`REQUEST_TRANSITION_STATE.state=incomplete_no_boundary`とlatest entry transitionのexact一致、entry `boundary=null` / `outcome=incomplete_no_boundary` / 全write結果を含むnonnull `incomplete_evidence`を保存して停止する。全writeが`proven_not_created`の場合だけ完全tuple検証後の`retry_without_boundary`を許可する。再依頼後に通常のcleanup・commit・pushを行わず、旧roundのfeedbackやterminal状態を新roundへ持ち越さない。

#### 9.6.3. 最終responseの待機とループ制御

exact causal metadata、または競合trigger 0件かつ未解決先行successful attempt 0件のfull post-baseline inventoryでcurrent attemptへbindingできた`headless service-state response`だけ、reviewed headを要求せずattemptのnonnull `incomplete_evidence`、latest `outcome=incomplete`、global `ROUND_OUTCOME=incomplete`を同じatomic post-checkpointへ保存して即時停止する。因果が曖昧なら`ambiguous_service_state` feedbackとして記録・分析し、current terminalまたはtimeoutまで待つ。いずれもheadless response自体をterminal / findings / zeroには使用しない。

約3分間隔で最大30分、ステップ2の全channelを全page再取得する。各pollでfull identity、base、local/raw remote/GitHub headがrequest boundaryと一致することを確認する。

- `REQUIRED_REVIEWERS`の全員が`status == requested`であり、各reviewerについてbaseline後・`requested_at`以後・head-bound・明示的terminal responseが揃った場合だけ分析へ進む。`REQUESTED_REVIEWERS`は`status == requested`集合と一致し、最終roundでは`REQUESTED_REVIEWERS == REQUIRED_REVIEWERS`を満たす
- terminal responseにdedupe後の抽出指摘があれば、全required reviewerのcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`を保存し、global `ROUND_OUTCOME=findings` / ledger最新entry `outcome=findings`を同じatomic post-checkpointで確定する。イテレーションが5未満ならステップ2へ戻る
- 全required reviewerのterminal responseが揃いdedupe後の抽出指摘0件でも、zero直前に全channel / 全page inventoryを再取得して`FEEDBACK_LEDGER`へ反映し、各stable IDのlatest versionで`pending | action_pending`が0件の場合だけ、全required reviewerのcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`、global `ROUND_OUTCOME=zero` / ledger最新entry `outcome=zero`を同じatomic post-checkpointへ保存して収束とする。この最終roundでは空の分析mdを作らず、`CREATED_REVIEW_DECISION_PATHS`のhistoryは保持する
- timeout、placeholderだけ、quota、permission、依頼失敗、Geminiの`unknown_permission` / `temporarily_unavailable` / `retired`は、停止前に取得済みterminalと対象reviewer・原因を網羅するnonnull `incomplete_evidence`、global `ROUND_OUTCOME=incomplete` / ledger最新entry `outcome=incomplete`を同じatomic post-checkpointへ保存し、0件または収束としない。成功triggerがあるattemptの後続resumeはsame-head retryせずverified boundary rotationを使う
- 初回roundで権限ある完全inventoryにより証明したGemini `not_installed`の`skipped`だけはrequired集合・監視対象・`incomplete`から除外できる。直前roundでrequiredだったGeminiを再roundのavailability変化だけで落とさない
- 5イテレーション到達時にfeedbackまたは`incomplete`が残る場合は、globalとledger最新entryの`findings | incomplete`がexact一致し、対応するfull terminal / incomplete evidenceを持つatomic tupleの実値を保持して未完了として報告する

判定結果にはrequest ledger全entryのround / attempt、request head、reviewer/channel別artifact件数・抽出指摘件数、dedupe後指摘総数、terminal / incomplete、明示head / requested_at / exact bot / unique successful-attempt correlation、feedback ledgerのcarryover handlingを含める。

新しいanalysis iterationを開始する直前に`ANALYSIS_ITERATION`をexactly 1増やし、開始時と同じ値での完了時にcheckpointを更新する。Phase12 executionでは停止・`incomplete`を含む各loop transitionでfull checkpointを返す。resume時はcheckpointの`ANALYSIS_ITERATION` / `REQUEST_ROUND`から続け、同じiterationを二重加算したり、0 / 1へ戻したり、GitHubのrequest event件数から再計算したりしない。

### 10. 最終報告

全イテレーション終了後（収束 or 最大5周到達）、以下を簡潔にまとめて報告する:

- 対象PR: `#<PR番号> <PRタイトル>（<PR URL>）`
- 分析結果ドキュメントの完全なexact list `REVIEW_DECISION_PATHS`（最終round 0件なら空list）
- この実行で保存した分析結果pathのappend-only exact history `CREATED_REVIEW_DECISION_PATHS`（artifact-excluded repositoryでは除外結果、normal repositoryでは残存fileも併記）
- Phase12 executionでは`PHASE12_MODE`と、`CHECKPOINT_VERSION`、`CHECKPOINT_IDENTITY`、`CODEX_EXTERNAL_REVIEW_AUTHORIZED`、`CODEX_LOCAL_REVIEW`、`CODEX_REVIEW_SKIP`、`ROUND_STATE`、`ROUND_OUTCOME`、`EXPECTED_LOCAL_OID`、`EXPECTED_REMOTE_OID`、`REVIEW_DECISION_PATHS`、`CREATED_REVIEW_DECISION_PATHS`、`CURRENT_REQUEST_BOUNDARY`、`PREVIOUS_REQUEST_BOUNDARY`、`PREVIOUS_REQUIRED_REVIEWERS`、`ANALYSIS_ITERATION`、`REQUEST_ROUND`、`REQUEST_TRANSITION_STATE`、append-only `REQUEST_ATTEMPT_LEDGER` / `FEEDBACK_LEDGER`、`GIT_MUTATION_STATE`、generation別`CLEANUP_STATE`、thread別`REPLY_RESOLVE_STATE`の全同名fieldを持つ最新full `PHASE12_CHECKPOINT`。`incomplete` / 停止 / 最大周到達でも省略しない
- **回したイテレーション数と終了理由**（最終headで全required reviewer terminal・指摘0件 / incomplete / 最大5周到達）
- request attempt ledger全entryの`REQUEST_HEAD_OID`、`REQUEST_STARTED_AT`、round / attempt、依頼成功reviewer、outcome / invalidation reason / successor / rotation evidence / base advance evidence / terminal evidence / incomplete evidence
- 各roundの`TARGET_REVIEWERS`、`REQUIRED_REVIEWERS`、`REQUESTED_REVIEWERS`と、再roundでrequired集合を維持できたか
- self-push / base advance / incomplete retryのstate遷移、各検証済みhead、成功trigger後のboundary rotation、旧feedback / terminalを最終zeroへ再利用していないこと
- reviewer/channel別のraw/new response artifact件数・抽出指摘件数と、cross-channel dedupe後の指摘総数
- 最終roundのfull identity/head/base検証と、feedbackごとの明示head / requested_at / exact bot / unique successful-attempt evidence、feedback ledger latest versionのpending 0件
- terminal / skipped / incompleteのreviewer一覧。timeout等を0件に含めない
- 検証で判定が変更された件数（全イテレーション合計）
- 実際に修正した項目の一覧（MUST_FIX / SHOULD_CONSIDER 別）
- 修正をスキップした SHOULD_CONSIDER 項目とその理由
- triage 後の未対応・対応済み件数
- push完了の旨と、pushしたコミットのSHA（イテレーションごと）
- 投稿した返信の件数と resolve したスレッド数（reply-reviews の結果）
- git mutationがidleであること、cleanup generation obligationsのkey / operation ID / substate / cleanup head evidenceと、reply / resolve chainのlatest complete・旧complete / superseded・successor / supersession evidence
- 最大5周に到達した場合は、残っているfeedbackと`incomplete`の一覧

## 制約事項

- **follow-up issue 作成ゲート**: 分析・修正の過程で follow-up issue（別 issue への切り出し）を作る場合は、事前に `../followup-issue-gate/SKILL.md` を Read し、その作成条件・本文ルールに従う。条件を満たさないものは issue 化しない。
- **修正範囲の厳格化**: 修正は最終判定が MUST_FIX / SHOULD_CONSIDER の項目かつ、返信案で「対応する」と明記したもののみに限定する。CAN_IGNORE の項目や、指摘外の箇所に対する「ついでの修正」は行わない。
- **triage 時の内容保全**: ドキュメント再構成時は、各項目の原文・返信案・理由・検証結果などの本文は一切変更しない。構造の並び替えとマークアップ追加のみ。
- **情報不足時の対応**: PRやコメントの情報が不十分で判断が難しい場合は、その旨を「理由」に明記したうえで最も妥当と思われる判定を選ぶ。どうしても判定不能な場合は「情報不足で判定困難」と明示し、当該項目は修正対象から外す。
- **検証の独立性**: 各検証エージェントは他のエージェントの結果を参照せず、完全に独立して判定する。初版の判定に引きずられないよう、エージェントには「初版の判定結果」は伝えるが「初版を支持する方向に誘導するような文言」は含めない。
- **検証の比例性**: 全判定について5.0で規模を決め、記録する。事実確認済みの判定へ一律3体を投入しない一方、MUST_FIXと不一致発生時の3体検証は省略しない。
- **push時の安全性**: `--force`と、ancestry gateを通さないhistory rewrite目的の`--force-with-lease`はユーザーの明示的な指示がない限り使用しない。通常pushをatomicにするexact CAS leaseはステップ1.5と9の規則どおり使用する。push前に `git status` で意図しない変更が含まれていないかを確認する。
- **mutationする全入力で専用worktreeを使用**: 明示PR、会話推定、current branchのどの入力でもステップ1.5を通す。分析のみはread-onlyとしてworktreeを作らない。
- **failure propagation**: identity / base / permission / dry-run / push / post-push OID / request boundary / request transition / Phase12 checkpointの失敗時はlocal workを保持して停止し、返信・resolve・review trigger・cleanup済み / 対応済み / 最終zero報告を行わない。resume時の両path list、generation obligation、thread substate、request attemptをreset・推測して継続しない。
- **自己ループ・最大5イテレーション**: 無限ループ防止のため、ステップ2〜9.6のイテレーションは最大5周まで。最終headにbindingされた全required reviewerがrequestedかつterminalになり、dedupe後の抽出指摘0件になった場合だけ収束する。Skill tool は使わず、他コマンド（reply-reviews、request-ai-review等）の手順は 同梱された `../<name>/SKILL.md` を Read で読んで直接実行する（Skill呼び出しはユーザーターンを消費しループが途切れるため）。
- **既分析feedbackの再分析禁止**: 2周目以降はreviewer別baselineとnamespaced ID / canonical snapshotを比較し、新規IDまたは依頼後に内容が変わったIDだけを現在roundのarrivalとして扱う。同一内容を毎周再分析・再返信しない。
- **reviewer応答待機**: ステップ9.6の待機ではforeground `sleep`を使わず、Monitor / バックグラウンド待機を使う。最大30分に到達してterminal responseが揃わなければ`incomplete`として停止し、「新規なし」や収束扱いにしない。
- **incomplete retry**: 成功triggerを含むattemptはsame-head retryせず、retry元entryを`outcome=incomplete`、`invalidation_reason=retry_after_incomplete`、nonnull `successor`として保存し、transient `ROUND_STATE=retry_after_incomplete`のもとverified boundary rotation後の新headで旧required exact setへfresh baseline / triggerを作る。successor boundary成立後はglobal stateを`active`へ戻し、履歴は旧entryとrotation evidenceで検証する。成功trigger 0件はglobal `ROUND_OUTCOME=incomplete` / `ROUND_STATE=incomplete_no_boundary`、ledger boundary / outcome / evidence、transition exact一致のatomic tupleと全writeのserver非作成を検証できる場合だけ`retry_without_boundary`でattemptを増やす。旧terminalの部分再利用やinitialへのresetは禁止する。
- **最終zeroの境界必須**: boundaryなしのstandalone分析、placeholderだけ、過去review、timeout、quota、permission errorから最終headの指摘0件を認定しない。
- **verified self-push transition**: self-push後は旧roundをinvalidatedとして扱い、operational gateで返信・cleanup・再依頼まで進める。旧`REQUEST_HEAD_OID`への一致を再要求したり、旧roundのfeedbackを新headのterminal / zeroへ流用したりしない。
