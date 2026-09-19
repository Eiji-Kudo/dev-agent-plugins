---
name: gtr-new
description: gtr CLIでissue/PR対応のworktreeを作成し、実装・PR作成・レビュー修正まで一気通貫で行う（PR入力時は既存ブランチをチェックアウトしてrefineから続行）
# CROSS-TOOL-REVIEW-OFF: 再有効化時は allowed-tools に Bash(codex exec:*) と Bash(claude:*) を戻す。
allowed-tools: Bash(git gtr:*), Bash(gh issue:*), Bash(gh pr:*), Bash(gh api:*), Bash(gh repo:*), Bash(git fetch:*), Bash(git log:*), Bash(git push:*), Bash(git ls-remote:*), Bash(git remote:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git merge:*), Bash(git update-ref:*), Bash(git worktree:*), Bash(git status:*), Bash(git branch:*), Bash(git -C:*), Bash(git add:*), Bash(git commit:*), Bash(git diff:*), Bash(codex review:*), Bash(printenv:*), Agent
---

# gtr: issue → worktree → 実装 → PR → refine

引数（$ARGUMENTS）からissue情報を取得し、以下を一貫して行う:
1. worktree作成
2. issue内容に基づくコード実装
3. コミット・push・draft PR作成
4. critics reviewerによるレビュー＆修正ループ（loop-critics-fix）

## 実行ルール

- このコマンドは **フェーズ1〜12をすべて完了して初めて完了扱い** とする（フェーズ12はバックグラウンドAgentの起動だけでなく、最終レビューラウンドの結果確認をもって完了とする）。GitHub Codexのusage limitを確認した場合は、後述のlocal `codex review` fallbackを必ず実行する。fallbackも利用枠枯渇で実行不能な場合だけ、フェーズ11〜12の残りをスキップ済みとして完了扱いにできる
- 実行開始時に、以下のチェックリストを内部で作成して管理すること:
  - フェーズ1: セットアップ
  - フェーズ2: 実装
  - フェーズ3: PR作成
  - フェーズ4: refine（loop-critics-fix）
  - フェーズ5: 自動テスト追加（pr-test）
  - フェーズ6: CI チェック
  - フェーズ7: PR description更新（必要ならローカルQA・スクリーンショット掲載）
  - フェーズ8: Ready for Review
  - フェーズ9: PR解説md作成（pr-explain）
  - フェーズ10: critics review の要約・一時成果物除外（summarize-resolved）
  - フェーズ11: 最終headへのAIレビュー依頼（request-ai-review。GitHub Codexのusage limit時はlocal `codex review`へfallback）
  - フェーズ12: AIレビュー出揃い監視 → review-comment-analysis 自動実行（同fallback条件を引き継ぐ）
- 中間報告では、**完了したフェーズ番号** と **未完了フェーズ番号** を明示すること
- フェーズ3（PR作成）完了時点では、**絶対に完了報告しない**。その時点は「中間報告」であり、必ず refine 以降へ進むこと
- `loop-critics-fix`、`pr-test`、`CI チェック`、`PR description更新`、`Ready for Review`、`pr-explain`、`summarize-resolved`、`request-ai-review` は原則省略不可。ユーザーに見えるUI変更でスクリーンショットがレビュー判断に有効な場合は、フェーズ7の`pr-local-qa-screenshot`も省略しない。GitHub Codexのexactなusage limit証跡がある場合もlocal `codex review` fallbackを先に試し、fallbackもexactなusage limitで実行不能な場合に限り`request-ai-review` / 監視の残りをスキップできる。未実施または根拠のないスキップのまま「完了」「done」「Ready for Review」と報告してはいけない
- 途中で中断・保留する場合は、「最後に完了したフェーズ」と「残っている必須フェーズ」を明示して終了すること

### 外部Codexレビューへの差分送信許可

- `codex review` は、対象PRの差分をこのセッションとは別の外部Codexレビューサービスへ送信する処理である。GitHub側のCodex usage limitを理由にlocal fallbackへ進む前に、今回のPR・gtr実行について、ユーザーがPR差分の外部送信を明示的に許可していることを確認する。
- 「実装して」「レビューして」「終わったらマージ」だけでは外部送信の許可とはみなさない。ユーザーが直前の確認に対して明示的に許可した場合は、その許可を同じgtr実行中の対象PRへbindingし、`CODEX_EXTERNAL_REVIEW_AUTHORIZED=true` としてPhase 11 / 12のfresh / resume Agentへ引き継ぐ。Agent promptと`PHASE12_CHECKPOINT`には、許可値に加えて許可発言・確認時刻・対象`PR_URL`のexact evidenceを渡す。
- 許可はユーザーの発言内容・対象PR・確認時刻を証跡として保持する。別タスク・別PRへは引き継がない。
- 許可が無い場合は `codex review` を実行せず、Phase 11 / 12を `incomplete` として停止する。通常のusage limit skipや「指摘0件」には読み替えない。
- 既存roundがlocal fallback最大5 iteration到達で`incomplete`になっている場合も、許可済み外部レビューを同じrequest boundaryへ再利用してはならない。まず`retry_after_incomplete`のsuccessor boundary rotationを検証済みheadへ完了し、新しいrequest round・baseline・triggerを作成する。外部レビューはその新boundaryの新roundとして実行し、過去roundのincompleteをzeroへ読み替えたり、analysis iterationを同じround内で再利用したりしない。

### 成果物pathの引き継ぎ

producer commandの最終報告から、実際に作成・更新した相対pathを以下のexact listとして記録し、後続フェーズへ引き継ぐ:

- `CRITICS_PATHS`: critics-reviewer / loop-critics-fix が報告した全critics review md。root、任意の既存サブディレクトリ、backend / frontend splitを含む
- `TEST_ARTIFACT_PATHS`: pr-testが報告した設計md・実装報告md
- `EXPLANATION_PATH`: pr-explainが報告した解説md
- `REVIEW_DECISION_PATHS`: review-comment-analysisが現在roundで作成・更新した分析mdの完全なexact list。新しいrequest boundaryのround開始transitionでだけresetし、同じroundのPhase12 resumeではresetしない。reply等のcurrent producer / consumer契約に使う
- `CREATED_REVIEW_DECISION_PATHS`: review-comment-analysisが保存した分析md pathを初出順でappend-onlyに重複排除した完全なexact history。最終0 roundで`REVIEW_DECISION_PATHS=[]`でも保持し、wrapper最終diff検証・最終報告に使う。cleanup ownershipはgeneration別obligationで管理し、このdedup historyを完了判定に使わない

固定の`temp-docs/` pathや単一ファイルを後続フェーズで推測し直さない。replyにはcurrent list、cleanupにはgeneration obligation、全履歴報告にはappend-only dedup historyを使い、更新・stageで`git add -A`により無関係なuser fileを巻き込まない。

## フォローアップ issue の取り扱い（全フェーズ横断・必須）

### follow-up issue 作成ゲート（オーバーエンジニアリング防止）

このフローの途中で follow-up issue を作る前に、必ず `../followup-issue-gate/SKILL.md` を Read し、その作成条件・本文ルールに従うこと。条件を満たさないものは issue 化しない。

このフローの**どのフェーズでも follow-up issue を新規作成したら**（critics の「対応不要→別 issue」、型安全性/ドリフト検知の issue 化、review-comment-analysis 由来の別 issue 等）、その issue を以下の **3 つの成果物すべてに必ず明記**すること。記載漏れは完了扱いにしない。

1. **PR description**（フェーズ7 で更新）: 「フォローアップ issue」セクションに `#<番号> <タイトル>`を、issue作成・再取得responseのcanonical `issue.url`へのリンク付きで列挙する。hostを推測してURLを組み立てない。
2. **PR 解説 md**（フェーズ9 の pr-explain）: クリックで遷移できる Markdown リンク `[#<番号> <タイトル>](<issue URL>)` を専用セクションに書く。
3. **critics review md**（フェーズ4で記録した`CRITICS_PATHS`の全ファイル）: 当該懸念点（多くは「対応不要」）に、クリックできる Markdown リンク `[#<番号>](<issue URL>)` を併記する。

- フォローアップ issue が **0 件なら**各成果物に「フォローアップ issue: なし」と明記する（セクション自体を省略しない）。
- issue は **URL（フルパス）でリンク**し、`#<番号>` だけのプレーンテキストで終わらせない（md は必ずクリックで遷移可能にする）。
- フェーズ12（review-comment-analysis）など **PR description / pr-explain md 確定後**に issue を作った場合は、**当該成果物へ戻って追記し commit/push** すること（「後から作った issue ほど記載漏れしやすい」ため特に注意）。このpushで現在のレビューラウンドを無効化し、必要な一時成果物除外も完了してから全required reviewerへ再依頼する。
- 最終報告の「派生 issue」欄と上記 3 成果物の記載が一致していることを確認する。
- artifact-excluded repositoryでは、PR固有mdを最終diffから除外するspecial caseを優先する。除外前にその時点のfollow-up issue記載を検証し、除外後にフェーズ12で追加されたissueはPR descriptionへ反映する。最終報告では、md側へ追記しない理由を「artifact-excluded repositoryの一時成果物除外」と明記する

## 入力パターン

$ARGUMENTS は以下のいずれか:
- GitHub PR URL（例: `https://github.com/owner/repo/pull/123`）
- PR番号に `pr` プレフィックス（例: `pr123`, `pr#123`）
- GitHub issue URL（例: `https://github.com/owner/repo/issues/78`）
- issue番号（例: `78`, `#78`）
- ブランチ名（例: `feat/my-feature`）
- **空（引数なし）**: 直前までの会話文脈からブランチ名を生成して進める。**issue は勝手に作らない**（ユーザーが明示的に依頼した場合のみ作成）

**PR入力の場合**: 既存PRのブランチをworktreeにチェックアウトし、フェーズ2（実装）・フェーズ3（PR作成）をスキップしてフェーズ4（refine）から続行する。

**引数なしの場合**: 直前のセッションでの作業文脈（ファイル変更・議論内容）からブランチ名を自動生成する。命名規則: `<prefix>/<descriptive-slug>`（例: `feat/user-profile-avatar-upload`）。issue 紐付け無しで進む。途中で「issue 番号教えて」「issue 作る?」とユーザーに確認しない。

### 共通PR identity tupleとmutation gate

PRとして判定したURL、`prN`、`pr#N`、会話から選んだPR、current branchのいずれも、最終的に一意なPR URLへ解決する。明示URLはそのrepositoryを使い、PR番号系とcurrent branchはcurrent local repositoryのremote URLを`gh repo view <remote-url> --json nameWithOwner,url`で照合してbase repositoryを決める。plain `N` / `#N`は入力パターンどおりissueとして扱い、PR番号として曖昧に再解釈しない。候補が0件または複数件なら停止する。

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

`git worktree list --porcelain -z`をNUL区切りのまま解析する。`refs/heads/$HEAD_REF`を持つlocal branchはOIDの一致・不一致を問わず、最初にupstreamのremote URLとrefを両方取得・正規化し、repositoryが`HEAD_REPO`、refが`refs/heads/$HEAD_REF`と完全一致すると証明できた場合だけ候補にする。upstreamなし・取得不能・repository/ref不一致は、OIDが偶然`HEAD_OID`と一致していてもforkやuser branchのsame-name collisionとして候補から除外し、そのbranch pointerを動かさない。検証済みの`refs/heads/$HEAD_REF`、またはhost / immutable base repository ID / PR番号でnamespaceした`refs/heads/$DEDICATED_BRANCH`を持つworktreeのうち、branch / OIDが一致するcleanな1件へ移動する。対象PRに結び付く候補のdirty、local ahead、diverged、または複数候補は停止する。対象との紐付けを証明できたcleanなbehindだけは、local OIDが`HEAD_OID`のancestorであることを確認し、そのworktree内で`git merge --ff-only "$HEAD_OID"`して再検証してよい。`git branch -f`や`git update-ref`でcheckout中のbranchだけを動かさない。候補がなければ、新規worktreeは常に`LOCAL_BRANCH=$DEDICATED_BRANCH`で作る。専用名が既存branch / worktreeと衝突する場合はbranchを動かさず停止する。

```bash
git gtr new "$LOCAL_BRANCH" --from "$HEAD_OID" --track none --no-fetch --yes
```

作成後もpath / `LOCAL_BRANCH` / OID / clean / 一意性を再検証する。remote `HEAD_REF`とlocal `LOCAL_BRANCH`を分離する。

mutation開始時は`EXPECTED_REMOTE_OID=HEAD_OID`、`EXPECTED_LOCAL_OID=HEAD_OID`とする。最初の編集前に`PR_STATE == OPEN`、head repositoryがnonnull、`VIEWER_CAN_EDIT_FILES == true`を要求する。`git remote`でremote名を全件列挙し、各nameについて`git remote get-url --push --all "$remote"`を実行する。取得したraw effective push URLを保持したまま正規化先を`HEAD_REPO` / `HEAD_REPO_URL`と照合し、一致するraw URLをexact stringで重複排除する。候補がexactly 1件ならそのraw URL自体を`PUSH_TARGET`にし、0件、複数件、または1remoteでもURL取得失敗なら単一の`HEAD_REPO_URL`をdirect `PUSH_TARGET`にする。これによりfetch / push URLの取り違え、検証後のpushurl変更、multi-push remoteのpartial successを避ける。`git ls-remote "$PUSH_TARGET" "refs/heads/$HEAD_REF"`が`EXPECTED_REMOTE_OID`と一致し、`git push --dry-run "$PUSH_TARGET" "$HEAD_OID:refs/heads/$HEAD_REF"`が成功することを確認する。dry-runは新しいcommitのruleset通過を保証しない。

