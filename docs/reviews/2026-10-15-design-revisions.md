# 設計レビュー修正対応表

2026-10-15 / 設計草案 v0.3

[元のレビュー](2026-10-15-design-review.md)はcommit 36523d7時点、[再レビュー](2026-10-15-design-rereview.md)はcommit b9d7bbd時点の記録として保存する。ここでは初回6件と再レビュー残件3件の設計上の対応を記録する。「反映済み」は文書の変更を意味し、コード・動作・セキュリティ試験の合格ではない。

## 指摘の対応

| 指摘 | 設計への反映 | 正本 | 実装時に確認する条件 |
| --- | --- | --- | --- |
| R1 辞退後PDF条件 | E_SHAREDを組織・状態4種・撤回なしのAND条件に統一。辞退時はwithdrawnと撤回時刻を同時更新。自社agency閲覧と区別 | [データ](../design/04-data-model.md)、[API](../design/05-api.md)、[安全性](../design/06-security.md) | A05。直接URL、全状態、撤回commit後の新規要求 |
| R2 RLSと共有参照 | application_documentsへ不変のstorage/表示名/hashを保存。企業は共有行から取得し原本にJOINしない。求人snapshotをapplicationsに分離して共有失効後もmetadataを表示 | [データ](../design/04-data-model.md) | A03/A04/A11。通常DBロールで共有PDF取得、原本/他組織/失効後の拒否 |
| R3 募集終了との競合 | jobの編集/終了とdraft作成/提出に同じtransaction-level advisory lock。提出commitを受付時点に固定しjob_versionも検証。agencyのjob UPDATE権限を広げない | [データ](../design/04-data-model.md)、[API](../design/05-api.md) | A14。両方の先行順と途中失敗、lock待ち上限 |
| R4 撤回の状態 | draft拒否、進行中は辞退、rejected/hiredは状態維持・共有のみ失効。placement維持、再共有なし、重複no-op | [API状態表](../design/05-api.md)、[画面](../design/02-experience.md) | A15。全状態/同キー/別キー/no-opのeventと通知数 |
| R5 冪等とversion | 認証→冪等scope lock/完了確認→version/業務の順を固定。同一キーの並行処理、現在の認可、HTTP method/実pathのscopeを定義。multipartの残件は下記F1で反映 | [API](../design/05-api.md)、[upload](../design/06-security.md) | A07/A08。応答喪失後の古いversion再要求、異payload、並行要求、候補者アーカイブ後のupload再要求 |
| R6 PDF検査/復旧 | pikepdf/libqpdfを選択し静的PDFの受付policyを定義。staging→予約/lease→隔離検査→create-only配置→ready、明示retryと中断復旧を設計。文脈判定と予約前後の残件は下記F2/C1で反映 | [安全性](../design/06-security.md)、[構成](../design/03-architecture.md) | A09/A16。正常/禁止要素/警告/上限、各停止点、hash不一致、leaseの競合 |

## 再レビュー残件の対応（v0.3）

| 指摘 | 設計への反映 | 正本 | 実装時に確認する条件 |
| --- | --- | --- | --- |
| F1 [P2] uploadの再試行順序 | 反映済み。初期検査は現在の認証・所有までとし、hash/冪等lock/既存結果の確認を先行。非アーカイブは新規予約とready確定で検査。アーカイブだけでは完了済み結果の参照を拒否しない | [API](../design/05-api.md)、[安全性](../design/06-security.md) | A07。保持期間内の成功→応答喪失→アーカイブ→同bytes/キーで同document/201、新キーは409。現在の認可喪失は拒否 |
| F2 [P2] PDFの/Aの過剰拒否 | 反映済み。全辞書の/A一律拒否を文脈・型判定へ変更。構造ツリーで確認した構造属性を許可し、属性の配下・参照位置も検査。アクション・型偽装・禁止要素を引き続き拒否 | [安全性](../design/06-security.md) | M0/A09。通常/タグ付き静的PDFは許可。型偽装・参照共有・属性配下の禁止要素・既存の拒否fixtureは拒否 |
| C1 [P3] 予約前後の復旧条件 | 反映済み。予約commit前は未公開と再送時の初回単一予約、commit後は既存ID/冪等記録の復旧と分けた | [安全性](../design/06-security.md)、[受入計画](../design/07-delivery.md) | A16。予約前の孤立stagingを管理し、予約後の各停止点はlease切れ後に同じdocument IDで復旧 |

今回の3件は設計へ反映済み。スキーマ・構成・対象機能・80〜140時間の仮積算は維持する。実装試験の結果は、実装段階に別途記録する。

## 範囲と工数の変更

- 1ユーザー1組織をusers.organization_idで固定。membershipsと組織切替UI/APIを初期版から外した。
- 請求PDFをA4縦・固定1明細/金額・1ページに固定し、組織名の省略とoverflow失敗を定義した。
- 期限切れ後の入力保持はOIDC遷移前まで。戻った後の再入力を案内し、永続的なPII保存を増やさない。
- 工数は40〜100時間という初期仮説から、実装/認可/復旧/検証/引渡しを積み直した80〜140時間の仮積算へ変更。[内訳](../design/07-delivery.md)を参照。予算・納期の承認ではない。
- クラウド3例の実装/実地確認、LP/ガイド本文、移行、本番は引き続き別の作業。

## 残る確認と変更の扱い

M0で選定version/依存ライセンス、OIDC接続、通常DBロールとlock、PDF policy/日本語1ページを実測する。いずれも今回動作確認済みとは扱わない。方式が成立しない場合は結果を記録して設計/工数を再評価し、安全条件を下げて通過扱いにしない。

今回の成果物はMarkdownのみ。コード、Terraform、CI、実装試験、クラウド資源を追加しない。Gitのコミットとpushは設計修正の反映を対象とする。
