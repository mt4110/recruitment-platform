# M6：Expat・基底OS・同梱依存の限定更新

2026-10-18 JST。対象は承認された6〜12時間の更新バッチ。公式ソース再buildも同じ上限内で行う追加承認を受けた。M7・公開・画面の作り込みは対象外。

## 1. 結果

更新を実装し、ローカルの移行・復旧単独13件、S5＋S4の22件、実runtime 14役割の検査を確認した。修正版ありHigh／Criticalは同じDBで**51→3記録**。残る3記録はrendererのnpm配下。未修正OS指摘・RustSec・ライセンス照合も残るため、**M6受入は保留**。脆弱性0件・公開可能とは扱わない。

現段階のローカル22件・監査対象は `224cc0bbd433e95585853145e2a22975d077690a`。後続のR6補助処理の作業ディレクトリ修正はLinuxで再検証中。初回 `6fdefa5e9503c337495b7a787c8878806789e3e0` の失敗と修正後の結果を区別する。最終記録では各試験のcommitと実装137ファイルのhashを照合する。

## 2. 更新内容

| 対象 | 変更・実行確認 |
| --- | --- |
| gateway | 同じnginx 1.30.6／Alpine系列でOS更新。libexpat **2.9.0-r0** |
| AV | ClamAV **1.5.4**を維持し、Debian 13のlibexpat1 **2.9.0-1~deb13u1**。実PythonのExpatも2.9.0 |
| PDF／XLSX inspector | 公式CPython **3.13.16**とExpat **2.9.0**の無改変ソースをSHA-256固定でbuild。`pyexpat`が `/usr/local/lib/libexpat.so.1` へ実際にリンクすることを検査 |
| Python補助ツール | pipは検証済みCPythonソース内wheelからbuild時だけ使用。runtimeにpip／ensurepipを導入しない。既存4件のhash固定wheelを維持 |
| Web／viewer／broker／relay | 公式Node **24.22.0**の実行バイナリ・LICENSEだけを同じDebian bookworm系列へコピー。npm実行ファイルとnpmツリーの不在を検査 |
| DB | PostgreSQL **17.11**を維持。公式gosu **1.19**を公式Go **1.27.2**で再buildし、CGO無効。実版を検査 |
| その他の基底OS | API／DB／renderer等の取得可能なapt更新、依存整合検査。上流imageのdigestは公式registryで再照合したが同じ値だった |
| 検査の受入下限 | XLSX parserのExpat下限を2.9.0へ。実workerの既存67ケースに、旧版2.7.2／2.8.5を拒否する2ケースを追加し**69件**。旧パーサー自体は実行せずversion guardを検査 |

[buildのURL・hash・registry照合](m6-update-2026-10-18/build-provenance.json)、[実runtime／実image ID](m6-update-2026-10-18/local-arm64/runtime-versions.json)、[XLSX検査69件](m6-update-2026-10-18/local-arm64/xlsx-policy.json)。apt repositoryのsnapshot固定、imageのbyte単位再現性、一般再配布条件の完了は主張しない。

最初のCPython buildでは旧Expatとのリンクでsymbol不足が発生した。include／library／rpathを明示し、build時と実runtime両方のExpat検査を通した。検査下限を下げて回避していない。

Pythonのmsgpack／setuptools／urllib3指摘は、独立したdistributionではなくpipの `_vendor` 実体・同梱SBOMに由来した。通常のpackage metadataに見えないことだけで誤検知としなかった。別の新しいurllib3を追加して済ませず、製品で不要なpipをruntimeへ持ち込まない方式にした。SBOM削除・scanner ignoreは行っていない。

