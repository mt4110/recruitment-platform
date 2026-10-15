# M1 ブラウザE2E

対象は認証基盤だけ。7サービスの起動、実Keycloakを通した4アカウントのログイン、唯一の所属、DB session/CSRF、拒否・期限・再起動・画面の復帰を確認する。求人・候補者・推薦などM2以降を実装/検証するテストではない。

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

手動workflowは`M1 browser E2E`。M1の再現確認用であり、M6の業務全体のCIや本番適合性を完了扱いにしない。
