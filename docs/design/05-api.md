# API契約

> **2026-10-16：設計v0.5の追加契約（未実装）**
> 以下のmultipart、原本/content、invoice-preview.pdf、署名URL不使用は現行APIの契約。新API/7日照合・旧配信閉鎖は追加設計に従う。署名認可はupload用に限定し、閲覧用署名GET URLは導入しない。 正本は[署名付き・暗号化アップロードと安全な閲覧](12-secure-document-pipeline.md)。以下の実装済み機能が新方式へ変更済みという意味ではない。

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

同一キーの並行要求はlockで待ち、先行commit後に結果を参照する。3秒の待ち上限で503 RETRYABLE_BUSY、同じキーで再試行可能。別キーでの二重推薦にはDBの部分一意制約を適用し409 DUPLICATE_APPLICATION。通常のJSON業務要求のcompleted記録は完了から24時間保持する。v0.4改訂2のuploadは完了/拒否から7日間保持し、期限後もexpired tombstoneで同キー再実行を禁止する。response bodyの完全一致ではなく、同じ操作結果/resourceへの参照を保証する。

PDF/XLSXアップロードはDBとファイルをまたぐ。multipartの実bytesをstagingへ保存して算出したSHA-256と、候補者ID・正規化表示名・形式・書類種別・架空データ確認をrequest_hashに使う。v0.4でpayload契約を変更するため、旧キーは旧scope/versionとして照合し、新payloadに再利用しない。現在の認証・所有確認→staging/hash→冪等lock/既存結果の確認→新規だけ非アーカイブ確認と予約→検査→確定の順序とし、復旧も同じdocument IDを使う。完了済み要求は候補者のアーカイブ後も、現在の閲覧認可で同じ結果/resourceを参照できる。新キーのアーカイブ済み候補者への登録は409 CANDIDATE_ARCHIVED。詳細と中断時の扱いは[安全性設計](06-security.md)を正本にする。

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
| POST /candidates/:id/documents | multipart PDF/XLSX、fictional_confirmed=true、document_kind | 自社agency、readyなら201、処理中なら202、検査拒否は422、検査障害はpending/503 |
| GET /documents/:id | なし | 自社agency、status/rejection_code/再試行案内、200 |
| POST /documents/:id/retry | なし | 自社agencyかつ元の登録user、lease切れpendingを復旧。readyは200/lease有効pendingは202/rejectedは409 DOCUMENT_REJECTED。document IDとleaseで冪等、追加key不要 |
| GET /documents/:id/content | なし | 自社agencyのreadyかつ検査利用可の文書、形式別attachment |
| GET /applications/:id/documents/:document_id/content | なし | A_OWNERまたはE_SHARED、選択済み共有行と検査可否からPDF/XLSXを取得 |

求人のemployer_nameはサーバーが自社組織名から設定して返し、編集入力には含めない。employment_typeはfull_time/contract/part_time、description/summary最大10,000文字。PDF/XLSXは各最大10MiB、詳細な対応範囲は安全性設計を参照。storage_key/staging_keyは返さない。アップロード202にはdocument_idとstatus URLを返し、取得間隔は初期2秒とする。lease切れのpendingには元の登録者がretryを要求できる。利用者操作が必要な障害では自動再送を止める。

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

表以外の遷移は409 INVALID_TRANSITION、version不一致は409 VERSION_CONFLICT。企業の共有失効後の変更要求は403 SHARING_REVOKED、無関係な組織は404。提出前・共有撤回済みの共有書類取得は404。

## 請求PDF：固定1ページ

A4縦・1明細・固定デモ金額500,000円・1ページ。IDはDEMO-{placement_id}、日付は採用決定日。宛先/発行者は推薦時に保存したemployer_name_snapshot/agency_name_snapshot、税額は「未計算」、支払い先・期日・登録番号は表示しない。上部/下部に「デモ用・実際の請求には使用できません」。候補者氏名・経歴は載せない。

組織名は表示用に最大40書記素までに省略し、各欄は最大2行、続きは省略記号で示す。日本語フォントを同梱、日付・金額・IDは固定欄に置く。全文の組織名はPDF前の画面で確認できる。テンプレートに自由な明細や追加ページを持たせない。

レンダラーはフォント読込み後に配置と生成PDFのpage count=1を確認する。2ページ以上/枠外なら503 PDF_LAYOUT_ERRORで失敗させ、読めない縮小や強制的なページ切捨てをしない。同じplacementの再表示ではplacementを増やさない。障害は503 PDF_UNAVAILABLE、10秒timeoutは504 PDF_TIMEOUT。利用者が再試行できる表示を出す。

## 可観測性

/liveはプロセス応答、/readyはDB/migration、保存領域、PDF service疎通を確認する。外部へ依存先の詳細を出さない。request_idを応答とlogに共通化し、認可失敗・状態変更・文書取得を記録する。rollbackした業務transactionに拒否監査を依存させず、拒否記録は秘密を含まない独立したsecurity logへ出す。


