# 署名付き・暗号化アップロードと安全な閲覧

2026-10-16 / 設計 v0.5 改訂1（レビュー5件を反映。実施状況は第1節と各段階の記録を参照）

## 1. 適用範囲と優先順位

初版は設計・工数整理・Git反映までの承認で作成した。その後の明示承認で[S0技術確認](../validation/2026-10-16-s0-report.md)だけを実施し両archで成立。その後のS1承認に基づき暗号化受付を実装・検証完了（[S1記録](../validation/2026-10-16-s1-report.md)）。S2の鍵管理・隔離ワーカーを実装・E2E・最終CIまで確認（[S2記録](../validation/2026-10-16-s2-report.md)、[実装契約](14-s2-worker-contract.md)）。S3の安全な閲覧・旧配信閉鎖は実装・ローカル13件・Linux/amd64全体137件まで確認（[S3記録](../validation/2026-10-16-s3-report.md)、[実装契約](15-s3-safe-view-contract.md)）。S4の暗号化コピー・旧鍵／DB／blob復旧も隔離環境で実装・検証した（[S4記録](../validation/2026-10-16-s4-report.md)、[実装契約](16-s4-migration-contract.md)）。S5の横断検証・性能計測は両archの基準全体CIと最終差分CIで確認した（[S5記録](../validation/2026-10-16-s5-report.md)、[検証契約](17-s5-verification-contract.md)）。R5の暗号化端末保存・復元も[R5記録](../validation/2026-10-17-r5-report.md)で先行全体と最終差分の両native CIで確認した。外部公開は行っていない。M6の監査指摘による受入保留、R6・M7の停止条件は維持する。実在の求職者情報は禁止する。

本書は01〜10のうち、アップロード経路、原本保存、閲覧、検査と生成のサービス境界を変更する正本。旧文書の原本attachment配信・請求PDF inline配信・署名URL不使用・同一PDFサービスという記述は現行実装/v0.4の契約として残し、新方式には適用しない。認証、1ユーザー1組織、A_OWNER/E_SHARED、選択版snapshot、共有撤回、7日結果照合、全フォーム下書きの契約は維持する。プレミアム/AI構想・クラウドサイン連携は対象外。

| 項目 | 現行実装（M5/R4まで） | 新方式の完成条件 |
| --- | --- | --- |
| 受付 | Rust APIがmultipartを受信 | 署名付きの限定認可で暗号文を受信。Nextを経由しない |
| 保存 | API専用volumeの原本。下書きの暗号化とは別 | 原本・閲覧用成果物ともアプリケーション暗号化。TLSも必須 |
| 検査 | 実AV、PDF/XLSX構造検査、利用可否判定 | 既存判定を再利用し、隔離ワーカーで復号・検査・閲覧用変換 |
| 表示 | 認可後のPDF/XLSX原本取得、請求PDF表示 | 認可後の制御したHTML/テキスト/ページ画像。原本配信経路は閉じる |
| サービス | 書類検査と請求生成が同一サービス | 不信な書類処理と信頼済み請求テンプレート生成を分離 |

PDF/XLSXのアップロード必須要件は維持する。署名はアップロード権限の証明であり、本人の電子署名・無害性の証明ではない。署名認可、暗号化の認証タグ、AV/形式検査、閲覧時認可を別の防御として扱う。

## 2. 経路と信頼境界

1. ブラウザが認証済みAPIへ受付を予約する。APIは現在の本人/組織/候補者所有・アーカイブ状態、CSRF/Origin、容量/quotaを確認し、受付IDと暗号化用公開鍵の版・暗号contextを返す。
2. ブラウザがPDF/XLSXを暗号化し、暗号文のサイズ/hashを確定する。APIへ署名認可を要求し、特定受付・保存先・method・暗号文hash/サイズに限定した短期ticketを取得する。
3. ブラウザから専用受信経路へ暗号文を直接送る。初期対象はLocalBlobStoreの専用受信API。クラウドでは検証済みのオブジェクトストレージadapterへ置換可能とするが、今回クラウド製品を選定・構築しない。
4. APIが保存結果を照合し、同じ受付IDの処理ジョブを確定する。ワーカーは限定したジョブ権限で暗号文を取得・復号し、実AV→形式検査→閲覧用変換の順に処理する。
5. 原本hash、検査世代、変換policy、成果物hashを束ねて確定する。利用可能な選択版だけ推薦でき、閲覧はAPIの現在認可を経由する。

Nextには原本volume・復号秘密鍵・DB資格情報を渡さない。受付APIも復号秘密鍵を持たず、専用ワーカーだけが復号する。検査のためバックエンドは復号可能であり、サーバーが一切読めないE2EEとは呼ばない。TLS終端/CDNはファイル本体の暗号文だけを見るが、認証・metadata・配信画面は別の保護対象。

復号・成果物暗号化を担当するdocument brokerと、不信な原本を解析するsandboxは別コンテナ/実行identity/PID・mount namespaceに分ける。同じコンテナの子プロセスへ鍵を渡さないだけでは隔離成立としない。現在の内部scannerにはbrokerから上限付き平文を渡し、AV定義更新専用経路との分離を維持する。

