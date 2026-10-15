# データモデル

設計草案 v0.4 / 2026-10-15。R1〜R6および再レビュー残件の対応先は[修正対応表](../reviews/2026-10-15-design-revisions.md)。

## 共通ルール

IDはUUID、日時はUTCのtimestamptz、API上はISO 8601、画面はAsia/Tokyo。求人・候補者・推薦の業務更新はversion整数で管理する。sessionの期限やupload/冪等記録の技術状態は期限・lease token・CASを使う。文字列上限はAPIとDBで一致させる。**1ユーザーは必ず1組織に所属し、所属組織は不変**。組織切替・複数所属・所属移管APIは設けない。Candidateは紹介会社ごとに所有し、氏名・メール等による組織横断の人物照合は行わない。

## テーブルと主要列

| テーブル | 主な列・型 | 制約・所有 |
| --- | --- | --- |
| organizations | id UUID PK、kind enum agency/employer、name varchar(200)、active bool | デモ初期化で作成。kindは不変 |
| users | id UUID PK、organization_id FK、active bool、oidc_issuer text、oidc_subject text、display_name varchar(100) | UNIQUE(oidc_issuer,oidc_subject)。organization_idは不変 |
| sessions | token_hash PK、user_id FK、expires_at | cookie原文は保存しない。組織はuserから取得 |
| auth_attempts | state_hash PK、browser_binding_hash、nonce、encrypted_pkce_verifier、expires_at | 単回消費・5分有効、短期cookieと関連付ける |
| jobs | id、employer_org_id、employer_name varchar(200)、title varchar(200)、description text、location varchar(200)、employment_type enum、status enum、version | UNIQUE(id,employer_org_id)、draft/published/closed |
| job_favorites | agency_org_id、job_id、created_by、created_at | PK(agency_org_id,job_id)、自社共有 |
| candidates | id、agency_org_id、name varchar(100)、summary text、archived_at、version | UNIQUE(id,agency_org_id) |
| documents | id、agency_org_id、candidate_id、created_by FK、storage_key text、staging_key text NULL、original_name varchar(255)、size_bytes bigint、sha256 char(64)、status enum、rejection_code text NULL、validation_policy text NULL、validated_at、created_at、updated_at | composite FK(candidate_id,agency_org_id)、storage_key UNIQUE、pending/ready/rejected |
| applications | id、agency_org_id、employer_org_id、candidate_id、job_id、status enum、reason varchar(2000)、version、submitted_at、share_revoked_at、job_title_snapshot、job_description_snapshot、job_location_snapshot、job_employment_type_snapshot、job_version_snapshot、agency_name_snapshot、employer_name_snapshot | composite FK candidate/agency、job/employer。所属・参照IDは不変。求人snapshot列は提出時に一度設定 |
| application_snapshots | application_id PK/FK、name varchar(100)、summary text、consent_recorded_at、consent_recorded_by、consent_text_version | 候補者の提出時点を一度だけ保存 |
| application_documents | application_id、document_id、agency_org_id、storage_key_snapshot、original_name_snapshot、size_bytes_snapshot、sha256_snapshot | PK(application_id,document_id)。提出時にready文書から複写。不変 |
| selection_events | id、application_id、event_type、from_status、to_status、application_version、actor_user_id、actor_org_id、reason varchar(500)、created_at | 追記のみ。event_type=transition/sharing_revoked |
| placements | id、application_id UNIQUE、decided_at、demo_fee_yen bigint | hiredへの変更時に一度作成、デモ固定500000円 |
| notification_previews | id、application_id、recipient_org_id、event_id、subject varchar(200)、body text、created_at | UNIQUE(event_id,recipient_org_id)。候補者本文を含めず常に未送信 |
| audit_events | id、actor_user_id、actor_org_id、action、resource_type、resource_id、result、request_id、created_at | PII本文・生トークン・秘密は記録しない |
| idempotency_records | org_id、user_id、http_method、normalized_path、key、request_hash、resource_id、state、result_status、error_code NULL、lease_token UUID NULL、lease_expires_at NULL、expires_at NULL | PK(org_id,user_id,http_method,normalized_path,key)。state=processing/completed/failed。processingはexpires_at=NULL、完了/失敗は期限必須 |

