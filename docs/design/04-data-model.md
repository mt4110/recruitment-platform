# データモデル

## 共通ルール

IDはUUID、日時はUTCのtimestamptz、API上はISO 8601、画面はAsia/Tokyoで表示する。更新可能なレコードはversion整数を持ち、更新時に増加する。文字列は最大長をAPIとDBで一致させる。業務データに汎用JSONを多用せず、列と制約を定義する。

同一アカウントの所属は複数可能、1セッションのactive organizationは1つ。Candidateを全組織共通の人物マスターにしない。メールや氏名を使った組織横断の同一人物判定はしない。

## テーブルと主要列

| テーブル | 主な列・型 | 制約・所有 |
| --- | --- | --- |
| organizations | id UUID PK、kind enum agency/employer、name varchar(200)、active bool | デモ初期化で作成。kindの変更は不可 |
| users | id UUID PK、oidc_issuer text、oidc_subject text、display_name varchar(100) | UNIQUE(oidc_issuer, oidc_subject)。メールは認可に使わない |
| memberships | organization_id、user_id、active bool | PK(organization_id,user_id)。所属種別はorganizations.kindに従う |
| sessions | token_hash PK、user_id、active_org_id、expires_at | 所属有効性を各要求で確認。cookie原文はDBへ保存しない |
| auth_attempts | state_hash PK、nonce、encrypted_pkce_verifier、expires_at | 単回消費、5分有効。セッションと異なる短期cookieへ結び付ける |
| jobs | id、employer_org_id、title varchar(200)、description text、location varchar(200)、employment_type enum、status enum、version | UNIQUE(id,employer_org_id)。ownerはemployer。status=draft/published/closed |
| job_favorites | agency_org_id、job_id、created_by、created_at | PK(agency_org_id,job_id)、共有範囲は自社 |
| candidates | id、agency_org_id、name varchar(100)、summary text、archived_at、version | UNIQUE(id,agency_org_id)、ownerはagency |
| documents | id、agency_org_id、candidate_id、storage_key text、original_name varchar(255)、size_bytes bigint、sha256 char(64)、status enum | composite FK(candidate_id,agency_org_id)。storage_key UNIQUE、status=pending/ready/rejected |
| applications | id、agency_org_id、employer_org_id、candidate_id、job_id、status enum、reason varchar(2000)、version、submitted_at、share_revoked_at | composite FK candidate/agency、job/employer。組織IDは作成後不変 |
| application_snapshots | application_id PK/FK、name varchar(100)、summary text、job_title varchar(200)、job_description text、consent_recorded_at、consent_recorded_by、consent_text_version | 候補者・求人の提出時点を一度保存。candidate原本へJOINして出力しない |
| application_documents | application_id、document_id、agency_org_id | PK(application_id,document_id)。同じagencyかつ同じcandidateのready文書だけ追加 |
| selection_events | id、application_id、from_status、to_status、actor_user_id、actor_org_id、reason varchar(500)、created_at | 追記のみ。アプリケーションと同じトランザクション |
| placements | id、application_id UNIQUE、decided_at、demo_fee_yen bigint | status=hiredへの変更で一度作成。demo_fee_yen=500000（デモ用固定値） |
| notification_previews | id、application_id、recipient_org_id、event_id、subject varchar(200)、body text、created_at | UNIQUE(event_id,recipient_org_id)。常に未送信。候補者氏名・概要を文面へ含めない |
| audit_events | id、actor_user_id、actor_org_id、action、resource_type、resource_id、result、request_id、created_at | PII本文・PDF本文・秘密・生トークンは記録しない |
| idempotency_records | active_org_id、user_id、route、key、request_hash、resource_id、result_status、expires_at | PK(active_org_id,user_id,route,key)。業務書込みと同じtransaction、24時間保持 |

created_at/updated_atは必要な業務テーブルに付ける。foreign keyは原則RESTRICT。物理削除・cascade削除を通常APIに用意せず、候補者はアーカイブで扱う。デモ環境の明示リセットだけがデータ消去を行う。

consent_text_versionはdemo-share-v1を記録する。チェック記録は架空データのデモ操作に関するもので、実在の本人の同意を検証した証拠とは扱わない。sessionsは(user_id,active_org_id)でmembershipへの参照を持つ。organization.kindと業務表のagency/employerの整合はDB triggerとAPIで確認する。

## 状態・参照の整合性

推薦作成時にcandidateが自組織、jobがpublished、ownerがemployerであることを確認する。提出時にも同じ条件を再確認し、候補者versionを指定して、読んでいた内容から変更されていないことを検証する。

application_documentsはdocumentのagencyだけでなく、application.candidate_idとdocuments.candidate_idが一致する必要がある。DB triggerで検査する。企業の認可に必要な組織IDはjobからAPIが取得し、リクエスト値を信用しない。

同じ(agency_org_id,candidate_id,job_id)のdraft/submitted/screening/hiredには部分一意制約を付ける。rejected/withdrawn後の再推薦は別applicationで履歴を残す。組織間の重複推薦は検知しない。

提出はapplicationの行をロックし、状態・version・候補者version・PDFのready・架空データ確認を検証した上で、snapshot/document links/event/notificationを同一transactionへ書く。候補者の行も更新との競合を防ぐためロックする。DBエラー時は全体をrollback。

## RLSと接続

APIの通常DBロールはownerでもsuperuserでもBYPASSRLSでもない。業務表にRLSを有効化しFORCEする。認証後、transaction内でuser IDとactive org IDをSET LOCAL相当で設定し、poolへのコンテキスト残留を防ぐ。認証前のsession/auth参照は限定された別権限で扱い、通常業務の権限を混ぜない。

agencyは自社candidate/documentsを読める。employerは関係する提出済みapplicationのsnapshot/document linksを読めるがcandidate/document metadataの原本を直接読めない。ファイルは専用認可経路で返す。RLSのある表だけではこの共有要件を完結できないため、APIの返却DTOも分ける。

## インデックス・検索

candidateは(agency_org_id,created_at,id)、jobは(status,created_at,id)と(employer_org_id,created_at,id)、applicationはそれぞれ(agency_org_id,status,updated_at,id)、(employer_org_id,status,updated_at,id)を用意する。イベントは(application_id,created_at,id)。FKの参照列には必要な索引を付ける。

初期の求人検索はtitle/description/locationのパラメータ化された部分一致。日本語の一般的な全文検索品質は保証しない。検索qは1〜100文字、limit最大100。LIKE用の%と_はエスケープする。生成データ15,000求人で計測し、必要な場合だけpg_trgm等を検討する。候補者の検索は自社内のみ。

## データ寿命

v0.1は架空データ専用で、保持期間による自動削除は行わない。アーカイブしたcandidateから新規推薦はできないが、既存applicationの共有は別の状態で管理する。共有撤回は各application.share_revoked_atで管理し、snapshotとPDF取得を拒否する。企業にすでにダウンロードされたファイルは回収できないことをUIに明示する。

本番利用の保持期間・削除・同意の法的評価は[文書要件](09-documentation.md)の運用前ガイドへ引き継ぐ。

参照：[PostgreSQL Row Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。RLSと複合制約・DTO分離の組合せは本設計の判断。