| 担当 | 鍵・保存領域 | 許可する通信/入力 |
| --- | --- | --- |
| document broker | 原本復号用secret、成果物wrap用公開鍵、ジョブ限定の暗号blob。不信parserは動かさない | 固定のAPIジョブ窓口、blob、内部AV、鍵なしI/O relayのみ。外向き通信なし |
| I/O relay | 鍵/DB/原本volumeなし。ジョブID・一時認可だけ | brokerとsandbox間の長さ制限付きバイト列・固定schema応答。汎用proxy/任意URL/パスを受け付けない |
| 構造検査/変換sandbox | 鍵/DB/blob/ホストmountなし。ジョブ専用tmpfsだけ | relayとの専用内部経路のみ。broker/API/AV/他ジョブ/請求/外部へ到達不可 |
| 閲覧API | 成果物専用の復号secretと現在認可。原本復号secretなし | 確定した成果物だけ復号。原本blobの復号要求を受け付けない |
| 請求生成 | 書類用鍵/volumeなし | 固定請求schemaのみ。書類sandboxから到達不可 |

sandboxは非root/read-only、capability全drop、no-new-privileges、別PID namespace、seccompと資源制限を必須にする。host PID、privileged、Docker socket、brokerの/proc・secret・Unix socketの共有は禁止。環境変数/継承FDにも秘密を置かず、必要なI/O以外を継承しない。ジョブ間の平文を残さないよう、1隔離単位1ジョブとし、終了後にそのtmpfs/プロセスを終了する。既存ready/証拠/バックアップの削除は含めない。アプリ/relayにコンテナ起動用のホスト管理権限を渡さず、初期の起動・終了は信頼したローカル管理側で行う。

brokerはAEAD認証完了前の平文をAV/構造検査/変換へ流さない。sandboxからの応答は上限/固定schema/成果物種別を照合し、任意HTML/SVG、保存先、コマンド、外部URLを採用しない。これも未知のsandbox脱出を防ぐ保証ではなく、S0でmount/identity/到達性/FDの実証を残す。暫定資源上限とS0の合否は[確認計画](13-s0-verification-plan.md)を正本とする。

ワーカーの処理はdocument IDを限定した短期ジョブ認可とlease/CASで行い、組織横断の汎用DB権限を追加しない。APIが現在状態を確認してジョブを払い出し、結果commit時にもlease・版・所有・アーカイブ/検査状態を照合する。無効化された本人/組織の処理から利用可能へ昇格させない。

## 3. 暗号化と鍵の契約

- 初期候補はWeb CryptoのAES-256-GCM、ファイルごとのランダムDEK、96bit nonce、128bit tag。公開鍵によるDEKのwrapはRSA-OAEP/SHA-256・3072bit以上を候補にする。暗号実装を自作せず、相互運用・依存・鍵強度・資源をS0で確認して確定する。不成立時は代案を提示し、平文uploadへ自動降格しない。
- 鍵の版、upload/document ID、attempt ID、org ID、形式、schema versionをサーバーが正規化した固定encodingでAADへ結び付ける。初回予約/新attempt作成時にIDとcontextを払い出してから暗号化し、authorizeで後から別contextへ変えない。client自己申告のorgを認可根拠にしない。ファイル名等のPIIは暗号化metadata内へ置き、URL/object keyには入れない。
- 1ファイルは平文10MiBまで。初期案は1回のAEAD操作とし、独自chunk暗号方式やmultipartは作らない。暗号化前payloadは4byteのmetadata長（big-endian）、UTF-8 JSON metadata（最大4KiB）、原本bytesの順。暗号文長はpayload長+16byteのtag、外側envelopeは最大8KiBのJSON（schema/key版、wrapped DEK、nonce、AAD参照）。外側にファイル名を含めない。平文ファイル/暗号文/復号後/展開後の制限を別々に検証する。暗号化/転送は端末ごと初期1件とし、メモリ増加をS0で測定する。
- 同じ受付の転送再試行は同じ暗号文/envelopeを使う。再暗号化時は新DEKとnonceを作り、新しい転送attemptへbindする。過去のhashと異なる暗号文を既存ticketへ送らない。再認証/再起動後の復旧規則は第5節に従う。
- 署名ticket鍵、wrap用秘密鍵、成果物暗号鍵、既存DRAFT_MASTER_KEYは用途と版を分ける。秘密鍵はGit/ブラウザ/Next/ログへ渡さず、ローカルはworker専用secret、クラウドは鍵管理サービスを候補とする。鍵取得/復号権限の監査とバックアップ復元を受入対象にする。
- 旧版秘密鍵は参照中の原本/成果物を復号できる期間保持し、ローテーションで一括失効させない。漏えい時は当該版を利用停止し、復旧/再wrap・再暗号化を管理操作として扱う。鍵がない・失効・tag不一致では処理/配信を停止する。
- 閲覧用成果物の暗号化単位はページ画像1枚、抽出テキスト1個、XLSX正規化表1個、manifest1個とする。brokerが各個に新しいランダム256bit DEK/96bit nonceを生成しAES-GCM/128bit tagで暗号化する。原本や別成果物のDEKを流用しない。再生成は同じページでも新しいgeneration/成果物ID・DEK・nonceで行い、保存済み暗号文の再送だけはそのまま使う。
- 成果物DEKは成果物専用RSA-OAEP/SHA-256公開鍵でwrapし、閲覧APIだけが対応する復号secretを持つ。brokerはその公開鍵のみを持ち、sandbox/relayはDEKを受け取らない。原本復号鍵と成果物復号鍵を共有しない。AADはschema/org/document ID・不変原本版/原本hash・変換policy・generation/成果物ID・種別・ページ番号（非ページはnull）・鍵版を固定順/encodingで含む。manifestと各成果物の対応・hashも検査し、差替え/別ページへの付替えを拒否する。
- 成果物envelopeには暗号schema/鍵版、wrapped DEK、nonce、AAD版/参照と暗号文hash/長さを記録する。旧鍵復旧・失効確認・保持規則は原本/成果物それぞれに適用する。成果物復号もtag検証を終えてから配信し、不一致時に一部をstreamしない。漏えいした鍵で過去に取得された暗号文の秘密は復元できない。DEK漏えいが疑われる場合は再wrapだけで済ませず、新DEKによる再暗号化と参照切替を管理操作にする。

