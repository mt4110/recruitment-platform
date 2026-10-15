# 開発への参加

現状はM1のローカル認証基盤まで。範囲・権限・状態・失敗時の契約は[設計書](docs/design/README.md)を正本とする。実在する求職者情報・秘密値をissue、ログ、fixture、commitへ入れない。

## 起動

READMEのsetup/upを利用する。Python helperはDocker Compose pluginとstandaloneのdocker-composeを自動判別する。秘密値は`.local`にだけ生成する。migration/fixtureはupの途中で適用し、既存の適用済みmigrationを書き換えず、新しいSQLファイルを追加する。checksum不一致で停止したときは原因を確認し、履歴を消して通過させない。

## 変更の確認

- Rust: `cargo fmt --manifest-path services/api/Cargo.toml --check`、`cargo check --manifest-path services/api/Cargo.toml --locked`
- Web: `cd apps/web`で`npm ci`、`npm run build`。本番用のCompose buildでも型検査する。
- 変更した認証経路は、通常/拒否/期限/再起動時の動作を架空データで確認する。M1の再実行には[E2E手順](e2e/README.md)を使い、私有の通常デモへ無効化/期限変更を行わない。現時点の[実行済み確認](docs/validation/2026-10-15-m1-report.md)と、未実装の回帰テストを区別する。
- 依存はlockfileとimage digestを更新し、`npm audit`、`cargo audit --file services/api/Cargo.lock`を確認する。既知の指摘を無条件にignoreしない。

APIの認証用roleへ業務表権限や管理権限を追加しない。所属はusersの1件から取得し、メール、URLのorg ID、ブラウザの自己申告から決めない。OIDC/sessionの生値やqueryをログへ出さない。PDF製品処理を追加するときはM0のsandbox/制限を維持し、M3/M5の受入を確認する。

データのreset/削除、外部公開、外部送信、本番変更を通常起動の副作用へ含めない。変更の目的・差分・確認範囲・残る制約をPRに記載する。