最初の編集、各commit、各push、各GitHub mutationの直前に、worktree path、`LOCAL_BRANCH`、local HEAD=`EXPECTED_LOCAL_OID`、再取得したGitHub tuple、remote OID=`EXPECTED_REMOTE_OID`、statusがその段階のexact scopeだけであることを再検証する。commit後は`EXPECTED_LOCAL_OID`を更新する。通常pushでは`EXPECTED_REMOTE_OID`がlocal HEADのancestorであることを`git merge-base --is-ancestor`で要求し、dry-runと実pushの両方に`--force-with-lease="refs/heads/$HEAD_REF:$EXPECTED_REMOTE_OID"`を指定する。このleaseはremote refのexact CASにだけ使い、ancestry gateによりhistory rewriteを許可しない。push後にGitHub `HEAD_OID == local HEAD`を確認してから`EXPECTED_REMOTE_OID`を更新する。失敗時はlocal workを保持して停止し、reset / stash / force branch move、返信・resolve・review依頼・対応済み報告を行わない。

PR入力はフェーズ1からこのgateを通る。issue / branch / 引数なし入力はPR作成前にはidentityが存在しないため従来の専用worktreeで実装し、フェーズ3でPRを作成・再取得した直後に同じtupleとgateへ移行する。以降フェーズ4〜11のproducer commandによるdocument/code編集、各commit、各push、GitHub mutationもこのgateを省略しない。明示的な分析のみはpull refまでのread-only処理とし、編集・commit・pushを行わない。

### 最終AIレビュー依頼前のbase更新は再検証して自動続行

最終AIレビューのrequest baseline / write準備を始める前（フェーズ1〜10）では、通常のbase前進や、この実行が行ったbase統合だけを理由に停止・承認待ち・「続けて」の要求をしない。この節を共通mutation gateおよび下位producerの一律停止規則より先に適用し、条件を満たせば更新後のidentityを全producerへ渡して同じ実行を続ける。フェーズ11の依頼準備開始後、フェーズ12、local fallbackにはこの例外を適用せず、それぞれのrequest boundary・checkpoint・無効化・再依頼規則を使う。

- base更新を検出したら、同じhost / base repositoryの同じ`BASE_REF`をfetchし、保存baseから観測した新baseへの通常の前進を`git merge-base --is-ancestor <old-base> <new-base>`で確認する。GraphQLの`BASE_OID`とfetchしたbase先端が異なる場合は両方を別々に記録し、値を混同しない。GraphQL側のbase変更も保存値からのancestor証明を要求し、観測OIDが同じbase branchの履歴上にあることを確認する。
- `BASE_OID`以外のidentityは不変、worktree path / local branchは検証済みの対象、local / raw remote / GitHub headはexpected OIDと一致、statusは当該フェーズのexact scopeだけであることを要求する。自分の統合commitをpushした直後だけは、記録済みparent・統合base・解消path・commit OID・exact lease pushの証跡に一致する新headを採用してよい。他者のhead更新は自分の更新として採用しない。
- GitHubの反映が遅れているだけなら最大60秒、短い間隔でread-only再取得して収束を待つ。POST・commit・pushを再実行しない。収束不能、base retarget、履歴の書き換え、対象や権限の変更、想定外のhead / dirty差分、証跡不足は従来どおり停止する。
- PRの競合解消にbase統合が必要なら、cleanな対象worktreeで統合前head・統合base・対象pathを記録し、既存コメントと双方の変更意図を保持して解消する。解消内容を検証し、共通gateとancestor確認を通して通常commit / exact lease pushする。意図を判断できない競合は停止して具体的な判断点を尋ねる。単なるbase前進のたびに不要なmerge commitは作らない。
- 検証後、旧 / 新baseと証明、必要なら自分の統合headとpush証跡を保持し、operational identityの`BASE_OID`とexpected headを実観測へ更新する。この更新を「identity不一致」として再度停止しない。更新後のPR差分を再取得し、影響するreview・test・CI・成果物を再実行してから残りのフェーズへ進む。過去の検証結果を新しい差分の完了証拠へ流用しない。

## フェーズ1: セットアップ

### 1. 入力の解析

- **PR URLまたは`prN` / `pr#N`の場合**:
  1. 共通PR identity tupleを取得し、fork-safe pull refと専用worktreeを検証する
  2. `HEAD_REF`はremote branch、`LOCAL_BRANCH`はlocal worktree branchとして別々に保持する
  3. ベースブランチ: `BASE_REF`を使用（ユーザー確認不要）
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
  - 共通gateのpull ref fetchと既存worktree選択を使う。`origin/<headRefName>`から取得しない
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

1. 最初のpush前に、`git -C <worktree-path> branch --show-current`で現在のブランチ名を取得し、空でないことを確認して`BRANCH_NAME`として保持する。`codex/`で始まる場合だけ、リモートheadとopen PRをそれぞれ確認する:
   ```bash
   git ls-remote --heads origin "$BRANCH_NAME"
   gh pr list --state open --head "$BRANCH_NAME" --json number,title,url --jq 'length'
   ```
   - 2つのcommandの終了statusと出力を個別に保持する。どちらかが失敗した場合は公開状態を判定できないため、改名もpushもせずエラーを報告して停止する
   - 両方が成功し、`git ls-remote`の出力が空、かつopen PR件数が`0`なら未公開branchなので、変更内容に合う`feat/`・`fix/`・`chore/`・`refactor/`等の`<type>/<descriptive-slug>`を決め、`git -C <worktree-path> branch -m "$NEW_BRANCH_NAME"`で改名して`BRANCH_NAME="$NEW_BRANCH_NAME"`へ更新する
   - 両方が成功し、`git ls-remote`の出力が空でないか、open PR件数が`1`以上なら、force-pushやPR破損を避けるため改名せず、既存の`BRANCH_NAME`をそのまま使う
2. `BRANCH_NAME`をリモートにpush:
   ```bash
   git -C <worktree-path> push -u origin "$BRANCH_NAME"
   ```
3. draft PRを作成:
   ```bash
   gh pr create --draft --title "<PRタイトル>" --body "$(cat <<'EOF'
   ## Summary
   <変更内容の要約>

   Closes #<number>
   EOF
   )" --head "$BRANCH_NAME"
   ```
   - issue番号がある場合、本文に `Closes #<number>` を含める
   - PRタイトルはissueタイトルを元に生成
   - **stack PR の場合**: `--base <親ブランチ>` を付けて、PRのベースを親ブランチに向ける（origin/main 向けにしない）
4. 作成結果のcanonical PR URLから`PR_HOST`を導出・検証し、`gh api graphql --hostname "$PR_HOST"`で作成したPRを再取得して共通identity tupleを確立する。`HEAD_REF == BRANCH_NAME`、`HEAD_OID == local HEAD`を確認し、`LOCAL_BRANCH=BRANCH_NAME`として共通mutation gateへ移行する。取得または一致確認に失敗した場合は、PRを推測で報告せずlocal workを保持して停止する

### 6. 中間報告

セットアップ完了時点で以下を報告:
- worktreeのパス
- ブランチ名（`LOCAL_BRANCH`）
- 対象PRの `#<番号> <タイトル>（<PR URL>）`
- これからrefineフェーズに入る旨
- 進捗状況（例: `完了: フェーズ1-3 / 残り: フェーズ4-12`、PR入力の場合: `完了: フェーズ1（2-3スキップ） / 残り: フェーズ4-12`）

## フェーズ4: refine（loop-critics-fix）— クロスツール委譲は現在オフ

フェーズ4〜11でproducer commandの手順をReadして直接実行するたびに、`PR_URL`、12-field identity tuple、`PR_HOST`、`BASE_REPO_NODE_ID`、`DEDICATED_BRANCH`、`<worktree-path>`、`LOCAL_BRANCH`、`EXPECTED_REMOTE_OID`、`EXPECTED_LOCAL_OID`を現在値付きで引き継ぐ。下位手順に裸のPR番号・引数なしcurrent repository・default hostから対象を解決する記述があっても使用せず、`PR_URL`、`--hostname "$PR_HOST"`、host-qualifiedな`$PR_HOST/$BASE_REPO`へ置き換える。各producerの編集・commit・push・GitHub mutation前には共通mutation gateを再検証し、不一致ならlocal workを保持して停止する。

<!-- CROSS-TOOL-REVIEW-OFF: `codex exec` / `claude -p` による2巡目は現在オフ。
     再有効化するときは、frontmatter の Bash(codex exec:*) と Bash(claude:*)、4.2 の委譲先、
     4.3 の完了条件、最終報告の refine 記載を元に戻す。 -->

このフェーズは、起動元にかかわらず **現在のセッション自身による loop-critics-fix（1巡目）のみ**を実行する。Claude Code 起点の `codex exec` と Codex 起点の `claude -p` はどちらも起動しない。

1巡目のループ管理・オーケストレーションは、現在の起動元セッションが行う。2巡目のクロスツール・オーケストレーションはトグルオフ中のため行わない。

対象はフェーズ3で作成した、またはPR入力時にフェーズ1で取得したcanonical `PR_URL`と保持identityを使用する（表示や一時file名にだけ`{PR番号}`を使う）。以下のコマンドはすべて **worktreeディレクトリ**（フェーズ1で作成したパス）から実行する。

### 4.0. 起動元ツールの判定

`printenv CLAUDECODE` を実行して起動元を判定する:

- 出力が `1`（値あり） → **claude code 起点**
- 出力が空（未設定・終了コード非0） → **codex 起点**

クロスツール委譲は現在オフのため、起動元の判定結果にかかわらず4.2の2巡目は行わない。

### 4.1. 起動元ツール自身での loop-critics-fix（1巡目）

起動元がどちらでも、まず**いま動いているこのセッション自身で** `../loop-critics-fix/SKILL.md` を Read で読み込み、`PR_URL`を明示入力として保持identityとともに引き継いで、その手順に従ってレビュー＆修正ループを実行する。裸のPR番号やcurrent repositoryから対象を再解決しない。新規発見が0件で収束するまで回す。

収束後、loop-critics-fixが最終報告した実際のcritics review mdを全件、exact listの`CRITICS_PATHS`として記録する。固定保存先で再探索せず、以降のfollow-up追記・要約・stage・最終報告に同じリストを使う。

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

**A. 親の前処理（委譲なし・その場で実施）**: `pr-{PR番号}-critics-tmp/` を作成。`gh pr diff "$PR_URL"` を `pr-{PR番号}-diff.txt` に保存。既存 critics docを`**/critics-review-pr-{PR番号}.md`、`**/critics-review-pr-{PR番号}-backend.md`、`**/critics-review-pr-{PR番号}-frontend.md`で検索し、`*-resolved.md`とアーカイブ用ディレクトリ配下のarchiveを除いて見つかった全pathを`CRITICS_PATHS`として読み込み、前回の対応済み/対応不要リストを把握。ガイドライン（CLAUDE.md / AGENTS.md 等）を収集。diff からレビュワー構成（M ドメイン）とコンテキスト収集領域を決定する。

**B. コンテキスト収集（並列リーフ）**: 領域ごとに `OTHER` リーフを一括起動。各リーフは担当領域の周辺コード（依存・呼び出し元・関連テスト・既存パターン）を調査し `pr-{PR番号}-critics-tmp/context-{area}.md` に簡潔にまとめる。→ `wait` → 親が全 context を読む。

**C. レビュー（並列リーフ）**: ドメインごとに `OTHER` リーフを一括起動。各リーフは diff＋該当ソース＋関連 context を読み、**自領域の懸念のみ**を `pr-{PR番号}-critics-tmp/review-{domain}.md` に出力（重要度 CRITICAL/HIGH/MEDIUM・file:line・問題点・該当コード・推奨対応、ultrathink で深く）。既存 doc の対応済み/対応不要（親がプロンプトに列挙して渡す）は再指摘しない。→ `wait` → 親が全 review を読む。

**D. 相互検証（並列リーフ）**: 検証観点ごと（矛盾検出 / 重複検出 / 確信度検証 / コード照合）に `OTHER` リーフを一括起動。各リーフは全 findings 一覧を受け取り、担当観点で検証して `pr-{PR番号}-critics-tmp/verify-{angle}.md` に判定を書く（必要ならソース直読）。→ `wait` → 親が統合（重複マージ・矛盾解決・確信度の採否・重要度順）。

**E. 解説充実（並列リーフ）**: 確定した懸念点をグループに分割し、グループごとに `OTHER` リーフを一括起動。各リーフは担当懸念点の「問題点」「推奨対応」を具体化（そのまま適用できるコードスニペット付き）して `pr-{PR番号}-critics-tmp/enrich-{group}.md` に書く。懸念点の追加/削除/重要度変更はしない。→ `wait` → 親が doc に反映。

**F. doc 執筆（親・委譲なし）**: 親が critics-reviewer.md の出力フォーマット・既存 doc 保持ルールに従って`CRITICS_PATHS`を更新する。新規作成時はproducerが決めた実pathを同リストへ追加する。完了後、`pr-{PR番号}-diff.txt` と `pr-{PR番号}-critics-tmp/` を削除する。

#### ループ（親が制御、最大5イテレーション）

各イテレーションで以下を順に行う:

1. **critics パイプライン実行**: 上記 A〜F を実行する（各並列フェーズは小さなリーフを `OTHER` で一括起動し `wait`）。
2. **親が収束判定**: 親が`CRITICS_PATHS`の全ファイルを Read し、「未対応の懸念点」セクションを確認する。
   - 未対応が0件、かつ前イテレーションから**新規発見なし** → ループ終了（4.3 へ）
   - 未対応が残っている → ステップ3へ
3. **fix を委譲（修正・1パス）**: `OTHER` に次の `<prompt>` を渡して実行させる。
   > `../loop-critics-fix/SKILL.md` のステップ2（未対応懸念点の修正 → 対応済みに更新 → コミット → push）の手順に従って、`<PR_URL>`と親から渡したidentityに対応する critics-review doc の未対応懸念点を**1巡だけ**修正・コミット・pushして。裸のPR番号やdefault hostへ戻らないこと。**再レビューやループはしない**（ループは親が管理する）。Skill tool は使わず手順を直接実行すること。
