# recruitment-platform

人材紹介会社と求人企業が、求人・候補者・推薦・選考を一つの流れで扱うOSSプロトタイプの設計です。

**現在は設計のみです。アプリケーション、起動コマンド、Terraformはまだ実装されていません。**

設計フェーズは2026-10-15にv0.3で完了しました。[最終レビュー記録](docs/reviews/2026-10-15-design-final-review.md)で残件3件の設計上の解消を確認しています。本実装は未着手です。[M0の技術確認結果](docs/validation/2026-10-15-m0-report.md)では、macOS上のLinux/arm64コンテナで4項目の成立を確認しました。Linux/amd64実機CIは未確認です。

完成後は、架空データを使って「求人登録 → 候補者登録・PDFレジュメ添付 → 推薦 → 選考 → 採用決定 → 請求書PDFプレビュー」を試せる構成を目指します。データ移行は別の作業として扱います。

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

技術方針は Next.js / TypeScript、Rust / Axum / SQLx、PostgreSQL。ローカル起動を最初の完成条件とし、クラウド構成は参考例として設計します。ソフトウェア公開時のライセンスはApache-2.0を候補に、依存物・フォントのライセンス確認後に確定します。現段階でライセンス付与済みとは扱いません。
