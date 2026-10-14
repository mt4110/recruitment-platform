# API契約

## 共通契約

業務APIは /api/v1、JSONはsnake_case。UUID・日付・列挙値の不正は422。認証なし401、組織種別の不許可403、存在しないまたは他組織所有のresourceは同じ404を返す。入力構造不正400、競合409、アップロード超過413、回数超過429、予期せぬ障害500。失敗JSONはerror.code/message/request_id/field_errors（入力時のみ）を含む。

成功時は単体オブジェクト、一覧はitemsとnext_cursor。limit初期20、上限100。created_at/id等の安定したカーソル順でページングする。qとfilterを変えたらカーソルを破棄する。業務応答・PDFはCache-Control: private, no-store。

更新・状態遷移はversion整数必須。対象行をversion条件で更新し、0件なら409 VERSION_CONFLICT。状態遷移のPOSTはIdempotency-Key UUIDを必須にする。POSTの再試行で別案件を作らないため、作成APIも同キーを受け付ける。

冪等記録は(active_org_id,user_id,route,key)を一意にし、request_hash・resource_id・result_statusを業務更新と同じtransactionに保存、24時間保持。同一キー・異なるpayloadは409 IDEMPOTENCY_MISMATCH。再要求時も現在の認可を確認し、共有撤回後に過去のPII応答を返さない。

## 認証・所属

| Method / Path | 入力 | 応答・条件 |
| --- | --- | --- |
| GET /auth/login | なし | OIDCへのリダイレクト。state/nonce/PKCE作成 |
| GET /auth/callback | code,state | 認証検証後session cookieを設定。所属なしは403 |
| POST /auth/logout | CSRF | session無効化、cookie解除、204 |
| GET /api/v1/me | cookie | user、memberships、active_org、csrf_token。秘密OIDC tokenは返さない |
| POST /api/v1/session/organization | organization_id、CSRF | 有効所属を検証しactive_orgとCSRF tokenを更新 |

## 求人・候補者・文書

| Method / Path（/api/v1以下） | 入力 | 応答・認可 |
| --- | --- | --- |
| GET /jobs | q,location,employment_type,favorited,cursor,limit | agencyは公開のみ。employerは自社の全状態 |
| POST /jobs | title,description,location,employment_type | employerのみ、draftで作成、201 |
| GET /jobs/:id | なし | 自社または公開求人。200 |
| PATCH /jobs/:id | version、編集する列 | 自社employer。公開中は変更可、closedは変更不可 |
| POST /jobs/:id/status | version,status | 自社employer。draft→published、published→closed |
| PUT /jobs/:id/favorite | なし | agency、自組織保存、冪等、204 |
| DELETE /jobs/:id/favorite | なし | agency、保存解除のみ、204 |
| GET /candidates | q,cursor,limit,archived | agency自社のみ |
| POST /candidates | name,summary,fictional_confirmed=true | agency、201 |
| GET /candidates/:id | なし | agency自社のみ、document metadata含む |
| PATCH /candidates/:id | version,name,summary | agency自社のみ |
| POST /candidates/:id/archive | version | agency自社のみ、アーカイブ |
| POST /candidates/:id/documents | multipart PDF、fictional_confirmed=true | 自社候補者、10MiB上限、readyなら201 |
| GET /documents/:id/content | なし | agency自社のみ、application/pdf、attachment |
| GET /applications/:id/documents/:document_id/content | なし | 関係組織、提出済み、共有撤回なし。PDF bytes |

employment_typeはfull_time/contract/part_time。description/summary最大10,000文字。PDF名は表示用に正規化し、保存パスに使わない。文書原本のURLを企業へ返さない。

## 推薦・選考・請求・通知

| Method / Path（/api/v1以下） | 入力 | 応答・条件 |
| --- | --- | --- |
| POST /applications | candidate_id,job_id,reason | agency、draft作成。共有先をjobから決定 |
| GET /applications | status,cursor,limit | 関係組織。企業にdraftは返さない |
| GET /applications/:id | なし | draftはagencyのみ。それ以外は関係組織 |
| PATCH /applications/:id | version,reason | agency、draftのみ |
| POST /applications/:id/submit | version,candidate_version,document_ids,fictional_confirmed,consent_confirmed | 全確認=true、ready文書1件以上。snapshotを作成しsubmittedへ |
| POST /applications/:id/transition | version,to_status,reason | state表に従う。reasonは不採用・辞退時に必須 |
| POST /applications/:id/revoke-sharing | version,reason | agencyのみ、share_revoked_at更新、企業の候補者アクセス失効 |
| GET /applications/:id/invoice-preview | なし | hiredかつ共有有効な関係組織。架空の金額と宛先 |
| GET /applications/:id/invoice-preview.pdf | なし | 同条件。PDF bytes、Content-Disposition:inline |
| GET /notifications | cursor,limit | 自組織の未送信通知のみ |

application詳細のDTOは、job、status、version、events、candidate_snapshot、shared_documents、allowed_actions。draftでは自社candidateを表示。提出後のjobは提出時点のsnapshotを返し、現在の公開状態は別の列で示す。withdrawnまたは共有撤回後の企業DTOは候補者snapshot/document情報と自由記入のreasonを省略し、イベントは状態と時刻だけを返す。allowed_actionsは操作案内であり、実行APIでも再認可する。

状態遷移とイベント・通知・placementは同一transaction。submitted→screening/rejectedはemployer、screening→hired/rejectedはemployer、submitted/screening→withdrawnはagency。共有撤回後の企業の状態変更は403、agencyの辞退は可能。状態が変わった場合は409 INVALID_TRANSITION。

## 請求PDFの仕様

placementごとに固定ID DEMO-{placement_id}を使う。宛先・発行者は架空の組織名、紹介料は500,000円の例示値。税額は「未計算」、支払い先・期日・登録番号は表示しない。上部とフッターに「デモ用・実際の請求には使用できません」を入れる。実請求額、税務書類、発行・入金状態を保存するAPIは作らない。

同じ採用案件を繰り返し表示してもplacementは増えない。レンダラー障害は503 PDF_UNAVAILABLE、10秒timeoutは504 PDF_TIMEOUT。ブラウザ側には再試行ボタンを出す。

## 可観測性

/liveはプロセス応答、/readyはDB接続とmigration version、ストレージ書込み可否、PDF renderer疎通を確認する。外部には依存先情報を露出しない。request_idを応答とサーバーログに共通化し、認可失敗・状態変更・PDF取得を監査する。
