# S5：新しい書類経路の横断受入

対象はv0.5のS-A01〜S-A10。S1〜S4の局所試験を再利用し、新経路の一巡・障害・復帰・計測をつなぐ。架空データ、ローカル保存adapter、Chromium PCを基本とする。画面の装飾、全CJSのTS化、アーキテクチャ全面再編、R5／R6／M7の受入、外部公開は別段階。

## 追加する確認

- ブラウザで求人作成・候補者作成・PDF／XLSX暗号化受付・実ワーカー処理・推薦・企業側閲覧・採用・請求HTML・未送信通知まで進める。後から追加した版が共有へ混入しないことも確認する。
- 定義期限切れ、更新失敗、published／loaded世代不一致で既存の暗号化書類の閲覧と新しい推薦提出を拒否する。検証用manifestを復元し、同じ書類・選択版の閲覧へ戻れることを確認する。これはAV新世代での既存ready成果物の再生成機能ではない。
- 別文書の成果物envelopeを付け替えても配信しない。原本配信へ降格しない。
- stored応答喪失とauthorize応答喪失後にブラウザcontextを終了し、再ログインして本人用下書き・復帰リンクから同じ受付へ戻る。受領済みは再送せず、未受領は本人のファイル再選択と新attemptで進める。
- 通常の終端確定で7日保持を確認した上で、別の受付を初回の終端確定時だけ期限切れにするDB fixtureで境界を越え、状態照合・再認可・新attempt・completeを拒否する。ブラウザの復帰リンクも期限切れを示す。不変制約は無効化せず、終端後の期限変更を拒否することも検証する。fixture用triggerは特定UUIDに限定し隔離環境に保持する。日数経過を実際に待った検証とは扱わない。

## 検出した経路の修正

推薦提出は保存済みclean判定だけでなく、その書類の検査証拠と実ロード中のAV状態を照合する。既存の組織RLS・候補者所有・不変hash・共有確定transactionは維持する。

受付下書きの復元では書類の実状態からUI状態を決める。ready書類を再度pendingとして扱わず、追加登録を妨げない。確認チェックは再度本人が行う。

正常完了の結果照合はcompleted・元の201・元の7日期限を返し、status_urlを維持する。

期限後の受付APIは元のexpires_atを保ったtombstoneを同じtransactionで確定し、commit後に拒否を返す。結果照合の内部戻り値もFound／Expired／NotFoundで区別し、失効状態を保存せず終了しない。

## 性能・資源の記録

小容量PDFの最初の試料と後続3試料、PDF／XLSXの複数受付、10MiB PDF、拒否される不正形式を区別する。ブラウザcontextの初回／後続の違いであり、各ジョブは常に新しい隔離sandbox。ページ遷移でJS realmは作り直される。常駐ワーカーのwarm性能やTLS／WAN性能とは扱わない。

Web Cryptoの所要時間、予約／認可／転送／completeの要求時間、受付wall時間、claimまでのqueue、ホスト起動・処理・停止全体、初回manifest／page、brokerでの復号・AV・形式検査＋変換・成果物暗号化保存を記録する。形式検査と変換の内訳は分離していない。Crypto時間にはファイルfingerprint用digestも含む。ブラウザのrequestAnimationFrame間隔も記録するが、任意の閾値を合格条件として新設しない。

小容量のp50／p95は少数試料のnearest-rank記述統計とする。商用SLA、安定した尾部性能、改善率を主張しない。メモリはbrokerの完了時RSS、稼働中relay／sandboxのcgroup peak、制限値、OOMの有無を区別する。終了済みbrokerのcgroup peakは取得できない。総合runner時間を人の工数に換算しない。

brokerの計測ログは固定のphase名と数値だけに限定し、ホストlauncherも許可したschemaだけを採用する。ticket／DEK／鍵／原本／氏名／任意URLを計測へ渡さない。

## CIの判定

新しい`e2e/s5.spec.ts`は既存の固定済みTypeScript compilerでstrict型検査する。依存は追加しない。PlaywrightのCJS試験も回帰に含める。

Linux/amd64とLinux/arm64のnative runnerで、同じ基準commitの全体試験を実行する。開発subsetだけを全体受入にはしない。全体CI中に見つかった完了結果APIの返答修正は、基準c02f4f9から正常系の返答分岐5行のみを追加する限定差分とし、最終c518252のS2＋S5を両native環境で再実行する。S2の失敗／workerとS5の完了／期限切れ／ブラウザ復帰を含め、全体基準のhashと最終hashの差がuploads.rs・s5.spec.tsだけであることを照合する。schema・暗号・鍵・受信処理等へ差分が広がる場合はこの再利用を適用しない。全体基準155件と最終差分23件はcommit・件数を分け、最終commitで全155件を実行したとは扱わない。GitHubの標準arm64ラベルは[公式runner一覧](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)を確認した。

ブラウザの終了コードだけでは受入にしない。source不変、AV稼働・OOMなし、全対象サービスのログ検査、主環境・復旧先・各ジョブの停止まで必要とする。失敗した検査を通過扱いにしない。復旧試験を最後に実行し、通常デモのDB・鍵・cookieへ触れない。

証拠の採用状況と残計画はS5完了記録で確定する。