4. ステップ1に戻る。

最大イテレーション（5回）到達、または収束（未対応0件かつ新規発見なし）で 4.2 を終了する。委譲先ツール名・各イテレーションのレビュー件数/修正件数/起動したリーフ数を親が記録する。
-->

### 4.3. フェーズ4の完了条件

- 起動元セッション自身による1巡目が、最終的に**未対応の懸念点0件・新規発見0件**で収束していること
- `codex exec` / `claude -p` の2巡目は実行せず、最終報告の `refine` に `cross-tool review skipped: toggle off` と明記すること

これらを満たして初めてフェーズ4完了とする。1巡目のイテレーション数・修正件数・新規発見件数を最終報告に含める。

## フェーズ5: 自動テスト追加（pr-test）

`../pr-test/SKILL.md` を Read で読み込み、`PR_URL`を明示入力として保持identityとともに引き継いで、その手順に従って PR に必要な自動テストの洗い出し・実装・検証ループを実行する。裸のPR番号やcurrent repositoryから対象を再解決しない。

- ユーザー承認は待たず、未カバー項目はすべて実装する
- 実装したテストは pr-test の手順に従ってコミット・push する
- 設計md（`temp-docs/test-design-pr-{PR番号}.md`）と報告md（`temp-docs/test-implementation-report-pr-{PR番号}.md`）の生成・更新も pr-test の手順に従う
- pr-testが最終報告した設計md・報告mdの実pathをexact listの`TEST_ARTIFACT_PATHS`として記録する
- 新規発見が0件、未実装テスト項目が0件になった時点でフェーズ完了とする（最大10イテレーションで打ち切り）

## フェーズ6: CI チェック

`../ci/SKILL.md` を Read で読み込み、その手順に従ってCI チェック（lint, type check, test）を実行する。

問題があれば修正し、コミット・pushする。すべてのチェックがパスするまで繰り返す。

## フェーズ7: PR description更新

`../pr-description/SKILL.md` を Read で読み込み、その手順の対象を保持済み`PR_URL`へ固定してPR descriptionを生成・更新する。下位手順の引数なし`gh pr`は同じ操作の`PR_URL`指定形へ置き換え、REST / GraphQLは`--hostname "$PR_HOST"`、repo引数は`$PR_HOST/$BASE_REPO`を使う。裸のPR番号・current repository・default hostから再解決せず、follow-up issueリンクには上で保持したcanonical `issue.url`だけを使う。

CI結果や最終的な差分を反映した状態で実行し、PR本文・タイトル・動作確認チェックリストを最新化する。追加した自動テスト（フェーズ5）の内容も description に反映する。

- CI・lint・型チェック・build・自動テストの結果は、チェックボックスを使わない「検証結果」等のセクションへ記載する
- 「動作確認」のチェックリストには、CIでは判定できず人間が実際に操作する必要がある項目だけを未チェックで記載する

### 必要な場合のローカルQA・スクリーンショット掲載

ユーザーに見えるUI変更があり、ユーザーがスクリーンショットを求めた場合、または表示差分を画像で示すことがレビュー判断に有効な場合は、PR description更新後に`../pr-local-qa-screenshot/SKILL.md`をReadし、その手順を保持済み`PR_URL`とidentityに固定して実行する。バックエンド・設定・文書のみの変更や、画像が判断材料にならない変更では実行せず、スキップ理由を保持する。

- ローカルで実際の変更箇所を操作し、期待するDOM・操作結果の検証と画像の目視確認を両方行う
- スクリーンショットは一時コミットの完全長OIDへ固定したURLでPR descriptionに掲載する
- 撮影用route・script・Markdown・`temp-docs`のPNGを後続コミットで削除し、最終PR差分に残さない
- PNG削除後も固定コミット上の画像が取得でき、PR descriptionに表示されることを確認する
- screenshot commitの履歴を書き換えない。後続でsquash / rebase / force rewriteが必要になった場合は、新しい到達可能なOIDで掲載処理をやり直す
- 実行による通常push後は`EXPECTED_REMOTE_OID`を更新し、フェーズ8へ進む前にlocal / raw remote / GitHub headの一致を再検証する

## フェーズ8: Ready for Review

全チェック通過後、PRのdraftを外す:

```bash
gh pr ready "$PR_URL"
```

## フェーズ9: PR解説md作成（pr-explain）

`../pr-explain/SKILL.md` を Read で読み込み、`PR_URL`を明示入力として保持identityとともに引き継いで、その手順に従ってPR解説md（mermaid図含む）を作成する。裸のPR番号やcurrent repositoryから対象を再解決せず、follow-up issueリンクには上で保持したcanonical `issue.url`だけを使う。最新のCI結果・PR descriptionが反映された状態で実行する。

pr-explainが最終報告した実際の相対pathを`EXPLANATION_PATH`として記録する。

作成後、解説mdをコミット・pushしてPRに含める:

```bash
git -C <worktree-path> add <解説mdのパス>
git -C <worktree-path> commit -m "docs: add PR explanation"
git -C <worktree-path> push --force-with-lease="refs/heads/$HEAD_REF:$EXPECTED_REMOTE_OID" "$PUSH_TARGET" "HEAD:refs/heads/$HEAD_REF"
```

## フェーズ10: critics review の要約（summarize-resolved）

`../summarize-resolved/SKILL.md` を Read で読み込み、その手順に従って、`CRITICS_PATHS`の各ファイルを実path指定で1つずつ要約・整理する。複数候補を再探索してユーザー選択を求めず、フェーズ4から引き継いだ全ファイルを対象にする。

PR番号は フェーズ3 で作成したPR、またはPR入力の場合はフェーズ1で取得したPR番号を使用する。

要約後、変更された`CRITICS_PATHS`のexact listだけをコミット・pushする:

```bash
git -C <worktree-path> add -- <変更された CRITICS_PATHS の全パス>
git -C <worktree-path> commit -m "docs: summarize critics review"
git -C <worktree-path> push --force-with-lease="refs/heads/$HEAD_REF:$EXPECTED_REMOTE_OID" "$PUSH_TARGET" "HEAD:refs/heads/$HEAD_REF"
```

要約対象ファイルが見つからない場合（critics ファイルが存在しない等）はスキップし、その旨を最終報告に含める。

### artifact-excluded repositoryの一時成果物除外

対象repositoryが **artifact-excluded repository**（プロジェクト指示（`AGENTS.md` / `CLAUDE.md` 等）で、PR固有の一時成果物Markdownを最終diffに残さないと定められたrepository。生成したMarkdownがそのまま配布物・公開物になる場合が該当する）なら、フェーズ9・10まで一時成果物を利用した後、`CRITICS_PATHS`、`TEST_ARTIFACT_PATHS`、`EXPLANATION_PATH`のexact listにあるPR固有mdだけを最終PR diffから除外し、除外commitをpushする。

- path globや`git add -A`は使わず、この実行でproducerから記録したexact pathだけを対象にする
- 各pathが作業開始時のbase treeに存在しない、このフローで追加したファイルであることをpath単位で確認する。base treeに存在したuser fileなら削除せず停止して報告する
- 別のMarkdown、source、未追跡user fileは削除・stageしない
- 対象pathを`git -C <worktree-path> rm -- <確認済みexact pathの全件>`で削除し、削除だけを`chore: exclude PR artifacts`としてcommit/pushする。対象が0件なら空commitは作らない
- 除外後、`gh pr diff "$PR_URL" --name-only`に上記PR固有mdが残っていないことを確認する
- Phase12で`REVIEW_DECISION_PATHS`が作られた場合は、`review-comment-analysis`のStep 9.6をcleanup ownerとしてcurrent listの返信利用後にgeneration別cleanup obligationを一度ずつ処理し、Phase12 wrapperは結果を再検証する。`CREATED_REVIEW_DECISION_PATHS`はdedup path historyとして保持し、同pathの後続generationをcleanup済みとみなす根拠にしない
- 最終報告には各成果物の実pathと「artifact-excluded repositoryのため最終diffから除外済み」を残す

この除外commitを含め、ここまでに必要な通常の編集・commit・pushをすべて完了させる。続けて以下を満たすことを確認し、この時点を**最終通常push境界**とする:

- `<worktree-path>`がcleanで、local `HEAD`、raw remote tracking ref、GitHub GraphQLの`HEAD_OID`が一致する
- 保持済み12-field identity tupleをGraphQLから再取得して全fieldが一致し、`BASE_REF`と`BASE_OID`も最新値で一致する
- `gh pr diff "$PR_URL" --name-only`に除外対象のPR固有mdが残っていない

以後、フェーズ11のレビュー依頼後は、通常フェーズとして編集・commit・pushしてはならない。レビュー対応でpushが必要になった場合はフェーズ12の再依頼手順で**レビューラウンド全体を無効化**し、全処理後の新しい最終headに対して依頼をやり直す。

## フェーズ11: 最終headへのAIレビュー依頼（request-ai-review）

<!-- COPILOT-REVIEW-OFF: Copilot へのレビュー依頼は現在オフ（コメントアウト中）。
     再有効化するときは、この注記ブロックと下記 ">【Copilot オフ】" の引用、
     フェーズ12のCopilot注記、最終報告の取り消し線を元に戻す。 -->

> **【Copilot オフ】** request-ai-review の手順を実行する際、**Copilot へのレビュー依頼はスキップ**し、**Codex のみ**に依頼する。Geminiもskipし、baseline取得・依頼・監視の対象に含めない。Copilot / Gemini を「依頼済みレビュアー」に含めないこと（→ フェーズ12の監視対象からも自動的に外れる）。

`../request-ai-review/SKILL.md` を Read で読み込み、reviewer policyへ`copilot: disabled`、`codex: enabled`、`gemini: disabled`を明示して、その各手順を保持済み`PR_URL`とidentityへbindingしCodexにレビュー依頼を送る。Geminiはskipし、availability分類・baseline取得・依頼・監視を行わない。下位手順にある裸の`gh pr ... <PR番号>`は`PR_URL`指定、全`gh api`は`--hostname "$PR_HOST"`、repo引数は`$PR_HOST/$BASE_REPO`へ置き換える。裸のPR番号・current repository・default hostから再解決しない。

### Codex usage limit 時のlocal review fallback

Codex reviewの依頼または監視中に、GitHub側のCodex利用枠を使い切ったことが**明示的かつ今回の依頼へ一意にbindingされた証跡**で確認できた場合は、即時スキップせず、OpenAI提供のCLI reviewerである`codex review`へfallbackする。GitHub側の証跡は次の`trigger`として保持する:

```
CODEX_LOCAL_REVIEW:
  state: not_started | running | findings | complete | unavailable
  external_data_transfer:
    authorized: true | false
    authorization_evidence: <ユーザー発言の要約またはnull>
    bound_pr_url: <canonical PR URLまたはnull>
    authorized_at: <証跡の時刻またはnull>
  trigger:
    detected_in: phase11 | phase12
    request_head_oid: <GitHub側review requestの完全長OID>
    request_round: <該当round | null>
    request_attempt: <該当attempt | null>
    evidence: <HTTP response、またはexact Codex botのresponse ID / URL / body / server timestamp>
    resets_at: <明示されていれば時刻 | null>
  profile_order: <discoverして決めたprofileのexact order list>
  profile: <現在試しているprofile名 | null>
  profile_home: <現在のCODEX_HOME絶対path。defaultは~/.codex | null>
  model: <-c model= へ渡したslug。無指定ならnull>
  profile_attempts:
    - profile: <profile名>
      profile_home: <CODEX_HOME絶対path>
      model: <試したslug | null>
      command: <実行したexact command>
      exit_status: <integer>
      outcome: reviewed | usage_limit | model_unsupported | auth_missing | other_error
      evidence: <full terminal output または error output>
  iteration: <1..5>
  reviewed_head_oid: <完全長OID | null>
  reviewed_base_ref: <BASE_REMOTE/REQUEST_BASE_REF | null>
  reviewed_base_oid: <完全長OID | null>
  command: <実行したexact command | null>
  exit_status: <integer | null>
  findings_count: <integer | null>
  actionable_count: <integer | null>
  output: <reviewerのfull terminal output | error output | null>
```

fallback triggerを認めるのは次をすべて満たす場合だけ:

- `CODEX_LOCAL_REVIEW.external_data_transfer.authorized == true` で、許可証跡が今回のcanonical `PR_URL`へbindingされている。fresh Agentへ渡すpromptにもこの3項目を加工せず含める
- response本文またはserver metadataが `usage limit reached`、`quota exceeded`、`credits exhausted`、利用枠のリセット待ち等、**Codexの利用枠枯渇**を明示している。単なるtimeout、permission error、network error、temporarily unavailable、レビュー失敗、曖昧なエラーは対象外
- GitHub上のresponseはexact bot identityがREST `chatgpt-codex-connector[bot]` / GraphQL `chatgpt-codex-connector`であり、`requested_at`より後のserver timestampと、current requestへのexact causal metadata、または競合trigger 0件・未解決先行successful attempt 0件のfull inventoryにより今回の依頼へ一意にbindingできる
- 全feedback channel / 全page inventoryを取得し、今回またはcarryoverの未処理feedback、actionable finding、`pending | action_pending`が0件である。見つかったGitHub上の指摘をfallbackで無視しない
- worktreeがcleanで、full identity、base、local HEAD、raw remote tracking ref、GitHub `HEAD_OID`が`trigger.request_head_oid`と一致する

条件を満たしたら、新しいGitHub request、boundary rotation、空commit、再依頼、Phase12 Agentの再起動を行わず、次を最大5イテレーション実行する:

1. `git fetch "$BASE_REMOTE" "+refs/heads/$REQUEST_BASE_REF:refs/remotes/$BASE_REMOTE/$REQUEST_BASE_REF"`を実行し、`refs/remotes/$BASE_REMOTE/$REQUEST_BASE_REF`の完全長OIDが`REQUEST_BASE_OID`と一致することを確認する。不一致ならreviewせず`incomplete`で停止する
2. worktree、full identity、base、local/raw remote/GitHub headの一致を再検証し、下記「profileのrotation」で決めた順に`codex review`を1 profileずつ実行する。`--base`とcustom promptは同時指定できないため、標準のcode review指示を使う。`CODEX_LOCAL_REVIEW.command`には実行時に展開したコマンドをそのまま記録する。レビューはPR差分のみを対象とし、ファイルを変更しない

#### profileのrotation

`codex`はCODEX_HOME別に複数アカウントを持ちうるため、**1 profileのusage limitだけで`unavailable`と判定しない**。

- profile候補は`ls -d "$HOME/.codex" "$HOME/.codex-"*`で毎回discoverし、`auth.json`を持つものだけを残す。profile名をこのドキュメントへhardcodeしない
- rotation順は`~/.codex`（default）を先頭、以降はdirectory名の昇順とする。ユーザーがprofileを明示した場合はそれを先頭へ置く
- 決めた順序を`profile_order`へ保存し、各試行を`profile_attempts`へappend-onlyで記録する
- defaultは`CODEX_HOME`を設定せずに実行し、それ以外は`CODEX_HOME="$HOME/.codex-<profile>"`を前置する。shell関数`codex <profile>`ではなく`command codex`を使い、関数定義の有無に依存しない
- あるprofileが`usage_limit`なら次のprofileで同じiterationをやり直す。`reviewed`になった時点でrotationを止める

#### modelの互換性

`config.toml`の`model`がそのprofileのアカウント種別で使えないことがある（例: ChatGPTアカウントで`gpt-5.6-sol`を指定すると`The '<model>' model is not supported when using Codex with a ChatGPT account.`）。**これは利用枠枯渇ではないため`usage_limit`に分類せず**、同じprofile内でmodelを補正して1回だけ再実行する。

- `$CODEX_HOME/models_cache.json`の`models[]`から`visibility == "list"`かつ`priority`最小の`slug`を選び、`-c model="<slug>"`で上書きする。選んだslugを`model`と当該`profile_attempts`エントリへ記録する
- `models_cache.json`が無い、または補正後もmodel非対応が続くprofileは`model_unsupported`として次のprofileへ進む
- `auth.json`はあるがauth不備で起動できないprofileは`auth_missing`、network error等は`other_error`として記録し、いずれも`usage_limit`に数えない

```bash
# default profile
command codex review --base "$BASE_REMOTE/$REQUEST_BASE_REF"
# 名前付きprofile（modelを補正する場合）
CODEX_HOME="$HOME/.codex-<profile>" command codex review \
  -c model="<models_cache.jsonから選んだslug>" \
  --base "$BASE_REMOTE/$REQUEST_BASE_REF"
```
3. command、exit status、full output、reviewed head/baseを`CODEX_LOCAL_REVIEW`へ保存する。終了status 0かつ明示的なterminal outputだけをreview結果として採用し、実行後もworktree、identity、base、全headが不変であることを確認する
4. findingsを周辺コード・テスト・project guidelineと照合して個別に判定する。actionable findingが0件なら`state=complete`とする。false positiveまたは対応不要は理由を保持する。actionable findingがあれば通常のmutation gateで修正・テスト・commit・exact lease pushを行い、変更で無効になったフェーズ5〜10を再実行して新しい最終通常push境界を作り、更新したhead/baseで次のlocal review iterationへ進む
5. 5イテレーションでactionable finding 0件へ収束しない、terminal outputが曖昧、またはusage limit以外のerrorなら`incomplete`で停止する。`state=unavailable`へ進めるのは、**`profile_order`の全profileを実際に試し、そのすべてが`outcome=usage_limit`だった場合だけ**とする。`model_unsupported` / `auth_missing` / `other_error`で終わったprofileが1件でも残る場合は`unavailable`にせず`incomplete`で停止する

local fallbackも利用枠枯渇で実行不能な場合だけ、次を保持してフェーズ11〜12の残りをスキップしてよい:

```
CODEX_REVIEW_SKIP:
  reason: usage_limit
  detected_in: local_fallback
  request_head_oid: <local fallbackを試した最終headの完全長OID>
  request_round: <GitHub側の該当round | null>
  request_attempt: <GitHub側の該当attempt | null>
  evidence: <CODEX_LOCAL_REVIEW.trigger.evidence>
  fallback_evidence: <local codex reviewのexact command / exit status / usage limit output>
  profiles_tried: <CODEX_LOCAL_REVIEW.profile_attempts の全件。全entryがoutcome=usage_limitであること>
  resets_at: <明示されていれば時刻。profileごとに異なる場合は最も遅い時刻 | null>
```

`CODEX_REVIEW_SKIP`ではCodexレビューを「指摘0件」「review済み」「成功」とは扱わず、`skipped: GitHub and local usage limit`として記録する。GitHub側のquota証跡だけでskipしてはならない。**利用可能な全codex profileを実際に試し、そのすべてがusage limitであることを`profiles_tried`で示せない限りskipしてはならない。**

フェーズ11は`PHASE11_MODE=initial | resume_no_boundary`を明示する。`initial`は最初のattemptだけ、`resume_no_boundary`は成功trigger 0件で有効boundaryを作れなかったattemptの継続だけに使う。最初のPOST前から、下記checkpoint schemaと同形の`REQUEST_TRANSITION_STATE`、append-only `REQUEST_ATTEMPT_LEDGER`を親contextで保持する。最初のcandidateは`REQUEST_ROUND=1`、`REQUEST_ATTEMPT=1`とし、prepared stateを作った同一live executorだけが、各reviewerのfull baselineと`write_prepared`を親が保持したexact ack直後にPOSTを1回行える。fresh / resume executorがpreparedを受け取った場合はPOST済みかもしれないため即read-only convergenceだけを行い、exactly 1件を一意に採用できる場合だけ継続し、0件・複数・曖昧なら自動再POSTせず`incomplete`で停止する。成功trigger 0件かつHTTP response等で全reviewer writeのserver非作成を`proven_not_created`と証明できた場合も、先にglobal `ROUND_OUTCOME=incomplete` / `ROUND_STATE=incomplete_no_boundary`、latest ledger `boundary=null` / `outcome=incomplete_no_boundary` / nonnull full `incomplete_evidence`、transition exact一致を同じpost-checkpointへ保存する。その完全tupleを検証した後だけ、同じcandidate roundのattemptを増やしてfresh baselineから`resume_no_boundary`できる。hard interruption後にexact transition / ledgerがなければGitHub上のtriggerを推測してフェーズ11を再実行せず停止する。有効boundaryを持つ完了transitionとledger全体だけをフェーズ12 `initial`へ渡し、成功trigger 0件のままPhase12へ進めない。

依頼直前に、以下を凍結する:

- `REQUEST_HEAD_OID`: local `HEAD`、raw remote tracking ref、GitHub GraphQL `HEAD_OID`の3者が一致する完全長OID
- `REQUEST_BASE_REF` / `REQUEST_BASE_OID`: 保持identityの`BASE_REF` / `BASE_OID`
- `REQUEST_IDENTITY`: 順序を維持した12-field identity tupleと、補助identityの`PR_HOST`、`BASE_REPO_NODE_ID`、`DEDICATED_BRANCH`

`request-ai-review`が返す以下の値を加工せず保持する:

- `REQUEST_STARTED_AT`: 実際に成功したtrigger comment responseのGitHub server `created_at`の最小値。local clockで代用しない
- `REVIEWER_POLICY`: 実際に適用した`copilot: disabled`、`codex: enabled`、`gemini: disabled`
- `TARGET_REVIEWERS`: 初回roundでは明示的な`null`
- `REQUIRED_REVIEWERS`: 初回roundでpolicy対象となり`status == requested | incomplete`になったreviewerのexact set。`disabled`、`not_targeted`、証明済み`not_installed`の`skipped`は除く
- `REQUESTED_REVIEWERS`: `status == requested`になったreviewerのexact set
- `AI_REQUESTS`: reviewerごとの`status`、exact bot identity、trigger commentの`id` / `url` / `body` / `created_at`、`requested_at`、`request_head_oid`、`request_base_ref` / `request_base_oid`、依頼直前に全page取得したchannel別baseline ID setとcanonical snapshot
- `REQUEST_TRANSITION_STATE`: append-only ledgerの最新entryとexactに一致するcandidate identity / head / base / set / attempt / round、reviewer別write state、full baseline、expected trigger、full trigger response / evidenceを含むstate
- `REQUEST_ATTEMPT_LEDGER`: round / attemptごとのcandidate、全reviewer baseline / trigger evidence、成立boundary、outcome、invalidation reason、successor、terminal evidenceと別分類のincomplete evidenceを保持するappend-only history
- Geminiのavailability state: `available | not_installed | unknown_permission | temporarily_unavailable | retired`のいずれか

`REQUESTED_REVIEWERS`はtrigger成功集合、`REQUIRED_REVIEWERS`はround完了に必要な集合として分けて保持する。`AI_REQUESTS`で`status == requested`のreviewerだけはresponseを監視し、requiredなのに`incomplete`のreviewerが1件でもいればround全体を`incomplete`として停止する。Copilot / Geminiは依頼も監視もしない。`gemini: disabled`ではGeminiのavailability分類、baseline取得、依頼、監視を行わず`status = disabled`とする。`unknown_permission` / `temporarily_unavailable` / `retired` / 依頼失敗はrequired集合へ残し、「指摘0件」へ読み替えない。

依頼送信後にもう一度、full identity、`BASE_REF` / `BASE_OID`、local `HEAD`、raw remote tracking ref、GitHub `HEAD_OID`が凍結値と一致することを確認する。不一致ならそのラウンドを無効化し、別PRへ再解決せず停止する。各レビュアーへの依頼結果と凍結値を最終報告に含める。

## フェーズ12: AIレビュー出揃い監視 → review-comment-analysis 自動実行

Agent toolを `run_in_background: true` で起動し、`REQUIRED_REVIEWERS`のうち`AI_REQUESTS.status == requested`のreviewerに対する**今回の依頼境界より後の最終結果**を監視する。requiredなのに`incomplete`のreviewerがいれば待機で隠さずroundを`incomplete`として停止する。Copilotは依頼も監視もしない。フェーズ12はAgentの起動だけでは完了せず、最終レビューラウンドの結果を受け取って下記完了ゲートを満たすまで待つ。

### 12.1. 監視Agentの起動

起動ごとに`PHASE12_MODE=initial | resume`を明示する。`initial`はフェーズ11直後の初回起動だけ、`resume`は停止・`incomplete`・Agent context喪失後に同じPhase12を継続する起動だけに使う。

- `initial`: フェーズ11が成功trigger 1件以上の有効boundaryを返した場合だけ`PHASE12_CHECKPOINT = null`を渡す。この場合だけ`ROUND_STATE=active`、`ROUND_OUTCOME=monitoring`、`REVIEW_DECISION_PATHS=[]`、`CREATED_REVIEW_DECISION_PATHS=[]`、`PREVIOUS_REQUEST_BOUNDARY=null`、`PREVIOUS_REQUIRED_REVIEWERS=[]`、analysis iteration `0`、cleanup obligations / reply-resolve threads / feedback ledgerを空、git mutationをidleで初期化する。フェーズ11が返したfull request dataをcurrent boundaryへ、最新transitionを`REQUEST_TRANSITION_STATE`へ写し、フェーズ11から渡された`REQUEST_ATTEMPT_LEDGER`全entryを順序のまま保持する
- `initial`では`CODEX_LOCAL_REVIEW=null`、`CODEX_REVIEW_SKIP=null`とする。GitHub usage limitを検出したtransitionでだけ前者を作成し、後者はlocal fallbackもusage limitで失敗した後にだけ作成する
- `resume`: 直前Agentが返した`PHASE12_CHECKPOINT`を加工せず渡す。current path、request / feedback ledger、generation obligation、git mutation、thread substate、request transitionを空resetしたり、最新GitHub stateからboundaryやprogressを再構成したりしない

`PHASE12_CHECKPOINT`は永続fileやbranch artifactを作らず、親とAgent間で値として引き継ぐ。少なくとも次のexact stateを持つ:

```
PHASE12_CHECKPOINT:
  CHECKPOINT_VERSION: 9
  CHECKPOINT_IDENTITY: <checkpoint時点の12-field identity + PR_HOST + BASE_REPO_NODE_ID + DEDICATED_BRANCH>
  CODEX_EXTERNAL_REVIEW_AUTHORIZED: <true | false。trueの場合は許可発言・確認時刻・対象PR_URLのexact evidenceを必須とする>
  CODEX_LOCAL_REVIEW: <前述のlocal fallback構造 | null>
  CODEX_REVIEW_SKIP: <前述のusage limitスキップ構造 | null>
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

resume Agentは`CHECKPOINT_VERSION == 9`、`CODEX_LOCAL_REVIEW`、`CODEX_REVIEW_SKIP`、全field・list順序・重複なし・OID形式、全ledgerとrotation / base advance evidence listのappend-only性、cleanup generation keyとthread generation chain keyの一意性を検証する。通常は両fieldをnullとする。`CODEX_LOCAL_REVIEW`がnonnullなら前述のfallback stateとhead/base bindingを検証して未完了iterationを継続し、`CODEX_REVIEW_SKIP`がnonnullならlocal fallbackもusage limitで失敗した全証跡をread-only再検証してmutationやretryを行わず親へ返す。`REQUEST_TRANSITION_STATE`は`REQUEST_ATTEMPT_LEDGER.entries[-1].transition`とexactに一致させ、current / previous boundaryの上書き後も全attemptをledgerから再構成できなければ停止する。`ROUND_STATE=boundaryless`では`CURRENT_REQUEST_BOUNDARY=null`、`active`ではnonnullかつledger最新entryのnonnull boundaryとexact一致を要求する。`incomplete_no_boundary | retry_without_boundary`ではledger最新entryのboundaryをnullとし、先行する有効boundaryがなければcurrentもnull、あればcurrentをledger上で直近の先行nonnull boundaryとexact一致させ、失敗candidateで上書きしない。`ROUND_STATE=retry_after_incomplete`はboundary rotation / resume中だけのtransient current stateとし、その間はretry元entryの`outcome=incomplete`、`invalidation_reason=retry_after_incomplete`、nonnull `successor`のexact pairを要求してenum外outcomeを作らない。successor boundaryがactiveになった後はglobal stateを`active`へ戻し、retry履歴は旧ledger entryとrotation evidenceだけで検証する。request / feedback ledger entryは削除・並替えず、同一entryのstateは定義済みの単調遷移だけ、外部feedback更新は同じstable IDのversionを増やした新entryとしてappendする。cleanup obligationsは`pending -> completed | retained`とする。thread generation keyは`(request_round, analysis_iteration, thread_id, feedback_version, generation)`とし、botは`reply_pending | reply_outcome_unknown -> resolve_pending -> complete`、humanは`reply_pending | reply_outcome_unknown -> complete`、どのpending stateからも正当なexternal update時だけ`superseded`へ進める。chainの旧generationは`complete | superseded`だけとし、`superseded`には新しいfeedback version / generationを指すnonnull `successor`とsnapshot対応を示す`supersession_evidence`を必須にする。

current active boundaryのterminal transitionは`ROUND_OUTCOME`とledger最新current attemptを1つのatomic tupleとして扱う。transition前checkpointは旧tuple、transition後checkpointは`findings / zero / incomplete`の同じ値をglobalとlatest entry `outcome`へ同時に設定し、対応するfull evidenceも同じcheckpointへ保存するため、片方だけ更新したcheckpointを返さない。`findings | zero`では全`REQUIRED_REVIEWERS`のcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`、`incomplete`では取得済みterminalを欠落なく保持したうえで未到着・timeout・request failure・quota / permission / availabilityの対象reviewerと原因を網羅するnonnull `incomplete_evidence`を要求する。Codex quotaが前述のfallback trigger条件を満たす場合だけ、この通常terminal transitionの代わりに`CODEX_LOCAL_REVIEW`を保存してlocal reviewへ移行する。local reviewもusage limitで失敗した場合だけ`CODEX_REVIEW_SKIP`を保存して終了する。後続self-push / base advance / retryでhistorical entryを`invalidated | invalidated_base_advanced`またはreason付き`incomplete`として扱う場合だけcurrent globalとの一致から除外できるが、先行するatomic terminal tupleとevidenceを削除・上書きしてはならない。

incomplete retry lifecycleはA=current source、B=予約済みsuccessor key、C=verified rotation childに固定する。active Aのterminal `incomplete`から`ROUND_STATE=retry_after_incomplete`へ進むpost-checkpointは、Aのoutcome / reason / successor Bと、`GIT_MUTATION_STATE.state=prepared`かつ`kind=boundary_rotation`、source A、successor B、reason `retry_after_incomplete`、P、remote-before、exact empty paths / planned tree、subjectを同時に凍結するatomic transitionであり、retry stateとgit mutation idleのgapを作らない。このtransition観測でbaseが進んでいれば、same ref・saved→latest normal descendant proof・他identity不変を`pending_base_advance(window=transition_prepared, A/B/P, C=null)`とlatest operational baseへ同じcheckpointで結合する。C push前のretry stateはこのprepared / commit_observed / push_observed operationを必須とし、C push後だけverified rotation evidenceを持つA、未開始B、operation nullのidleを許可する。

成功trigger 0件のrequest terminalはcurrent active terminalとは別のboundaryless atomic tupleとする。同じpost-checkpointで`ROUND_OUTCOME=incomplete`、`ROUND_STATE=incomplete_no_boundary`、ledger最新entry `outcome=incomplete_no_boundary` / `boundary=null` / nonnull full `incomplete_evidence`、`REQUEST_TRANSITION_STATE.state=incomplete_no_boundary`と同entry transitionのexact一致を保存し、current boundaryは既定規則どおり保持する。全writeが`proven_not_created`の場合だけ、この完全tupleから後続`retry_without_boundary`へ進める。

`GIT_MUTATION_STATE.state != idle`のresumeでは、current active / operational expected-OID gateより先にoperation-specific recoveryを行う。保存`parent_oid=P`と、parent / subject / exact paths / planned treeまたはdiff hashへexact一致する直系childを`C`とする。`prepared`はlocal HEADが`P`またはexactly 1件の`C`、raw remote / GitHub headがそれぞれ`P | C`であることを検証し、child 0件で全headが`P`なら保存index / worktree planを再検証してcommit前から続ける。`commit_observed`は保存`child_oid=C`とcommit evidenceがexactでlocal HEAD=`C`、raw remote / GitHub headがそれぞれ`P | C`であることを要求する。`push_observed`はbounded convergence後にlocal / raw remote / GitHub headがすべて`C`であることを要求する。前段stateでexact childまたはpush済み`C`を発見した場合は単調にadoptし、`EXPECTED_LOCAL_OID`、`EXPECTED_REMOTE_OID`、関連ledger / cleanup obligation、commit / push evidenceを実観測へ収束させて`idle`へ戻す。複数child、plan不一致、`P | C`外、raw remote / GitHubの収束不能は停止する。

identity差分は原則停止するが、`BASE_REF`が同一、latest `BASE_OID`が保存base OIDのnormal descendantであることをbase commit graphからcryptographically証明でき、base OID以外の全identity fieldが不変な場合だけ、full proof、`window=non_idle_recovery`、operation ID / kind、A / B / Pと観測済みCまたはnullを`pending_base_advance`へcheckpointしてP/C recoveryを続ける。transition時点のpendingがあればwindow / saved proofを保持し、commit観測時にexact Cを追記する。operationがretry rotation A→Bとexact一致する場合、`prepared`ではpending保存後にCのcommit、`commit_observed`ではexact Cのpush、`push_observed`では3 headのC収束を行い、各checkpoint直後の中断も同じoperationからresumeする。C push後はAのappend-only `rotation_evidence`へoperation / P/C / pushを、`base_advance_evidence`へproof / window / `coalesced_retry_rotation`をappendし、A tupleとtransient stateを維持して2回目のrotationを作らない。B candidate前にlatest base / identityとexpected Cを再凍結し、その全更新後だけpendingをclearする。binding不一致または他operationではidle収束後に従来どおり`invalidated_base_advanced`と必要な別rotationを処理する。

checkpointなし、部分的field、identity / OID / request ledger / feedback ledger / git mutation / path generation / thread substate / request transition不一致、またはhard interruptionにより安全なcheckpointを得られない場合は、新boundary作成、cleanup / reply済み主張、最終zero判定を行わずblockerとして停止する。glob、固定path、単一path、GitHubの現在値から欠落stateを推測で補わない。

background Agentは`incomplete` / 停止時と、round outcome、両path listのproducer更新・request / feedback ledger appendまたはstate更新・git mutation・cleanup obligation・reply/resolve thread・request boundary更新の各transition前後に、上記全fieldを含む最新`PHASE12_CHECKPOINT`を必ず返す。terminal transitionではpre-checkpointに旧global / latest ledger tuple、post-checkpointに新global / latest ledger outcomeとfull evidenceをまとめ、両者の中間checkpointを返さない。親はresume Agentへその値を加工せず渡す。同じAgent contextを継続できる場合も各transitionでcheckpointを更新する。

`subagent_type: general-purpose` でAgentを `run_in_background: true` 起動する。プロンプトには`PHASE12_MODE`と`PHASE12_CHECKPOINT`、`PR_URL`、12-field identity tuple、`PR_HOST`、`BASE_REPO_NODE_ID`、`DEDICATED_BRANCH`、`EXPECTED_REMOTE_OID`、`EXPECTED_LOCAL_OID`、`<worktree-path>`、`LOCAL_BRANCH`、`EXPLANATION_PATH`、`CRITICS_PATHS`、artifact-excluded repository判定に加え、current request boundaryの`REQUEST_HEAD_OID`、`REQUEST_BASE_REF`、`REQUEST_BASE_OID`、`REQUEST_STARTED_AT`、`REQUEST_IDENTITY`、`REVIEWER_POLICY`、`TARGET_REVIEWERS`、`REQUIRED_REVIEWERS`、`REQUESTED_REVIEWERS`、`AI_REQUESTS`、full `REQUEST_TRANSITION_STATE` / `REQUEST_ATTEMPT_LEDGER` / `FEEDBACK_LEDGER` / `GIT_MUTATION_STATE`を**値付きで**渡し、以下の内容を含めて自己完結させる。resume時のcurrent request boundary、全ledger、request transition、expected OIDの別入力はcheckpointの同名値をexactに転記し、Phase11の初期値へ戻さない。fresh Agentは裸のPR番号をcurrent repositoryから再解決しない:
`CODEX_EXTERNAL_REVIEW_AUTHORIZED`とその許可証跡（許可発言、確認時刻、対象`PR_URL`）も値付きで渡す。`true`の場合だけ、current request boundaryと同じPR差分を外部Codexレビューサービスへ送信してよい。別PR・別gtr実行へ転用せず、値または証跡が欠ける場合はlocal fallbackを実行せず`incomplete`で停止する。