## M2で確定した補足

- candidateのアーカイブは不可逆。アーカイブ後のPATCHと新キーのarchiveは409 CANDIDATE_ARCHIVED。同じ完了キーのarchive/作成は現在のDTOを返し、versionや監査を増やさない。
- 一覧はcreated_at/id降順、candidateは既定で非アーカイブ、archived=trueはアーカイブ済みのみ。求人のfavoritedはagencyだけで使用できる。検索locationも1〜100文字、qは求人名/仕事内容または候補者氏名/概要の部分一致。
- cursorは日時・ID・組織/検索条件/limitのhashをbase64url化する。条件が変わったcursorは422。署名や認可には使用せず、すべてのページでRLSを適用する。
- M3ではcandidate詳細のdocumentsを実際の文書に接続し、登録・状態・retry・原本取得を実装。M4の共有文書取得APIは後続。
- job lockは各要素のUTF-8 byte長をunsigned 64bit big endianで前置し、`job`と小文字UUIDをSHA-256、先頭8byteをsigned 64bit big endianへ変換。冪等lockは同じ形式で`idem`とorg/user/method/path/keyを順番に使う。M4もこの関数を共用する。
- 通常JSONの上限は64KiB。文字数上限と別にbyte上限を設ける。JSONの入力不正にはfield_errorsを付ける。

