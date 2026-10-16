# 署名付き・暗号化アップロードと安全な閲覧

2026-10-16 / 設計 v0.5 追加契約（未実装）

## 1. 適用範囲と優先順位

今回承認されたのは設計・工数整理・Git反映まで。技術確認、製品実装、移行、鍵作成、外部公開は行わない。M6の監査指摘による受入保留、R5・M7の停止条件は維持する。実在の求職者情報は禁止する。

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

初期案では現在の内部scannerに、復号ワーカーから制限付きで平文を渡す。scannerのAV定義更新専用経路との分離を維持する。構造検査/変換の子プロセスには鍵・DB・原本volume・外向きnetworkを渡さない。復号の親も、任意URLや任意保存先をジョブ入力として受け付けない。請求生成サービスは別identity/volume/network/同時実行枠とし、書類ワーカーから到達させない。

ワーカーの処理はdocument IDを限定した短期ジョブ認可とlease/CASで行い、組織横断の汎用DB権限を追加しない。APIが現在状態を確認してジョブを払い出し、結果commit時にもlease・版・所有・アーカイブ/検査状態を照合する。無効化された本人/組織の処理から利用可能へ昇格させない。

## 3. 暗号化と鍵の契約

- 初期候補はWeb CryptoのAES-256-GCM、ファイルごとのランダムDEK、96bit nonce、128bit tag。公開鍵によるDEKのwrapはRSA-OAEP/SHA-256・3072bit以上を候補にする。暗号実装を自作せず、相互運用・依存・鍵強度・資源をS0で確認して確定する。不成立時は代案を提示し、平文uploadへ自動降格しない。
- 鍵の版、upload/document ID、org ID、形式、schema versionをサーバーが正規化した固定encodingでAADへ結び付ける。client自己申告のorgを認可根拠にしない。ファイル名等のPIIは暗号化metadata内へ置き、URL/object keyには入れない。
- 1ファイルは平文10MiBまで。初期案は1回のAEAD操作とし、独自chunk暗号方式やmultipartは作らない。暗号化前payloadは4byteのmetadata長（big-endian）、UTF-8 JSON metadata（最大4KiB）、原本bytesの順。暗号文長はpayload長+16byteのtag、外側envelopeは最大8KiBのJSON（schema/key版、wrapped DEK、nonce、AAD参照）。外側にファイル名を含めない。平文ファイル/暗号文/復号後/展開後の制限を別々に検証する。暗号化/転送は端末ごと初期1件とし、メモリ増加をS0で測定する。
- 同じ受付の転送再試行は同じ暗号文/envelopeを使う。再暗号化時は新DEKとnonceを作り、新しい転送attemptへbindする。過去のhashと異なる暗号文を既存ticketへ送らない。再認証/再起動後の復旧規則は第5節に従う。
- 署名ticket鍵、wrap用秘密鍵、成果物暗号鍵、既存DRAFT_MASTER_KEYは用途と版を分ける。秘密鍵はGit/ブラウザ/Next/ログへ渡さず、ローカルはworker専用secret、クラウドは鍵管理サービスを候補とする。鍵取得/復号権限の監査とバックアップ復元を受入対象にする。
- 旧版秘密鍵は参照中の原本/成果物を復号できる期間保持し、ローテーションで一括失効させない。漏えい時は当該版を利用停止し、復旧/再wrap・再暗号化を管理操作として扱う。鍵がない・失効・tag不一致では処理/配信を停止する。
- 変換した閲覧用成果物はワーカー側で別DEKにより暗号化する。配信APIには成果物専用の復号権限だけを与え、原本用秘密鍵を共有しない。成果物も暗号contextとhashでdocument/versionへbindする。

ブラウザ暗号化は侵害されたフロントエンドJSから原本を守れない。CSP、依存更新、第三者script制限、Nextの権限縮小を併用する。保存時暗号化やPDF passwordを無害化の代替にしない。

## 4. 署名認可・容量・差替え防止

ticketの初期有効期間は5分（設計初期値、性能保証ではない）。用途/audience、upload ID、attempt、method、固有staging先、暗号文hash/サイズ、期限、鍵版を署名対象にする。ブラウザはticketをメモリだけに持ち、URL/認可headerをアクセスログ・分析・下書きに保存しない。認可応答はno-store。署名URLを使うadapterではReferer等への流出も抑制する。

Local受信APIは有効session・本人scope・Origin/CSRFとticketを検証し、create_new・上限付きstream・実hash照合で受信する。通常APIのJSON/body上限を全体で緩和しない。クラウドへの直接送信はcookieに依存しないbearer認可なので、次を必須とする。

