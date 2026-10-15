# API契約

## 共通契約

業務APIは/api/v1、JSONはsnake_case。認証なし401、組織種別の不許可403、存在しない/無関係/共有閲覧失効のresourceは同じ404。構造不正400、列挙値/UUID/項目不正422、競合409、容量超過413、回数超過429、処理待ち503、内部障害500。失敗JSONはerror.code/message/request_id/field_errors（入力時のみ）。

成功時は単体オブジェクト、一覧はitems/next_cursor。limit初期20、最大100。created_at/id等の安定カーソル順で返し、検索条件変更でカーソルを破棄。業務応答・PDFはCache-Control: private, no-store。

versionを持つresourceのPATCHと状態変更POSTにはversion必須。対象行をversion条件で更新し、0件なら409 VERSION_CONFLICT。お気に入りPUT/DELETE、login/logout、ファイル作成はこのversion要件の対象外。組織IDは認証したuserの唯一の所属から取得する。推薦のreasonは最大2,000文字、transition/revoke-sharingのreasonは必要時1〜500文字。

## 冪等性の実行順序（R5）

作成・提出・選考・辞退/撤回・アーカイブの業務POSTにはIdempotency-Key UUIDを必須とする。auth/logoutは対象外。keyのscopeは(org_id,user_id,HTTP method,実IDを含む正規化path,key)。pathはrouting後のUUID小文字・末尾slashなしの形式とし、/:idのようなroute patternを使わない。request_hashはcanonical JSONのSHA-256。CSRF token/通信headerは含めない。

JSON要求は次の順序を守る。

1. 現在の認証・CSRF/Originと組織種別、入力形式を確認する。業務表をorg contextなしで参照しない。
2. transactionを開始してuser/org contextを設定し、対象resourceの関係を確認する。version/元状態はまだ検査しない。その後scopeから決まるtransaction-level advisory lockを取得する。lock keyはドメインidemとscopeを長さ付きで連結したSHA-256先頭64bitから作り、job lockと区別する。
3. 同じscopeの記録を読む。hash不一致は409 IDEMPOTENCY_MISMATCH。completedなら現在の読取り認可を再確認して同じresource_idと記録済みHTTP statusを返す。DTOは現在の状態から作り直し、旧PII bodyは保存/再生しない。version・状態遷移を再実行しない。
4. 未実行ならprocessing記録をINSERTし、[DB設計のlock順序](04-data-model.md)に従ってversion・許可状態を検査、業務を更新する。
5. 記録をcompletedにし、業務・イベント・通知と同じtransactionでcommit。失敗はすべてrollbackする。

同一キーの並行要求はlockで待ち、先行commit後に結果を参照する。3秒の待ち上限で503 RETRYABLE_BUSY、同じキーで再試行可能。別キーでの二重推薦にはDBの部分一意制約を適用し409 DUPLICATE_APPLICATION。completed記録は完了から24時間保持する。response bodyの完全一致ではなく、同じ操作結果/resourceへの参照を保証する。

PDFアップロードだけはDBとファイルをまたぐ。multipartの実bytesをstagingへ保存して算出したSHA-256と、候補者ID・正規化表示名・架空データ確認をrequest_hashに使う。現在の認証・所有確認→staging/hash→冪等lock/既存結果の確認→新規だけ非アーカイブ確認と予約→検査→確定の順序とし、復旧も同じdocument IDを使う。完了済み要求は候補者のアーカイブ後も、現在の閲覧認可で同じ結果/resourceを参照できる。新キーのアーカイブ済み候補者への登録は409 CANDIDATE_ARCHIVED。詳細と中断時の扱いは[安全性設計](06-security.md)を正本にする。

認証callbackの失敗はHTTP statusを維持する。Acceptがtext/htmlのブラウザ遷移には静的な再ログイン案内を返し、application/jsonのAPI要求には共通のerror/code/request_id形式を返す。入力queryの解釈失敗もAUTH_ATTEMPT_INVALIDに正規化し、生の入力を応答やlogへ含めない。

## 認証・所属

