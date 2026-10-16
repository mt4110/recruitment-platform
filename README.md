# recruitment-platform

人材紹介会社と求人企業が、求人・候補者・推薦・選考を一つの流れで扱うOSSプロトタイプです。

**M4の推薦・選考・スナップショット・共有失効まで実装・検証済みです。arm64/amd64で各50件のE2Eが成功しました。通知画面・請求プレビューは未実装です。**

設計v0.3の[最終レビュー](docs/reviews/2026-10-15-design-final-review.md)に続き、[M0はarm64/amd64で確認済み](docs/validation/2026-10-15-m0-completion.md)。[M1の最終記録](docs/validation/2026-10-15-m1-e2e-report.md)に続き、[M2の実装・検証・残工数](docs/validation/2026-10-15-m2-report.md)を記録しています。[M3の実装・検証・残工数](docs/validation/2026-10-15-m3-report.md)を記録しています。[M4の実装・検証・残工数](docs/validation/2026-10-15-m4-report.md)を保存し、M4で停止しています。

**v0.4のR4まで実装・両arch検証済みです（各88件）。** [R4の実装・検証・残工数](docs/validation/2026-10-16-r4-report.md)を参照してください。PDF/XLSXの実AV・版管理・受付復帰に加え、ログイン以外の現行全フォームに本人用の暗号化下書き・サーバー自動保存/復元を追加しました。本人/組織分離、期限切れ、競合、業務確定後の復活拒否を確認済みです。復元はサーバー保存成功分が対象で、通信断中の端末永続化はR5に残します。未送信ファイルは再選択が必要です。[残計画は38〜68時間の条件付き仮積算](docs/design/07-delivery.md)。R5・M5へは進まず停止しています。検証は隔離環境で行い、通常デモ`localhost:3000`のM4環境・DBは未更新です。下書きの復旧にはGit外の`.local/local.env`内`DRAFT_MASTER_KEY`とDBをセットで保全してください。

## ローカルで試す

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

現在は、企業X/Yで「自社求人 → 登録 → 下書き保存 → 公開 → 募集終了」、紹介会社A/Bで「求人検索 → 詳細 → 保存」と「候補者 → 登録 → 編集 → アーカイブ」を試せます。企業には自社求人、紹介会社には公開求人と自社候補者のみを表示します。初期データは架空求人8件、候補者6名です。候補者のアーカイブは不可逆です。

完成後は、架空データを使って「求人登録 → 候補者登録・PDF/XLSXレジュメ添付 → 推薦 → 選考 → 採用決定 → 請求書PDFプレビュー」を試せる構成を目指します。データ移行は別の作業として扱います。

## M1/M2/M3/M4のブラウザE2E

実Keycloakを含む認証と、求人・候補者の操作/組織分離テストを、通常デモと別のポート・DB・ブラウザcontextで実行します。

```sh
npm ci --prefix e2e
npx --prefix e2e playwright install chromium --only-shell
python3 scripts/e2e.py
```

既定のテスト用portは3001/18082。実行ごとに新しいCompose projectを作り、終了時にそのサービスだけ停止します。通常デモや既存データをresetしません。環境指定、検証範囲と秘密値の扱いは[E2E手順](e2e/README.md)、実行結果は[M4の最終記録](docs/validation/2026-10-15-m4-report.md)（認証20件＋M2の10件＋M3の9件＋M4の11件）を参照してください。

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
- [PDF/XLSX・AV・全フォーム保存/復元の追加設計](docs/design/10-resumes-and-autosave.md)

## 利用上の前提

プロトタイプは架空データ専用です。メールは送信せず、請求書はデモ用PDFとして表示します。個人情報を扱う本番運用は、運用体制・法務・安全性・復旧手順を確認した上で判断してください。

初期範囲は1ユーザー1組織、請求PDFは固定1ページです。v0.4で追加した必須要件は上記の設計書を参照してください。旧設計v0.3では、初回レビュー6件と再レビューの残件3件を設計に反映しています。[修正対応表](docs/reviews/2026-10-15-design-revisions.md)で変更内容と未実施の検証を、[実装計画](docs/design/07-delivery.md)で工数と受入条件を確認できます。

技術方針は Next.js / TypeScript、Rust / Axum / SQLx、PostgreSQL。ローカル起動を最初の完成条件とし、クラウド構成は参考例として設計します。本体は[Apache-2.0](LICENSE)です。[第三者依存と監査範囲](THIRD_PARTY.md)を併せて確認してください。


M3の更新後も最初に `python3 scripts/local.py setup` を実行してください。既存の資格情報を保持したまま、内部PDF service用の共有鍵だけを不足時に生成します。既存migrationを書き換えず、`up`時に文書tableを追加します。PDFは架空情報だけを使い、登録した文書・一時ファイルをこの段階で自動削除しません。
