# M6回帰：M1〜M5・R1〜R4のブラウザE2E

対象はM1の認証基盤とM2の求人・保存・候補者。実Keycloakの4アカウント、固定所属、session/CSRF、求人の公開/終了、候補者の更新/アーカイブ、組織間のID差替え・通常runtimeロールのRLS拒否、冪等性・version競合・job lock待ち上限、画面の入力保持を確認する。M3のPDF登録・隔離検査・lease復旧・配信も確認する。M4の推薦・選考・snapshot・共有失効も確認する。M5の通知モック・採用後の固定1ページ請求PDFも対象。R2の実AV、R3の書類版管理/受付復帰、R4の本人用サーバー下書きも含む。R5の端末永続保存は対象外。

## 実行

DockerとCompose、Python 3.11以上、Node 20以上が必要。初回は次を実行する。

```sh
npm ci --prefix e2e
npx --prefix e2e playwright install chromium --only-shell
python3 scripts/e2e.py
```

LinuxでブラウザのOS依存がない場合は、installに`--with-deps`を付ける。ローカルのDocker環境を選ぶ場合は、runner実行時に`DOCKER_CONTEXT=colima-recruitment-m1`等を指定する。Buildxがない環境では`DOCKER_BUILDKIT=0`を併用できる。

通常デモの3000/18080とは別の3001/18082を使う。空いていなければ既存サービスを変更せず停止する。変更例：

```sh
python3 scripts/e2e.py --app-port 3002 --idp-port 18083
```

runnerは毎回新しい`.local/e2e-...`とCompose projectを作る。資格情報・realm・DB・volumeはそのrunだけのもの。直接の`npm test`はrunnerが作るtest markerなしでは開始できない。DBで無効化/期限変更を行うhelperも、e2e instanceでのみ実行する。

テストは1 worker、retryなし。rate limitの設定値は緩めず、429では6秒待って再開する。実経過8時間/5分の試験は行わず、対象テスト行の期限を過去へ変えて失効判定を確認する。DB変更は専用テスト環境内でのみ行う。IdPを含む正常系はモックではない。通信障害と応答競合のテストだけPlaywright route制御を使用する。

## 結果と秘密値

結果は`.local/e2e-.../artifacts/summary.json`と`run.json`、確認画面のPNGに残る。失敗時の詳細は秘密値・URLを伏せて記録する。trace、動画、storageState、通信dump、失敗時の自動スクリーンショットは保存しない。ログイン入力画面のPNGも保存しない。

build/startの詳細は同runの私有`operations.log`に残る。外部共有しない。GitHub Actionsはartifacts配下のJSON/PNGと固定のデモ請求PDFだけを回収し、env・realm・credentials・build logをアップロードしない。

終了時は成功/失敗にかかわらず、作成したrunのサービスだけstopする。container、volume、設定、以前の証拠を削除しない。片付けは対象を確認した別操作とする。

手動workflowは`M6 regression and image audit`。Rust format/Clippy/単体・Web型検査・構文検査、隔離した全件E2E、実image/lock/secret/license inventoryの監査を実行する。監査に指摘があればstepは失敗する。E2E成功、監査の機械指摘、利用経路の評価、公開可否は別々に確認する。[M6記録](../docs/validation/2026-10-16-m6-report.md)を参照。


Browser pluginはこの環境にないため、リポジトリのPlaywrightを使用する（Browser plugin not available）。1280×900と390×844のChromiumで日本語の操作、URL/title、非空表示、overlay/console/runtime例外、画面の収まりを確認する。スクリーンショットには架空情報だけを含める。


## M3の障害制御

PDFのfixtureは固定サンプルからテスト専用PDF service内で生成し、exec経由の制限付きarchiveで取り出す。Dockerのtmpfsからのcompose cpはこのローカル環境で取得できなかった。fixture生成に実在する求職者情報は使わない。