```
PR #<PR番号> <PRタイトル>（<PR_URL>）の最終AIレビューラウンドを監視し、今回の依頼境界に結び付いた明示的な最終結果が揃った時点で `/review-comment-analysis <PR_URL>` 相当の処理を実行するタスク。30分タイムアウトは`incomplete`であり、指摘0件や完了として扱わない。
親から渡された`BASE_REPO`、`PR_NUMBER`、`PR_URL`、`PR_STATE`、`HEAD_REPO`、`HEAD_REPO_URL`、`HEAD_REF`、`HEAD_OID`、`BASE_REF`、`BASE_OID`、`VIEWER_CAN_EDIT_FILES`、`IS_CROSS_REPOSITORY`を同じ名称・順序で保持する。補助identityの`PR_HOST`、`BASE_REPO_NODE_ID`、`DEDICATED_BRANCH`も値を保持し、canonical PR URL / GraphQL `baseRepository.id`から再導出した値と一致することを要求する。GitHub read / mutationは`PR_URL`、またはhost-qualifiedな`$PR_HOST/$BASE_REPO`と`PR_NUMBER`を明示して実行し、全`gh api` / GraphQLへ`--hostname "$PR_HOST"`を付け、番号やdefault hostだけに戻さない。
対象のPR head専用worktreeは`<worktree-path>`、検証済みlocal branchは`LOCAL_BRANCH`。ファイル操作とgit commandは必ずこのworktreeを対象にし、専用branchを新規作成する必要が生じた場合は`DEDICATED_BRANCH`以外の番号だけの名前を使わない。

最初に`PHASE12_MODE`を検証する。`initial`は親から成功trigger 1件以上の有効request boundaryとappend-only request attempt ledger全体を受け取った場合だけ許可し、current boundaryを`ROUND_STATE = active`、`ROUND_OUTCOME = monitoring`で開始する。この場合だけ両path list、previous boundary / required reviewers、iteration、cleanup obligations / reply-resolve threads / feedback ledgerを初期値、git mutationをidleにする。`REQUEST_TRANSITION_STATE`は受領ledger最新entryのtransitionとexactに一致させ、作り直さない。`resume`なら`PHASE12_CHECKPOINT`の同名fieldをすべてexactに復元し、両path list、全ledger、cleanup generation、git mutation、thread substate、request transitionを空resetしない。current / previous request boundary、round state / outcome、expected OID、iteration / roundのいずれも、GitHubの現在値、glob、既定path、単一pathから再構成しない。復元・照合完了前はpoll以外のmutation、新boundary作成、cleanup / reply済み主張、最終zero判定を行わない。

`initial`では`CODEX_REVIEW_SKIP=null`として、親から渡された`REQUEST_HEAD_OID`、`REQUEST_BASE_REF`、`REQUEST_BASE_OID`、`REQUEST_STARTED_AT`、`REQUEST_IDENTITY`、`REVIEWER_POLICY`、`TARGET_REVIEWERS`、`REQUIRED_REVIEWERS`、`REQUESTED_REVIEWERS`、reviewer別`AI_REQUESTS`をラウンド境界として保持し、full `REQUEST_TRANSITION_STATE`およびledger最新entryのcandidate / reviewer evidence / boundaryと一致させる。`resume`ではcheckpointの`CURRENT_REQUEST_BOUNDARY`とrequest transitionを同じ名称のcurrent値として使い、親が別途渡した値とも完全一致させる。resume時に`CODEX_REVIEW_SKIP`がnonnullならスキップ条件のread-only再検証だけを行って親へ返し、`GIT_MUTATION_STATE.state != idle`なら次段のoperation-specific recoveryを先に完了し、以下のgeneric active gateは`idle`へ収束するまで適用しない。開始時・各poll・arrival分析直前・旧roundによる最終zero判定直前に、full 12-field identity、`PR_HOST`、`BASE_REPO_NODE_ID`、`DEDICATED_BRANCH`、`BASE_REF` / `BASE_OID`、local `HEAD`、raw remote tracking ref、GitHub `HEAD_OID`を再取得する。このidle時generic gateでは次段のretry lifecycle 2 windowを先に判定し、いずれにも一致せず、base refと他のidentityが同一、最新`BASE_OID`が保存base OIDの通常のdescendant advanceだとbase repositoryのcommit graphで証明できた場合だけ、current attemptを理由付きでledgerへ`invalidated_base_advanced`として保存し、`ROUND_STATE=invalidated_base_advanced`へ進めてlatest base / identityを再凍結できる。non-idle incomplete-retry rotation中に観測してcoalesced処理したbase advanceは、既にlatest base / identityへ再凍結済みであるためこのgeneric分岐へ入れず、source Aを上書きしない。base retarget、force rewrite、ancestry取得不能、base以外のidentity変更は別PRへ再解決せず停止する。以前に成功triggerがある通常base advance / incomplete retryは、後述の`GIT_MUTATION_STATE`で検証するboundary rotation commitをpushしてheadを必ず変えてからfresh requestを作る。

idleでbase差分を観測した場合は上記generic invalidationより先にretry lifecycleの2つのwindowを検査する。第一に、`ROUND_STATE=active`、`GIT_MUTATION_STATE.state=idle` / operation null、latest current Aのterminal `outcome=incomplete`・full evidence・transitionがexactで、successor B / Bのledger entry / candidate / baseline / writeが未作成なら、Bとfull prepared rotation operationを予約し、same ref・saved→latest normal descendant・他identity不変のproofを`pending_base_advance(window=transition_prepared, operation ID/kind, A/B/P、C=null)`へ含め、Aのreason / successor、`ROUND_STATE=retry_after_incomplete`、`GIT_MUTATION_STATE.state=prepared`と同じcheckpointで保存する。latest baseをそのoperationのoperational baseとして束縛し、generic invalidationやretry + idle checkpointを挟まない。第二に、`ROUND_STATE=retry_after_incomplete`、`GIT_MUTATION_STATE.state=idle` / operation null、Aのincomplete tupleとsuccessor B、append-only rotation evidenceのverified P→C、local / raw remote / GitHub head=C、Bのledger entry / candidate / baseline / writeが未作成であることがexactなら、same ref・saved→latest normal descendant・他identity不変のproofを`pending_base_advance(window=post_rotation_idle, operation=null, A/B/P/C)`としてまずcheckpointする。次のfull checkpointでCを新base advanceにも満たすrotation evidenceと`coalesced_retry_rotation` base evidenceをAへappendし、latest base / identityを再凍結し、expected head C、A tuple、transient stateを維持する。pendingは全更新後だけclearするため、各checkpoint直後の中断はpendingまたはappend済みevidenceからresumeし、2回目のrotationを禁止する。B request開始済み、evidence / head / identity不一致、または他lifecycleだけが前段のgeneric `invalidated_base_advanced`分岐へ進む。

review-comment-analysis自身が検証済みのexact-lease pushを行う場合だけ、active boundaryからoperational stateへ遷移できる。Phase12中の全commit / push（findings、follow-up、cleanup、boundary rotationを含む）は、commit前にoperation ID、kind、source / successor attempt、rotation reason、parent OID、remote-before、exact paths、planned treeまたはdiff hash、commit subjectを`GIT_MUTATION_STATE=prepared`として親が保持してから実行する。non-rotationはsource / successor / reasonをnull、retry rotationはA / B / `retry_after_incomplete`、通常base rotationは対応attempt / successor / `base_advanced`とする。commit観測後はexact child OID / evidenceを保存して`commit_observed`、raw remote / GitHub headの一致後はpush evidenceを保存して`push_observed`とし、関連ledger / obligation / expected OID更新後だけ`idle`へ戻す。resumeでstateがnon-idleなら上記operation-specific tupleを最初に検証し、exact child / pushをadoptするか保存段階から継続する。state-first recovery中はgeneric active / operational expected-OID gateを先に適用せず、複数child、別content、unexpected path、`P | C`外のremote / GitHub headなら停止する。

push前はHEAD以外のidentityとoperational baseが凍結値から不変、GitHub/raw remote headが`EXPECTED_REMOTE_OID`、local HEADがancestor検証済み`EXPECTED_LOCAL_OID`であることを通常gateとする。例外はretry rotationの`GIT_MUTATION_STATE.state=commit_observed`と`pending_base_advance(window=transition_prepared | non_idle_recovery)`が同じoperation ID、A / B / P / exact C、same `BASE_REF`、saved→latest baseのnormal descendant proof、base以外の全identity不変へexact bindingされ、Aが`outcome=incomplete` / reason `retry_after_incomplete` / successor B、local HEAD=C、raw remote / GitHub head=Pである場合だけとする。このexact pushではpendingに保存したlatest baseをoperational baseとしてlease P→Cを行う。field欠落、operation / pending / ledger不一致、別window、non-descendant、他identity差分は停止し、Aをinvalidatedへ変更しない。

findings / follow-up / cleanup push後にlocal/raw remote/GitHub headが一致したら、先行するatomic findings tuple / evidenceを保持したまま旧round全体とrequest ledger entryを理由付きで`invalidated`にする。retry rotationではsource Aのincomplete tupleとglobal `ROUND_STATE=retry_after_incomplete`を維持し、exact Cのrotation evidenceをappendする。同じoperation中のnormal base advanceがpendingなら、descendant proofをAの`base_advance_evidence`へ`coalesced_retry_rotation`としてappendし、Cを両方のhead-changeに使って2回目のrotationを禁止する。それ以外のbase advanceは従来どおり`outcome=invalidated_base_advanced`と対応reason / successor / evidenceを保持する。retry / base advance中は`ROUND_OUTCOME=incomplete`のまま、expected OIDをcurrent headへ更新してfull checkpointを返す。以後の返信・resolve・follow-up反映・分析md cleanup・再依頼前mutationでは、旧`REQUEST_HEAD_OID`ではなく、このoperational identity/base、local HEAD=`EXPECTED_LOCAL_OID`、raw remote/GitHub head=`EXPECTED_REMOTE_OID`を要求する。旧roundのfeedbackはcarryoverとして分析できるが、terminalを新headのzero判定へ再利用せず、全cleanup後に新boundaryを作ったときだけ`ROUND_STATE = active`へ戻す。

新request boundaryを作るときは、先にcandidate head / base / full identity、policy、`TARGET_REVIEWERS` / `REQUIRED_REVIEWERS`、candidate roundと単調増加するattemptを`REQUEST_TRANSITION_STATE.state=in_progress`へ凍結し、同じtransitionを`REQUEST_ATTEMPT_LEDGER`末尾entryへappendする。先行attemptが無効化済みなら、そのentryの`successor`を新keyへ単調更新して双方向の連鎖を検証する。reviewerごとにfull baselineを保存した後、exact expected triggerとwrite operation IDを含む`write_prepared` checkpointを親へ返す。このpreparedを作った同一live executorだけが、hard interruptionなしに親のexact ackを受けた直後にcreate POSTを1回行える。fresh / resume executorがpreparedを受け取った場合は即`write_outcome_unknown`へ進め、POSTせず保存baseline以後の全pageをbounded read-only convergenceで確認する。HTTP responseが作成成功を一意に示せば`created`、結果不明も同じread-only経路を使う。expected method / endpoint / body-or-reviewer / actor / candidateに一致するfresh triggerがexactly 1件なら`adopted`、0件・複数・曖昧なら`incomplete`で停止して自動再POSTしない。HTTP response等がserver非作成を明示するときだけ`proven_not_created`にできる。`prepared | requested | created | adopted | outcome_unknown`のwriteへfresh / resume executorから再POSTしない。

全reviewerが`requested | skipped | incomplete | proven_not_created`になりcandidateと集合規則を検証できたら、そのattemptのboundary / outcomeをledgerへ保存する。成功triggerが1件以上の有効candidateだけ旧currentをpreviousへ移して`CURRENT_REQUEST_BOUNDARY`へ昇格し、`REQUEST_TRANSITION_STATE.state=complete`、`ROUND_STATE=active`へ更新する。`REQUESTED_REVIEWERS == REQUIRED_REVIEWERS`ならglobal / ledger最新entryを同じpost-checkpointで`ROUND_OUTCOME=monitoring` / `outcome=monitoring`にする。不足ならglobal / latest entryをともに`incomplete`とし、未依頼required reviewerごとのfailure evidenceを同じpost-checkpointへ保存して停止する。成功trigger 0件ではcurrent boundaryを置き換えず、同じpost-checkpointでglobal `ROUND_OUTCOME=incomplete`、`ROUND_STATE=incomplete_no_boundary`、`REQUEST_TRANSITION_STATE.state=incomplete_no_boundary`とlatest entry transitionのexact一致、entry `boundary=null` / `outcome=incomplete_no_boundary` / 全write結果を含むnonnull `incomplete_evidence`を保存して停止する。全create writeが`proven_not_created`の場合だけ、このtupleを検証した後続resumeで`ROUND_STATE=retry_without_boundary`へ進み、同じcandidate roundのattemptを増やせる。1件でも`outcome_unknown`、複数、曖昧なwriteがあれば自動retryは禁止する。

有効boundaryで成功triggerを含むtimeout / quota / permission / availability等の`incomplete`になった場合、同じheadへの再依頼は禁止する。ただしCodex quotaが前述のfallback trigger条件をすべて満たす場合は`CODEX_LOCAL_REVIEW`をcheckpointへ保存してlocal reviewへ移行し、以下のboundary rotationへ入らない。local reviewもusage limitなら`CODEX_REVIEW_SKIP`へ進む。それ以外ではactive Aのterminal atomic tupleを保存後、Bのkeyとempty rotationのP / remote-before / exact paths / planned tree / subjectを先に予約し、current base / full identityを再観測する。その1つのpost-checkpointでAを`outcome=incomplete`、`invalidation_reason=retry_after_incomplete`、`successor=B`、global `ROUND_STATE=retry_after_incomplete`とし、同時に`GIT_MUTATION_STATE.state=prepared`、`kind=boundary_rotation`、source A、successor B、reason `retry_after_incomplete`をfull bindingで保存する。観測時にsame-ref normal base advanceがあれば他identity不変を証明し、`pending_base_advance(window=transition_prepared, A/B/P, C=null)`とlatest operational baseも同じcheckpointへ保存する。prepared前のidle retry checkpointは禁止し、中断時は必ずこのprepared stateからresumeする。以後exact child Cをcommit / pushし、operation中またはC push後B開始前のnormal base advanceはCへcoalesceして別rotationを作らない。旧required setを維持したfresh Bだけを新head / latest baseへ作り、成功済みreviewerの旧terminal / responseも再利用しない。他lifecycleのbase descendant advanceは従来の`invalidated_base_advanced` / `rotation_reason=base_advanced`規則を使う。

### Agent内のlocal fallback優先規則

このprompt内の`Codex quota`、`usage limit`、`CODEX_REVIEW_SKIP`に関する記述には、フェーズ11の「Codex usage limit 時のlocal review fallback」を優先適用する。GitHub側のusage limitを検出したAgent自身が、`CODEX_LOCAL_REVIEW`をfull checkpointへ保存して同節の`codex review`手順を実行する。GitHub側証跡だけで`CODEX_REVIEW_SKIP`を作成したり親へskip完了を返したりしてはならず、同節のprofile rotationで全profileを試し切ってなおusage limitだった場合だけ`CODEX_REVIEW_SKIP`へ進む。

## 監視対象（出揃ったかの判定）

exact causal metadata、または競合trigger 0件・未解決先行successful attempt 0件を示すfull post-baseline inventoryでcurrent attemptへbindingできた`headless service-state response`だけ、review terminalの到着を待たずに処理できる。Codex usage limitで前述のfallback trigger条件を満たす場合は`CODEX_LOCAL_REVIEW`としてcheckpointしてlocal reviewへ移行し、fallbackもusage limitの場合だけ`CODEX_REVIEW_SKIP`として停止する。それ以外はattempt `incomplete`としてcheckpointして停止する。因果が曖昧なら`ambiguous_service_state` feedbackとして分析しcurrent terminal / timeoutまで待ち、headless response自体をterminal / findings / zeroには使用しない。

フェーズ11の`REQUESTED_REVIEWERS`と`AI_REQUESTS`で`status == requested`のreviewer setが完全一致することを確認する。初回roundの`REQUIRED_REVIEWERS`はpolicy対象の`status == requested | incomplete`集合と一致し、disabled / not_targeted / 証明済みnot_installed skippedを除く。再roundでは`REQUIRED_REVIEWERS == TARGET_REVIEWERS`を要求する。required reviewerのうちrequestedになったreviewerだけresponseを監視し、requiredなのにincompleteのreviewerがいればroundを停止する。**Copilot は現在オフのため依頼せず、監視対象にも含めない**。Geminiの`not_installed`が権限ある全page inventoryで証明済みなら初回roundでは`skipped`としてrequired集合・監視対象・`incomplete`外にする。`unknown_permission` / `temporarily_unavailable` / `retired`、依頼失敗、permission、timeoutはすべて`incomplete`であり、指摘0件には含めない。Codex quotaは前述のfallback trigger条件をすべて満たす場合だけ`CODEX_LOCAL_REVIEW`へ移行し、local fallbackもusage limitの場合だけ`CODEX_REVIEW_SKIP`として返す。それ以外は`incomplete`とする。

<!-- COPILOT-REVIEW-OFF: 1. **Copilot**: `gh api --hostname "$PR_HOST" "repos/$BASE_REPO/pulls/$PR_NUMBER/reviews"` の中に `user.login == "copilot-pull-request-reviewer[bot]"` かつ `user.type == "Bot"` のレビューがあるか -->
2. **Codex**: REST loginは`chatgpt-codex-connector[bot]`、GraphQL loginは`chatgpt-codex-connector`と完全一致し、かつ`user.type == "Bot"` / GraphQL actor typeがBotであること
3. **Gemini**（依頼した場合のみ）: REST loginは`gemini-code-assist[bot]`、GraphQL loginは`gemini-code-assist`と完全一致し、かつ同様にBotであること

loginのsubstring一致は禁止する。各pollでREST / GraphQLの全pageを取得し、少なくとも次のchannelを確認する:

- GraphQLのresolved / unresolvedを含む**全reviewThreads**と各threadの全comments
- REST review comments
- REST top-level review bodies
- REST issue comments
- REST timelineの`reviewed` / `review_requested` events

channelごとにID namespaceを分け、GraphQLとRESTで同一feedbackを表すものはparent review ID・review comment ID等のstable keyでcross-channel dedupeする。全page inventoryの各canonical itemをstable namespaced IDとsnapshot hashで`FEEDBACK_LEDGER`へ記録し、current arrivalだけでなくbaseline内の未処理carryoverも一度は必ず分析する。特に全unresolved human / bot threadとthread外feedbackを黙って除外しない。外部編集・追加・削除は同じstable IDのversionを増やしたcanonical snapshotまたはtombstoneの`pending` entryとしてappendし、旧versionを`superseded`へ進める。人間threadは返信済み`handled_waiting_human`、bot threadはresolve確認済み`handled_resolved`、thread外feedbackは分析・必要対応済み`handled_analyzed`をterminal handling stateとし、旧人間threadをroundごとに再返信しない。reviewer/channel別のresponse artifact件数、そこから抽出した指摘件数、cross-channel dedupe後の指摘総数を分けて記録する。「指摘なし」のterminal responseは到着artifact 1件・指摘0件であり、response自体を指摘1件に数えない。unresolved filterは返信・resolve対象を選ぶときだけ使い、到着・分析判定ではresolved threadも除外しない。

各reviewerのbaseline ID setとcanonical snapshotを基準に、次のいずれかだけを今回の到着候補にする:

- request attemptの保存baselineに存在しないIDで、そのreviewerの`requested_at`以後に作成・公開されたもの
- baselineと同じIDでは、server `updated_at` / `lastEditedAt`が`requested_at`より厳密に後（`>`）であるか、最初のpost-trigger canonical snapshotから後続pollまでの間にbody hashが変化したことを2つのpost-trigger snapshotで証明できるもの。同時刻やtrigger前baselineとの差がpost-triggerの1回の観測で見つかっただけでは、baseline取得後・POST前の同一ID更新raceを排除できないため今回responseへ分類しない

trigger comment自身、reaction、placeholder、agent-start通知は到着候補から除く。同じIDのplaceholderが依頼後に最終本文へ編集された場合は、snapshot差分を根拠に到着候補にできる。ただし「開始した」だけの本文はterminalではない。

明示的なquota / permission / temporarily unavailable / retired等のservice-state issue commentはreview terminalとは別の`headless service-state response`として分類する。本文またはserver metadataがservice stateを明示し、server作成・公開時刻がreviewerの`requested_at`より厳密に後、actor login / typeがexact bot identityと一致することを前提とする。reviewed headなしでcurrent attemptへ即時bindingできるのは、server metadataがcurrent round / attempt / trigger IDへexact causal linkを持つ場合、またはbaseline後の全channel / 全page trigger inventoryによりcurrent triggerからresponseまで同reviewerの競合triggerが0件で、かつ遅延headless responseを返し得る未解決の先行successful attemptが0件と証明できる場合だけとする。このときCodex usage limitが前述のfallback trigger条件を満たせば`CODEX_LOCAL_REVIEW`へ保存してlocal reviewへ移行し、fallbackもusage limitの場合だけ`CODEX_REVIEW_SKIP`へ進む。それ以外は該当attemptのnonnull `incomplete_evidence`へ保存してlatest `outcome=incomplete` / `ROUND_OUTCOME=incomplete`を同じatomic post-checkpointで確定して即時停止できる。どちらの因果証明もないresponseは`FEEDBACK_LEDGER.binding=ambiguous_service_state`として記録・分析し、current terminalまたはtimeoutまで待つ。headless response自体はterminal response、findings、zeroのいずれにも絶対に使用しない。

到着候補には次のhead binding evidenceも必須とする:

- top-level review: `commit_id == REQUEST_HEAD_OID`
- inline root: `original_commit_id == REQUEST_HEAD_OID`かつparent reviewの`commit_id`も一致。REST inlineの移動し得る現在`commit_id`だけに依存しない
- GraphQL thread/comment: `originalCommit.oid == REQUEST_HEAD_OID`かつparent review commitも一致
- issue comment: 本文の`Reviewed commit`等またはserver metadataに、reviewed commitが`REQUEST_HEAD_OID`へ一意に解決できる明示値があり、server作成・公開時刻がreviewerの`requested_at`より厳密に後で、actor login / typeがexact bot identityと一致すること。さらにrequest ledger上、そのreviewerのsuccessful triggerを持ち同じreviewed headを使うattemptがexactly 1件で、そのkeyがcurrent boundaryのround / attemptと一致することを要求する。issue commentに存在しないtrigger comment ID / round metadataは要求しない。同じheadのsuccessful attemptがledgerに複数あればambiguous `incomplete`とし、時系列とstable headだけではterminalにしない。成功triggerを含むsame-head retryは禁止を維持し、成功trigger 0件で全writeが`proven_not_created`のretryだけは同じheadでもunique successful-attempt数を増やさない。旧headの遅延responseはcarryoverとして分析できるが、新terminalへ流用しない

明示的な最終レビュー本文だけをterminalとする。指摘本文、承認、または「指摘なし」を明示する最終本文が必要で、placeholder・agent-start・reactionだけではterminalにしない。

## ポーリング

- 間隔: 約3分（180秒）
- タイムアウト: 30分（10回ポーリング）
- 各ポーリングでreviewer/channel別の新規・更新候補、head binding evidence、terminal / incompleteを記録する
- `REQUIRED_REVIEWERS`の全員が`status == requested`かつterminalになり、`REQUESTED_REVIEWERS == REQUIRED_REVIEWERS`を満たすときだけ次へ進む
- terminalが揃ってdedupe後の指摘があればglobal / ledger最新entryをともに`findings`、明示的な指摘0件かつ`FEEDBACK_LEDGER`最新versionの`pending | action_pending`が0件ならともに`zero`とし、全required reviewerのcomplete nonnull `terminal_evidence`と`incomplete_evidence=null`を同じatomic post-checkpointへ保存する。zero直前に全channel / 全pageを再取得し、新しいcarryoverやexternal updateがないことを確認する
- タイムアウト、required reviewerの依頼失敗、permission等では停止前にglobal / ledger最新entryをともに`incomplete`とし、対象reviewer・原因・取得済みterminalを欠落なく含むnonnull `incomplete_evidence`を同じatomic post-checkpointへ保存する。Codex quotaはfallback trigger条件をすべて満たす場合だけ`CODEX_LOCAL_REVIEW`へ移行し、local fallbackもusage limitの場合だけ`CODEX_REVIEW_SKIP`を返して監視を終了する。それ以外は同様に`incomplete`とする。いずれも分析や「指摘0件」判定へ進まない

## 揃った後の処理

`../review-comment-analysis/SKILL.md` を Read で読み込み、開始直前に渡されたidentity tuple、request boundary、worktree / `LOCAL_BRANCH` / expected OIDを再取得・再検証してから、その手順に従って`PR_URL`を明示した対象PRの分析を実行する。不一致なら別PRへ再解決せずlocal workを保持して停止する。

その際、Skillツールは使わずに review-comment-analysis.md の手順を直接実行すること。

- terminal responseが全required reviewerとも今回のboundaryにbindingされ、dedupe後の指摘が0件なら、空の分析mdを作成・commitしない
- 指摘がある場合、producerが現在roundで返す分析mdの**完全なexact list**を`REVIEW_DECISION_PATHS`として保持し、`reply-reviews`等のconsumerにも同じlistをそのまま渡す。保存したpathは`CREATED_REVIEW_DECISION_PATHS`へ初出順でappend-onlyに重複排除し、後続roundでcurrent listが空でも履歴を消さない。各artifact commit後に`(REQUEST_ROUND, ANALYSIS_ITERATION, path, creation_head_oid)`を一意keyとするcleanup obligationを追加する。同じpathが後続finding roundで再生成された場合も新generationを追加し、過去generationの`completed`を理由にskipしない。producer/consumer間で単数pathへ縮退させたり再探索したりしない
- thread外のtop-level review body・issue commentも必ず分析する。返信・resolve mutationはunresolved review thread項目だけに行い、thread外feedbackを黙ってthread IDへ対応付けない

thread返信前は`(request_round, analysis_iteration, thread_id, feedback_version, generation)`を一意keyとするentryへcanonical snapshot / hash、bot / human、expected reply hash、stable write operation IDを持つ`reply_writes[].state=prepared`を保存する。このpreparedを作った同一live executorだけが、hard interruptionなしに親のexact ackを受けた直後にcreate POSTを1回行える。fresh / resume executorがlatest write `prepared` / thread `reply_pending`を受け取った場合は、write / threadを`outcome_unknown` / `reply_outcome_unknown`へ進めてPOSTせずbounded read-only convergenceだけを行う。response不明も同じ経路とし、exact expected replyが1件だけなら`adopted`、0件・複数・曖昧なら自動再POSTせず`incomplete`で停止する。HTTP response等でserver非作成を証明したwriteだけ`proven_not_created`とし、retryする場合は新しいwrite operation entryをappendしてpre-write checkpointからやり直す。`prepared | created | adopted | outcome_unknown` writeへfresh / resume executorから再POSTしない。bot reply後はpost-reply snapshotとevidenceを保存して`resolve_pending`、human reply後は`complete`、bot resolve後はresolve evidenceを保存して`complete`にする。resolveはidempotent state setとして、保存snapshot不変かつ`isResolved == false`の場合だけcount上限内で再実行できる。`resolve_pending`でreplyを再投稿しない。

`reply_pending | reply_outcome_unknown | resolve_pending`中に、許可した自分のexact reply / resolve以外の正当なexternal updateを検出した場合は、同じstable feedback IDの新versionを`FEEDBACK_LEDGER`へ`pending`でappendし、旧feedback versionを`superseded`へ進める。同時に旧thread generationを`superseded`へ進め、新しいfeedback versionと次generationを指すnonnull `successor`、old/new snapshot対応を示す`supersession_evidence`を保存して停止する。旧generationのreplyを再POSTもresolveもせず、再分析がsuccessor keyの新generationを作る。同じrequest / iteration / threadでもfeedback version / generationで衝突させない。

1件でも指摘を受け、code・分析md・cleanupのいずれかでcommit・pushした場合、検証済みself-push後に`ROUND_STATE = invalidated`、`ROUND_OUTCOME = findings`とし、**全reviewer分の現在ラウンドを無効化**する。他reviewerが既にterminalでも再利用しない。以後はoperational gateで指摘対応、返信・resolve、artifact-excluded repositoryの分析md除外をすべて完了し、cleanup / reply / feedbackにpendingがなく`GIT_MUTATION_STATE.state=idle`になった後にだけ、次の順序で新ラウンドを開始する:

1. worktree clean、full identity、base、local/raw remote/GitHub headの一致を再検証する
2. 直前roundの`REQUIRED_REVIEWERS`を`PREVIOUS_REQUIRED_REVIEWERS`として退避し、全targetについてrequest-ai-reviewの規則どおりtrigger直前baselineを取り直す
3. `PREVIOUS_REQUIRED_REVIEWERS`を`TARGET_REVIEWERS`のexact setとして渡し、新しい`REQUEST_HEAD_OID` / base / identityを凍結して全required reviewerへ再依頼する。新しい`REQUIRED_REVIEWERS == TARGET_REVIEWERS == PREVIOUS_REQUIRED_REVIEWERS`を要求し、`REQUESTED_REVIEWERS`がrequired集合に満たなければ集合を縮めず`incomplete`として停止する
4. 新しいserver `created_at`、trigger情報、reviewer別baselineを保存して`ROUND_STATE = active`へ戻し、同じ監視・分析を繰り返す

レビュー分析mdを返信に使うため一時commitする場合も、そのcommitと後続の除外commitでheadが変わる。必ず除外pushを先に完了してから再依頼し、最終AIレビューがcleanup後のhead全体を対象にするようにする。最終レビュー依頼後にはcleanupを行わない。

## follow-up issue の新規作成禁止

全フェーズ横断の follow-up issue 作成ルールにかかわらず、review-comment-analysis 中は新しい issue を作成しない。`gh issue create`、`issue-create`、`review-issue-create`などの issue 作成処理は実行せず、新規 issue が必要と思われる指摘は未対応の懸念として分析結果と最終報告に記録する。既に作成済みの follow-up issue の記載やリンクは削除しない。

artifact-excluded repositoryでは、親がPR固有mdを最終diffから除外済みのため、履歴上のcritics review mdが必要な場合は`git -C <worktree-path> show`で参照するだけとし、worktreeへ再生成しない。review-comment-analysisが現在roundで作成・更新したexact listは`REVIEW_DECISION_PATHS`、この実行で保存したpathのappend-only dedup historyは`CREATED_REVIEW_DECISION_PATHS`として記録する。cleanup ownershipはpath historyではなく`CLEANUP_STATE.obligations`のgeneration entryで管理し、同commandのStep 9.6を唯一のownerとしてcurrent listを返信などに利用した後・**次のレビュー依頼より前に**current pending generationを除外する。Phase12 wrapperは二重に`git rm`せず、次だけを検証する:

- obligationの一意keyが`(request_round, analysis_iteration, path, creation_head_oid)`で、各pathがこのPRのbase treeに存在せず、そのgenerationの分析で追加したファイルだったこと
- artifact-excluded repositoryではgenerationごとに`pending -> completed`が一度だけ起き、cleanup commitがexact pathだけを削除し、exact lease付きの明示refspecでpush済みで、obligationの`operation_id` / `mutation_substate`が`GIT_MUTATION_STATE`のwrite-ahead operationと結び付き、`cleanup_head_oid` / commit / push evidenceが一致すること。normal repositoryでは`retained`と根拠を保持すること
- 同じpathの過去`completed` entryが、後続roundで追加された別generation obligationのcleanupをskipする根拠に使われていないこと
- push後の`gh pr diff "$PR_URL" --name-only`に`CREATED_REVIEW_DECISION_PATHS`またはcurrent `REVIEW_DECISION_PATHS`のpathが残っていないこと
- 最終ラウンドが指摘0件なら`REVIEW_DECISION_PATHS=[]`で、空の分析mdやcleanup commitが作られず、`CREATED_REVIEW_DECISION_PATHS`の過去historyは保持されていること

分析処理がcleanup前、commit後、push後のいずれかで中断した場合は、`GIT_MUTATION_STATE`、`PHASE12_CHECKPOINT.CLEANUP_STATE.obligations`、両path listをexactに返し、再依頼や完了判定へ進まない。親は同じcheckpointを加工せず`PHASE12_MODE=resume`へ渡し、prepared / commit_observed / push_observedのexact stateから同じoperationを一意に検証して再開する。安全なfull checkpointがない場合は、path、local commit、GitHub diffやremote headからgeneration / cleanup進捗を推測せずblockerとして停止する。

## 制約

- このAgentは独立して動作する。親セッションには結果と、上記同名fieldをすべて含む最新のfull `PHASE12_CHECKPOINT`を文字列で返し、永続fileやbranch artifactへstateを書かない
- `incomplete` / 停止 / 最大周到達 / 正常完了に加え、各request / feedback ledger transition、git mutation、cleanup obligation、reply / resolve thread、boundary更新の各transitionでfull checkpointを更新して返す。親が返却値を受け取れないhard interruptionでは安全にresumeできたと主張しない
- 監視中は他のことをしない
- head/base/identityまたはbaselineを省略して過去レビューを今回分として数えない
- 揃ったレビュアー、reviewer/channel別のresponse artifact件数・抽出指摘件数、dedupe後指摘総数、head binding evidence、タイムアウト有無、再依頼回数、最終的に review-comment-analysis を実行したかどうかを最終報告に含める
```