- storage側でも新規作成限定・サイズ/整合性制約・非公開・PUTだけの権限を実現する。S3なら署名へ`If-None-Match: *`等をbindし、適切なpolicyで強制する。他providerも同等の条件を実証する。実現不能なら専用受信APIを選ぶ。
- 署名URLだけで単回利用とみなさない。アプリ側のattempt stateと一意制約で1回の受付確定を保証し、既存objectを上書きしない。削除後の同じkey再利用も禁止する。
- 上限が転送前に強制できないproviderでは、受信proxyやstorage quotaを含む代案を選ぶ。後からのサイズ判定だけで帯域/容量枯渇対策が済んだとは扱わない。
- 固定IP限定公開では、アプリ入口だけでなくupload先にも同じ方針を適用する。CORSは認証の代替ではない。worker用内部経路は利用者用入口と分けて許可する。
- URL失効が開始済み転送を停止するとは保証しない。受信側の時間/速度/容量制限、確定時の現在認可、未完了attemptの閉鎖を別途行う。

各orgの未完了予約は初期10件/平文合計100MiBとし、受信中暗号文と変換scratchにも全体quotaと予約を持つ。値はS0で資源計測して見直す。空予約で無制限に保持せず、未受信attemptは最終認可から15分で閉鎖する。未受信かつ受信中でない受付は初回予約から24時間で失敗確定し、枠を解放して7日結果保持へ移す。再開は期限内に同じupload IDから新attemptを認可し、予約の24時間期限は延長しない。処理中の受付/leaseは期限だけで削除せず、容量不足では429/503と再試行案内を返す。実ファイルの整理はmanifest/DB参照/leaseを照合し、削除の承認手順に従う。

確定後はstorage versionまたは新規作成限定の不変参照、暗号文hash、envelope hashを固定する。検査はその参照から復号した平文hashに結び付け、配信成果物も同じ原本版を参照する。ETagを常にSHA-256とみなさない。finalize・検査・推薦間の差替えを許さない。

## 5. データ・API・復帰

以下は追加設計でありmigration/routeは未作成。既存migrationは書き換えない。

| 内部データ | 必須情報と制約 |
| --- | --- |
| upload_sessions | user/org/candidate/document、操作キー、正規化要求hash、受付状態、結果期限。本人/org RLS、scope内unique、同じ操作のdocumentを増やさない |
| upload_attempts | session、attempt番号、固有staging、不変参照、暗号文hash/長さ、envelope/hash、ticket期限、state。再認可と受信確定をCASで直列化 |
| document_encryption | 原本hash/長さ、暗号schema、wrap鍵版、wrapped DEK、nonce/AAD版、blob参照。通常DTO/ログへ出さない |
| document_jobs / derivatives | document版、lease/fencing token、検査policy/世代、成果物policy/hash/暗号情報、成功/失敗。原本版ごと冪等、利用可否とは別に処理段階を持つ |

| 提案API（/api/v1以下） | 契約 |
| --- | --- |
| POST /candidates/:id/document-uploads | 操作キー、種類、形式、平文長、架空確認で予約。既存uploadの7日scopeと連携し、document/upload ID・公開鍵版/contextを返す。PII metadataは後の暗号envelopeに含める |
| POST /document-uploads/:id/authorize | 暗号文hash/長さ、上限付きenvelopeをbindし、ticket/送信先/必須headerを返す。現在認可・元scope・期限を確認。受信結果不明なら先に照合 |
| PUT /document-uploads/:id/bytes | Local専用。session/CSRF/Origin+ticket、暗号文のみ。クラウドadapterではこの転送だけstorageへ直接送る |
| POST /document-uploads/:id/complete | attemptと不変参照をサーバー側照合し、202と同じdocument/status URL。二重要求は同じ結果。未完了転送/別hashは確定不可 |
| GET /document-uploads/:id | 本人scopeの受付/転送/検査/変換状態、document ID、結果期限。鍵・URL・保存先を返さない |
| GET /documents/:id/view、/view/pages/:page | 自社agency。現在利用可のmanifest/テキストまたは画像。任意path/URL入力不可 |
| GET /applications/:id/documents/:document_id/view と /view/pages/:page | A_OWNER/E_SHARED、選択版の不変参照を通じて同じ成果物を読む |
| GET /applications/:id/invoice-view | hiredかつA_OWNER/E_SHARED。固定テンプレートの請求HTML/必要なページ画像。PDF bytesを返さない |