| Method / Path | 入力 | 応答・条件 |
| --- | --- | --- |
| GET /auth/login | なし | OIDCへredirect。state/nonce/PKCE作成 |
| GET /auth/callback | code,state | 認証後session cookie設定。所属userが未登録/無効なら403 |
| POST /auth/logout | CSRF | session無効化、cookie解除、204 |
| GET /api/v1/me | cookie | user、organization、csrf_token。tokenや所属一覧を返さない |

1ユーザー1組織。組織切替APIは存在しない。別の役割で試すときは別アカウントでログインする。

## 求人・候補者・文書

| Method / Path（/api/v1以下） | 入力 | 応答・認可 |
| --- | --- | --- |
| GET /jobs | q,location,employment_type,favorited,cursor,limit | agencyは公開のみ、employerは自社の全状態 |
| POST /jobs | title,description,location,employment_type | employer、draft作成201 |
| GET /jobs/:id | なし | employerは自社、agencyは公開求人のみ |
| PATCH /jobs/:id | version、編集する列 | 自社employer、closedは不可、job lock取得 |
| POST /jobs/:id/status | version,status | 自社employer、draft→published/published→closed、job lock取得 |
| PUT /jobs/:id/favorite | なし | agency、公開求人を自社へ保存、冪等204 |
| DELETE /jobs/:id/favorite | なし | agency、自社保存の解除、募集終了後も204 |
| GET /candidates | q,cursor,limit,archived | 自社agencyのみ |
| POST /candidates | name,summary,fictional_confirmed=true | 自社agency、201 |
| GET /candidates/:id | なし | 自社agency、PDFのstatus/rejection_codeも含む |
| PATCH /candidates/:id | version,name,summary | 自社agency |
| POST /candidates/:id/archive | version | 自社agency、アーカイブ |
| POST /candidates/:id/documents | multipart PDF、fictional_confirmed=true | 自社agency、readyなら201、処理中なら202、PDF拒否は422 |
| GET /documents/:id | なし | 自社agency、status/rejection_code/再試行案内、200 |
| POST /documents/:id/retry | なし | 自社agencyかつ元の登録user、lease切れpendingを復旧。readyは200/lease有効pendingは202/rejectedは409 DOCUMENT_REJECTED。document IDとleaseで冪等、追加key不要 |
| GET /documents/:id/content | なし | 自社agencyのready文書、PDF attachment |
| GET /applications/:id/documents/:document_id/content | なし | A_OWNERまたはE_SHARED、選択済み共有行からPDFを取得 |

求人のemployer_nameはサーバーが自社組織名から設定して返し、編集入力には含めない。employment_typeはfull_time/contract/part_time、description/summary最大10,000文字。PDFは最大10MiB、詳細な対応範囲は安全性設計を参照。storage_key/staging_keyは返さない。アップロード202にはdocument_idとstatus URLを返し、取得間隔は初期2秒とする。lease切れのpendingには元の登録者がretryを要求できる。利用者操作が必要な障害では自動再送を止める。

## 推薦・選考・請求・通知

| Method / Path（/api/v1以下） | 入力 | 応答・条件 |
| --- | --- | --- |
| POST /applications | candidate_id,job_id,reason | 自社agency、公開求人へdraft作成 |
| GET /applications | status,cursor,limit | agencyは自社、employerは自社案件のdraft以外 |
| GET /applications/:id | なし | A_OWNER、または自社求人へのsubmitted_atがある案件のmetadata（withdrawnも含む） |
| PATCH /applications/:id | version,reason | A_OWNER、draftのみ |
| POST /applications/:id/submit | version,candidate_version,job_version,document_ids,fictional_confirmed,consent_confirmed | A_OWNER、draftかつ未撤回、両確認true、ready文書1件以上 |
| POST /applications/:id/transition | version,to_status,reason | 下記状態表。rejected/withdrawnのreason必須 |
| POST /applications/:id/revoke-sharing | version,reason | A_OWNER、下記撤回表。reason必須 |
| GET /applications/:id/invoice-preview | なし | status=hired AND (A_OWNER OR E_SHARED)、デモ金額/宛先 |
| GET /applications/:id/invoice-preview.pdf | なし | 同条件、PDF bytes、Content-Disposition:inline |
| GET /notifications | cursor,limit | 自組織の未送信通知のみ |

