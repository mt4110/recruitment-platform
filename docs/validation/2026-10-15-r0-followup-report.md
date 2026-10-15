# R0残件の確認結果 — 2026-10-15追補

## 結論

**今回承認されたR0の残件5つは確認・設計反映を完了した。R1以降へ進まず停止する。** 初期互換範囲をSheets由来に明示し、空metadataの限定許可、公式Debian版AVのnative両arch、実定義の新世代への切替を独立実験で確認した。製品のupload/HTTP認証/受付停止/DBとの結合受入を完了した意味ではない。

[初回R0記録](2026-10-15-r0-report.md)は当時の未成立判定として保持する。最新結果は本追補と[summary](r0-followup-2026-10-15/summary.json)を参照。

- 検証source: `d0e6c16a722e7335df136deb1ad78fd2a0209c4f`
- [native Linux/amd64 CI](https://github.com/mt4110/recruitment-platform/actions/runs/38727136793): success。job 11:24:46〜11:25:48 UTC（62秒）。機械の時間で、人の工数ではない。
- ローカルDocker VMはaarch64、AVもlinux/arm64のnative実行。前回のamd64エミュレーションとは区別する。

## 1. Sheets由来を初期互換範囲とする

Excel契約なし・Sheetsで進めるという利用者回答と今回の承認により、R0の最低試料を**Sheets実出力の架空履歴書・職務経歴書の2点**へ明示変更した。Excel実出力の互換性は未検証で、契約・購入は求めない。将来Excel固有の互換性を約束する場合は実出力試験を別途追加する。

原本は前回取得した実出力を改変せず使用し、CIとのSHA256一致を確認した。一般のOffice互換や任意テンプレートを保証しない。実在の本人資料、提供された職務経歴書のリンク先は取得/fixture化していない。producerメタデータで検査を省くこともない。

## 2. 未対応partと安全条件

Microsoftの[Persons仕様](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/1a170d26-42a2-46f0-b2b6-0ff1dec1c344)と[personList仕様](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/9f1b6e0e-79cd-4ae2-b3a7-6dea649c57f6)を参照した。これはthreaded commentsの投稿者情報であり、Sheets実出力では空だった。**投稿者・コメント全般へ許可を広げず、空rootだけを許可**する。

[設計の詳細契約](../design/10-resumes-and-autosave.md#sheets実出力の空metadata例外r0確認後)に、part固定名、content type、workbook由来の内部relationship一つ、空root、属性/子/本文制限、UTF-8・16KiB、DOCTYPE/entity拒否を追加した。Sheetsにある未使用odttf用Default宣言だけを例外とし、実font partは引き続き拒否する。無関係な未知構造を許可する例外ではない。

独立した`validation/r0/sheets_policy_probe.py`は正常2点と、person子、foreign子、属性、本文、別namespace、DOCTYPE、UTF-16、過大XML、外部Target、別rel type、重複rel、別content typeの12変種を確認した。local/CIとも正常2点を通し、12変種を拒否した。この実験は**空metadata周辺だけ**で、完全なZIP/XML/式の製品validatorではない。旧`inventory.py`のcompatibilityフィールドは改訂2のpersons未許可を基準とした棚卸し結果で、新しい許可契約の総合判定には使わない。

R1は既存Python serviceの標準zipfile/Expatで逐次制限する方針。新しいOffice変換/描画依存は追加しない。採用済みPython imageをnative arm64で確認し、Python3.13.16 / Expat2.8.5だった。[PythonのXMLセキュリティ説明](https://docs.python.org/3.13/library/xml.html#xml-vulnerabilities)を踏まえ、最低Expat2.7.2、DTD/entity無効化、実展開量・要素数・深さ・子process制限を必要条件とした。正式なparser/式文法/異常系はR1/R6で実装・受入する。

## 3. arm64/amd64の公式AV構成

前回の`1.5.4_base`（Alpine版）だけではなく、公式の`clamav/clamav:1.5.4-debian13-slim`に両archがあることを確認した。選定を訂正し、自前buildは追加しない。

| native arch | 固定manifest digest |
| --- | --- |
| arm64 | `sha256:45bbe454c6b8ba12382f58133a72ffd983cd0b7505f8f4cea906202f5a8a3b28` |
| amd64 | `sha256:99f1e9b79d0a5ec8c019483b40577f6bae4f30a954f9f057a7b39da600861391` |

[公式ClamAV Docker repository](https://github.com/Cisco-Talos/clamav-docker)を参照。ClamAV1.5.4、clamav uid/gid1000:1000。版/digestを固定し、scanはnetwork none・host port公開なし、non-root/read-only/cap drop ALL/no-new-privileges、2GiB/1CPU/pids32、tmpfs384MiB。更新側だけbridge/DB書込み・4GiB。原本volumeや製品DB認証を渡さない。実験用TCPはcontainer内127.0.0.1で、製品設計はUnix socketのまま。

ClamAVの[GPL v2本文](https://github.com/Cisco-Talos/clamav/blob/clamav-1.5.4/COPYING.txt)と第三者ライセンスを保持する。今回は公式imageを利用する実験で、改変imageの配布は行っていない。再配布物のlicense/source案内確認は既存M7の配布確認に含める。

## 4. 実定義の切替・ロード・失敗

公式image内の署名付き旧DBを別directoryへ保全してロードした後、別のstaging copyをFreshClamで更新した。TestDatabases yesの実DB試験を通し、別の新世代pathnameへpublishしてclamdを新規起動した。旧世代は上書きしない。

- daily **28151 → 28154**の実更新。main63、bytecode339。版の後退なし。
- 旧/新の各DBについてsigtoolによるVerification OK、SHA256、ロード後のファイル不変性を確認。
- 実ロードVERSIONは旧`1.5.4/28151`、新/復旧`1.5.4/28154`。正常テキスト/Sheets実出力2点はclean、無害なEICARは検出、raw INSTREAMの10MiB+1は上限エラー。
- 不正な更新用directoryでFreshClamが実際にexit2、検証済み世代に変更がないことを確認。
- 破損DBを指定した実clamdは起動失敗。その後、検証済み新世代で別daemonを起動し、正常・検出・上限拒否が復旧した。

**同じ版と同じhashを混同しない。** 旧CVDは両archでhashまで一致したが、各環境で更新生成された新版daily.cldは版28154が一致してもSHA256が異なった。別の配布物として記録し、同一世代とは扱わない。各実行環境では、自分のupdaterが検証/publishした全DBのhashとread-onlyでロードする全DBが一致することを確認した。製品でも「版が等しいからhash不一致を許可」してはならず、1つのpublished世代をそのままscan側へ配布する。異なるCLDの内部全entryが等しいという追加主張はしていない。

**受付ゲートは隔離した判定モデル**である。実観測したmanifestを入力し、版/hash不一致、新世代確認時刻と旧ロード版、24時間超過、未来時刻、busy/更新中、更新失敗/ロード失敗で受付不可、合致/復旧で受付可を確認した。未来のHTTP応答や実アップロードをこのモデルへつないだ証拠ではない。worker枯渇・drain/CAS・認証・競合時の応答はR2/R6に残る。

### 実験の修正履歴

初回はDebian版clamdが通常ログへ`Loaded`という文字を出すという誤った仮定で実験assertionが失敗した。文字列への依存を除き、実VERSION応答、全DBのsigtool検証、read-onlyの同一manifest、実scanで確認した。

またDebian版ncでは、過大INSTREAM送信時のエラー応答を実験側が取りこぼした。失敗した証拠を残したまま、送信と応答読取りを並行するbashのTCP transportで再実行し、10MiB超の実エラーを取得した。拒否条件を緩めたり、空応答を成功にしていない。最終local v4とCIは同じcommitのsourceを使用する。失敗runのcontainer/log/DBもGit外で保持する。

## 5. 資源と残工数

| native環境 | 旧load | 新load | 復旧load | 測定したscanner peakの最大 |
| --- | ---: | ---: | ---: | ---: |
| arm64 local | 7.594秒 | 6.500秒 | 6.499秒 | 1,480,806,400 bytes |
| amd64 CI | 5.349秒 | 5.334秒 | 5.333秒 | 1,309,749,248 bytes |

今回のDB/試料で2GiB上限内に収まった結果。全ファイル/将来定義/同時loadの保証ではない。[公式のRAM推奨](https://docs.clamav.net/manual/Installing/Docker.html)は3〜4GiBで、2GiBを一般的な運用推奨にしない。既存7サービスと独立して実行し、旧daemonを停止してから次世代を起動した。両engineの同時常駐は前提にしない。Linux子process memory/CPU/wallとbrowser旧鍵復元の独立実験もCIで再成功した。macOS RLIMIT_ASの非成立という前回の限界は消していない。

**R0の残確認は今回の範囲で完了。残計画は82〜144時間の暫定仮積算。** 人の実作業時間は未計測で、CI時間/token量から実工数や予算残高を算出しない。

| 残段階 | 時間仮説 | 影響 |
| --- | ---: | --- |
| R1 | 12〜20時間 | Sheets空metadata契約を含む形式検査/API/共有配信。全式/ZIP/XML検査はこれから |
| R2 | 10〜18時間 | 公式multi-arch imageで自前buildを回避。受付ゲート/manifest/鮮度/workerを製品へ結合する負担は残る |
| R3 | 4〜8時間 | 書類種類/版・複数登録/復帰UX |
| R4 | 18〜30時間 | 本人用下書きAPI/RLS/暗号化/業務結果連携 |
| R5 | 12〜20時間 | 端末保存/queue・旧鍵復元・失効 |
| R6 | 10〜16時間 | 横断E2E/CI/追加文書・既存回帰 |
| R1〜R6 | **66〜112時間** | 設計時74〜124時間から、残っていないR0計画8〜12時間を除いたWBS幅 |
| M5〜M7 | **16〜32時間** | 通知モック/請求PDF/一巡/配布 |
| 合計残計画 | **82〜144時間** | R1以降未着手。実績の削減量でも予算延長の承認でもない |

未知partの限定対応はR1、manifestの製品結合はR2の既存幅へ含め、独立実験をさらに重複加算しない。新たな大きい未知構造、2GiB超過、実機保存制約が出た場合はその段階で再積算する。元の40〜100時間で追加要件を全部完成できるという判断にはしない。Excel互換・ポートフォリオURL欄など新たな範囲をこの見積もりへ黙って追加しない。

## 証拠と停止

[arm64 AV](r0-followup-2026-10-15/av-native-arm64.json)、[amd64 AV](r0-followup-2026-10-15/av-native-amd64.json)、[Sheets local](r0-followup-2026-10-15/sheets-policy-local.json)、[Sheets CI](r0-followup-2026-10-15/sheets-policy-ci.json)、[CI旧鍵](r0-followup-2026-10-15/keys-ci.json)、[CI資源](r0-followup-2026-10-15/resources-ci.json)。署名DB・profile・鍵・原本個人情報はコミット/CI artifactへ含めない。

R1の製品実装・migration・既存サービス変更・M5は行っていない。R0のcontainerは停止して保持し、削除していない。最新の設計への反映と記録のcommit/pushまでで停止する。