一次資料：[Expat 2.9.0 release](https://github.com/libexpat/libexpat/releases/tag/R_2_9_0)、[DebianのExpat修正情報](https://security-tracker.debian.org/tracker/CVE-2026-77214)、[CPythonのbuild設定](https://docs.python.org/3.13/using/configure.html)、[gosu 1.19](https://github.com/tianon/gosu/tree/1.19)。ソースと版の照合は実build・runtime検査で補完する。

## 3. 検証と初回失敗

| 確認 | 結果 |
| --- | --- |
| 静的検査 | Rust fmt／Clippy／9 unit、Web・E2E TypeScript、reporter 3件、export 6件、Python／Node syntax成功 |
| ローカル初回全体 | 185成功／1失敗。復旧先gatewayの不足で失敗。成功扱いしない |
| ローカル修正後S4単独 | **13/13成功**、14役割のruntime検査も成功 |
| ローカル最終S5＋S4 | **22/22成功**。業務一巡・安全な閲覧・鍵失効・移行・旧鍵／DB／blob復旧、実行後AV・ログ・停止検査成功 |
| 最終実装のLinux/amd64・arm64全体CI | 結果確認中。最終記録で確定する |
| ローカル配布物監査／証拠export | いずれも成功、exportの保留0件。既知fixture秘密値・認証header／token patternを検査 |
| ローカル実image脆弱性監査 | 14役割／8実imageを照合し、**findings／exit1**。tool errorではない |

[単独確認](m6-update-2026-10-18/local-s4-only/summary.json)、[最終22件](m6-update-2026-10-18/local-arm64/summary.json)、[実行記録](m6-update-2026-10-18/local-arm64/run.json)、[復旧証拠](m6-update-2026-10-18/local-arm64/s4-recovery.json)、[配布物監査](m6-update-2026-10-18/local-arm64/distribution.json)。Browser pluginが利用できないため、既存のPlaywright Chromiumで確認した。実在する求職者情報を使っていない。

初回CIは[39069687391](https://github.com/mt4110/recruitment-platform/actions/runs/39069687391)。amd64は185成功／1失敗、arm64は172成功／2失敗／12スキップ。[初回記録](m6-update-2026-10-18/first-attempt.json)を残す。

- gatewayをbuild対象にしたのにsnapshotの実image一覧へ追加していなかった。保存・復旧tag作成へ追加し、復旧後も元と同じ実image IDを必須にした。
- arm64のR6準備中に書類登録が503になった。具体的なAV内部原因は未確定。準備前の認証付きAV state安定確認を補った。503なら `SCANNER_UNAVAILABLE`・未検査・利用不可に限定して確認し、同じ書類IDを1回だけretry、最終200・同ID・availableを必須にする。他の503や拒否を成功扱いしない。
- 初回復旧失敗後はサービスが停止し、実行後runtime検査も完了していなかった。ブラウザの通過分だけで受入せず、修正後は実行後検査まで要求した。

**互換制約：更新前snapshotにはgateway実IDがない。今回のrestoreは稼働元停止・復旧先作成の前に拒否する。** 元環境を保持したまま、移行・切替前に新しい検証済みsnapshotを取得する。最新版のpullや推測で不足IDを補わない。[復旧契約](../design/16-s4-migration-contract.md)を参照。

追加修正：`224cc0b`のamd64 CIではAV state確認の子プロセスに作業ディレクトリ指定がなく、npm実行位置からスクリプトを探して90秒で失敗した。cwdをrepository rootへ固定し、事前のファイル存在確認を加えた。これは製品のAV拒否を緩める変更ではない。R6単独と両Linux全体で再確認する。

## 4. 再監査の差分

Trivy 0.76.0／cargo-audit 0.22.1。baselineと更新後は、Vulnerability DB更新2026-10-17 18:34 UTC／期限2026-10-18 18:34 UTC、Java DB更新2026-10-17 01:07 UTC／期限2026-10-20 01:07 UTCという同じDBを使用し、実行時はどちらも期限内。[全差分](m6-update-2026-10-18/comparison.json)と[更新後summary](m6-update-2026-10-18/local-arm64/audit/summary.json)を保持する。

| 独立imageのpackage／advisory記録 | baseline | 更新後 |
| --- | ---: | ---: |
| 修正版ありHigh／Critical | 51 | **3** |
| Critical（未修正も含む） | 11 | **7** |
| High（未修正も含む） | 378 | **336** |
| Medium | 1,242 | 1,203 |
| Low | 737 | 740 |
| Unknown severity | 9 | 9 |
| license未知／未取得package記録 | 538 | **518** |

[更新対象51記録の個別照合](m6-update-2026-10-18/targeted-delta.json)では、同じ役割・advisory・package・pathで48記録が検出されなくなり、3記録が継続した。package非同梱とversion修正を一律に「CVEを48個修正」と表現しない。

これはunique CVE数、悪用可能性、リスク低減率ではない。同じimage IDだけを重複除外し、別imageの同じpackageは別記録。集計減少には構成・version・package分類の変化もある。OS scanに現れなかった静的Expatは別の実version検査で補完する。

修正版ありHigh／Criticalはgateway 1→0、web 3→0、db 25→0、renderer 7→3、viewer 10→0、scan 5→0、api／idp 0を維持。broker／relay／sandbox等は同一IDへの対応をsummaryで残す。Web・E2E・PDFのnpm lockは各0、RustSecは従前の1、秘密pattern検出0。

### 未解消の指摘

1. rendererのglobal npm配下：`brace-expansion` 5.0.9の2記録（CVE-2026-102276／102278）、`undici` 6.28.0の1記録（CVE-2026-19534）。製品lockは0でも同梱CLIは別対象。照合した最新版npm 12.2.0にも残るため、ignore・SBOM削除・vendorへの独自上書きはしない。
2. OSの未修正・fix deferred・will not fix指摘。Criticalはzlib／MiniZipのCVE-2023-45853、DBのSQLite CVE-2025-7458、DB／scanのlibxml2 CVE-2026-6653。Debianの注記と実バイナリ・入力経路の個別評価が必要。修正版がないことを安全確認とは扱わない。
3. RustSecの `rsa 0.9.10 / RUSTSEC-2023-0071`。APIは公開鍵検証のみという制約を維持。書類の秘密操作へ流用しない。patched releaseなしのため単純更新で解消したとは見積もらない。
4. license未知／未取得518記録（idp 413、renderer 77が大半）。POM／LICENSE／OS copyrightとの一次照合を残す。Go標準libraryもBSD-3-Clauseの対象であり、再buildしたgosuを含むimage一般配布時の表示・対応ソース条件はM7で確認する。scanner不明を違反確定・適合済みのどちらにも置き換えない。

## 5. 負荷確認の範囲

ローカルarm64／Colima 4CPU・8GiB、通常デモと同居、認証付きローカルHTTP。架空744B PDF、14,344B Sheets XLSX、10MiB PDF、2件バッチを使用。[実測](m6-update-2026-10-18/local-arm64/s5-performance.json)では10MiBのWebCrypto約23ms、受付全体約2.803秒、キュー待ち約13.367秒、host jobの起動・処理・停止約14.589秒、最初のmanifest／ページ取得約32ms。queueとjob wallは定義が異なるため単純合算しない。最大animation frame gapは600msで、UIの無停止や即時閲覧は保証しない。各測定ジョブにOOMなし。

これは本番TLS／WAN・多人数負荷・商用SLA・過去版比の改善率ではない。compiler設定が変わった影響も、同条件比較なしに性能改善や影響ゼロとは主張しない。画面の作り込み・追加の性能改善はこのバッチで行っていない。

## 6. 残工数と停止条件

以下は今後の作業計画幅で、人の実績工数・runner時間・予算残高ではない。今回済んだ再build・両arch検証を二重に積み直さない。

| 残作業 | 仮積算 | 範囲 |
| --- | ---: | --- |
| renderer CLIの対処方式選択・必要な変更・差分再検証 | 4〜8時間 | 修正版npmの有無、同じサポート系列でCLIを持ち込まない構成を確認。無条件の独自vendor patchは含めない |
| 未修正OS／zlib／RSAの個別評価 | 4〜8時間 | 実バイナリ・入力・権限・upstream判断を照合し、未解消と追加判断を明示。例外承認やゼロ件を保証しない |
| license一次照合・残件整理 | 3〜6時間 | package重複整理、POM／LICENSE／copyright対応、未確認一覧。法的全件適合保証ではない |
| M6の残計画 | **11〜22時間** | 上記に必要な差分確認・記録を含む |
| M7 | **別途6〜12時間** | 第三者再現・引渡し・一般配布条件。今回着手しない |

M7込みは**17〜34時間**の仮説。未修正native依存のために基底OS変更・独自patch等を選ぶ場合だけ、別途**12〜24時間**の従前条件を残す（その場合の合計29〜58時間）。今回済んだ公式Expat／CPython／gosu再buildをこの別枠へ再計上しない。上流修正待ちの日数は工数へ換算しない。

任意AV再処理導線2〜4時間、先方限定公開のTLS／OIDC／IP制限、外部専門家確認は別枠。評価後も未修正指摘が残れば受入保留を維持し、工数を使えば監査greenになるとは約束しない。

## 7. 停止状態・作業資源

通常localhost:3000の旧版デモは再build・再起動していない。隔離検証環境・復旧先・確認用コンテナは停止して保持し、データ・旧鍵・既存imageを削除していない。M7・外部公開へ進まず停止する。

主担当の実モデルはsession記録で `gpt-6.1-sol / medium` と確認。Highへ変更していない。独立担当1名が差分・失敗原因・修正差分を読み取りレビューし、編集・試験は主担当が実施。[使用量checkpoint](m6-update-2026-10-18/usage-checkpoint.json)は2026-10-18 07:26 JST時点の主担当ターンをresponse IDで重複除外して集計。入力36,509,380 token、その内キャッシュ36,062,592、出力103,273。APIリクエストごとの累積で同じ文脈の再読込を含み、キャッシュは入力の内数。レビュー担当・過去milestone・集計後の呼出と最終応答は含まない。子担当の使用量・料金は未取得。