ブラウザ暗号化は侵害されたフロントエンドJSから原本を守れない。CSP、依存更新、第三者script制限、Nextの権限縮小を併用する。保存時暗号化やPDF passwordを無害化の代替にしない。

## 4. 署名認可・容量・差替え防止

ticketの初期有効期間は5分（設計初期値、性能保証ではない）。再認可しても期限はmin（今回発行時刻+5分、attempt初回認可+15分、受付予約+24時間）とする。用途/audience、upload ID、attempt、method、固有staging先、暗号文hash/サイズ、期限、鍵版を署名対象にする。ブラウザはticketをメモリだけに持ち、URL/認可headerをアクセスログ・分析・下書きに保存しない。認可応答はno-store。署名URLを使うadapterではReferer等への流出も抑制する。

Local受信APIは有効session・本人scope・Origin/CSRFとticketを検証し、create_new・上限付きstream・実hash照合で受信する。通常APIのJSON/body上限を全体で緩和しない。クラウドへの直接送信はcookieに依存しないbearer認可なので、次を必須とする。

- storage側でも新規作成限定・サイズ/整合性制約・非公開・PUTだけの権限を実現する。S3なら署名へ`If-None-Match: *`等をbindし、適切なpolicyで強制する。他providerも同等の条件を実証する。実現不能なら専用受信APIを選ぶ。
- 署名URLだけで単回利用とみなさない。アプリ側のattempt stateと一意制約で1回の受付確定を保証し、既存objectを上書きしない。削除後の同じkey再利用も禁止する。
- 上限が転送前に強制できないproviderでは、受信proxyやstorage quotaを含む代案を選ぶ。後からのサイズ判定だけで帯域/容量枯渇対策が済んだとは扱わない。
- 固定IP限定公開では、アプリ入口だけでなくupload先にも同じ方針を適用する。CORSは認証の代替ではない。worker用内部経路は利用者用入口と分けて許可する。
- URL失効が開始済み転送を停止するとは保証しない。受信側の時間/速度/容量制限、確定時の現在認可、未完了attemptの閉鎖を別途行う。

各orgの未完了予約は初期10件/平文合計100MiBとし、受信中暗号文と変換scratchにも全体quotaと予約を持つ。値はS0で資源計測して見直す。未受信attemptは初回認可から15分、未受信の受付は初回予約から24時間で期限とする。受信中の扱いは下記の受信leaseを優先する。期限を再認可で延長しない。処理中の受付/leaseは期限だけで削除せず、容量不足では429/503と再試行案内を返す。実ファイルの整理はmanifest/DB参照/leaseを照合し、削除の承認手順に従う。

確定後はstorage versionまたは新規作成限定の不変参照、暗号文hash、envelope hashを固定する。検査はその参照から復号した平文hashに結び付け、配信成果物も同じ原本版を参照する。ETagを常にSHA-256とみなさない。finalize・検査・推薦間の差替えを許さない。

## 5. データ・API・復帰

以下は新方式の設計契約。受付はS1、鍵・ジョブ・隔離検査基盤はS2で実装し、閲覧route／変換はS3で実装した。既存migrationは書き換えない。

| 内部データ | 必須情報と制約 |
| --- | --- |
| upload_sessions | user/org/candidate/document、操作キー、正規化要求hash、受付状態、結果期限。本人/org RLS、scope内unique、同じ操作のdocumentを増やさない |
| upload_attempts | session、attempt番号、固有staging、不変参照、暗号文hash/長さ、envelope/hash、ticket期限、state、受信lease/fencing token、受信期限、永続manifest参照。再認可と受信確定をCASで直列化 |
| document_encryption | 原本hash/長さ、暗号schema、wrap鍵版、wrapped DEK、nonce/AAD版、blob参照。通常DTO/ログへ出さない |
| document_jobs / derivatives | document版、lease/fencing token、検査policy/世代、成果物policy/hash/暗号情報、成功/失敗。原本版ごと冪等、利用可否とは別に処理段階を持つ |