stateはreserved→received→checking→converting→ready。拒否はrejected、インフラ障害は段階と再試行可能理由を残す。既存documents.status/availabilityは維持し、readyへの昇格は両検査・変換・暗号保存成功時だけ。AV freshness/ロード世代不一致・blocked・共有失効を配信時にも確認する。

新APIのキーはv0.5 scopeで旧multipartと区別する。同じ操作キーの先行予約へ戻し、暗号化のたびに変わる暗号文hashを業務の同一性hashへ混ぜない。平文の同一性はワーカーが検証した原本hashと復号metadataで確定し、異なる原本/種類/表示名を同じ受付へ確定しない。受信確定済みなら新attemptを作らず処理状態を照合する。

7日結果照合は既存idempotency_recordsを正本に維持し、upload_sessionsが別の結果期限を作らない。completeが202を返した時点で終端completedにせず、ready/rejectedの確定から7日を数える。期限後は元キーの再認可/再受信/再検査開始を禁止しexpired tombstoneへ戻す。既存outcomeにも新受付との対応を返し、現在認可を要求する。

UIは「暗号化中→送信中→受信済み→検査中→表示準備中→利用可能」を区別する。File bytes/平文鍵/ticketを下書きへ保存しない。R4の保存成功分はupload/document ID、操作キー、選択metadataから復帰する。再起動で暗号文を失った場合は結果照合を先に行い、未受信と確定できたときだけ本人がFileを再選択し新attemptへ再暗号化する。R5の未同期端末保存を完了扱いにしない。受信状態が不明なら別キーで再登録しない。

## 6. 隔離検査・安全な閲覧・請求

原本のAV/形式policyはv0.4の限定許可を維持する。暗号envelopeはサービスの外側の暗号化であり、PDF自体のpassword/encryption禁止とは別。パスワード付きPDF/XLSXを復号して受け入れる機能は追加しない。

- PDFはAV/構造合格後、隔離してページ画像へ変換し、認可済みHTMLで表示する。20ページ/10MiBは維持し、画素数・出力合計・時間・同時実行の上限をS0で確定する。変換不能/上限超過時は保留/拒否を表示し原本表示へfallbackしない。画像化により検索/読み上げが失われるため、抽出テキストをエスケープした代替表示も提供し、抽出不能は明示する。
- XLSXは外部リンク・マクロ等の既存拒否条件を維持し、許可したシート/セル値を固定コンポーネントの表で表示する。式を実行せず検証済みcached値を使い、欠落は「表示できない値」とする。HTML埋込・自動リンク・外部画像取得を禁止。画像/図形/印刷レイアウトの完全再現は含めず、PDFでの再提出を案内する。履歴書の画像や罫線等の再現が必須なら追加見積もりとし、欠落を完全な原本プレビューと呼ばない。
- 変換はnative parserの脆弱性を消さない。非root/read-only、ネットワーク遮断、ジョブごとのscratch、CPU/メモリ/PID/時間/展開量制限、同時実行と容量制御を必須にする。実装時にrenderer候補のライセンスと配布imageも監査する。
- APIの固定HTML/UIにエスケープしたデータだけを渡し、任意変換HTML・SVG・scriptは配信しない。ページ画像は信頼したencoderで生成したPNG等に限定、nosniff/no-store。文書/画像ごと毎回認可し、公開static URLや閲覧用署名GET URLは作らない。CSPはdefault拒否を基準に必要な同一originのみ許可し、Nextのnonce等と整合を確認する。
- 原本`/content`、共有原本`/content`、`invoice-preview.pdf`は切替後410の本文なし応答とし、迂回経路を残さない。現在のPDFボタンは閲覧用表示へ置換する。外部向け原本ダウンロードは本設計の範囲外。
- 請求は固定1ページ/1明細のデータとテンプレートを維持し、外部表示はHTMLを基本にする。内部PDF生成を残す場合も隔離した請求専用サービスだけで実行し、PDFをブラウザへ送らない。任意HTML/URLを受け付けない。HTMLと内部PDFの値・省略表示・日本語の一致を確認する。

共有撤回commit後の新しいmanifest/画像/テキスト要求を拒否する。既に表示/取得された内容の回収は保証できない。失効通知/再認証で機密表示を消し、暗号化をスクリーンショット防止や本人同意の代替と説明しない。

## 7. 既存書類と切替

現在の原本を暗号化済みとは扱わない。移行は原本とDB/鍵のバックアップ、参照とhashの棚卸し、旧版復旧の確認後に行う。旧原本をその場で上書きせず、新しい暗号blob/成果物と対応表を追加する。原本ID/版、application_documentsの選択版を維持し、共有snapshotを書き換えて最新版へ差し替えない。

