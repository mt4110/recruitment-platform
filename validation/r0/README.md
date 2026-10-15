# R0: v0.4の独立した方式確認

製品のAPI/DB/認証/保存処理には接続しない。R1以降の実装ではなく、小さい技術実験と結果の再現用コード。実行成功と設計全体の成立を区別する。

## 対象

- `fixtures/sheets-*.xlsx`: 架空資料をGoogle Sheetsへ取り込み、Sheetsで日付値を確認・補正してからXLSXへ実際に書き出した2点。ライブラリの出力をそのままSheets実出力と呼ばない。Excel実出力の代用でもない。
- `build_sources.mjs`: 取り込み元を作る補助。bundled `@oai/artifact-tool`を使用し、検証用の既存インストールを利用する。元のISO date型がGoogle取り込みで欠落したため、最終版は数値日付と書式を用いる。
- `inventory.py`: ZIP/XML/parts/関数/画像の有界な棚卸し。R1の完全なOOXML/式/AV判定器ではない。未知partを検出した結果は対応未確認として返す。
- `key_probe.cjs`: 実Chromium/IndexedDB/Web Cryptoでprofile再起動、旧鍵取得、復号/current版再暗号化、改ざん・AAD違い・失効・未認証を確認。鍵サービスは検証専用fixtureで、製品OIDC/RLSを証明しない。
- `resource_probe.py`: 子processのCPU/memory/wall制限。OS差異は結果に残す。XLSX parserの資源性能の測定ではない。
- `av_probe.py`: digest固定のClamAV 1.5.4、FreshClam、実DBの初回取得/再確認/ロード、実EICAR、raw INSTREAMの上限、RO/non-root/非公開network、cgroup実測。通常デモの7サービスを変更しない。

## 再現

Nodeは既存e2eの依存を使う。初回は`npm ci --prefix e2e`と対応Chromiumのインストールが必要。出力は新しいGit外directoryを指定し、過去の証拠を上書きしない。

```sh
mkdir -p .local/r0-my-run
node validation/r0/key_probe.cjs .local/r0-my-run/keys
python3 validation/r0/resource_probe.py .local/r0-my-run/resources.json
python3 validation/r0/inventory.py validation/r0/fixtures .local/r0-my-run/xlsx.json
DOCKER_CONTEXT=colima-recruitment-m1 python3 validation/r0/av_probe.py .local/r0-my-run/av
```

AVの公式imageは確認時点でamd64のみ。Apple SiliconでのAV実行はエミュレーションであり、native arm64の証明ではない。native Linux/amd64は手動workflow `R0 isolated feasibility`で確認する。AV署名の初回downloadには外向き通信と最大4GiBを使い、scannerは2GiB/1CPU/pids32/net none。scannerのraw protocol実験用TCPはコンテナ内127.0.0.1限定で、host portを公開しない。製品のHTTP wrapperは実装しない。

検証用containerはfinallyで停止するが、container/DB/volume/profile/ログは保持する。削除コマンドは実行しない。browser profileには試験用sessionがあるためGitやCI artifactへ含めない。AV DBも配布artifactへ含めない。公開するのは架空fixture、probe source、限定した結果JSON/診断だけ。

初回の未成立は`docs/validation/2026-10-15-r0-report.md`、承認された5件の最新判定/範囲変更/工数は`docs/validation/2026-10-15-r0-followup-report.md`を参照する。Sheetsを初期互換範囲として明示した。Excelの実出力は未検証であり、一般のOffice互換を保証しない。

## R0残件の追補

`followup_av.py`は公式Debian版ClamAV1.5.4を各archのmanifest digestへ固定し、Docker daemonのnative archで実行する。image内の実旧定義を保持し、別directoryでFreshClam更新後、旧/新/破損/復旧を確認する。出力directoryは未作成の新しい名前にする。Alpine imageのuid100からDebian版のuid1000へ合わせている。

```sh
python3 validation/r0/sheets_policy_probe.py .local/r0-my-run/sheets-policy.json
DOCKER_CONTEXT=colima-recruitment-m1 python3 validation/r0/followup_av.py .local/r0-new-av-run
```

`followup_av.py`の受付ゲートはモデルで、製品のHTTP認証/DB/業務処理へつながない。busy/更新中/不一致/期限のモデル試験と、実engineの起動/scan/失敗を区別する。新版CLDは独立生成でhashが異なる場合があり、各publish元の全DB hashとロード対象の一致を照合する。Docker内のbash transportを実験で用い、製品のINSTREAM client実装では同じ入出力境界を検証する。

`sheets_policy_probe.py`は空persons metadata限定。ZIP全体/式/画像/namespaceの完全検査器ではない。元の`inventory.py`のv04 compatibilityは改訂2の許可リストの棚卸しを保持し、追補後の総合合格を意味しない。

公式image内の定義をseedにして差分更新する。固定imageの旧定義と上流最新版が同じになった場合は、版更新の実験が成立しないものとして停止し、人工的な公式版を作らない。実験の旧DBを本番の新規受付に使わない。container/DB/profileは停止・保持し、削除しない。
