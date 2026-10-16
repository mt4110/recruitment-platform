# S4：既存書類の暗号化移行・ローカル復旧

対象はこのプロトタイプの既存PDF／XLSXと、推薦で既に選択された共有参照。閲覧画面の装飾・レイアウト再現、自動転記、汎用バックアップ製品、クラウド公開、S5は含めない。架空データだけを使う。

## 不変条件

- `documents`、`document_versions`、`application_documents`、`application_snapshots`、既存受付結果は変更しない。共有参照を最新版へ置き換えない。
- `document_migrations`に既存IDと新しい暗号blobの対応を追加する。元ファイルは上書き・削除しない。既存共有snapshotのhash・形式・サイズ等が原本と一致しなければ移行を拒否する。`encrypted_transport=false`は元の受付経路を示し、移行状況は対応表と`safe_view_keys`で判定する。
- 移行コピーにも実AV・形式検査・隔離変換を通す。閲覧は既存S3経路のみ。未移行・検査不能・鍵失効は利用不可。旧原本／請求PDFルートは410を維持する。
- 企業は現在有効な`application_documents`の選択参照からのみ閲覧する。他組織・選択していない版・共有失効後の閲覧を拒否する。

## 移行

`RP_INSTANCE`で初期化済みの対象環境を明示する。通常のデモへ自動実行しない。

```sh
python3 scripts/document_migrate.py inventory
python3 scripts/document_snapshot.py backup
python3 scripts/document_migrate.py apply --backup /absolute/path/to/backups/UUID --document DOCUMENT_UUID
python3 scripts/document_job.py --no-build
```

1. バックアップで受付・処理サービスを停止し、DB・原本・暗号blob・全世代の鍵・AV定義を同一停止区間で保存。完了時は復号認証とhashを再確認してサービスを再開する。
2. 移行前にバックアップの認証と対象原本のサイズ・SHA-256を照合する。既存ready文書と有効な所有者だけを対象にする。未完了・拒否済み・アーカイブ済みは自動的に正常扱いしない。
3. 新しいDEK／nonce、RSA-OAEP SHA-256、AES-256-GCMを用いる。AADは`rp-migration-v1|鍵版|移行ID|原本ID|組織ID|形式`。ブラウザticketのscopeを流用しない。
4. 1GiBの既存物理容量台帳へ暗号コピーを追加計上してからvolumeへ書く。元の平文も引き続き容量に数える。コピーはcreate-newとfsync。再実行では同じ暗号文の一致を要求する。
5. 隔離ワーカーはS2／S3と同じ120秒lease、5試行上限、鍵失効・現所有者の再確認を行う。成功後だけ移行対応をreadyにする。
6. 転送中のreserved対応が残る場合はバックアップを拒否し、同じ移行の転送完了後に再実行する。ワーカー失敗はretryableとして再実行できる。検査拒否は自動再試行しない。旧原本へfallbackしない。

## 切替

```sh
python3 scripts/document_migrate.py cutover
# 未移行・不成立文書を利用不可のまま残すと明示判断した場合だけ：
python3 scripts/document_migrate.py cutover --quarantine-unmigrated
```

旧multipart受付を停止・drainしてから確認する。通常の切替は未移行ready文書があれば拒否する。明示的な隔離指定ではそれらを削除せず利用不可にしたまま、新規受付を暗号化経路だけにする。既存の処理中leaseが生きている場合は切り替えない。旧retry／recheckで平文受付経路を再開しない。

## 最小の復旧範囲

```sh
python3 scripts/document_snapshot.py verify --backup /absolute/path/to/backups/UUID
python3 scripts/document_snapshot.py restore --backup /absolute/path/to/backups/UUID --target e2e-recovery-UNIQUE
```

- 対象はこのローカルCompose構成だけ。アプリDB・IdP DBの論理dump、書類volume、AV定義volume、private設定・旧鍵を保存する。Dockerイメージそのものやホスト全体はバックアップしない。保存した実イメージIDがローカルに存在する場合だけ復旧し、別版へ差し替えない。
- エントリごとにAES-256-GCMで暗号化し、バックアップIDとエントリIDをAADへ束縛する。manifestも暗号化する。鍵は暗号文ディレクトリの外の`backup-keys/UUID.key`へ0600で保存する。移送する場合は鍵と暗号文を別管理する。この同一ホスト保存だけを災害対策完了とは呼ばない。
- 1ファイル512MiB未満、合計1.5GiB、2万ファイルまで。途中失敗の残骸は削除しない。`COMPLETE`と全エントリのAEAD認証・hashがそろわないものは復旧に使わない。
- 復号認証が終わる前にSQL・原本を利用しない。汎用tar展開はせず、許可した種別・相対パスだけを空の復旧先へcreate-newで書く。
- 復旧先は未作成の`e2e-*`環境に限定。同じポート・OIDC issuerを維持するため元環境を停止してから起動する。復旧先の既存Docker資源も拒否する。元のDB・volume・鍵は残し、既存環境への上書き復旧は提供しない。
- `setup`／`migrate`で失った鍵を作り直さず、保存した鍵・registry・失効状態を戻す。旧鍵を保持していても失効状態なら閲覧は拒否する。AV鮮度・ロード版不一致もS3どおり拒否する。
- ロールバックでも旧原本配信は開かない。切替前DBを復旧すると旧multipart受付の状態も戻るため、外部受付を開く前に再度cutoverを実施する。原本／backup／一時ファイルの削除は別承認。

## 受入

Playwrightの`z-s4.spec.cjs`で、移行前の不可視、PDF／Sheets実出力XLSXの移行、選択版・snapshot・受付結果の一致、中断後再実行、鍵欠落・失効、他組織／非選択版／共有失効の拒否、旧受付閉鎖、改ざんbackup拒否、別環境復旧後の閲覧を確認する。既存業務フローの回帰は全体CIで確認する。試験結果はS4完了記録を参照する。
