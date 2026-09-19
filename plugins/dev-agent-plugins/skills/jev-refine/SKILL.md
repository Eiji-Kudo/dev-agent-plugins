---
name: jev-refine
description: PR差分と既存review comment・返信から安価なLLMで指摘候補を構造化し、Jevで候補risk・網羅性・全体収束を反復評価して、Codex reviewを省略できるか保守的に判定する。最終AIレビュー前やreview修正後の収束ゲートに使い、通常のコードレビュー生成には使わない。
---

# Jev refine

Codex reviewの代替レビュアーではなく、次のCodex reviewを省略できるか判定するfail-openゲートとして使う。

## 入力と外部送信

- canonical PR URLと検証済みworktreeを入力にする。対象headと収集contextのSHA-256 digestを凍結し、終了時にdiff・rules・review conversationを再収集して一致を確認する。
- PR diff、適用される`AGENTS.md` / `CLAUDE.md`、既存のinline review comment・返信、top-level review、issue commentを収集する。既存指摘は再発見として数えず、現在のdiffで未解消かを候補へ記録する。
- この処理はprivate sourceとreview conversationをVercel AI Gateway経由でOpenAI GPT-5 nanoとTypeSafe AI Jevへ送る。対象PRへbindingされた明示的な許可がある場合だけ`scripts/jev-refine.mjs --authorized`を付ける。許可がない場合は外部callを行わず`run_codex`へfail-openする。
- `AI_GATEWAY_API_KEY`が無い、入力が上限を超える、取得・schema parse・API・head再検証のいずれかが失敗した場合も`run_codex`とする。エラーを高confidenceへ読み替えない。

## 実行

```bash
node <skill-dir>/scripts/jev-refine.mjs \
  --pr "$PR_URL" \
  --worktree "<worktree-path>" \
  --authorized
```

標準出力のJSONを`JEV_REFINE`として保持する。repositoryへ評価artifactを保存・commitしない。`decision`は次のどちらか:

- `skip_codex`: 全候補のriskが`0.10`以下、候補抽出の網羅性と全体収束がともに`0.90`以上、未解消の曖昧点が0件で、開始・終了headが一致した。
- `run_codex`: 上記AND条件を1つでも満たさない、または判定不能。通常のCodex reviewへ進む。

閾値はscriptの既定値を使う。評価データで再較正せずに緩めない。厳しくする場合だけ`--candidate-max`、`--convergence-min`、`--coverage-min`を指定してよい。

## 壁打ち

1. GPT-5 nanoが差分とreview conversationを読み、各候補をfile・line・claim・根拠・反証・既存議論の解消状態・影響で構造化する。
2. Jevが候補ごとの「未解消でCodexが指摘する確率」、候補抽出の網羅性、全体収束を同時採点する。
3. gateを満たさなければ、JevのscoreをGPT-5 nanoへ返し、根拠・反証・既存返信との整合を再調査させて再びJevで採点する。
4. 固定のround上限は設けない。gate通過まで反復するが、閾値までの距離が`0.01`以上改善しないroundが2回続いたら評価が停滞したとみなし、`run_codex`へfail-openする。

安価なLLM自身のconfidenceはgateに使わない。Jevのcandidate riskだけが低くても、coverageまたはconvergenceが低ければ省略しない。

## 呼び出し元との契約

- このskillはread-onlyであり、code修正、commit、push、review依頼、返信、resolveを行わない。
- `skip_codex`は`headOid`、`baseOid`、`contextDigest`の組にだけ有効。base/head/diff/rules/review conversationが変わったら失効し、新しい入力で再実行する。
- `run_codex`時は`rounds`内の候補とscoreをCodex reviewへ渡す追加contextとして利用してよいが、候補を確定findingとして扱わない。
- gtr-newからは最終通常push後、Codex review依頼の直前に呼ぶ。Codex finding修正後に再依頼する場合も、更新headに対して再実行する。

## 料金記録

結果JSONの`usage`と`estimatedCostUsd`を保持し、最終報告にround数・decision・最大candidate risk・coverage・convergence・推定料金を記載する。価格取得に失敗した場合は料金を推測せず`null`のまま報告する。
