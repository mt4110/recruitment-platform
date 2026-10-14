# 認証・権限・ファイル保護

## 認証方式

OIDC Authorization Code + PKCEをAPI側で処理する。issuer、audience、署名、nonce、state、有効期限、固定redirect URIを検証し、callbackのauth attemptを一度だけ消費する。OIDCの外部issuer URLとコンテナ間アクセスURLは一致を検証し、検証省略でローカル接続問題を解決しない。

ユーザーのキーは(issuer,subject)。メールドメインから所属を推定せず、デモ投入済みのmembershipsを参照する。認証成功後は256bit以上のランダムな不透明セッションを発行し、DBにはhashを保存する。プロトタイプの期限は8時間、active org変更でtokenをrotate。CSRF tokenはセッション原文と専用secretからHMACで導出し、/meで返してconstant-time比較する。生セッションはJSONへ返さない。

ログアウトでアプリセッションを破棄する。デモの利用者交代はOIDCのprompt=loginで毎回認証画面を出し、前のSSOセッションによる自動ログインを避ける。IdP側のログアウト連携は対応する仕様とredirect先を検証して追加する。

cookieはHttpOnly、SameSite=Lax、Path=/。HTTPS環境ではSecure、Host限定にする。HTTPのローカル例外はloopbackの開発環境だけ。状態変更にはCSRF tokenとOrigin検査。CORSは同一オリジンのみ。変更APIはGETで呼ばない。

## 認可の順序

1. 有効sessionとuserを取得。
2. active orgのmembershipとorganization.activeを再確認。
3. 操作できる組織種別を確認。
4. 所有またはapplicationでの共有関係を確認。
5. 状態とversion、share_revoked_atを確認。
6. 同じ認可条件をDB transaction/RLSと出力DTOへ適用。

API bodyのorganization_idやemployer_org_idを権限根拠にしない。企業はcandidate原本を参照できない。UI上の組織変更後は前組織の画面状態とキャッシュを破棄する。ログアウトでも機密画面を消し、ブラウザの戻る操作で共有キャッシュから再表示しないようにする。

## PDFアップロード

最大10MiB、PDFの拡張子とmagicだけでなく構造を検証する。暗号化PDF、壊れたPDF、JavaScript・添付ファイル・起動アクションを含むPDFを拒否する。検査ツールは隔離環境・時間制限5秒で実行し、ツールの終了状態を確認する。検査済みでも実運用の安全性を保証しない。

まずランダムkeyの一時領域にstream保存し、検査成功後readyへ遷移する。DBはpendingから開始し、失敗したレコードはrejected。一時ファイルの整理処理は対象を限定して設計する。readyになるまで推薦に選べない。ストレージキーを推測可能な氏名・メール・候補者IDにしない。

ファイルはAPI認可後にstreamし、公開bucketや汎用static配信を使わない。Content-Type:application/pdf、X-Content-Type-Options:nosniff、no-storeを付ける。cloud例でも初期版は署名URLを直接利用者へ渡さず、API経由とする。後で署名URLを採用するなら、短い期限と撤回後の残存アクセスを別途評価する。

## 請求プレビュー

レンダラーは固定schemaの入力に限定し、ユーザー提供のHTML・URL・任意のファイルパスを受け付けない。文字列はHTMLエスケープ、外部ネットワークアクセス禁止、非root、プロセスとメモリ・同時実行を制限する。共有鍵は環境のsecretで渡し、Gitへ保存しない。

## ログ・秘密・運用

OIDC client secret、session cookie、PDF本文、候補者氏名・経歴、未加工の入力bodyをログへ出さない。監査はactor、組織、resource ID、操作、結果、時刻を記録する。環境変数の全出力を診断手順にしない。

DB認証情報とrenderer鍵はローカルでも生成する。デモログイン用の架空アカウントはREADMEに説明してよいが、クラウドで同じ固定パスワードを公開しない。初期化済み管理者認証情報をイメージへ埋め込まない。

本番のバックアップ、保存期間、本人同意の証跡、権限剥奪、脆弱性対応、漏えい時の連絡と法的整理は運用前ガイドで扱う。OSSの認証・認可を機能削減のために省略しない。

参照：[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)、[PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。セッション期限・ファイル上限などは本プロトタイプの設計値で、法定基準や性能測定値ではない。
