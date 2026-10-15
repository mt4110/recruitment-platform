# M0の残件確認と完了記録

2026-10-15。macOS/Apple Silicon上のarm64確認に続き、[Linux/amd64実機CI](https://github.com/mt4110/recruitment-platform/actions/runs/38678810711)が成功した。検証対象commitはc9de3bc。[証拠JSON](2026-10-15-m0-amd64-evidence.json)に個別結果を保存した。

| 項目 | Linux/amd64の結果 |
| --- | --- |
| 認証 | 実Keycloak、4アカウント、未登録・state/nonce/PKCE/署名/issuer/audience/期限/redirectの拒否、logoutが成立 |
| RLS/lock | PostgreSQL 17.11、通常ロール、組織分離・共有/失効・接続再利用・双方向のlock順序・timeoutが成立 |
| PDF検査 | 18 fixtureの許可/拒否、CPU・メモリ・wall timeout、非root/read-only/外向き通信なしが成立 |
| PDF生成 | Chromium 151.0.7922.34、Namespace/PID/Network/Seccomp-BPF有効、3例すべて日本語1ページ |

ホストLinux x86_64、Docker 28.0.4 amd64。検証プロセスの経過164.4秒、CIジョブ3分36秒。人の開発工数ではない。arm64での目視確認は[先行記録](2026-10-15-m0-report.md)を参照。amd64のPDFはページ数・文字抽出・DOM配置を確認し、この記録時点では目視未実施。

## 解消した実行上の残件

- 読み取り専用rootを維持し、検証結果の出力先だけ32MiBのtmpfs（UID/GID 1001）を追加。
- Docker cpがtmpfsの出力を回収できなかったため、実行中コンテナから固定の5ファイルだけをtarで読み出し、通常ファイル/容量を確認して回収。任意パスの展開は行わない。
- 失敗したCI 38677882003、38678420748は成功扱いにせず保存。認証/RLSの部分結果と、最終的な4項目成功を区別する。

M0の対象2環境で方式の成立を確認した。製品の認証実装、SQLx pool、全migration、PDF serviceのHTTP統合や悪性入力の包括的安全性を確認した結果ではない。主要依存のライセンス確認範囲は先行記録のとおりで、製品依存・配布物の監査は実装段階に残る。

## 次の段階と工数

今回の承認範囲に従いM1（7サービスの起動・認証・固定所属・DB session/CSRF・架空fixture）へ進める。M2には進まず、M1の結果を報告する。

全体80〜140時間の仮積算は据え置く。M0後のM1〜M7は76〜132時間、M1の計画枠は12〜20時間。CIの実行待ちを人の開発工数へ換算せず、上限保証や予算延長には読み替えない。
