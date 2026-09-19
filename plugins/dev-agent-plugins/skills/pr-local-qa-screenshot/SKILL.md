---
name: pr-local-qa-screenshot
description: UI変更をローカルブラウザで確認し、スクリーンショットをPR descriptionへ掲載して一時画像を最終差分から削除する
---

# PR Local QA Screenshot

変更したUIをローカルで動かし、視覚的な証跡をPR descriptionに残しつつ、最終PR差分には一時的なQA成果物を残さない。

## 入力と境界

- canonical PR URLを優先する。current branchから解決する場合は、repositoryとPRが一意なときだけ使う。
- 開始前に期待する挙動、対象route、確認に使うidentityやデータ状態を記録する。
- 無関係なworktree変更を保持する。明示的な許可なしにローカルDBデータを変更しない。
- スクリーンショットがUIや操作変更のレビュー判断に有効な場合だけ実行する。

## ローカル動作確認

1. PR差分、project instructions、ローカル起動方法、既存E2E・QA helperを確認する。
2. 変更後の挙動と重要な非対象ケースを示す最小限のscenarioを選ぶ。
3. 実際のローカルapplicationを起動し、可能なら既存のPlaywright fixtureやmockを使ってbrowserで操作する。
4. 既存のローカルtest infrastructureが動かない場合は先に原因を診断する。一時routeやscriptは、実際に変更したcomponentをrenderし、撮影後に正確に削除する場合だけ使う。end-to-endがblockedなら成功扱いせず制約を報告する。
5. 目視確認だけでなく、期待するDOMまたは操作結果もassertする。
6. loading skeleton、developer overlay、secret、個人情報、無関係な画面領域を含めず、表示が安定してから撮影する。公開前に全画像を目視確認する。

一時スクリーンショットは`temp-docs/screenshots/`にPR単位の名前で保存する。一時harness、cache、trace、reportはstageしない。

## 最終差分へ画像を残さず掲載する

通常のコード変更とCI確認が終わった後、AIレビュー依頼前に次を行う。

1. mutation前にcanonical PR identity、local head、raw remote head、base、clean scopeを再検証する。
2. 承認済みスクリーンショットだけをcommit・pushし、完全長のscreenshot commit OIDを保持する。
3. 次のimmutable URLでPR descriptionへ掲載する。

   `https://github.com/<owner>/<repo>/blob/<screenshot-commit-oid>/<path>?raw=true`

4. PR descriptionを再取得してexact URLを検証する。GitHub contents APIへ`ref=<screenshot-commit-oid>`を指定し、各historical fileが取得できることを確認する。
5. branchから一時PNGを削除し、同じidentity・lease検証で削除commitをpushする。
6. 最終PR file listにスクリーンショット、一時Markdown、harness fileが含まれず、worktreeがcleanで、historical image URLが引き続き取得できることを確認する。

screenshot commitは到達可能な状態を保つ。掲載後にsquash、rebase、その他のhistory rewriteを行わない。後から書き換えが避けられない場合は、新しい到達可能なcommit OIDで掲載処理をやり直し、PR descriptionを更新する。

## PR description

- repositoryのPR templateと既存の関連内容を維持する。
- ローカルで確認したscenarioを記載し、browser確認とblockedなfull E2Eを区別する。
- スクリーンショットは裏付ける挙動の近くへ、簡潔なalt text付きで置く。
- CIで判定できる項目を手動QA checklistへ入れない。

## 完了報告

次を報告する。

- 確認したscenarioとlocal URL
- assertionと目視確認の結果
- screenshot commit OIDとPR description検証結果
- 一時route、script、Markdown、PNG、cache、traceが最終差分から除外されていること
- true end-to-end pathを妨げたローカルinfrastructure上の制約