A_OWNER/E_SHAREDは[DB設計](04-data-model.md)の定義をAPI・RLSで共用する。企業の候補者snapshot・PDFはE_SHAREDに限り返す。企業がwithdrawn/撤回済み案件を開く場合は案件ID・求人/組織名snapshot・状態・イベントの種類/時刻だけを返し、候補者snapshot・document参照・自由記入reasonを省略する。候補者と求人の原本へJOINしない。

共有の有効性を判定するAPIでは、判定クエリ時点をアクセス許可時点とする。撤回commit後に始まる取得は拒否する。許可済みのstreamやダウンロード済みbytesの回収までは保証しない。v0.1は署名URLを配布しない。

## 状態と撤回の表（R1/R4）

| 操作 | 元状態 | 実行組織 | 結果 |
| --- | --- | --- | --- |
| submit | draftかつ未撤回 | agency | submitted、共有snapshot作成 |
| transition screening | submittedかつ共有有効 | employer | screening |
| transition rejected | submitted/screeningかつ共有有効 | employer | rejected |
| transition hired | screeningかつ共有有効 | employer | hired、placementを一度作成 |
| transition withdrawn | submitted/screening | agency | withdrawn、share_revoked_atを同時設定 |
| revoke-sharing | draft | agency | 409 SHARE_NOT_STARTED、変更なし |
| revoke-sharing | submitted/screening | agency | withdrawn、share_revoked_at設定、transitionイベント1件 |
| revoke-sharing | rejected/hired、まだ共有有効 | agency | 状態維持、share_revoked_at設定、sharing_revokedイベント1件 |
| revoke-sharing | withdrawnまたは既に撤回済み | agency | 新キーなら現在version確認後200 no-op、同キーなら完了結果参照。イベント/通知を増やさない |

撤回で変更があった場合だけversionを増やし、event・未送信通知・監査を同じtransactionへ記録。hiredの撤回でもplacementは維持し、自社agencyはデモ請求PDFを引き続き読める。企業はE_SHARED失効により読めない。再共有/終端状態の復帰は設けない。rejected/withdrawnから再推薦するなら新しいapplicationを作る。hiredは同じ候補者/求人への再推薦を許可しない。

表以外の遷移は409 INVALID_TRANSITION、version不一致は409 VERSION_CONFLICT。企業の共有失効後の変更要求は403 SHARING_REVOKED、無関係な組織は404。提出前・共有撤回済みの共有PDF取得は404。

## 請求PDF：固定1ページ

A4縦・1明細・固定デモ金額500,000円・1ページ。IDはDEMO-{placement_id}、日付は採用決定日。宛先/発行者は推薦時に保存したemployer_name_snapshot/agency_name_snapshot、税額は「未計算」、支払い先・期日・登録番号は表示しない。上部/下部に「デモ用・実際の請求には使用できません」。候補者氏名・経歴は載せない。

組織名は表示用に最大40書記素までに省略し、各欄は最大2行、続きは省略記号で示す。日本語フォントを同梱、日付・金額・IDは固定欄に置く。全文の組織名はPDF前の画面で確認できる。テンプレートに自由な明細や追加ページを持たせない。

レンダラーはフォント読込み後に配置と生成PDFのpage count=1を確認する。2ページ以上/枠外なら503 PDF_LAYOUT_ERRORで失敗させ、読めない縮小や強制的なページ切捨てをしない。同じplacementの再表示ではplacementを増やさない。障害は503 PDF_UNAVAILABLE、10秒timeoutは504 PDF_TIMEOUT。利用者が再試行できる表示を出す。

## 可観測性

/liveはプロセス応答、/readyはDB/migration、保存領域、PDF service疎通を確認する。外部へ依存先の詳細を出さない。request_idを応答とlogに共通化し、認可失敗・状態変更・文書取得を記録する。rollbackした業務transactionに拒否監査を依存させず、拒否記録は秘密を含まない独立したsecurity logへ出す。
