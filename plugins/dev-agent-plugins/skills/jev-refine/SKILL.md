---
name: jev-refine
description: 親AgentがPR差分と既存review comment・返信から構造化した指摘候補をJevで採点し、高risk候補はsub-agent修正、低coverageは親Agentとの再調査、収束時はCodex review省略へ振り分ける。最終AIレビュー前やreview修正後の収束ゲートに使い、通常のコードレビュー生成には使わない。
---

# Jev refine

Codex reviewの代替レビュアーではなく、親Agentの調査結果を採点し、修正・再調査・Codex review・省略のどこへ進むか決めるfail-openゲートとして使う。

## 入力と外部送信

- canonical PR URLと検証済みworktreeを入力にする。対象headと収集contextのSHA-256 digestを凍結し、終了時にdiff・rules・review conversationを再収集して一致を確認する。
- 親Agent自身がrepository、PR diff、適用される`AGENTS.md` / `CLAUDE.md`、既存のinline review comment・返信、top-level review、issue commentを調べ、候補JSONを作る。既存指摘は再発見として数えず、現在のdiffで未解消かを記録する。
- Jevへ送るのはPR metadata、構造化候補、coverageだけで、生diffやrepository fileは送らない。対象PRへbindingされた明示的な許可がある場合だけ`--authorized`を付け、許可がない場合は外部callを行わず`run_codex`へfail-openする。
- `AI_GATEWAY_API_KEY`が無い、候補schema不正、入力超過、取得・API・context再検証のいずれかが失敗した場合も`run_codex`とする。エラーを高confidenceへ読み替えない。

## structured candidate

候補をrepository外の一時JSONへ保存する。件数の固定上限は設けず、親Agentが根拠と反証の両方を調べる。

```json
{
  "analysisSummary": "string",
  "candidates": [{
    "id": "C1",
    "title": "string",
    "file": "path",
    "lineStart": 1,
    "lineEnd": 1,
    "claim": "string",
    "evidence": ["exact evidence"],
    "counterEvidence": [],
    "impact": "string",
    "discussionStatus": "none | open | addressed | unclear",
    "discussionSummary": "string"
  }],
  "coverage": {
    "changedAreas": ["string"],
    "checkedRisks": ["string"],
    "unresolvedAmbiguities": [],
    "complete": true
  }
}
```

## 実行

```bash
node <skill-dir>/scripts/jev-refine.mjs \
  --pr "$PR_URL" \
  --worktree "<worktree-path>" \
  --candidates "<repository外のtemporary JSON>" \
  --round <N> \
  [--previous-distance <直前round値> --stagnant-rounds <直前round値>] \
  --authorized
```

標準出力のfull JSONをround順に保持し、一時JSONは評価後に削除する。`decision`は次のいずれか:

- `skip_codex`: 全candidate riskが`0.10`以下、coverage / convergenceがともに`0.90`以上、coverage complete、未解消ambiguity 0件。
- `fix_with_subagent`: riskが`0.10`を超える候補がある。`roundState.fixCandidateIds`だけをsub-agentへ渡す。
- `refine_candidates`: 高risk候補は無いがcoverage・convergence・ambiguityのgateが未達。Jev scoreを親Agentへ返して再調査する。
- `run_codex`: 同じheadで閾値までの距離が`0.01`以上改善しないroundが2回続いた、または判定不能。

## 修正と壁打ち

1. 親Agentが候補JSONを作り、Jevでcandidate risk・coverage・convergenceを採点する。
2. `fix_with_subagent`では、対象candidateのclaim・evidence・counterEvidence・scoreと適用ルールをsub-agentへ渡す。sub-agentには各候補をコードで再検証し、成立するものだけ最小修正と関連テストを行わせる。commit / pushはさせない。
3. 親Agentがsub-agentのdiffを検証し、必要なテストを実行する。妥当な変更だけを親がcommit / pushし、無効になった工程を再実行して新headで候補を作り直す。
4. `refine_candidates`では、親Agentが低confidenceの理由を周辺コード・テスト・既存返信と照合し、候補を更新して同じheadを再採点する。
5. 固定のround上限は設けない。改善停滞時だけ`run_codex`へfail-openする。

親Agent自身のconfidenceはgateに使わない。Jevのcandidate riskだけが低くても、coverageまたはconvergenceが低ければ省略しない。

## 呼び出し元との契約

- evaluator script自体はread-onlyであり、code修正、commit、push、review依頼、返信、resolveを行わない。修正は呼び出し元が明示的に起動するsub-agentだけが行い、親Agentが全変更を検証する。
- `skip_codex`は`headOid`、`baseOid`、`contextDigest`の組にだけ有効。base/head/diff/rules/review conversationが変わったら失効し、新しい入力で再実行する。
- `run_codex`時は候補とscoreをCodex reviewへ渡す追加contextとして利用してよいが、候補を確定findingとして扱わない。
- gtr-newからは最終通常push後、Codex review依頼の直前に呼ぶ。sub-agent修正またはCodex finding修正後に再依頼する場合も、更新headに対して再実行する。

## 料金記録

各round JSONの`usage`と`estimatedCostUsd`を集計し、最終報告にround数・decision・最大candidate risk・coverage・convergence・Jev推定料金を記載する。候補作成とsub-agent修正は呼び出し元の利用枠であり、Jev料金へ含めない。価格取得に失敗した場合は推測せず`null`のまま報告する。
