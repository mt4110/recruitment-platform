# M6再監査：期限内DBでの結果・修正計画

2026-10-18（JST）。**DB期限切れによる停止は解消し、再監査は`findings / exit 1`で完走した。M6は引き続き受入保留。修正実装・M7・公開は行っていない。**

## 1. 今回確認した範囲

- 手元に保持したR6のローカルarm64実イメージを再監査。常設11＋broker／relay／sandboxの14役割を実image IDで照合し、同じIDだけを除いた8イメージが対象。
- 実行対象コードは`6476ad96f1954983db10bfc12b1a1edec0de8b0b`。直前記録`c0c1bca`の作業ツリーと135ファイルのhashが一致し、イメージの再buildや依存更新を混ぜていない。
- 入力の`run.json`は前日のS5／S4対象22件の実行記録を複写したもの。今回は新しいE2Eを実行していない。R6のLinux両環境各186件成功は[前日の記録](2026-10-17-r6-report.md)の履歴である。
- Linux/amd64の旧CIイメージは今回の再監査対象に含めていない。修正後の両arch再build・E2E・監査は下記の見積もりに含める。過去CIの`failure`を今回のローカル結果で成功へ変更しない。
- 既存のrun／公開証拠は維持し、前回のprivate scanner出力13ファイルも別ディレクトリへ保全。秘密値・生ログを含めず、[抽出結果](m6-reaudit-2026-10-18/arm64/export-status.json)は20ファイル・保留0で成功した。

[対象照合と集計](m6-reaudit-2026-10-18/arm64/comparison.json)、[監査summary](m6-reaudit-2026-10-18/arm64/audit/summary.json)、[保全・実行由来](m6-reaudit-2026-10-18/arm64/provenance.json)を参照。

[最終照合](m6-reaudit-2026-10-18/arm64/verification.json)でDB期限、135ソースhash、共有JSONの既知秘密値・認証形式、文書リンク、過去private出力の保全、確認用コンテナ停止、通常デモ7サービスのhealthyとHTTP 200を確認した。検出指摘を承認した記録ではない。

## 2. DBの鮮度

Trivy 0.76.0、cargo-audit 0.22.1を継続利用。新規キャッシュへGHCR公式脆弱性DBを実ダウンロードし、監査完了時も両DBの`NextUpdate`が現在より先であることを確認した。時計・期限条件・拒否条件は変更していない。

| DB | UpdatedAt（JST、分まで） | NextUpdate（JST、分まで） | 結果 |
| --- | --- | --- | --- |
| VulnerabilityDB | 2026-10-18 03:34 | 2026-10-19 03:34 | 期限内 |
| JavaDB | 2026-10-17 10:07 | 2026-10-20 10:07 | 期限内 |