| 提案API（/api/v1以下） | 契約 |
| --- | --- |
| POST /candidates/:id/document-uploads | 操作キー、種類、形式、平文長、架空確認で予約。既存uploadの7日scopeと連携し、document/upload/初回attempt ID・公開鍵版/contextを返す。PII metadataは暗号化payload内に含める |
| POST /document-uploads/:id/attempts | 現在認可と元scope/期限、旧受信の停止と照合結果を確認し、新attempt ID/contextを発行。stored/attached/受信結果不明なら発行不可。元受付の期限は延長しない |
| POST /document-uploads/:id/authorize | attempt ID、暗号文hash/長さ、上限付きenvelopeをbindし、ticket/送信先/必須headerを返す。現在認可・元scope・期限を確認。受信結果不明なら先に照合。同attemptのhash/envelope変更は409 |
| PUT /document-uploads/:id/bytes | Local専用。session/CSRF/Origin+ticket、暗号文のみ。クラウドadapterではこの転送だけstorageへ直接送る |
| POST /document-uploads/:id/complete | attemptと不変参照をサーバー側照合し、202と同じdocument/status URL。二重要求は同じ結果。未完了転送/別hashは確定不可 |
| GET /document-uploads/:id | 本人scopeの受付/転送/検査/変換状態、document ID、結果期限。鍵・URL・保存先を返さない |
| GET /documents/:id/view、/view/pages/:page | 自社agency。現在利用可のmanifest/テキストまたは画像。任意path/URL入力不可 |
| GET /applications/:id/documents/:document_id/view と /view/pages/:page | A_OWNER/E_SHARED、選択版の不変参照を通じて同じ成果物を読む |
| GET /applications/:id/invoice-view | hiredかつA_OWNER/E_SHARED。固定テンプレートの請求HTML/必要なページ画像。PDF bytesを返さない |

受付stateはreserved→receiving→received→checking→converting→ready。拒否はrejected、インフラ障害は段階と再試行可能理由を残す。attemptはprepared→authorized→receiving→stored→attached、未確定の中断/失効はclosed。GETで受付状態とattemptの照合状態（reconcilingを含む）を返す。既存documents.status/availabilityは維持し、readyへの昇格は両検査・変換・暗号保存成功時だけ。AV freshness/ロード世代不一致・blocked・共有失効を配信時にも確認する。

### 受信の確定順序と中断復帰（指摘2）

1. 有効ticketの最初のPUTで、attemptをCASでreceivingへ移し、受信lease/fencing tokenをDBへcommitしてから固有stagingをcreate_newする。受信のwall期限は開始から5分、無通信30秒を初期値とし延長しない。同attemptの同時PUTは202と状態照合先を返し、第二writerを作らない。
2. 上限/hash確認後にファイルをfsyncし、attempt/token・暗号文hash/サイズ・envelope hashを記した完了manifestを原子的に配置してdirectoryもfsyncする。現在のattempt/token/期限/認可をDBで再照合しstored（受付received）をcommitしてから成功応答する。閉鎖/lease喪失後のwriterはstoredへ昇格できない。
3. completeはstoredの参照を再照合し、受付につき唯一のcanonical attemptをCASでattachedにしてジョブを同じDB transactionで記録する。応答喪失/重複completeは同じdocument/jobへ戻す。storedは「保存済み・complete待ち」であり新規転送を始めない。24時間の受付期限前にstoredとなったものは未受信失敗にせず、照合とcompleteへ案内する。
4. 停止後は先にreceivingをreconcilingとして扱う。writerを停止/隔離し、永続manifestと実bytesを照合する。期限内かつ現行tokenの完全一致ならstoredへ回復し、manifestなし/部分受信/期限後ならclosedにする。完全ファイルだけが残りmanifestがなければ完成と推定しない。孤立bytesは非公開で保持し、新しいstagingへ上書きしない。
5. stored commit直後の応答喪失はGETで同じstoredへ、attached後は同じ処理結果へ戻す。新attemptを許すのは未受信prepared/authorizedを閉鎖した後、または旧writer停止とclosedが確認できたときだけ。受付が非終端で期限内ならreservedへ戻すが、document ID/操作キーは維持する。状態不明では409 UPLOAD_RECONCILINGと再照合案内を返す。closed attemptの遅延到着/旧ticket/旧fencing tokenは確定できない。
6. 未受信の受付が24時間を超えたら、writer停止とmanifest照合を先に行う。期限内にstoredとなっていたことが分かればその参照へ戻し、それ以外は受付rejected/UPLOAD_EXPIREDを終端確定して7日結果保持へ移す。quotaの論理枠を解放しても孤立bytesは物理使用量として計上し、削除完了まで容量を再利用済みと数えない。

