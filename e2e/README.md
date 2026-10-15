# M1/M2/M3/M4 ブラウザE2E

対象はM1の認証基盤とM2の求人・保存・候補者。実Keycloakの4アカウント、固定所属、session/CSRF、求人の公開/終了、候補者の更新/アーカイブ、組織間のID差替え・通常runtimeロールのRLS拒否、冪等性・version競合・job lock待ち上限、画面の入力保持を確認する。M3のPDF登録・隔離検査・lease復旧・配信も確認する。M4の推薦・選考・snapshot・共有失効も確認する。M5の通知画面・請求PDFは対象外。

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

build/startの詳細は同runの私有`operations.log`に残る。外部共有しない。GitHub Actionsはartifacts配下のJSON/PNGだけを回収し、env・realm・credentials・build logをアップロードしない。

終了時は成功/失敗にかかわらず、作成したrunのサービスだけstopする。container、volume、設定、以前の証拠を削除しない。片付けは対象を確認した別操作とする。

手動workflowは`M1/M2/M3/M4 browser E2E`。M1/M2/M3/M4の再現確認用であり、M6の業務全体のCIや本番適合性を完了扱いにしない。


Browser pluginはこの環境にないため、リポジトリのPlaywrightを使用する（Browser plugin not available）。1280×900と390×844のChromiumで日本語の操作、URL/title、非空表示、overlay/console/runtime例外、画面の収まりを確認する。スクリーンショットには架空情報だけを含める。


## M3の障害制御

PDFのfixtureは固定サンプルからテスト専用PDF service内で生成し、exec経由の制限付きarchiveで取り出す。Dockerのtmpfsからのcompose cpはこのローカル環境で取得できなかった。fixture生成に実在する求職者情報は使わない。

PDF serviceのpause/unpause、APIのrestart、テスト専用DBのlease期限/CAS tokenの制御で中断/復旧を確認する。実経過60秒待つ代わりに専用行のleaseだけを期限切れにする。通常デモにはこれらの制御を行わない。テストで新規作成したファイルとDB行を保持し、自動削除・上書き・volume resetを実行しない。


## M4の対象

workflow.spec.cjsはM3の後に実行し、自分の架空求人・候補者・PDF・推薦を作成する。下書き秘匿、提出時snapshotの不変性、選択PDFのみの共有、全選考状態、共有失効、B/Yの拒否、runtime RLS/列権限、version/冪等、求人終了と提出の同じjob lock、同時選考/撤回、応答喪失・入力保持・認証失効を確認する。通知はDB上の未送信記録だけを検証する。

開発中は `python3 scripts/e2e.py --test-file workflow.spec.cjs` でM4だけを実行できる。run.jsonのtest_selectionに対象を記録し、部分実行を全件成功とは扱わない。最終確認とCIは引数なしでM1〜M4をすべて実行する。

## R1

Browser plugin not available: use the existing Playwright suite. Flow: candidate detail → choose document kind and XLSX → format inspection completes → AV pending is visible and download/recommendation stays unavailable. Desktop1280×900/mobile390×844 and console/page errors are checked.

The runner stages an isolated new DB through0005, seeds a fictional ready PDF and active shared snapshot, then applies0006 and verifies unchanged bytes/status/snapshot and terminal expiry. `RP_TEST_MIGRATIONS_THROUGH` is rejected outside isolated e2e instances. Test networks use unoccupied small subnets; retained past resources are not pruned.

R1 has no AV writer. Positive delivery/M4 workflow regression uses the explicitly named `synthetic_av.cjs` helper to insert TEST_ONLY_SYNTHETIC_NO_AV records via test DB control, then calls the normal retry API. This is not evidence of real scanning. Unmodified raw upload endpoints are tested to remain pending and deny delivery. No product mock, environment bypass or relaxed authorization is added.

The real bounded XLSX worker is exercised by `check_xlsx.py` (native Sheets exports plus adversarial mutations). Fixtures in validation/r0 remain unchanged; their malformed test PNG is now an expected rejection. e2e/fixtures contains corrected PNGs imported into Sheets and exported natively, not just library-built ZIP/XML.
