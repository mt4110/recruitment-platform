# 依存物のライセンスと確認範囲

2026-10-18更新。各導入段階の履歴を含み、最新の監査結果は末尾の再監査節を参照。プロジェクト本体はApache-2.0。第三者の権利・ライセンスはそれぞれに従う。依存を改変して再配布する場合は、対象のLICENSE/NOTICE/source提供条件を再確認する。

| 主な製品依存 | 固定版 | 表記 |
| --- | --- | --- |
| Next.js / React / React DOM | 16.4.1 / 19.3.1 / 19.3.1 | MIT |
| Axum / Tokio / openidconnect | 0.8.9 / 1.53.3 / 4.0.1 | MIT |
| SQLx | 0.9.0 | MIT OR Apache-2.0 |
| AES-GCM / SHA-2 / HMAC / rand | 0.11.1 / 0.11.1 / 0.13.0 / 0.10.3 | Apache-2.0 OR MIT |
| PostgreSQL / Keycloak / nginx | 17.11 / 26.8.1 / 1.30.1 | PostgreSQL License / Apache-2.0 / BSD-2-Clause |
| Python（内部PDF service） | 3.13系 | PSF License |

RustはCargo.toml/Cargo.lock、Webはpackage.json/package-lock.json、基底イメージはDockerfile/Composeのdigestで固定する。上記は公式crate/npm metadataおよび各プロジェクトのLICENSEによる主要依存の一覧。全推移依存・OS packageのライセンス適合と製品イメージの脆弱性監査を完了した表ではない。