再転送は、同attemptの実bytesが未受信と確認できる場合のみ同じ暗号文を使える。create_new失敗時は上書きや削除で解消せず照合へ戻す。closed後の新attemptは新しいcontext/DEK/nonceで再暗号化する。クラウドadapterも保存確認・受信結果不明・条件付き作成について同等の契約を実証するまで採用しない。

新APIのキーはv0.5 scopeで旧multipartと区別する。同じ操作キーの先行予約へ戻し、暗号化のたびに変わる暗号文hashを業務の同一性hashへ混ぜない。平文の同一性はワーカーが検証した原本hashと復号metadataで確定し、異なる原本/種類/表示名を同じ受付へ確定しない。受信確定済みなら新attemptを作らず処理状態を照合する。

7日結果照合は既存idempotency_recordsを正本に維持し、upload_sessionsが別の結果期限を作らない。completeが202を返した時点で終端completedにせず、ready/rejectedの確定から7日を数える。期限後は元キーの再認可/再受信/再検査開始を禁止しexpired tombstoneへ戻す。既存outcomeにも新受付との対応を返し、現在認可を要求する。

UIは「暗号化中→送信中→受信済み→検査中→表示準備中→利用可能」を区別する。File bytes/平文鍵/ticketを下書きへ保存しない。R4の保存成功分はupload/document ID、操作キー、選択metadataから復帰する。再起動で暗号文を失った場合は結果照合を先に行い、未受信と確定できたときだけ本人がFileを再選択し新attemptへ再暗号化する。R5は入力metadataの未同期端末保存まで完了したが、File bytesは保存しない。受信状態が不明なら別キーで再登録しない。

## 6. 隔離検査・安全な閲覧・請求

原本のAV/形式policyはv0.4の限定許可を維持する。暗号envelopeはサービスの外側の暗号化であり、PDF自体のpassword/encryption禁止とは別。パスワード付きPDF/XLSXを復号して受け入れる機能は追加しない。

- PDFはAV/構造合格後、隔離してページ画像へ変換し、認可済みHTMLで表示する。20ページ/10MiBは維持し、画素数・出力合計・時間・同時実行の上限をS0で確定する。変換不能/上限超過時は保留/拒否を表示し原本表示へfallbackしない。画像化により検索/読み上げが失われるため、抽出テキストをエスケープした代替表示も提供し、抽出不能は明示する。
- XLSXは外部リンク・マクロ等の既存拒否条件を維持し、許可したシート/セル値を固定コンポーネントの表で表示する。式を実行せず保存されたcached値だけを使う。その計算結果の正確性/鮮度を既存validator合格から推定しない。型別の扱いは下表に従う。HTML埋込・自動リンク・外部画像取得を禁止。画像/図形/印刷レイアウトの完全再現は含めず、PDFでの再提出を案内する。履歴書の画像や罫線等の再現が必須なら追加見積もりとし、欠落を完全な原本プレビューと呼ばない。
- 変換はnative parserの脆弱性を消さない。非root/read-only、ネットワーク遮断、ジョブごとのscratch、CPU/メモリ/PID/時間/展開量制限、同時実行と容量制御を必須にする。実装時にrenderer候補のライセンスと配布imageも監査する。
- APIの固定HTML/UIにエスケープしたデータだけを渡し、任意変換HTML・SVG・scriptは配信しない。ページ画像は信頼したencoderで生成したPNG等に限定、nosniff/no-store。文書/画像ごと毎回認可し、公開static URLや閲覧用署名GET URLは作らない。CSPはdefault拒否を基準に必要な同一originのみ許可し、Nextのnonce等と整合を確認する。
- 原本`/content`、共有原本`/content`、`invoice-preview.pdf`は切替後410の本文なし応答とし、迂回経路を残さない。現在のPDFボタンは閲覧用表示へ置換する。外部向け原本ダウンロードは本設計の範囲外。
- 請求は固定1ページ/1明細のデータとテンプレートを維持し、外部表示はHTMLを基本にする。内部PDF生成を残す場合も隔離した請求専用サービスだけで実行し、PDFをブラウザへ送らない。任意HTML/URLを受け付けない。HTMLと内部PDFの値・省略表示・日本語の一致を確認する。

共有撤回commit後の新しいmanifest/画像/テキスト要求を拒否する。既に表示/取得された内容の回収は保証できない。失効通知/再認証で機密表示を消し、暗号化をスクリーンショット防止や本人同意の代替と説明しない。

### XLSXの最小表示契約（指摘4）

