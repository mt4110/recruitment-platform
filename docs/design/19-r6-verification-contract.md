# R6 横断検証・負荷確認・配布物監査

対象：R1〜R5とS1〜S5を統合した現在のプロトタイプ。M7、外部公開、通常デモの更新、画面装飾は行わない。gpt-6.1-sol／mediumで実施し、High変更は先に相談する。

## 確認条件

- 全既存E2Eを固定commit・clean tree・隔離DBで再実行する。A17〜A25は既存の実形式検査／AV／共有／版管理／移行／暗号化保存を再利用し、テスト名・実結果・ソースhashを対応づける。mock成功で実AVの受入を置き換えない。
- 既存12 form_typeで入力→保存→別画面→戻る→reload→hidden/visible相当のイベント→セッション期限切れ→同じ本人の再認証→復元を確認する。確認checkboxは復元せず、書類選択だけを復元する。業務件数・選考履歴・通知が勝手に増えない。実browser processの再起動と未同期復元はR5の14件も同時実行する。
- 小規模デモ向けの有界な負荷として、同版への8並列更新（成功1・競合7）、4本人合計32並列の本人／他人読取、残り29件の新規保存を並列に行い、30件/時到達後の429とRetry-Afterを確認する。測定は同じ隔離環境で経過・p50/p95・statusを記録する。製品の制限を緩めず、障害を成功へ変換しない。各要求の15秒上限は試験の暴走防止であり、性能SLAではない。継続負荷／最大同時利用者数の資格確認とは呼ばない。
- 常設11サービスの実メモリ・PID上限、稼働、観測cgroup peak、OOMを確認する。ジョブのsandbox制限は既存S2の実ジョブ試験を再実行する。cgroup再作成前を含む全期間のpeakは保証しない。失敗runも保持する。
- 配布対象のGit source tarとJSON/PNGを、許可path・既知試験用秘密値・認証形式で検査する。原本、env、秘密鍵、profile、生ログを共有しない。画像OCR・全履歴・独立侵入監査は対象外。
- 監査は常設11＋broker/relay/sandboxの14役割を実image ID・archで対応づけ、同一IDだけ重複除外する。タイムアウト診断のCall log／認証headerを遮断し、CIは検査済みexport専用directoryだけをアップロードする。unsafeな原記録は共有せず保持する。停止済みrunのsource hashを現treeと対象commitの両方で照合し、古いrunと新lockを混ぜない。npm/Cargo/imageの全severity・修正有無・license未知数を保持する。exit0=指摘なし、exit1=指摘あり、exit2=監査tool失敗として区別する。指摘の一括ignoreは追加しない。

## 証拠と停止

ローカルarm64とLinux/amd64・arm64の同一ソース／fixtureを照合する。Browser plugin not availableのため既存Playwright/Chromiumを用いる。PC／モバイル幅の画像とconsole/page errorを確認するが、実機電話・OS中断・Safari／Excel互換を主張しない。Google Sheetsの既存実出力2点と攻撃fixtureを区別し、追加の印刷設定差を実出力で確認できない場合は明示する。

M6の既知依存／OS指摘と、M7の一般配布条件・第三者再現は別の未完了ゲート。R6の監査実施が成功しても指摘が残ればgateは未合格で、CI全体をgreenと報告しない。広範なOS置換・自前patch・全面TS化の工数を無断でR6へ含めない。結果・必要な残工数を記録し、コミット・push後に停止する。

## 閲覧の一時拒否と試験の分割

正常な閲覧読取はSCANNER_UNAVAILABLEの503と本文／ページ情報なしを検証した場合だけ、10回・200ms間隔で有限再試行し、最終200を必須とする。拒否を期待する試験へ適用しない。S4の移行・旧鍵欠落・別ジョブ復帰・再適用を直列の別ケースへ分け、各120秒・全体45分の上限を維持する。IMEはChromium CDPの変換途中／確定を保存し、OS実機IMEとは区別する。