M0専用のpikepdf(MPL-2.0)、libqpdf(Apache-2.0)、Playwright(Apache-2.0)、Notoフォント(SIL OFL 1.1)等は[技術確認記録](docs/validation/2026-10-15-m0-report.md)を参照。M3の製品PDF serviceはpikepdf 10.17.0（MPL-2.0）と同梱libqpdf（Apache-2.0）を含む。pikepdfのソースを改変していない。再配布時にwheel内のLICENSEを保持し、対応ソースは[固定版の公開ソース](https://github.com/pikepdf/pikepdf/tree/v10.17.0)から取得できる。M5で同じ固定版Playwright 1.62.1（Apache-2.0）と公式v1.62.1-noble image/digest、Chromium・Noto CJKフォント（SIL OFL 1.1）・PopplerのPDF検証を製品serviceへ組み込んだ。npm依存はM0のintegrity付きlockを再利用し、Python wheelのhash固定も維持する。各OSパッケージのライセンス/著作権文書をimage内に保持する。ベースOS、Chromiumとnative依存全体の脆弱性監査完了とは扱わず、残る配布物監査はM6へ残す。

## セキュリティ確認

Webのlockfile生成時にnpm auditは0件。RustSecのcargo auditでは、openidconnectからのrsa 0.9.10に[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)が1件あり、ignoreしていない。この指摘はRSA秘密鍵処理の時間差による漏えいに関するもの。APIのOIDC経路は公開鍵によるRS256署名検証のみで、RSA秘密鍵を生成/保管/署名/復号しない。IdPの署名は別サービスのKeycloakが担当する。

この経路の評価を脆弱性0件とは表現しない。RSA秘密鍵処理の追加は禁止し、依存更新時と配布前に再確認する。OS/imageを含む配布物全体の監査はM6/M7に残る。

一次資料: [Next.js](https://github.com/vercel/next.js/blob/v16.4.1/license.md)、[React](https://github.com/facebook/react/blob/v19.3.1/LICENSE)、[Axum](https://docs.rs/crate/axum/0.8.9)、[SQLx](https://docs.rs/crate/sqlx/0.9.0)、[openidconnect](https://docs.rs/crate/openidconnect/4.0.1)、[PostgreSQL](https://www.postgresql.org/about/licence/)、[Keycloak](https://github.com/keycloak/keycloak/blob/26.8.1/LICENSE.txt)、[nginx](https://nginx.org/LICENSE)、[Python](https://docs.python.org/3.13/license.html)。

開発用TypeScript 5.9.3はApache-2.0、@types/node 24.10.1・@types/react 19.2.2・@types/react-dom 19.2.2はMIT。npmの各固定版metadataで確認した。

M1のテスト専用依存は@playwright/test 1.62.1（Playwright/coreを含みApache-2.0）。e2e/package-lock.jsonで固定し、認証のtrace/動画/storageStateは収集しない。

M3でAxumのmultipart featureを有効化し、multer 3.1.0（MIT）、encoding_rs 0.8.35（(Apache-2.0 OR MIT) AND BSD-3-Clause）をCargo.lockへ追加した。multipartを独自parserで実装しないための依存で、既存Axumの標準extractorを使う。

PDFのPython依存はservices/pdf-renderer/requirements.txtで固定し、PyPI公開wheelのSHA-256を検証して導入する。pikepdf 10.17.0（MPL-2.0）、Pillow 12.3.0（MIT-CMU）、lxml 6.1.3（BSD-3-Clause）、packaging 26.3（Apache-2.0 OR BSD-2-Clause）。[pikepdf](https://pypi.org/project/pikepdf/10.17.0/)、[Pillow](https://pypi.org/project/pillow/12.3.0/)、[lxml](https://pypi.org/project/lxml/6.1.3/)、[packaging](https://pypi.org/project/packaging/26.3/)の固定版metadataでライセンスと必要依存を確認した。wheel同梱の第三者ライブラリにも各ライセンスがある。Pythonパッケージ4件を2026-10-15のOSV queryで照合し既知指摘0件、RustSecは既知1件を維持。これをOS/imageや同梱native library全体の監査とは扱わない。

multipart仕様は[Axum 0.8.9の実装](https://github.com/tokio-rs/axum/blob/axum-v0.8.9/axum/src/extract/multipart.rs)、PDF APIは[pikepdf 10.17.0の一次資料](https://pikepdf.readthedocs.io/en/stable/api/main.html)を確認した。

M4は既存SQLx 0.9.0のjson featureを有効化し、既存serde_jsonでPostgreSQL JSONをdecodeする。Cargo.lockのpackage/versionは変更していない。RustSecの既知1件を引き続き記録し、新しい本体依存を追加していない。

R2では公式ClamAV 1.5.4 Debian 13 slimをmultiarch index digest `sha256:9a96980b265cb2b51a20bdcca921dc80aa55ed0e56cdfb076198ee27a9171927`で固定し、clamd/FreshClam/sigtoolのライセンス・著作権表示を保持する。ClamAVはGPL-2.0、署名DBは別の利用条件に従う。Python wrapperは標準ライブラリのみで、Debianのpython3 security packageをaptで導入する。OS packageの版は実行証拠へ記録するが、apt repositoryのsnapshot固定や配布image全体の脆弱性監査を完了した意味ではない。独自imageを配布する際の対応ソース提供・再配布条件の確認はM7に残る。[ClamAV配布ソース](https://github.com/Cisco-Talos/clamav/tree/clamav-1.5.4)、[ClamAV署名管理](https://docs.clamav.net/manual/Usage/SignatureManagement.html)。

## M6の更新・機械監査（2026-10-16）

製品Nodeを24.22.0、nginxを1.30.6へ更新しdigest固定。PostgreSQL17.11、ClamAV1.5.4、Python/wheel固定版は維持し、独自imageのOSに取得可能な更新を適用する。apt repositoryのsnapshotは固定せず、実image ID/package版を証拠へ保存する。

PDF製品workerはPlaywright1.64.1（Apache-2.0）と公式v1.64.1-noble digestへ更新。実runtimeはChrome for Testing156.0.8078.4で、Chromium151だったM0/M5と区別する。`ABOUT`とsandbox付き`chrome://terms`表示を実imageで確認し、[観測metadata](docs/validation/m6-2026-10-16/browser-terms.json)を保存した。[Playwright release notes](https://playwright.dev/docs/release-notes)と[Googleの実行バイナリ用追加規約](https://www.google.com/chrome/terms/)も参照。ブラウザ全体をPlaywrightと同じApache-2.0とは表記しない。Noto/Poppler/各OSのcopyright/license文書を保持し、独自imageの一般再配布条件の最終確認はM7に残す。製品imageの公開は行っていない。

[M6記録](docs/validation/2026-10-16-m6-report.md)とpackage/license inventoryを参照。Trivy0.76.0・同日更新DBで独立7image（9サービス）を検査し、Web/E2E/PDFのnpm lockは既知指摘0、RustSecは従前1件、OS/同梱ツールには指摘が残った。arm64 534/amd64 535 packageのlicenseが未知または未取得であり、全配布物の適合・脆弱性0件を確認した一覧ではない。修正版ありの同梱CLI/PythonやGo補助ツール、未修正のOSライブラリは監査残件へ明記し、ignoreしていない。

## S2のサービス分離（2026-10-16）

broker／relayは既存のdigest固定Node24.22.0 imageとNode/OpenSSL標準cryptoだけを利用し、npm依存を追加しない。sandbox／旧形式検査／請求生成は既存の固定Python inspector・Playwright1.64.1 imageを再利用する。書類用秘密鍵をsandboxへ渡さず、請求サービスの認証鍵も独立させる。Rustのrsa秘密操作禁止は維持する。サービス分離をOS／image全体の監査合格とは扱わず、M6の保留を維持する。[S2記録](docs/validation/2026-10-16-s2-report.md)。

## R6の再棚卸し（2026-10-17）

常設11サービスとbroker／relay／sandboxの14役割を実image IDで対応づけ、同一IDだけを重複除外して再scanした。[R6記録](docs/validation/2026-10-17-r6-report.md)の全severity・修正有無・license未知数は期限切れDBによる参考値とし、最新DBでの再監査を要する。Linux全186件とローカル段階別検証の成功は監査／再配布適合を意味しない。M6の依存／OS指摘とM7の対応ソース提供・Chrome for Testing等の一般配布条件は未完了のまま維持する。今回、依存lockfileとimage baseのversion指定は変更していない。

## M6再監査（2026-10-18）

[期限内DBの再監査記録](docs/validation/2026-10-18-m6-reaudit-report.md)を追加。保持したarm64の14役割／8実imageを照合し、Trivy／Java DBとも期限内でfindings/exit1。M6受入は保留。未知／未取得licenseは538のpackage記録で、idp 413・renderer 95が大半を占める。package重複の整理とPOM／LICENSE／OS copyrightへの一次照合、一般配布条件の確認は残る。scannerの未知記録を違反確定や許諾済みと扱わない。RustSecの未修正1件も維持。inspectorのExpat 2.8.5は手動の実version確認で補足し、OS package scan合計へ加算していない。今回、製品コード／lock／digestを変更せず、amd64の再監査・新しいE2E／CI・M7・公開は実施していない。

## M6の限定更新バッチ（2026-10-18、検証中）

同じ基底OS系列・製品版を維持し、取得可能なOS更新を適用する。公式基底imageのdigestは照合したが変更されていない。Webと書類用Node workerは公式Node 24.22.0の実行バイナリとLICENSEだけを同じDebian bookworm runtimeへコピーし、不要なnpm CLIを含めない。NodeのLICENSEは `/usr/local/share/doc/node/LICENSE` に保持する。

PDF inspectorは公式CPython 3.13.16とExpat 2.9.0の無改変ソースをSHA-256固定でbuildし、共有Expatへリンクする。CPythonのLICENSEとExpatのCOPYINGを `/usr/local/share/doc/python/`・`/usr/local/share/doc/expat/` に保持する。CPythonはPSF License、ExpatはMIT。pipは検証済みCPythonソース内wheelからbuild時だけ実行し、runtimeにpip／ensurepipを導入しない。既存4件のhash固定wheelとそのライセンスは維持する。Playwright基底imageのnpm CLI同梱依存は別途監査対象に残す。

PostgreSQL補助ツールgosu 1.19（Apache-2.0）はhash固定の公式ソースを公式Go 1.27.2で再buildする。gosuのLICENSEは `/usr/local/share/doc/gosu/LICENSE` に保持する。製品PostgreSQL 17.11とentrypointは維持し、Go compilerはruntimeに含めない。ソースURL・hash・build条件は各Dockerfileに記録する。一般再配布時の対応ソース提供等の確認は引き続きM7に残る。

一次資料: [CPython 3.13.16](https://www.python.org/downloads/release/python-31316/)、[Expat 2.9.0](https://github.com/libexpat/libexpat/releases/tag/R_2_9_0)、[gosu 1.19 source](https://github.com/tianon/gosu/tree/1.19)。実runtimeの版・リンク先・不要なCLI不在をE2Eのruntime inventoryで検査し、脆弱性監査の合格とは区別する。