業務表には必要なcreated_at/updated_atを付ける。FKは原則RESTRICT。求人・候補者・文書・推薦の物理削除APIは用意せず、候補者はアーカイブする。documentsのready後はファイルbytes・保存参照・検査情報を変更しない。ユーザーが新しいPDF/XLSXを登録すると別documentになる。v0.4で追加する形式/書類種別、検査記録、個人下書き/鍵、RLS/移行の詳細は[追加データ契約](10-resumes-and-autosave.md#5-個人下書きのデータapi)を正本とする。下表はM4までの既存列を示す。拒否・一時ファイルの扱いは[安全性設計](06-security.md)を参照。

consent_text_versionはdemo-share-v1。これは架空データの操作確認で、実在の本人同意の検証記録ではない。agency/employerのkind整合、candidate/documentの所有組織整合をAPIとDB制約/triggerで確認する。

## 共有情報の読取り経路（R1/R2）

企業の共有閲覧条件を **E_SHARED** と呼ぶ。要求元userが有効なemployerに属し、その組織IDがapplication.employer_org_idと一致、状態がsubmitted/screening/rejected/hired、share_revoked_atがNULL、のすべてを満たすこと。draft/withdrawnは許可しない。

自社agencyの閲覧条件を **A_OWNER** と呼ぶ。要求元userが有効なagencyに属し、その組織IDがapplication.agency_org_idと一致すること。agencyの自社閲覧は共有撤回後も可能。無関係な組織には404を返す。

企業のPDF取得は、通常DBロールのままapplication_documentsとapplicationsを照合してE_SHAREDを検証し、storage_key_snapshotから保管ファイルを取得する。documents原本へJOINしない。storage_key_snapshotはAPI内部専用でDTOやログに出さない。agencyは自社documents原本を読める。

提出後の求人はapplications自身のjob_*_snapshot列を表示する。これらの列の型/上限はjobsの対応列と同じで、draftではNULL、submitted以後は必須・変更不可とする。求人snapshotを候補者のapplication_snapshotsから分離することで、企業が共有失効後も求人・案件metadataだけを読めるようにする。v0.1の推薦詳細では現在の求人公開状態を返さず、募集終了後もjobs原本を例外的に読みにいかない。求人検索・求人詳細と、過去の推薦に残る求人内容を分ける。

jobs.employer_nameは求人作成時に自社organizations.nameからAPIが設定し、利用者入力を受け付けない。提出時はその値と自社agency名をapplicationsの両組織名snapshot（varchar(200)）へ保存する。請求プレビューもこの2列を使い、他組織のorganizations原本を追加権限で読むことを避ける。

## DB権限とRLSの表

APIはnon-owner・non-superuser・NOBYPASSRLSのruntimeロールを使用。業務transactionの開始時に、認証済みuserからuser_id/org_idをSET LOCALで設定する。接続をpoolへ返す前にtransactionを終了する。設定がない場合は既定で拒否。認証用ロールはusers/organizationsの必要列とsessions/auth_attemptsだけを扱い、業務表権限を持たない。migration/seedロールは通常要求で使用しない。

| 表 | agencyのSELECT | employerのSELECT | runtime書込み条件 |
| --- | --- | --- | --- |
| organizations/users | 自分と自組織の必要列 | 自分と自組織の必要列 | 業務runtimeは変更不可 |
| jobs | publishedのみ | 自社のみ | INSERT/UPDATEは自社employerのみ、owner不変 |
| job_favorites | 自社のみ | 不可 | 自社agencyのみ、保存時は公開求人、解除は募集終了後も可 |
| candidates/documents | 自社のみ | 不可 | 自社agencyのみ。ready文書は不変 |
| applications | A_OWNER | 自社案件のdraft以外 | agencyは自社作成・下書き更新・提出・辞退/撤回。employerはE_SHAREDかつ許可された選考遷移のみ |
| application_snapshots/application_documents | A_OWNER | E_SHARED | agencyがdraftを提出するtransaction内で一度INSERT、更新/削除不可 |
| selection_events | A_OWNER | 自社案件のdraft以外 | 関係する組織が許可操作と同じtransactionでINSERT、更新/削除不可 |
| placements | A_OWNER | E_SHARED | E_SHAREDのemployerがhired遷移時に一度INSERT、更新/削除不可 |
| notification_previews | recipient_org_idが自社 | recipient_org_idが自社 | 許可操作と同じtransactionで参加組織宛てのみINSERT、更新/削除不可 |
| audit_events | 通常画面から参照不可 | 通常画面から参照不可 | actorが自分/自組織の記録のみINSERT |
| idempotency_records | 自分/自組織のみ | 自分/自組織のみ | 同じscopeのみ。期限とstate条件を検証 |

業務表にRLSをENABLE/FORCEし、SELECTのUSING、INSERT/UPDATEのWITH CHECK、変更可能列のGRANTを定義する。行の所属が不変であることはtriggerでも検査する。状態遷移やversion検査はAPIと制約/triggerで補完し、RLSだけで選考フローを実装しない。snapshotのINSERT方針はA_OWNERかつdraftとし、共有リンク作成後にapplicationをsubmittedへ更新する。

selection_eventsは共有失効後も企業が状態と時刻を確認するため行自体を読める。自由記入reasonはDTOで失効時に省略し、エンドユーザーへDB接続を渡さない。機密snapshot/PDFは行レベルでも非表示にする。

employerによる選考はagency所有のcandidate/documentsを読まない。通知を相手組織へINSERTする場合、applicationの参加者であることと宛先がその2組織の一方であることをWITH CHECKで検査する。policyの参照方向は子表→applicationsに統一し、applicationsのpolicyは子表を参照しない。組織種別・有効性は認証と基礎表で解決し、policyの相互再帰を作らない。job_favoritesの自社保存解除を除き、runtimeの業務DELETEは許可しない。個人form_draftsのconsume/discardは本文を消したtombstoneとし、業務表の物理削除とは分ける。技術記録の期限整理は個別の保守権限で対象を限定する。

## 提出・求人変更の順序（R3）

受付時点は推薦提出transactionのcommit。求人の募集終了/編集と同時でも、提出が先なら提出commit後に求人を変更でき、募集終了が先なら提出を409 JOB_NOT_OPENで拒否する。

runtimeロールのまま、求人UUIDから決まる **transaction-level advisory lock** を使う。job IDをドメイン接頭辞とともにSHA-256し、先頭64bitを固定のbyte orderでbigintへ変換する契約とする。hash衝突は直列化が増えるだけで、認可には使用しない。セッションレベルのlockは使わない。求人作成後の編集・status変更と、推薦の下書き作成・提出はすべて同じlockを取得する。通常のjob UPDATE権限をagencyへ与えずに直列化するための方式で、全該当処理が従うことを結合試験で確認する。

JSON更新の順序は、認証/CSRF→transaction開始とorg context→冪等lock/完了結果確認→必要なjob lock→candidate行→application行→ready documentのID昇順参照（readyは不変なので行ロック不要）→検証→書込み→commit。使用しない行はロックしない。documentの確定と候補者アーカイブもcandidate→documentの順序を守る。選考・辞退・共有撤回はapplication行だけをロックし、その後job/candidateをロックしない。

提出ではcandidate_versionとjob_versionを両方照合し、job published（A_OWNERの既存draftでjobs行がRLSにより不可視ならJOB_NOT_OPEN）、candidate非アーカイブ、共有撤回なし、選択PDF/XLSXが同一候補者のreadyかつ現在の形式/AV検査で利用可能であることを確認。snapshot/link/event/通知を作りsubmittedへ更新する。すべて同一transaction。失敗時は業務変更と冪等記録をrollbackする。DB lock待ちは3秒、transactionは10秒を初期制限とし、超過は503 RETRYABLE_BUSY。外部PDF検査/生成をこのtransactionの中に入れない。

## 状態・共有撤回（R4）

同じ(agency_org_id,candidate_id,job_id)のdraft/submitted/screening/hiredには部分一意制約を付ける。rejected/withdrawn後の再推薦は新しいapplication。組織間の重複推薦は検知しない。

辞退はstatus=withdrawnとshare_revoked_at設定を同時に行う。進行中の共有撤回も辞退と同じ結果にする。rejected/hiredの撤回は状態を維持し、sharing_revokedイベントをfrom_status=to_statusで一度記録する。採用決定後のplacementは維持する。撤回済みフラグは元に戻さず、詳細な状態表は[API契約](05-api.md)を正本にする。

## 検索・寿命

candidateは(agency_org_id,created_at,id)、jobは(status,created_at,id)と(employer_org_id,created_at,id)、applicationは各組織/status/updated_at/id、イベントは(application_id,created_at,id)に索引を作る。documentsは(agency_org_id,status,updated_at,id)、冪等記録は(org_id,user_id,resource_id)にも索引を作る。FK参照列の索引も確認する。qは1〜100文字、パラメータ化した部分一致、LIKEの%/_をエスケープ。limitは最大100。候補者検索は自社のみ。

v0.1は架空データ専用。readyの文書・提出済みsnapshot・業務履歴は自動削除しない。アーカイブと共有撤回を区別する。個人下書きは保存から7日で復元不可とする。技術的な期限切れauth attempt/冪等記録とstagingの整理は別の保守処理で、参照中のpending/readyを消さない。データ全体のリセットは対象と復旧可否を示した確認が必要。既に利用者が取得したPDFは回収できない。

参照：[PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)、[transaction-level advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)。方式・制限値は本設計の判断で、動作検証は実装段階で行う。

## M4で確定した補足（2026-10-15）

- documentsにUNIQUE(id,agency_org_id)を追加し、共有参照のcomposite FKで所有組織の一致を確認する。共有参照のINSERT triggerは候補者ID・ready・保存先/表示名/size/hashの一致を検査する。
- selection_eventsはapplication_versionを保存し、UNIQUE(application_id,application_version)で同じ業務版への二重イベントを拒否する。snapshotの内容とeventのactor/状態・版もINSERT triggerで検査する。業務runtimeへこれらのUPDATE/DELETEを与えない。
- applicationsの非draftにはjob_version_snapshotの非NULLを、ready documentには検査policyの非NULLを明示的に要求する。SQL CHECKがNULLを成功として扱う抜けを防ぐ。適用済みmigrationは変更せず0004/0005を追加する。
- M4は状態変更と同時に相手組織宛ての未送信通知を1件保存する。本文は固定のデモ文で候補者本文を含めない。通知のAPI/画面と請求PDFはM5に残す。
