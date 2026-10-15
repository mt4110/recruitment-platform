# recruitment-platform

人材紹介会社と求人企業が、求人・候補者・推薦・選考を一つの流れで扱うOSSプロトタイプです。

**M0の技術確認とM1のローカル認証基盤まで実装済みです。求人・候補者・推薦などの業務機能はまだ操作できません。**

設計v0.3の[最終レビュー](docs/reviews/2026-10-15-design-final-review.md)に続き、[M0はarm64/amd64で確認済み](docs/validation/2026-10-15-m0-completion.md)。[M1の実装結果・未確認事項・残工数](docs/validation/2026-10-15-m1-report.md)を記録し、ここで作業を止めています。

## ローカルで認証を試す

必要環境は稼働中のDocker Engine/Desktop（Compose pluginまたはdocker-compose）とPython 3.11以上。Node/Rustのホストへのインストールは不要です。loopbackの3000/18080が空いていることを確認してください。

```sh
python3 scripts/local.py setup
python3 scripts/local.py up
python3 scripts/local.py status
```

[http://localhost:3000](http://localhost:3000)を開き、ログインします。アカウントはagency-a / agency-b / employer-x / employer-y。生成したパスワードはGit管理外の`.local/demo-accounts.json`で確認してください。固定の公開パスワードはありません。

同じブラウザで利用者を交代するときは、アプリからlogoutし、再度loginします。Keycloakが前の利用者を表示した場合は、標準のログインやり直し操作から別のユーザー名を入力してください。アプリlogoutはKeycloak全体のSSO sessionを終了しません。

停止と再起動：

```sh
python3 scripts/local.py stop
python3 scripts/local.py up
```

初期化を再実行しても既存データや資格情報をリセットしません。`.local`内の設定とCompose volumeはセットで保全してください。全削除/resetコマンドは設けていません。秘密値を含む`.local`、env、cookie、OIDC tokenを共有・commitしないでください。

今回確認したApple Silicon環境では専用Colima profileを使いました。環境を選ぶ場合は各コマンドの先頭に`DOCKER_CONTEXT=colima-recruitment-m1`を付けます。Buildxがない今回の環境では`DOCKER_BUILDKIT=0`も指定して、通常のDocker buildで確認しています。既存のdefault contextを切り替える必要はありません。

完成後は、架空データを使って「求人登録 → 候補者登録・PDFレジュメ添付 → 推薦 → 選考 → 採用決定 → 請求書PDFプレビュー」を試せる構成を目指します。データ移行は別の作業として扱います。

## M1のブラウザE2E

実Keycloakを含む認証テストを、通常デモと別のポート・DB・ブラウザcontextで実行します。

```sh
npm ci --prefix e2e
npx --prefix e2e playwright install chromium --only-shell
python3 scripts/e2e.py
```

既定のテスト用portは3001/18082。テストごとに新しいCompose projectを作り、終了時にそのサービスだけ停止します。通常デモや既存データをresetしません。環境指定、検証範囲と秘密値の扱いは[E2E手順](e2e/README.md)を参照してください。

## 設計を読む

[設計書の入口](docs/design/README.md)から、利用場面、画面、構成、データ、API、権限、受入条件を確認できます。

- [対象機能と完成条件](docs/design/01-scope.md)
- [画面とデモシナリオ](docs/design/02-experience.md)
- [アーキテクチャと実装配置](docs/design/03-architecture.md)
- [データモデル](docs/design/04-data-model.md)
- [API契約](docs/design/05-api.md)
- [認証・権限・ファイル保護](docs/design/06-security.md)
- [実装順序と受入計画](docs/design/07-delivery.md)
- [AWS・GCP・AzureのIaCサンプル設計](docs/design/08-cloud-examples.md)
- [LP・ガイド・利用文書の要件と目次](docs/design/09-documentation.md)

## 利用上の前提

プロトタイプは架空データ専用です。メールは送信せず、請求書はデモ用PDFとして表示します。個人情報を扱う本番運用は、運用体制・法務・安全性・復旧手順を確認した上で判断してください。

初期範囲は1ユーザー1組織、請求PDFは固定1ページです。設計草案v0.3では、初回レビュー6件と再レビューの残件3件を設計に反映しています。[修正対応表](docs/reviews/2026-10-15-design-revisions.md)で変更内容と未実施の検証を、[実装計画](docs/design/07-delivery.md)で工数と受入条件を確認できます。

技術方針は Next.js / TypeScript、Rust / Axum / SQLx、PostgreSQL。ローカル起動を最初の完成条件とし、クラウド構成は参考例として設計します。本体は[Apache-2.0](LICENSE)です。[第三者依存と監査範囲](THIRD_PARTY.md)を併せて確認してください。