確認は2026-10-18 04時台JST。正確なUTC時刻は[取得直後](m6-reaudit-2026-10-18/arm64/database-preflight.json)と監査summaryへ保存。JavaDBは同じ新規キャッシュへ監査中に取得した。これは監査用DBであり、書類AVのClamAV定義とは別物。[Trivy公式DB管理](https://trivy.dev/docs/latest/configuration/db/)も参照。

## 3. 機械監査の結果

| 代表イメージ | Critical | High | 修正版ありHigh/Critical | license未知／未取得のpackage記録 |
| --- | ---: | ---: | ---: | ---: |
| gateway | 0 | 1 | 1 | 0 |
| web | 1 | 60 | 3 | 5 |
| api | 1 | 69 | 0 | 3 |
| db（idp-dbも同一） | 4 | 95 | 25 | 9 |
| idp | 0 | 0 | 0 | 413 |
| pdf-renderer（invoice-renderer／sandboxも同一） | 0 | 10 | 7 | 95 |
| artifact-viewer（broker／relayも同一） | 4 | 64 | 10 | 4 |
| scan（updaterも同一） | 1 | 79 | 5 | 9 |
| 合計（image ID重複除外） | 11 | 378 | 51 | 538 |

合計はpackage／advisoryの検出数であり、固有CVE数、独立した攻撃経路数、悪用可能と実証した件数ではない。Medium 1,242、Low 737、Unknown 9も省かず各`audit/*.json`へ保持。licenseの538件もソフトウェアの固有数ではなく、未知／未取得のpackage記録数である。

Web／E2E／PDFのnpmロック3件は指摘0。RustSecは`rsa 0.9.10 / RUSTSEC-2023-0071`が1件。作業ツリーのTrivy secret scanは0件で、生の一致内容は共有していない。全履歴や侵入試験を実施した意味ではない。除外リスト・ignore・severityの足切りは追加していない。

### 前回からの主な変化

- gatewayに`libexpat 2.8.5-r0`のHigh 1件とMedium 1件が追加。修正版は`2.9.0-r0`。nginx本体の指摘と混同しない。
- scanの`libexpat1`は従来の指摘に対して修正版`2.9.0-1~deb13u1`が判明し、修正版ありHighが0→5件となった。
- idpのOpenJDKにMedium 1件が追加。DB同梱Go等にはseverity／修正版情報の変更もある。
- 修正版ありHigh/Criticalは前回45→今回51件。イメージを変更した差ではなく、同じイメージに対するDB更新の差である。[追加・変更・消滅の全差分](m6-reaudit-2026-10-18/arm64/delta.json)を保持した。

## 4. 必要な修正と判断事項

| 優先する対象 | 確認できた事実 | 次の修正・確認案（未実装） |
| --- | --- | --- |
| Python inspectorのExpat | ネットワークなし・read-onlyで既存イメージを起動して`pyexpat.EXPAT_VERSION=expat_2.8.5`を実測。OS packageの指摘表には現れない。 | PDF/XLSX検査・sandboxで実際に使うExpatを修正版へ更新し、実versionと対応する受入下限を更新する。現在の`>=2.7.2`だけでは新しい指摘への対処確認にならない。現在のapt更新工程後も2.8.5なので、inspectorからコピーするPython環境を含めて確認する。 |
| gateway／scanのExpat | 上記の修正版がDBで確認できた。Debian trixieとAlpine 3.24にも修正版情報がある。 | 同じサポート系列の基底digest／security package更新を優先。実version、AV初期化・更新・ロード版、XLSX拒否条件を再確認する。 |
| Node同梱CLI／viewerのOS package | web／viewer／rendererにnpm同梱brace-expansion・undici、viewerにperl-baseの修正版あり指摘が残る。broker／relayのDockerfileにはapt更新工程がない。 | 新しい基底と利用可能な更新を確認してdigest固定。残る未使用CLIは、実行経路を確認してruntimeへ持ち込まない構成を検討する。global npmの更新だけで全runtimeが直ったとは扱わない。 |
| rendererのPython補助依存 | msgpack／setuptools／urllib3等に修正版あり指摘。製品用Pythonとブラウザimageのsystem Pythonが混在する。 | どのPython環境・依存経路かを特定して更新または未使用部分をruntimeから除外。pikepdf等の固定wheel・hash検証・Chromium互換を維持する。 |
| DB同梱Goバイナリ | 指摘pathはgosu。実測で`gosu 1.19 / go1.24.6`。修正版ありHigh/Critical 25件。 | PostgreSQLのmajor更新ではなく、同梱gosu／公式基底の更新をまず確認。OSのapt更新だけではGoを静的に含むバイナリの更新を確認したことにならない。DB起動ユーザー切替と既存backup復旧を回帰する。 |
| 未修正OS指摘 | scan／dbのlibxml2、dbのSQLite等に未修正・保留の指摘が残る。libxml2のCVE-2026-6653はDebianでも保留／no-dsa扱い。 | バイナリ・入力経路・ベンダー判断を個別に照合。別ディストリビューションのlibraryだけを混ぜない。サポートされる基底変更や独自patchが必要なら、標準枠と分けて再判断する。隔離だけで修正済みとは扱わない。 |
| zlibの判定差 | CVE-2023-45853をTrivyは検出する一方、Debianは該当系列でMiniZipをビルドしない旨を注記している。 | 実バイナリと別途同梱MiniZipの有無を照合し、根拠付きの個別評価を残す。今回、誤検知確定・例外承認・自動ignoreはしていない。 |
| RustSec | openidconnect→rsaの依存経路を確認。APIのOIDCは公開鍵のRS256検証で、書類のRSA秘密操作は別Node/OpenSSL経路。 | Rustでの秘密操作を増やさない条件を維持し、依存の到達性評価を記録。公式にはpatched versionなしのため、単純なversion更新で解消できるとは見積もらない。依存除去／方式変更は別途判断する。 |
| license情報 | 538記録のうち413はidp、95はrenderer。 | package／version／由来で整理し、upstream POM・LICENSE・OS copyrightへ照合。Keycloak本体のApache表記を全jarへ一括適用しない。未知のまま許諾済みとは扱わず、一般配布条件の最終確認はM7へ残す。 |

[実測version](m6-reaudit-2026-10-18/arm64/runtime-versions.json)ではlxml同梱libxmlは2.14.6、qpdfは12.4.2、Node/OpenSSLは24.22.0／3.5.8だった。[scannerの対象pathとraw hash](m6-reaudit-2026-10-18/arm64/component-mapping.json)にも対応づけた。AVのOS libxmlとlxml同梱libxmlを同一視しない。手動で見つけたinspectorのExpatは機械監査合計に加算していない。影響するversionの存在を確認したもので、当該API経由の悪用を実証したものではない。今回のread-only確認コンテナ3点は終了済みで、削除せず保持する。

一次資料：[Expat修正のDebian情報](https://security-tracker.debian.org/tracker/CVE-2026-77214)、[Alpine情報](https://security.alpinelinux.org/vuln/CVE-2026-77214)、[Debian libxml2](https://security-tracker.debian.org/tracker/CVE-2026-6653)、[Debian zlib／MiniZip注記](https://security-tracker.debian.org/tracker/CVE-2023-45853)、[RustSecの未修正情報](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)。上記の利用経路に関する判断は、この一次資料とリポジトリ／実イメージの確認を合わせた評価であり、スキャナーの合格や例外承認とは別である。

## 5. 追加工数の仮積算

既存の暗号化・隔離・E2Eを再利用し、新機能や画面調整を含めない場合の提案。人の実工数、runner時間、予算残高ではない。下記の時間を使えば監査が無条件にgreenになるという意味でもない。

| 作業 | 追加計画幅 | 完了の確認方法 |
| --- | ---: | --- |
| Expat・基底・同梱CLI／Python／gosuの更新 | 6〜12時間 | 固定version／digestと実測version、対象の修正版あり指摘を再照合。inspectorのExpatも個別確認 |
| 未修正OS・zlib・RSAの個別到達性評価 | 4〜8時間 | 入力／バイナリ／権限／upstream根拠と、解消・未解消・追加判断を記録。ignoreで通さない |
| license一次照合・残件整理 | 3〜6時間 | package重複整理と一次資料への対応づけ、未確認一覧。法的な全件適合保証は含まない |
| 修正後の両arch build・E2E・監査・記録 | 4〜8時間 | 期限内DB、修正対象version、全体業務・AV・鍵／復旧の回帰、実image IDとの一致 |
| 標準対応の合計 | **17〜34時間** | 利用可能な公式更新と既存方式を使える場合 |

**次の実装を選ぶ場合は、まず更新作業の6〜12時間を1バッチとし、再監査結果で残りを見直す進め方を推奨する。今回その実装には着手していない。**

未修正libxml等のためにサポート基底の変更・独自build／patchを選ぶ場合は、別枠で**追加12〜24時間の仮説**。採る方式と対象範囲の確定が必要で、上流修正待ちの日数は工数へ換算しない。RSAの認証ライブラリ置換や全面的なruntime再編はこの幅に含めない。必要なら別途設計・見積もりを行う。

M7の既存6〜12時間を含む残計画は、標準経路で**23〜46時間**。上記の基底変更等も選ぶ場合は**35〜70時間**。AV新世代でready書類を再処理する任意導線2〜4時間、先方限定公開のTLS／OIDC／IP制限、外部専門家の確認は別枠。未解決のvendor指摘・license条件が残ればM6／配布判断は保留を維持する。

## 6. 停止状態

今回は監査の再実行・実versionの読取・修正計画の整理・文書更新まで。製品コード、依存lock、基底digest、認可・検査条件は変更していない。E2E／CIの再実行も行っていない。通常デモの更新・再起動・データ削除は行わず、M7・公開へ進まず停止する。

gpt-6.1-sol／medium。Highへの変更・補助担当への委譲なし。既存の未修正・期限切れの証拠を上書きして成功に変えず、新しい監査結果を追加した。

## 後続更新

この記録は更新前の再監査時点の履歴。後続の明示承認による実装・修正後検証・残工数は[M6限定更新記録](2026-10-18-m6-update-report.md)を正本とする。51件・Expat 2.8.5・標準対応17〜34時間は更新前の値として保持する。