RLSとtransaction timeoutは[PostgreSQL 17の公式資料](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)と[接続設定](https://www.postgresql.org/docs/17/runtime-config-client.html)を参照し、実装で検証する。

## v0.4の追加API契約（未実装）

[追加仕様のデータ/API節](10-resumes-and-autosave.md#5-個人下書きのデータapi)を正本とする。/draftsの本人専用保存・復元・版指定の鍵取得・outcome・discard、業務要求のdraft_id/draft_revision/operation_id（APIでは3項目まとめて省略可、v0.4の入力フォーム確定では必須）、既存原本の/documents/:id/recheckを追加する。draft JSONだけ96KiB、通常JSON64KiBを維持する。

upload結果はGET /candidates/:id/document-upload-outcome?key=:uuidで、本人の認証/自社候補者/元登録userを確認して7日間照合できる。document ID未取得でも元キーから同じ結果へ復帰する。期限以後は照合/同キーPOSTとも409 OPERATION_RESULT_EXPIRED、not_recordedは未実行の保証としない。別キーの自動再送を禁止し、現在の検査利用可否/認可も維持する。[uploadの7日契約](10-resumes-and-autosave.md#アップロード結果の7日照合と期限後の再実行禁止再レビューp2)を正本とする。

新文書DTOと共有文書DTOにはfile_format/media_type/document_kind、利用可否availability（pending/available/blocked/recheck_required）を追加する。登録中のstatusと利用可否を区別する。原本の検査engine/署名DB/hash/保存keyは内部専用。共有失効時は形式・種類を含む共有文書のkey自体を返さない。uploadは1要求1ファイルのまま、種類と形式を冪等hashへ加える。旧APIの結果を新policy合格と解釈しない。

業務要求は送信前の暗号化送信予定とdraft_operationsのcommit結果をoperation_idで照合する。POSTではIdempotency-Keyと同じUUID、PATCHでもdraft連動の操作IDを使う。通常冪等記録の24時間後も7日間の結果台帳を先に照合し、期限後は同操作の再実行を禁止する。outcomeはconsume後も本人/現在権限で結果metadataだけ返す。旧鍵はPOST /drafts/keyのkey_version指定で本人の未失効版だけ取得し、別user/存在しない版404、本人の失効版409 DRAFT_KEY_REVOKED。詳しい状態・順序は追加契約に従う。

形式別のattachment名とmedia_type、AV/構造の両合格・blocked優先・既存共有参照の再検査可否を原本/共有両経路で検証する。/retryのreadyは登録済みの意味であり、利用可否は別途返す。readyの旧原本への再検査は/recheckで行う。

## M3実装の補足（2026-10-15、v0.4追加対応前の実装記録）

multipartのfile項目は1件だけ、Content-Typeはapplication/pdf。fictional_confirmed=trueも必須で、fileより前に送る。確認項目を検証してからbytesを受信する。未知/重複項目を拒否する。表示名は区切り文字以前のpathを落として前後空白を除き、制御文字・空・255文字超を拒否する。ファイル受信は30秒、実bytesは10MiB、multipart全体は10MiB+64KiB。gatewayの11MiB上限はこのupload routeだけに適用し、JSONの64KiB制限を維持する。

文書DTOはid/document_id、candidate_id、original_name、size_bytes、status、rejection_code、created_at/updated_at、status_url、retry_allowed、lease_expires_at。leaseのtoken・ファイル保存key・SHAは返さない。期限情報とretry可否は元登録者のpendingにだけ返す。拒否済みuploadの応答にもerror.document_id/status_urlを含め、現在の状態へたどれる。同じキーの拒否codeは正規化した利用者向けcodeで一貫させる。

原本downloadは保存size/hash確認後のbytesをattachment; filename="resume.pdf"で返す。元表示名は画面に表示し、HTTP headerへ生の入力を埋め込まない。候補者のアーカイブは既存ready文書の自社閲覧を失効させない。

## M4で確定した補足（2026-10-15、v0.4追加対応前の実装記録）

推薦の一覧はupdated_at/id降順、limit初期20/最大100。cursorは組織・状態filter・limitに結び付け、条件変更は422。通常runtimeのapplicationsと、RLS適用済みapplication_snapshotsを一度のqueryで読む。求人原本や他組織organizationsを追加権限で読まない。

詳細DTOはid/status/version/job_id/created_at/updated_at/submitted_at/share_revoked_at/sharing_activeを持つ。提出後はjob_snapshotに提出時の求人内容・両組織名を返す。自社agencyにはcandidate_idを返す。候補者snapshot・推薦reason・documentsはA_OWNERまたはE_SHAREDのみ。共有失効後のemployerにはこれらのkeyとplacementを省き、eventsの自由記入reasonも省く。一覧のcandidate_nameもRLSで不可視ならkeyを省く。保存先keyとSHAはDTOに出さない。

POSTの完了キーは現在の読取り認可で現在DTOを返す。企業の選考操作の完了後に共有が失効した場合も、同キーなら機密本文を除いたmetadataを返す。新キーの選考は403 SHARING_REVOKED。revoke-sharingの新キーno-opは現在versionを確認し、version/event/通知/監査を増やさず、冪等記録だけを完了にする。

下書き作成では非公開/存在しない求人を404、提出時に閉じた求人は409 JOB_NOT_OPEN。提出に使うdocument_idsは非空・重複UUIDなしで、同候補者の自社ready文書だけを受け付ける。候補者または求人の版が変わっていれば409、snapshot・共有参照・event・通知・冪等記録を残さずrollbackする。

画面は一覧と詳細を2秒間隔およびfocus/再表示時に再取得し、共有失効を確認したら企業の候補者本文・PDFリンクを除く。下書きの他者更新は入力を自動で上書きせず、明示的な再読込みを求める。認証失効時は未保存の推薦理由だけを無効なtextareaで保持し、所属・候補者・PDFを隠す。ログアウトは機密状態を破棄する。

## R1の実装差分

文書uploadにはfileより前に`fictional_confirmed=true`と`document_kind=resume|career_history|other`が必須。PDF/XLSXの対応MIMEと拡張子を照合し、octet-streamは構造一致時だけ許可する。正常な形式検査の完了は202/pendingで、R2前はAV待ち。DTOはfile_format/media_type/document_kind/format_checked/inspection_state/availableを持ち、保存先や検査hashは返さない。

原本・共有のcontentと推薦提出は、statusだけでなくdocument_checksの対応policy cleanとblockedなしを要求する。共有snapshotの形式を使ってresume.pdf/resume.xlsxのattachmentを返し、企業には原本SELECTを与えない。旧ready PDFもAV記録なしなら404で配信拒否。

`GET /candidates/:id/document-upload-outcome?key=`の本人7日照合と期限後409を実装。`POST /documents/:id/recheck`はR1では認可/blocked確認までで、実AV未提供なら503。その他draft系と実再検査jobは後続段階。詳細は[最新契約](10-resumes-and-autosave.md)を参照する。

## R2 実装契約（2026-10-16）

実AV→形式検査が両方合格した新規uploadは201/ready、retryは200。技術障害は503 SCANNER_UNAVAILABLE/PDF_UNAVAILABLEでpendingと元操作keyを維持する。エラーのdocument_id/status_urlから状態を取得し、期限切れleaseを同一書類で再試行できる。検出は422 MALWARE_DETECTED。blockedは取消不可で配信/推薦を拒否する。

旧readyの元登録者はPOST /documents/:id/recheckにIdempotency-Keyを付ける。document単位job・120秒leaseで重複実行を制御し、失敗したjobは同じ操作keyで再試行する。既に利用可能なら現在結果を返す。原本/policy/提出snapshotを更新しない。agency以外・別組織・元登録者以外は404、blockedは409 DOCUMENT_BLOCKED。新規合格の鮮度/世代条件と、既存cleanが障害だけでは日次失効しない境界は[追加契約](10-resumes-and-autosave.md#4-ウイルス検査と隔離)に従う。

登録/実検査再試行の頻度上限は429 DOCUMENT_RATE_LIMITED/Retry-After:60、受信予約を含む容量上限は413 STORAGE_QUOTA_EXCEEDED。旧R1の202/AV待ちという正常応答はR2前の履歴である。