| 入力 | 固定表示・拒否条件 |
| --- | --- |
| shared string / inline string / 保存文字列 | index・型・長さを検証し、rich textは文字列へ連結。HTMLエスケープして表示。無効な参照は表示準備失敗とし別セル値へ置換しない |
| 数値/boolean/空欄 | 数値は有限な10進表記として検証し原表記を保持、精度を落とす丸め/ロケール変換をしない。booleanは0/1だけを「いいえ/はい」、欠落セルは空欄、空文字列はそのまま表示 |
| 日付 | 数値+許可した標準日付書式ID 14〜17のみ日付へ変換（値は非負整数、1900/1904系をworkbookPr.date1904で判定）してYYYY-MM-DDで表示。1900系はserial1〜59を1899-12-31起点、61以降を1899-12-30起点、1904系は0以降を1904-01-01起点とする。1900系0は未変換表示。時刻を含む18〜22やcustom formatは変換せず数値と「書式未再現」を表示。1900系serial 60は実在日へ直さず元値と「Excel互換の仮想日付」を表示。範囲外/非整数は元値+未変換表示とし黙って切り捨てない |
| ISO日付型（t=d）/未知型 | 初期の表示policyでは未対応。表示準備失敗とし原本へfallbackしない。新たな入力型の許可拡張はしない |
| 数式/cached値/エラー | 数式を実行せず、cached値も上記型検証を通す。対象セルと画面に「再計算していない保存値」を表示。cached値なしは「保存値なし」、error型はエラー文字列をエスケープして表示し通常値と区別する |
| 結合セル | 結合範囲を検証し左上に値、他セルに結合先を示す。巨大なHTML rowspan/colspanを生成しない。重複/交差等で解釈不能なら表示準備失敗 |
| 非表示sheet/row/column | 初期表示から除外し、名前/件数だけ「非表示部分あり」と示す。本人が明示的に開く操作でのみ表示し、共有前プレビューでも含まれる範囲を確認できるようにする |
| 画像/図形/罫線/書式 | 省略を画面に常時明記し、画像がある場合は件数も示す。PDFでの再提出を案内。省略して原本レイアウトと同等とは説明しない |

全sheetを巨大な矩形へ展開せず、実在セル/結合参照だけを上限付きで正規化する。1セル32KiB、合計20,000セル/正規化テキスト1MiBを初期表示上限とし、超過では黙った切捨てをせず表示準備失敗にする。元ZIP/XMLの既存上限も維持する。これは保存値の忠実な提示を目指す限定表示であり、Excel計算・印刷表示の再現ではない。型/日付fixtureの期待値はS0実行前に固定し、結果に合わせて期待値を変えない。

## 7. 既存書類と切替

現在の原本を暗号化済みとは扱わない。移行は原本とDB/鍵のバックアップ、参照とhashの棚卸し、旧版復旧の確認後に行う。旧原本をその場で上書きせず、新しい暗号blob/成果物と対応表を追加する。原本ID/版、application_documentsの選択版を維持し、共有snapshotを書き換えて最新版へ差し替えない。

既存参照から不変の暗号blob/成果物へ解決する対応表を用意し、企業側はE_SHAREDの共有参照からのみ読む。documentsの特権JOINを追加しない。新規分と移行分の両検査・成果物・鍵復元を確認後、環境単位で旧原本配信を閉じる。未移行/検査不能/鍵欠落は利用不可とし、旧配信へのfallbackはしない。未処理の旧multipart要求はdrainし、新旧キーのscopeを混ぜない。

ロールバックは受付停止と旧版DB/暗号鍵/対応表の復旧を準備するが、外部原本配信を自動再開しない。古いバックアップには平文が残るため、保管先暗号化・アクセス制限・保持期限を別途管理する。旧原本/backup/一時ファイルの削除は別の明示承認を得る。S4の明示承認で隔離環境の移行・復旧を確認した。旧原本・backup・一時ファイルの削除は行っていない。

## 8. 既存ツールの再利用範囲

2026-10-16に公開READMEと主要ソースを確認した範囲。動作試験・独立監査・商用適格性の証明ではない。ツール連携は最小基盤の必須依存にせず、成熟度に応じて採用する。