### 12.2. 最終レビューラウンド完了の確認

Agentがbackgroundで起動されたことだけではフェーズ12完了にしない。Agentの最終結果を待ち、次をすべて確認して初めて完了とする:

通常のGitHub経路では以下の全条件を要求する。local fallback経路では`CODEX_LOCAL_REVIEW.state == complete`、最終iterationのactionable finding 0件、reviewed head/baseとcleanなlocal/raw remote/GitHub head/full identityの一致、GitHub側full feedback inventoryの未処理feedback 0件を再検証する。fallbackもusage limitのスキップ経路では通常経路の`ROUND_OUTCOME == zero`条件を要求せず、代わりに`CODEX_LOCAL_REVIEW.state == unavailable`と`CODEX_REVIEW_SKIP`全field、GitHubとlocalの両usage limit証跡、`profiles_tried`が`profile_order`の全profileを網羅し全entryが`usage_limit`であること、cleanな最終head / base / identity一致を再検証する。GitHub側usage limitだけ、または一部profileだけでは完了扱いにしない。

- Agentが返した最新のfull `PHASE12_CHECKPOINT`を受け取り、`CHECKPOINT_VERSION`、`CHECKPOINT_IDENTITY`、`CODEX_LOCAL_REVIEW`、`CODEX_REVIEW_SKIP`、`ROUND_STATE` / `ROUND_OUTCOME`、両expected OID、current / previous boundary、両path list、previous required reviewers、iteration / round、request transition、request attempt ledger、feedback ledger、git mutation、cleanup obligations、reply / resolve threadsの全fieldが欠落なく復元・検証済み
- `ROUND_STATE == active`、`ROUND_OUTCOME == zero`、`CURRENT_REQUEST_BOUNDARY`が最終request boundary、`EXPECTED_LOCAL_OID == EXPECTED_REMOTE_OID == REQUEST_HEAD_OID`で、checkpoint identity / current full identity / base / local / raw remote / GitHub headが一致する
- ledger最新entryが`CURRENT_REQUEST_BOUNDARY`と同じcurrent attemptで`outcome=zero`、全`REQUIRED_REVIEWERS`のcomplete nonnull `terminal_evidence`を持ち、`incomplete_evidence=null`であり、同じatomic post-checkpointのglobal `ROUND_OUTCOME=zero`とexact一致する。historical `invalidated | invalidated_base_advanced`またはreason付き`incomplete` entryのevidenceをlatest zeroの代用にしない
- `REQUEST_TRANSITION_STATE.state == complete`でledger最新entryのtransitionおよびcandidate / current boundaryが一致し、reviewer entryに`not_started | baseline_captured | write_prepared | write_outcome_unknown`がない。`REQUEST_ATTEMPT_LEDGER`全entryのboundary / outcome / invalidation reason / successor / terminal / incomplete evidenceを検証済み。`GIT_MUTATION_STATE.state == idle`で全cleanup obligationがartifact-excluded repositoryでは`completed`、normal repositoryでは`retained`かつgeneration / operation evidenceを検証済み。各reply / resolve chainのlatest `(feedback_version, generation)`が`complete`でexpected snapshot / reply / resolve evidenceがGitHub stateと一致し、旧generationは`complete | superseded`だけ、`superseded`はnonnull successor / supersession evidence付きである
- 最終roundのfull identity、base、local/raw remote/GitHub headがrequest boundaryと一致する
- 最終roundの`REQUESTED_REVIEWERS`が`AI_REQUESTS.status == requested`集合と一致し、`REQUESTED_REVIEWERS == REQUIRED_REVIEWERS`を満たす
- `REQUIRED_REVIEWERS`の全reviewerから、baseline後かつ`requested_at`以後のhead-bound terminal responseを取得した
- 再依頼roundでは`REQUIRED_REVIEWERS == TARGET_REVIEWERS`を満たし、直前roundのrequired集合を維持している
- permission・timeout、Geminiの`unknown_permission` / `temporarily_unavailable` / `retired`、依頼失敗等の`incomplete`が0件（証明済み`not_installed`の`skipped`は除く）。Codex quotaは通常経路では`incomplete` 0件を要求し、local fallback完了またはGitHubとlocal双方のusage limitを検証した`CODEX_REVIEW_SKIP`だけを代替terminalとして許容する
- zero判定直前の全channel / 全page inventoryが`FEEDBACK_LEDGER`に反映され、全stable IDのlatest versionで`pending | action_pending`が0件、最終roundのdedupe後の未対応指摘が0件
- 指摘対応roundがあった場合、分析成果物の除外push後に全required reviewerへ再依頼し、cleanup後のheadを最終roundでレビュー済み
- self-pushの旧attemptはledger `outcome=invalidated`、通常base advanceは`outcome=invalidated_base_advanced`、incomplete retry Aは`outcome=incomplete`かつreason `retry_after_incomplete` / successor Bとして保持される。A→B transitionにprepared operationのidle gapがなく、verified child Cがexactly 1件、`transition_prepared | non_idle_recovery | post_rotation_idle`で観測した全base advanceがappend-only rotation / base evidenceへCとの`coalesced_retry_rotation`として残り、pending clear前のfull checkpoint、latest base再凍結、2回目rotationなしを検証する。最終global stateはBの`active`で、旧feedback / terminalをzeroへ再利用しない