既存参照から不変の暗号blob/成果物へ解決する対応表を用意し、企業側はE_SHAREDの共有参照からのみ読む。documentsの特権JOINを追加しない。新規分と移行分の両検査・成果物・鍵復元を確認後、環境単位で旧原本配信を閉じる。未移行/検査不能/鍵欠落は利用不可とし、旧配信へのfallbackはしない。未処理の旧multipart要求はdrainし、新旧キーのscopeを混ぜない。

ロールバックは受付停止と旧版DB/暗号鍵/対応表の復旧を準備するが、外部原本配信を自動再開しない。古いバックアップには平文が残るため、保管先暗号化・アクセス制限・保持期限を別途管理する。旧原本/backup/一時ファイルの削除は別の明示承認を得る。今回移行や削除はしない。

## 8. 既存ツールの再利用範囲

2026-10-16に公開READMEと主要ソースを確認した範囲。動作試験・独立監査・商用適格性の証明ではない。ツール連携は最小基盤の必須依存にせず、成熟度に応じて採用する。

| ツール / 確認commit | 使える部分 | 追加確認・使わない部分 |
| --- | --- | --- |
| [zt-gateway](https://github.com/mt4110/zt-gateway/tree/6cfd329a08738ca55994c8ee322770eb28d000c9) | scan→rebuild→署名/暗号化→verify、policyのfail-closed、供給元署名/pinの考え方をワーカーと成果物証拠へ適用 | secure-rebuildはJPEG/PNGのみ。PDF/XLSX変換を実装済みと数えない。GPG/CLI全体を同期要求やブラウザへ直結しない。adapter採用時はlicense/依存/exit/timeout/証拠schemaを検証 |
| [leak-fence](https://github.com/mt4110/leak-fence/tree/b4289ed497396064b01c334c2de8a7b880c9fdc1) | 認可後JSONのtenant/ID/field検査候補 | RLS/認可を置換せず、PDF/画像の無害化にも使わない。開発段階、既存API schemaとの誤拒否/抜けと負荷を検証 |
| [veil-rs](https://github.com/mt4110/veil-rs/tree/f995c706fbef9cb75639d987c383314c45b76cc9) | ログ/Git/配布物の秘密検査、署名付きルール配布の参考 | AVではない。原本文書をログへ渡さない。不完全検査を合格にしない。既存監査との重複を整理 |
| veil-drop / veil-blackhole / veil-warden | 今回の必須基盤には採用しない | 順に短文共有、現行DNS観測、実験的Linux接続制御。書類暗号転送/本番egress制御の完成品とは扱わない |

## 9. 追加WBSと停止条件

既存RLS/AV/形式policy/7日照合/R4を再利用し、ローカル保存1種類、上記の限定プレビュー、arm64/amd64と既存Chromiumを対象にした条件付き仮積算。人の実工数・納期・予算承認ではない。今回の設計作業やrunner待ち時間は実装実績へ換算しない。

| 段階 | 内容・成果物 | 追加工数 |
| --- | --- | ---: |
| S0 | WebCrypto/worker間wrap・鍵復旧、PDF画像/文字・Sheetsセル表示、制限/依存・配布確認、実測計画の小さな技術確認 | 6〜10時間 |
| S1 | 予約/ticket/暗号化/envelope、Local受信・quota・不変確定・DB/RLS/API・受付照合 | 14〜24時間 |
| S2 | 原本/成果物鍵管理、隔離ワーカー、非同期lease/停止復帰、AV/変換境界と請求service分離 | 10〜18時間 |
| S3 | PDFページ画像/代替テキスト、XLSX表、認可付き閲覧、共有失効、請求HTML/旧配信閉鎖、受付UI | 14〜24時間 |
| S4 | 既存文書/snapshotの不変対応、暗号化移行、旧鍵/バックアップ復旧・切替手順 | 6〜12時間 |
| S5 | 下記受入のブラウザ/DB/障害/両arch CI、性能計測、文書・証拠 | 8〜14時間 |
| 合計 | ローカル新方式の追加分 | **58〜102時間** |

S1〜S4は各局所試験を含み、S5は新方式を横断する試験のみ。R6の既存書類/下書き横断、M7の第三者再現とは対象を分ける。既存M6監査を新方式の分離だけで解消したとは扱わない。

既存残WBS **28〜48時間**と単純合算した計画幅は**86〜150時間＋未積算のM6監査残件**。当初40〜100時間へ収まる保証はなく、機能追加後の新しい残計画である。将来の重複削減は具体的な受入項目を確認してから行い、今は見込みで差し引かない。

zt-gateway実adapter **4〜8時間**、leak-fence追加guard **3〜6時間**、veil-rs監査組込 **1〜3時間**は任意採用分で合計**8〜17時間**を別枠とする。S0の方式参考/コード確認は58〜102へ含め、実接続を採用する場合だけ追加する。3ツール全採用時は**94〜167時間＋M6未積算残件**。効果を測らず全採用しない。

クラウドadapter/KMS/IaC・固定IP/TLS/OIDC公開検証、XLSXの画像/完全レイアウト再現、全ブラウザ/端末、独立セキュリティ監査、運用監視は別途見積もり。原本を受けない方式やAI転記へ広げない。

次の実作業を承認された場合も、最初はS0だけを提案する。鍵方式/変換互換/資源の成立条件と未成立理由を報告し、S1以降は別判断。S0は6時間時点で途中結果、最大10時間の枠を提案する。不成立でも弱い暗号・検査省略・原本配信へ緩和しない。今回の設計承認をS0着手や予算延長と解釈しない。

## 10. 追加受入（設計のみ・未実施）

既存A01〜A25の業務/分離/復帰を維持し、ファイル閲覧は新方式へ期待値を更新する。旧PDF配信成功の証拠を新方式の合格に流用しない。

| ID | 検証と合格条件 |
| --- | --- |
| S-A01 | 別user/org/candidateの予約・ticket・complete・状態・閲覧を拒否。無効session/CSRF/Origin/署名/期限/method/audience/サイズ/hashも拒否 |
| S-A02 | 同じticket再利用/同時PUT/completeで上書き・二重登録なし。転送前後/確定前後/lease奪取/鍵欠落の停止でも同じ受付IDへ復帰。別暗号文・別原本・AAD/タグ改変を拒否 |
| S-A03 | packet/storage/log/下書き/Nextに平文原本・DEK・秘密鍵・ticket漏えいなし。テストでは合成markerと対象経路を明示し、絶対的な漏えい不存在の証明とは呼ばない |
| S-A04 | 実AV検出、定義鮮度/ロード版不一致、scanner停止、未検査、変換失敗・展開/画素/資源上限で表示/推薦を拒否。旧成果物へfallbackしない |
| S-A05 | PDF正常/拒否fixture、Sheets実出力2種のセル/文字/日本語を確認。XLSXの省略内容を示し、任意script/外部URL/画像・式を実行しない |
| S-A06 | 選択した不変版の成果物のみ共有。共有撤回後のmanifest/全ページ/テキストの新要求と直接URLを拒否。旧原本/請求PDFの取得経路も閉鎖 |
| S-A07 | 再起動・再認証・応答喪失・予約失効・7日後で結果照合/再実行禁止を維持。アーカイブ/鍵失効/権限喪失を再認可で迂回できない |
| S-A08 | 移行前後の原本hash/選択snapshot一致、移行中断の再開、旧鍵/DB/暗号blobセットの復旧、未移行配信拒否。破壊的削除は行わない |
| S-A09 | 既存一巡と請求HTML/内部固定1ページPDFの値・日本語・省略/keyboard/代替テキストを確認。R4保存/復元を回帰し、R5未同期復元とは区別 |
| S-A10 | 小容量/10MiB、1件/複数件、warm/coldで暗号化・転送・queue・AV・変換・初回表示を分解しp50/p95、メモリ、失敗数を記録。成功/拒否負荷を分ける |

低レイテンシーは直接転送と重い処理の非同期化で目指す。初回は予約と認可の2回の制御APIに加え転送/確定が必要で、1往復と説明しない。受信成功と利用可能を分け、暗号化もWeb Worker等でUIを塞がないことを確認する。実測前に応答時間や速度改善率を約束しない。S0の測定結果から対象環境の目標と打切り条件を提示し、オーナーが選ぶ。

## 一次資料と確認範囲

- [AWS署名付きURL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)：期限内再利用、bearer権限、IP条件などの仕様。AWSはadapter例であり採用決定ではない。
- [AWS条件付き書き込み](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)：新規作成条件。世代管理だけで不変性を保証しない。
- [Web Crypto AES-GCM parameters](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)：nonce/AAD/tagのAPI契約。
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)：限定許可、隔離、AV/CDR等の防御。完全な無害化保証ではない。

以上は2026-10-16の文書/コード確認に基づく設計判断。暗号相互運用・新ワーカー・変換・復旧・性能・新受入の実行結果はまだ存在しない。