PDF serviceのpause/unpause、APIのrestart、テスト専用DBのlease期限/CAS tokenの制御で中断/復旧を確認する。実経過60秒待つ代わりに専用行のleaseだけを期限切れにする。通常デモにはこれらの制御を行わない。テストで新規作成したファイルとDB行を保持し、自動削除・上書き・volume resetを実行しない。


## M4の対象

workflow.spec.cjsはM3の後に実行し、自分の架空求人・候補者・PDF・推薦を作成する。下書き秘匿、提出時snapshotの不変性、選択PDFのみの共有、全選考状態、共有失効、B/Yの拒否、runtime RLS/列権限、version/冪等、求人終了と提出の同じjob lock、同時選考/撤回、応答喪失・入力保持・認証失効を確認する。通知はDB上の未送信記録だけを検証する。

開発中は `python3 scripts/e2e.py --test-file workflow.spec.cjs` でM4だけを実行できる。run.jsonのtest_selectionに対象を記録し、部分実行を全件成功とは扱わない。最終確認とCIは引数なしでM1〜M5/R1〜R4をすべて実行する。

## R1時点の確認記録

以下はR1当時の範囲。現在はR2の実clamd/FreshClamと定義世代・鮮度・障害時の拒否を別ケースで検証する。synthetic helperの結果を実AV成功の証拠としない。

Browser plugin not available: use the existing Playwright suite. Flow: candidate detail → choose document kind and XLSX → format inspection completes → AV pending is visible and download/recommendation stays unavailable. Desktop1280×900/mobile390×844 and console/page errors are checked.

The runner stages an isolated new DB through0005, seeds a fictional ready PDF and active shared snapshot, then applies0006 and verifies unchanged bytes/status/snapshot and terminal expiry. `RP_TEST_MIGRATIONS_THROUGH` is rejected outside isolated e2e instances. Test networks use unoccupied small subnets; retained past resources are not pruned.

R1 has no AV writer. Positive delivery/M4 workflow regression uses the explicitly named `synthetic_av.cjs` helper to insert TEST_ONLY_SYNTHETIC_NO_AV records via test DB control, then calls the normal retry API. This is not evidence of real scanning. Unmodified raw upload endpoints are tested to remain pending and deny delivery. No product mock, environment bypass or relaxed authorization is added.

The real bounded XLSX worker is exercised by `check_xlsx.py` (native Sheets exports plus adversarial mutations). Fixtures in validation/r0 remain unchanged; their malformed test PNG is now an expected rejection. e2e/fixtures contains corrected PNGs imported into Sheets and exported natively, not just library-built ZIP/XML.

## 静的検査と監査

Rust1.95.0（rustfmt/Clippy）、Web依存の導入後に`python3 scripts/check.py`を実行する。テスト実行用NodeとPDF製品imageのNode/Chromiumは別に記録する。

停止済みで全件成功したrunに対し、`python3 scripts/audit.py --run .local/e2e-<run>/artifacts/run.json --trivy <Trivyのパス>`を実行する。Trivy0.76.0、cargo-audit0.22.1が必要。Docker contextが既定以外の場合は`DOCKER_HOST`にも同じendpointを指定する。CIのchecksum固定手順と[M6再実行例](../docs/validation/2026-10-16-m6-report.md#再実行)を参照。

`audit/summary.json`がstatus=findingsならexit1。各serviceのimage ID、全severityの指摘・固定版候補、package/license一覧とCargo licenseを保存する。未知licenseの件数を適合確認済みと扱わない。DB欠落/期限切れやtool errorも失敗で、summaryの有無とprivate logから区別する。

CIはビルド/起動で失敗した場合に限り、operations.log末尾100行から生成済みenv/account値を伏せ、既知の機微形式が残れば内容を出さず`build-failure.json`へ記録する。元のoperations.log、env、realm、資格情報、raw secret scanはアップロードしない。artifactに加えるPDFは固定したデモ請求PDF1点のみ。
