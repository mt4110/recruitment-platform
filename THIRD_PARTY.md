# 依存物のライセンスと確認範囲

2026-10-15。プロジェクト本体はApache-2.0。第三者の権利・ライセンスはそれぞれに従う。依存を改変して再配布する場合は、対象のLICENSE/NOTICE/source提供条件を再確認する。

| 主な製品依存 | 固定版 | 表記 |
| --- | --- | --- |
| Next.js / React / React DOM | 16.4.1 / 19.3.1 / 19.3.1 | MIT |
| Axum / Tokio / openidconnect | 0.8.9 / 1.53.3 / 4.0.1 | MIT |
| SQLx | 0.9.0 | MIT OR Apache-2.0 |
| AES-GCM / SHA-2 / HMAC / rand | 0.11.1 / 0.11.1 / 0.13.0 / 0.10.3 | Apache-2.0 OR MIT |
| PostgreSQL / Keycloak / nginx | 17.11 / 26.8.1 / 1.30.1 | PostgreSQL License / Apache-2.0 / BSD-2-Clause |
| Python（M1の内部health service） | 3.13系 | PSF License |

RustはCargo.toml/Cargo.lock、Webはpackage.json/package-lock.json、基底イメージはDockerfile/Composeのdigestで固定する。上記は公式crate/npm metadataおよび各プロジェクトのLICENSEによる主要依存の一覧。全推移依存・OS packageのライセンス適合と製品イメージの脆弱性監査を完了した表ではない。

M0専用のpikepdf(MPL-2.0)、libqpdf(Apache-2.0)、Playwright(Apache-2.0)、Notoフォント(SIL OFL 1.1)等は[技術確認記録](docs/validation/2026-10-15-m0-report.md)を参照。M1の製品PDF serviceはhealthのみで、これらのPDF依存/フォントを含まない。M3/M5で組み込む際に配布条件を確認する。

## セキュリティ確認

Webのlockfile生成時にnpm auditは0件。RustSecのcargo auditでは、openidconnectからのrsa 0.9.10に[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)が1件あり、ignoreしていない。この指摘はRSA秘密鍵処理の時間差による漏えいに関するもの。APIのOIDC経路は公開鍵によるRS256署名検証のみで、RSA秘密鍵を生成/保管/署名/復号しない。IdPの署名は別サービスのKeycloakが担当する。

この経路の評価を脆弱性0件とは表現しない。RSA秘密鍵処理の追加は禁止し、依存更新時と配布前に再確認する。OS/imageを含む配布物全体の監査はM6/M7に残る。

一次資料: [Next.js](https://github.com/vercel/next.js/blob/v16.4.1/license.md)、[React](https://github.com/facebook/react/blob/v19.3.1/LICENSE)、[Axum](https://docs.rs/crate/axum/0.8.9)、[SQLx](https://docs.rs/crate/sqlx/0.9.0)、[openidconnect](https://docs.rs/crate/openidconnect/4.0.1)、[PostgreSQL](https://www.postgresql.org/about/licence/)、[Keycloak](https://github.com/keycloak/keycloak/blob/26.8.1/LICENSE.txt)、[nginx](https://nginx.org/LICENSE)、[Python](https://docs.python.org/3.13/license.html)。

開発用TypeScript 5.9.3はApache-2.0、@types/node 24.10.1・@types/react 19.2.2・@types/react-dom 19.2.2はMIT。npmの各固定版metadataで確認した。