| ツール / 確認commit | 使える部分 | 追加確認・使わない部分 |
| --- | --- | --- |
| [zt-gateway](https://github.com/mt4110/zt-gateway/tree/6cfd329a08738ca55994c8ee322770eb28d000c9) | scan→rebuild→署名/暗号化→verify、policyのfail-closed、供給元署名/pinの考え方をワーカーと成果物証拠へ適用 | secure-rebuildはJPEG/PNGのみ。PDF/XLSX変換を実装済みと数えない。GPG/CLI全体を同期要求やブラウザへ直結しない。adapter採用時はlicense/依存/exit/timeout/証拠schemaを検証 |
| [leak-fence](https://github.com/mt4110/leak-fence/tree/b4289ed497396064b01c334c2de8a7b880c9fdc1) | 認可後JSONのtenant/ID/field検査候補 | RLS/認可を置換せず、PDF/画像の無害化にも使わない。開発段階、既存API schemaとの誤拒否/抜けと負荷を検証 |
| [veil-rs](https://github.com/mt4110/veil-rs/tree/f995c706fbef9cb75639d987c383314c45b76cc9) | ログ/Git/配布物の秘密検査、署名付きルール配布の参考 | AVではない。原本文書をログへ渡さない。不完全検査を合格にしない。既存監査との重複を整理 |
| veil-drop / veil-blackhole / veil-warden | 今回の必須基盤には採用しない | 順に短文共有、現行DNS観測、実験的Linux接続制御。書類暗号転送/本番egress制御の完成品とは扱わない |

## 9. 追加WBSと停止条件

最新は[M6再監査・修正計画](../validation/2026-10-18-m6-reaudit-report.md)。期限内DBでarm64の再監査は完走、依存指摘と実測inspector Expat 2.8.5への対応が残る。標準対応17〜34時間＋M7 6〜12時間＝23〜46時間の仮積算。基底変更等を選ぶ場合35〜70時間、任意のAV再処理導線2〜4時間と公開設定は別枠。実装・M7・公開は未着手。以下は過去の計画履歴。

**S0実施後の新方式の残WBSは66〜112時間、既存分込み94〜160時間＋M6未積算残件。任意接続を全採用する場合102〜177時間＋M6未積算残件。** [S0記録](../validation/2026-10-16-s0-report.md)を参照。以下の表と74〜126/102〜174/110〜191はS0を含む着手前計画として保存する。

既存RLS/AV/形式policy/7日照合/R4を再利用し、ローカル保存1種類、上記の限定プレビュー、arm64/amd64と既存Chromiumを対象にした条件付き仮積算。人の実工数・納期・予算承認ではない。今回の設計作業やrunner待ち時間は実装実績へ換算しない。

| 段階 | 内容・成果物 | 追加工数 |
| --- | --- | ---: |
| S0 | [確認計画](13-s0-verification-plan.md)：隔離probe、原本/成果物暗号・鍵復旧、型別表示、暫定上限と両archの証拠 | 8〜14時間 |
| S1 | 予約/ticket/暗号化/envelope、Local受信・quota・DB/RLS/API、受信lease/manifest・応答喪失/閉鎖照合 | 16〜26時間 |
| S2 | 原本/成果物鍵管理、broker/relay/sandboxの強制分離、成果物単位の暗号/失効、非同期lease/復帰、請求service分離 | 16〜26時間 |
| S3 | PDF画像/代替テキスト、XLSX型/日付/結合/非表示/保存値注意、認可付き閲覧・共有失効、請求HTML/旧配信閉鎖、受付UI | 18〜30時間 |
| S4 | 既存文書/snapshotの不変対応、暗号化移行、旧鍵/バックアップ復旧・切替手順 | 6〜12時間 |
| S5 | 新しい中断点/成果物/型別表示を含む横断ブラウザ/DB/障害/両arch CI、性能計測、文書・証拠 | 10〜18時間 |
| 合計 | ローカル新方式の追加分 | **74〜126時間** |

改訂前58〜102時間から、S0 +2〜4、S1 +2〜2、S2 +6〜8、S3 +4〜6、S5 +2〜4時間（合計+16〜24）を追加した。隔離方式/受信復帰/成果物暗号/型別表示を具体化した分で、実測による変更ではない。S4と任意ツール枠は維持する。S0後に候補依存・資源・互換の成立を見て再積算し、この上限で未知の問題まで吸収できるとは保証しない。

S1〜S4は各局所試験を含み、S5は新方式を横断する試験のみ。R6の既存書類/下書き横断、M7の第三者再現とは対象を分ける。既存M6監査を新方式の分離だけで解消したとは扱わない。

既存残WBS **28〜48時間**と単純合算した計画幅は**102〜174時間＋未積算のM6監査残件**。当初40〜100時間へ収まる保証はなく、機能追加後の新しい残計画である。将来の重複削減は具体的な受入項目を確認してから行い、今は見込みで差し引かない。

zt-gateway実adapter **4〜8時間**、leak-fence追加guard **3〜6時間**、veil-rs監査組込 **1〜3時間**は任意採用分で合計**8〜17時間**を別枠とする。S0の方式参考/コード確認は74〜126へ含め、実接続を採用する場合だけ追加する。3ツール全採用時は**110〜191時間＋M6未積算残件**。効果を測らず全採用しない。

クラウドadapter/KMS/IaC・固定IP/TLS/OIDC公開検証、XLSXの画像/完全レイアウト再現、全ブラウザ/端末、独立セキュリティ監査、運用監視は別途見積もり。原本を受けない方式やAI転記へ広げない。

初回の実作業はS0だけとして実施した。以下はその承認/停止条件の履歴で、S1の承認ではない。鍵方式/変換互換/資源の成立条件と未成立理由を報告し、S1以降は別判断。S0は8時間時点で途中結果、最大14時間の枠を提案する。実行前条件、必須fixture/証拠、暫定上限、未成立判定は[確認計画](13-s0-verification-plan.md)に従う。不成立でも弱い暗号・検査省略・原本配信へ緩和しない。今回の設計承認をS0着手や予算延長と解釈しない。

## 10. 追加受入（実施状況は各milestone記録を参照）

既存A01〜A25の業務/分離/復帰を維持し、ファイル閲覧は新方式へ期待値を更新する。旧PDF配信成功の証拠を新方式の合格に流用しない。

| ID | 検証と合格条件 |
| --- | --- |
| S-A01 | 別user/org/candidateの予約・ticket・complete・状態・閲覧を拒否。無効session/CSRF/Origin/署名/期限/method/audience/サイズ/hashも拒否 |
| S-A02 | receiving/stored/attached前後・manifest有無・期限/CAS競合・遅延writerを含む同じticket再利用/同時PUT/completeで上書き・二重登録なし。転送前後/確定前後/lease奪取/鍵欠落の停止でも同じ受付IDへ復帰。別暗号文・別原本・AAD/タグ改変と成果物/ページ/世代の付替えを拒否。旧原本/成果物鍵の復旧・失効も確認 |
| S-A03 | packet/storage/log/下書き/Nextに平文原本・DEK・秘密鍵・ticket漏えいなし。テストでは合成markerと対象経路を明示し、絶対的な漏えい不存在の証明とは呼ばない |
| S-A04 | 実AV検出、定義鮮度/ロード版不一致、scanner停止、未検査、変換失敗・展開/画素/資源上限で表示/推薦を拒否。旧成果物へfallbackしない |
| S-A05 | PDF正常/拒否fixture、Sheets実出力2種と型/日付/結合/非表示/cached有無のfixtureでセル/文字/日本語を確認。XLSXの省略内容と保存値未再計算を示し、任意script/外部URL/画像・式を実行しない |
| S-A06 | 選択した不変版の成果物のみ共有。共有撤回後のmanifest/全ページ/テキストの新要求と直接URLを拒否。旧原本/請求PDFの取得経路も閉鎖 |
| S-A07 | 再起動・再認証・応答喪失・予約失効・7日後で結果照合/再実行禁止を維持。アーカイブ/鍵失効/権限喪失を再認可で迂回できない |
| S-A08 | 移行前後の原本hash/選択snapshot一致、移行中断の再開、旧鍵/DB/暗号blobセットの復旧、未移行配信拒否。破壊的削除は行わない |
| S-A09 | 既存一巡と請求HTML/内部固定1ページPDFの値・日本語・省略/keyboard/代替テキストを確認。R4保存/復元を回帰し、R5未同期復元とは区別 |
| S-A10 | 小容量/10MiB、1件/複数件、warm/coldで暗号化・転送・queue・AV・変換・初回表示を分解しp50/p95、メモリ、失敗数を記録。成功/拒否負荷を分ける |

低レイテンシーは直接転送と重い処理の非同期化で目指す。初回は予約と認可の2回の制御APIに加え転送/確定が必要で、1往復と説明しない。受信成功と利用可能を分け、暗号化もWeb Worker等でUIを塞がないことを確認する。実測前に応答時間や速度改善率を約束しない。S0の測定結果から対象環境の目標と打切り条件を提示し、オーナーが選ぶ。

[レビュー5件の修正対応表](../reviews/2026-10-16-v05-revisions.md)で変更と未実施の確認を追跡する。

## 一次資料と確認範囲

- [AWS署名付きURL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)：期限内再利用、bearer権限、IP条件などの仕様。AWSはadapter例であり採用決定ではない。
- [AWS条件付き書き込み](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)：新規作成条件。世代管理だけで不変性を保証しない。
- [Web Crypto AES-GCM parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)：nonce/AAD/tagのAPI契約。
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)：限定許可、隔離、AV/CDR等の防御。完全な無害化保証ではない。

以上は2026-10-16の文書/コード確認に基づく設計判断。初版時点では実行結果はなかった。S0終了時にはハーネスの確認結果だけが存在した。後続の製品実装・検証はS1/S2記録を参照。閲覧／移行はS3／S4、S-A01〜S-A10の横断受入は[S5記録](../validation/2026-10-16-s5-report.md)を参照。公開・本番適格性や独立監査の承認ではない。

改訂1の設計修正と、後続S0のハーネス結果を区別する。S0成立は製品変更の完了やM6監査・公開の承認を意味しない。

### S1のデータ具体化

予約時はupload_sessionsでdocument_idを確保し、complete時にpendingのdocuments行・暗号化参照・後続jobを原子的に作る。原本名／原本hashは復号前にはNULLで、偽の検証値を登録しない。S1ではencrypted_transportの行をpending・未検査に固定し、既存の原本処理worker／再試行経路へ渡さない。S2で正しい原本メタデータを確定するmigrationを追加する。

Local受信は同一volumeにつき単一プロセスとし、OSファイルロックで二重起動を拒否する。プロセス停止または受信task終了の確認とfencingを組み合わせて復旧する。多プロセス・クラウドストレージへの拡張は今回含めない。

### S2の具体化

[S2実装契約](14-s2-worker-contract.md)を追加した。S2では原本名/hashを検証済みjobへ確定し、documentsの公開metadataはS3の変換・成果物受入までNULLのままにする。検査合格はchecked／documents.pendingでありreadyではない。拒否時だけdocuments.rejectedと7日結果保持を確定する。成果物暗号の製品経路は検査manifestまでで、ページ画像／代替テキスト／正規化表と閲覧復号APIはS3。

新規wrapの鍵と旧版の有効状態を分けて管理する。workerはDB資格情報を持たず、固定関数によるジョブ限定制御を受ける。ホスト管理スクリプトが毎回新しいbroker／relay／sandboxを起動・停止する。コンテナ・旧鍵・孤児blobを自動削除しない。S2受入後の残計画は新方式34〜60時間、既存分込み62〜108時間＋未積算M6残件。初期WBSは履歴として保持する。