background Agentが開始通知だけ返した、full checkpointを返さない、checkpointが部分的 / 不一致、terminal responseが未到着、または`incomplete`が残る場合は、検証済み`CODEX_LOCAL_REVIEW.state == complete`またはlocal fallbackまで失敗した`CODEX_REVIEW_SKIP`がない限り`gtr-new 完了`やmerge可能判定を出さない。初回起動後にAgentを再開するときは常に`PHASE12_MODE=resume`とし、親が保持した最新checkpointを加工せず渡す。`initial`でやり直したり、同じAgent contextだからという理由でcheckpoint更新を省略したりしない。

## 最終報告

最終報告の直前に`gh api graphql --hostname "$PR_HOST"`でidentity tupleを再取得し、最新の番号・タイトル・URLを保持する。取得に失敗した場合、PR識別fieldまたはbaseが最終request boundaryから変わった場合、GitHub `HEAD_OID`が`REQUEST_HEAD_OID`（local fallbackでは`CODEX_LOCAL_REVIEW.reviewed_head_oid`、usage limitスキップでは`CODEX_REVIEW_SKIP.request_head_oid`）・検証済みlocal HEAD・raw remote tracking refのいずれかと一致しない場合は`gtr-new 完了`を報告しない。local branchには`LOCAL_BRANCH`、remote branchには`HEAD_REF`を使う。

**フェーズ1〜12をすべて実行して各フェーズの完了を確認するか、GitHub usage limit後にlocal reviewを完了するか、local fallbackもusage limitで実行不能なことを検証した場合にのみ** 以下を表示:

```
## gtr-new 完了

- **issue**: #<number> <title>
- **worktree**: <path>
- **ブランチ**: <LOCAL_BRANCH>
- **PR**: #<number> <title>（<PR URL>） (Ready for Review)
- **refine**: 起動元セッション自身による1巡目のイテレーション数・修正件数・新規発見件数（0件であること）。`cross-tool review skipped: toggle off` と明記
- **new findings**: 0件
- **pr-test**: N回のイテレーション、X件のテストを追加（`TEST_ARTIFACT_PATHS`の実path）
- **CI**: all passed
- **PR解説md**: <`EXPLANATION_PATH`の実path。artifact-excluded repositoryでは最終diffから除外済みと明記>
- **critics 要約**: <`CRITICS_PATHS`の全実path>を要約済み / スキップ（理由）。artifact-excluded repositoryでは最終diffから除外済みと明記
- **フォローアップ issue**: #<番号> <タイトル>（URL） … / なし。※通常repositoryではPR description・PR解説md・critics mdの3成果物すべてへの反映、artifact-excluded repositoryではPR descriptionへの反映と一時md除外理由を併記
- **AIレビュー依頼**: ~~Copilot（オフ）~~ / Codex / Gemini （各status、最終`REQUEST_HEAD_OID`、`REQUEST_STARTED_AT`、`TARGET_REVIEWERS`、`REQUIRED_REVIEWERS`、`REQUESTED_REVIEWERS`）。local fallback時は`codex review`のprofile・model・iteration・reviewed head/base・finding/actionable件数・terminal outputを明記し、fallbackもusage limitなら`Codex skipped: GitHub and local usage limit`と両証跡に加え試したprofile全件を明記
- **AIレビュー分析md**: current `REVIEW_DECISION_PATHS`とappend-only history `CREATED_REVIEW_DECISION_PATHS`。artifact-excluded repositoryではhistory全件を最終diffから除外済み、normal repositoryでは残存pathを併記
- **AIレビュー最終round**: reviewer/channel別response artifact件数・抽出指摘件数、dedupe後指摘総数、再依頼回数、明示head / requested_at / exact bot / unique successful-attempt correlation確認済み、`REQUESTED_REVIEWERS == REQUIRED_REVIEWERS`、`incomplete` 0件、feedback ledgerのpending 0件、未対応指摘0件。local fallback完了時はGitHub reviewがquotaで未実施だったこととlocal reviewのactionable finding 0件を区別して明記する。fallbackもusage limitのスキップ時は「指摘0件」と表現せず、両usage limit証跡とfull inventory上の未処理feedback 0件を明記する。self-push / base advance / incomplete retryがあればrequest attempt ledgerのinvalidated reason、boundary rotation、旧feedback非再利用も明記
- **Phase12 checkpoint**: 最終`PHASE12_MODE`、`CHECKPOINT_VERSION` / `ROUND_STATE` / `ROUND_OUTCOME` / expected OID、current / previous boundary、`ANALYSIS_ITERATION` / `REQUEST_ROUND`、request transitionとappend-only request attempt / feedback ledger、git mutation idle、cleanup generation obligations、reply / resolve thread entries、両path listをfull checkpointから検証済み。local fallback時は`CODEX_LOCAL_REVIEW`全field、fallbackもusage limitのスキップ時は加えて`CODEX_REVIEW_SKIP`全fieldと最終head / base / identity検証結果を明記
- **次のステップ**:
  - `git gtr ai <LOCAL_BRANCH>` でClaude Code起動
  - `git gtr editor <LOCAL_BRANCH>` でエディタ起動
```

- `gtr-new 完了` を出す条件として、`loop-critics-fix` の最終結果で **新規懸念点が 0 件** であることを確認すること
- 通常経路では最終AIレビューroundがcleanup後の`REQUEST_HEAD_OID`へbindingされ、`incomplete`と未対応指摘がともに0件であることを確認すること。local fallback経路では`CODEX_LOCAL_REVIEW`がcleanup後の最終head/baseへbindingされactionable findingが0件、fallbackもusage limitのスキップ経路では`CODEX_REVIEW_SKIP`が同headへbindingされ、未処理feedbackが0件であることを確認すること
- `new findings` は必須項目。0件でない場合は `完了` を出してはいけない

## 制約事項

- **Skill tool 禁止**: このコマンドではSkill toolを一切使わない。他コマンドの手順を参照する場合は 同梱された `../<name>/SKILL.md` をReadで読み、その手順に従って直接実行する
- **Agent toolの利用**: フェーズ12の監視タスクのみ Agent tool を `run_in_background: true` で使用してよい。他フェーズではAgent toolを使わない
- **プロジェクトのガイドライン遵守**: CLAUDE.md, AGENTS.md等のルールに従う
- **日本語で報告**
- **フェーズ未完了で完了扱い禁止**: いずれかの必須フェーズが未実施・未確認なら、完了報告をしてはいけない。例外は、GitHub usage limit後に`CODEX_LOCAL_REVIEW.state == complete`まで収束した場合、またはlocal fallbackもexactなusage limitで実行不能な`CODEX_REVIEW_SKIP`を検証した場合だけ
