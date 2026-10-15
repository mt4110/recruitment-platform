# レジュメ受付・ウイルス検査・全フォームの自動保存

設計 v0.4 R0追補 / 2026-10-15（レビュー5件と再レビュー残件P2を設計へ反映）。**R1の形式検査・DB/API・配信拒否を実装。AVはR2未着手のため新規文書はpending・配信不可。R0の独立方式確認は[追補記録](../validation/2026-10-15-r0-followup-report.md)を参照。** M4までの実行結果は変更しない。実装・migration実行・依存導入・クラウド変更は別途の着手判断とする。本書を追加要件の詳細契約とし、01〜09の関連箇所と合わせて読む。レビュー5件の変更は[反映記録](../reviews/2026-10-15-v04-revisions.md)を参照。

## 1. 対象と境界

- 履歴書・職務経歴書をPDFまたはXLSXの原本のまま登録できる。共通テンプレートへの転記は必須にしない。
- 初期のXLSX互換確認範囲はGoogleスプレッドシートからの実出力とする。Excel由来の実出力は未検証で、Excel固有機能との互換性を保証しない。producer申告を信頼して検査を省かず、由来を問わず同じ構造policyで判定する。GoogleスプレッドシートはXLSXへ書き出して登録する。Googleへの直接接続、旧形式XLS、XLSM、CSV、DOCX、XLSXのPDF変換・ブラウザ内プレビューは今回の対象外。
- PDF/XLSX双方で形式検査とウイルス検査の合格を必須にする。認証付きAPIで受け付け、非公開保管し、原本・共有とも取得時に認可する。署名URLは今回導入しない。
- ログインを除くすべてのフォームで下書きを自動保存する。求人・候補者の新規/編集、推薦作成/理由、提出書類の選択、選考/共有取消の理由、検索/絞込みと表示位置、後続M5のフォームも対象。ログインの認証情報・OIDC・CSRF値は保存しない。
- 保存先は利用者個人の下書き。公開、候補者作成/更新、推薦提出、採否、辞退、共有取消は既存の明示操作を維持し、下書き保存で業務表や通知を変更しない。架空データ専用という境界も維持する。

## 2. 書類の整理と利用体験

1. 候補者詳細に「履歴書」「職務経歴書」「その他」を表示する。各種類で複数の版を保持し、新版は別documentとして追加する。旧版・提出済み参照を上書きしない。
2. 利用者は種類を選び、PDF/XLSXを複数選択できる。1要求1ファイルの既存APIを順次呼び、一覧にファイルごとの待機/送信中/検査中/登録完了/登録拒否/再試行待ちを出す。同時送信は1件、1回の選択は最大10件。
3. ファイル名、種類、形式、登録時刻、サイズ、検査状態を表示。ファイル選択時に形式・サイズの案内をするが、サーバーの判定を正本にする。拒否理由と修正方法を日本語で返す。XLSXの数式、画像、複数シート、結合セルを一律拒否しない。
4. 推薦時は検査合格済みの種類・版・形式を並べ、実際に共有するファイルを明示選択する。初期値で全原本を共有しない。選択IDは個人下書きとして復元するが、提出直前に現在の認可・同一候補者・検査合格・サイズ/hashを再確認する。同意/架空データの確認は復元済みでも未確認へ戻し、再確認する。
5. 完了済みuploadのdocument ID、処理中ID、元Idempotency-Keyと状態を下書きへ保存する。再表示で状態照合し、失われた応答を新規uploadとして二重登録しない。ファイル入力のFileオブジェクト/原本bytesは端末下書きへ保存しない。送信前またはDB予約前の中断は再選択を案内し、再選択bytesのhashと元要求を照合する。
6. 取得は安全な固定名resume.pdf / resume.xlsxのattachment。原本名は画面だけに表示する。登録合格は未知の脆弱性まで安全と認定するものではなく、ダウンロード後のOffice動作も制御できない。

## 3. PDF/XLSXの受付policy

共通上限は実bytes 10MiB、multipart全体10MiB+64KiB、受信30秒。fictional_confirmed、document_kindをfileより前に送り、未知/重複項目を拒否する。拡張子・MIME・構造を照合する。MIMEはPDFのapplication/pdf、XLSXのapplication/vnd.openxmlformats-officedocument.spreadsheetml.sheet。application/octet-streamは拡張子と内容を厳格に照合できる場合だけ受理し、保存media_typeは検査結果から決める。名前だけで形式を決めない。

| 検査 | 許可と拒否・上限（初期設計値） |
| --- | --- |
| PDF | 既存static-resume-v1を維持。1〜20ページ、破損/暗号化/active content/注釈等は06のとおり拒否。ウイルス検査を追加してstatic-resume-v2とする |
| XLSX | OOXML transitional workbookの許可リスト方式をxlsx-resume-v1とする。通常の複数sheet/書式/結合/静的画像/内部数式を許可。計算・描画・外部取得は行わない |
| ZIP | 展開合計64MiB、1entry 16MiB、entry数1,000、全体展開比100倍以内、sheet数20以内。宣言値と実読取り値の両方を検査。絶対path、..、逆slashによる逸脱、重複/正規化衝突名、symlink、暗号化、入れ子archiveを拒否。diskへ無制限展開しない |
| XML/OOXML | DTD/外部entity/ネットワーク解決を無効化。DOCTYPE拒否、深さ64、全XML要素合計200,000まで。Content_Typesと全relationshipsを解析し、参照先・型・存在を照合。未知part/content type/relationshipは黙認せずUNSUPPORTED_STRUCTURE |
| active/external | VBA/XLM、OLE/ActiveX、埋め込みファイル、外部workbook/接続/query、外部relationship（リンク画像/クリックリンク含む）を拒否。DDE/WEBSERVICE/HYPERLINK/RTD等の外部作用を持つ式と未対応式も拒否。内部数式は対応する文法/関数の許可リストだけを通し、cached valueを含め実行しない。単なるURL文字列はリンク動作と区別する |
| 静的画像 | PNG/JPEGのみ、各4MiB以内/計10枚まで。画像の再エンコードや描画はせず、形式と格納関係を照合。その他図形/グラフ/画像形式は初期版で対応外として案内する |

初期の内部式の許可文法は同一workbook内のA1参照/範囲・定数・四則/比較/括弧、関数はSUM/MIN/MAX/AVERAGE/IF/AND/OR/ROUND/DATE/YEAR/MONTH/DAY/DATEDIF/TODAY/TEXTに限定する。名前定義は_xlnm.Print_Area/Print_Titlesの内部範囲だけを許可し、その他の名前定義/拡張関数/未知namespaceは対応外。式を構文解析し、文字列の部分一致だけで外部式を判定しない。必須partは[Content_Types].xml、_rels/.rels、xl/workbook.xml、workbook relationshipsと参照sheet。styles/sharedStrings/theme/calcChain、docPropsのcore/app、PNG/JPEG・それらのdrawing/relationshipsは整合検証したものだけ許可し、これ以外のpart/型/名前空間は初期版で対応外とする。ただし、以下のSheets実出力に限定した例外を加える。

### Sheets実出力の空metadata例外（R0確認後）

- `xl/persons/person.xml`は最大16KiB、UTF-8（BOM可）のXMLだけ。rootは`{http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments}personList`、属性なし・子要素なし・本文は空白だけ。person、extLst、未知要素/属性、別namespace、DTD/entity、他encodingは対応外。namespaceをworkbook全域へ許可するのではなく、このrootの用途にだけ許可する。
- Content typeは`application/vnd.ms-excel.person+xml`のOverrideがこのpartへ一つ。参照はworkbook relationshipsから`http://schemas.microsoft.com/office/2017/10/relationships/person`が一つだけ、Target=`persons/person.xml`、TargetMode省略またはInternal。part/関係の重複、不正path、別source、外部Target、persons自身のrelationshipsは拒否する。ZIP全体の重複・参照整合検査も維持する。
- 投稿者データ、threaded comments/comment partsは初期対応外。空metadataは削除せず、原本bytesを保持して検査する。Microsoftの[Persons仕様](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/1a170d26-42a2-46f0-b2b6-0ff1dec1c344)と[personList仕様](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/9f1b6e0e-79cd-4ae2-b3a7-6dea649c57f6)を参照した限定対応。
- Sheetsは実在partのない`odttf`用Default（`application/vnd.openxmlformats-officedocument.obfuscatedFont`）も宣言する。この特定の未使用宣言だけを許可する。実font part・同拡張子のentry、他の未知宣言、重複/矛盾は拒否し、埋込fontを許可する意味にしない。

Sheets実出力にある未使用namespace宣言も、[`xlsx_validator.py`](../../services/pdf-renderer/xlsx_validator.py)の`UNUSED_NS`に列挙した13 URIに限り許可する。これらを使う要素・属性・part/relationshipは許可せず、未知の宣言自体も拒否する。[XML namespace仕様](https://www.w3.org/TR/xml-names/#ns-decl)の名前識別と、構造を実際に利用することを区別する。ZIP名はZipInfoが切り詰める前の元名も照合してNULを拒否し、Unicode NFC/大文字小文字の正規化衝突を拒否する。sheet名は1〜31文字、`[]:*?/\`・制御文字・先頭末尾apostropheを拒否し、外部workbookの表記を内部sheetとして扱わない。数式は最大4,096文字/2,048 token/深さ64とし、Print_Titlesの行/列範囲も内部参照だけを許可する。

R1は既存Python serviceの標準`zipfile`＋`xml.parsers.expat`で、実展開量/比率、深さ/要素数を逐次制限し、DOCTYPE/外部entityをparser handlerでも拒否する方針。XMLは初期対応をUTF-8に限定。内部式は専用の小さな構文解析で上記文法を実装し、evalや数式計算は行わない。新しいOffice描画libraryは追加しない。[Python XMLの注意事項](https://docs.python.org/3.13/library/xml.html#xml-vulnerabilities)に従い、採用runtimeの`pyexpat.EXPAT_VERSION`を記録して2.7.2以上を必要条件とする。子process制限と悪性ZIP/XML/式の完全な受入はR1/R6に残り、R0の空metadata実験をその代替にしない。

「未対応式/構造」は感染と区別して説明し、「PDFへ書き出す」「外部リンクを外してXLSXを保存」を案内する。一般のExcel互換を保証しない。実装前の小さな方式確認で、架空情報を入力してGoogleスプレッドシートから実際に書き出した履歴書・職務経歴書fixtureを使い、許可リスト、parser依存/ライセンス/資源上限を固定する。手作りZIP/XMLだけでは実製品との互換確認を完了としない。実在情報を検証用に集めない。成立しなければ受付範囲/工数を提示して停止し、検査を緩めて合格にしない。

## 4. ウイルス検査と隔離

採用方式は公式Debian版ClamAV 1.5.4のclamd + FreshClam（`1.5.4-debian13-slim`、各archのmanifest digestをR0追補に固定）。native arm64/amd64での実行と公式定義の世代切替の独立確認結果は[R0追補](../validation/2026-10-15-r0-followup-report.md)を参照。Alpine版だけを確認していた前回のarm64未成立を更新する。ClamAVはGPL v2のライセンス本文・第三者ライセンスを保持し、公式配布imageを利用する。自前改変imageの再配布/商用配布条件の最終確認はM7。独立実験の成立を製品のHTTP認証/受付ゲートの結合成立とは扱わない。

- 既存PDF serviceはPDF/XLSXの構造検査を担当する。新しい内部scan serviceは認証付きHTTP wrapperから同コンテナのUnix socketのclamdへINSTREAMでbytesを渡す。任意path/コマンドを受け付けず、clamdのTCP portを公開しない。
- scan serviceは外向き通信なし、非root/read-only/cap drop、tmpfs・資源制限、DB認証/原本volumeなし。APIからの内部通信と共有鍵だけを許可する。検査bytesや検出文字列をログに流さない。
- 更新専用serviceだけがFreshClamの更新先へ外向き通信する。原本/DBへ接続せず、署名DB volumeのみ書込み可。検証済みの更新を不変な世代別directoryへpublishし、scan側は読み取り専用で取り込み、実際にロードしたDB版を応答する。途中のDBを使用しない。wrapperは新規scanを保留し、実行中のscanを完了/timeoutさせてから新世代directoryを指定してclamdを再起動し、ロード完了と版を照合して受付を再開する。方式/資源と版・hashの対応はR0で独立確認する。製品の受付停止・drain・manifest publishとHTTP応答の結合受入はR2に残す。
- 既存7サービスにscan/updaterを追加し、設計上は9サービスとする。scan初期上限2GiB、同時1検査、wall time20秒、構造検査は既存256MiB/CPU5秒/wall5秒。上限値は性能保証ではなく、両archで調整・記録する。
- アップロード全体はAV→形式検査の順。検査対象hashを応答へ結び付け、両結果が同じbytesであることをAPIが検証する。検査中もDB transactionを保持しない。upload leaseは60秒から120秒へ変更し、各外部要求にtimeoutを設定、期限切れ旧workerはCASで確定できない。
- scanはStreamMaxLength=10MiB、MaxScanSize=64MiB、MaxFileSize=16MiB、MaxRecursion=8、MaxFiles=1,000を初期値とする。AlertExceedsMax等を有効にし、上限に達して一部をskipした結果をclean扱いにしない。20秒のAPI timeoutだけで裏の処理が残らないよう、engine制限・busy制御・異常時のworker復旧を確認する。
- FreshClamは起動時と6時間ごとに更新確認する。更新側は世代ID・全DBファイルの版/hashを含むpublished_manifestと、その世代に対するlast_successful_checkを公開する。scan側はロード完了を確認したloaded_manifestを保持する。**新しいcleanを確定できるのはpublishedとloadedの世代/版/hashが一致し、その世代の正常確認が24時間以内の場合だけ。** 未導入/検証失敗/ロード不明/再ロード失敗/版不一致/確認期限超過はpending/503 SCANNER_UNAVAILABLEとする。更新なしの正常確認は同じ世代だけの時刻を更新し、新しい世代の確認時刻で旧ロード版を新鮮としない。DBのmtimeや単なる更新通知ではロード完了を認定しない。上流の公開時刻も記録し、版の後退を拒否する。
- 感染/禁止要素/確定した検査上限超過はrejected/422。scan停止・期限切れ定義・timeout・解析worker障害はpending/503で復旧可能。UIは失敗と処理中を区別し、手動retryを用意する。検査に失敗しても保存/推薦できる迂回操作は作らない。
- レート制限はuser毎10件/分、org毎30件/分、upload同時2/scan同時1を初期値とする。orgごとの原本・staging合計512MiBを予約込みで制限し、quotaは413 STORAGE_QUOTA_EXCEEDED、頻度は429/Retry-After。冪等replay用の一時領域もglobal上限1GiBで制限する。未検査の受信もglobal予約対象とし、予約は短いtx/CASで競合に耐える。容量不足時に既存ファイルを自動削除しない。

検査応答は要求nonce・対象hash・engine版・検査に実際に使ったloaded世代/版/hash・その世代の確認時刻を返す。scan中の更新で判定を混ぜないよう、要求開始時の世代を固定し、APIは検査結果の保存直前にもpublishedとの一致と24時間以内を照合する。不一致ならcleanを保存せずpendingとして再試行する。認証付き内部応答を照合する方式とし、署名DBの検証と独自の応答署名を混同しない。

検査情報はhash/形式policy/検査時刻/engine版/DB世代・版/hash/AV結果を保存する。ready後に別policyとして書き換えず、将来の検出や運用上の停止は別の利用可否記録で扱う。利用可能条件は同hashの対応policy cleanが存在し、blockedが存在せず、現在の取得認可があること。定義鮮度/scan障害は新しいclean確定を止める条件で、既存cleanを毎日失効させる条件ではない。新しい定義だけで未再検査の既存原本の安全性が上がったとは扱わない。

### 既存PDFの移行

適用済み0001〜0005は書き換えず、追加migrationで既存PDFの形式をpdf、種類をotherとして補完する。既存readyはstatusを保つがAV未検査のため利用不可とし、一覧に「追加検査待ち」を表示する。APIの原本取得・共有取得・新規提出のすべてで利用可否を検証する。既存共有参照も同じ判定を通し、PDFだけの旧配信経路を残さない。

認証した所有agencyの元登録者による明示的な再検査操作で同じhashの原本をAV・形式の両方で再検査し、合格policyをdocument_checksへ記録する（原本の旧policy列は書き換えない）。利用可否・検査結果は別表へ追記し、元のready/提出snapshot/bytesは変更しない。既存共有ファイルはapplication_documentsの不変参照と利用可否記録だけを読み、企業にdocuments原本権限を与えない。感染/障害なら配信を止め、取得済みbytesの回収は保証しない。定義更新ごとの全件再検査は今回作らず、後日の再検査でも悪性判定を取り消す操作は作らない。

## 5. 個人下書きのデータ・API

| 追加/拡張 | 契約 |
| --- | --- |
| documents | file_format(pdf/xlsx)、media_type、document_kind履歴書/職務経歴書/その他（API値resume/career_history/other）。新規は必須、不変。ready条件は形式policyとAV cleanの両方必須。既存行への移行例外は前節に限定 |
| document_checks | id/document_id/org_id/hash/policy/engine_version/signature_version/scanned_at/verdict(clean/blocked)、actor_user_id。composite FK(document_id,org_id)、API内部で認証付き検査応答の対象hash/要求nonce/定義世代を照合（定義DB自身の検証は更新側で実施）。追記のみ、runtime UPDATE/DELETE不可。blockedが1件でもあれば利用禁止、cleanの後もblockedを優先する。技術障害はclean/blockedを作らずpending相当。元所有userの再検査に限定。再検査jobはdocument ID UNIQUE、state/lease_token/lease_expires_atと元操作keyを持つ別表でCAS管理 |
| application_documents | format/media_type/kindを提出時に複写し不変。既存参照はpdf/otherで補完。共有側は親案件のE_SHAREDとdocument_checksの可否を検証。checksのemployer SELECTはE_SHAREDのapplication_documentsにあるdocumentだけ。applicationsのpolicyから子を参照せず、再帰を作らない |
| form_drafts | id UUID、org_id/user_id、form_type、target_id NULL、context_id NULL、schema_version、base_resource_version NULL、revision bigint、encrypted_payload、nonce、key_version、updated_at/expires_at、consumed_at NULL。UNIQUE(org_id,user_id,id)。対象/所有は作成後不変 |
| draft_operations | org_id/user_id/operation_id UUID、draft_id/revision、method/normalized_path、request_hash、result_resource_type/id、result_status、committed_at/result_expires_at。UNIQUE(org_id,user_id,operation_id)、業務commitと同じtransactionでINSERT。PII本文/資格情報を含めず、結果参照はcommitから7日。期限後は最小の識別子/hash/期限切れ状態を保持し、同操作の新規実行を禁止 |
| draft_keys | user_id/org_id/key_version、master keyでwrapした端末用256bit鍵、created_at/revoked_at。自分の有効鍵だけAPIが提供。業務runtimeには他user/他orgのSELECT不可。鍵生成は競合しても同じcurrent版を返す |

検査記録はowner agencyがSELECT可、元登録者かつ所有agencyだけがINSERT可。企業は自社E_SHARED共有参照に結び付く記録の可否だけをAPIから受け取り、詳細のengine/hash/原本情報はDTOへ出さない。document_checksのRLSは共有参照→親applicationを確認し、applications/application_documents側のpolicyからchecksを参照しない。

form_drafts、draft_operations、draft_keysはENABLE/FORCE RLSで自分かつ自組織のみ。form_typeはjob_new/job_edit/candidate_new/candidate_edit/application_new/application_reason/application_submit/selection_note/document_upload/job_filters/candidate_filters/application_filters。後続フォームはschemaと受入を同じ変更で追加する。新規draft IDはブラウザがUUIDを生成して同じIDで再試行する。targetは既存resource、contextは推薦作成時のjob等を特定する。IDを暗号化本文だけに隠して認可を省略しない。

payloadはフォーム別許可リストと各項目の既存文字数制限に従う。未入力/途中入力は許可するが、未知項目/型違い/超過を拒否する。検索語、編集値、選択document ID、focus field/selection/scroll、upload処理ID/操作キーを保存可。uploadの結果照合/期限切れ拒否は以下の7日契約に従う。候補者原本の表示用複製、ファイルbytes、同意済みフラグ、token、HTML、任意遷移URLを保存しない。1draft plaintext最大64KiB、envelope要求最大96KiB。通常JSON64KiB制限とは別にdraft routeだけ96KiBを許可し、無制限に広げない。1userの有効draft最大50件/合計2MiB（plaintext換算）。tombstoneは有効draft quotaに数えず、空bodyの無制限生成を防ぐためdraftの新規作成はuser毎30件/時、更新は120件/分を初期制限とする（429/Retry-After）。超過は409 DRAFT_QUOTA_EXCEEDEDとし入力を消さない。

| Method / Path（/api/v1以下、未実装） | 入力 / 応答 |
| --- | --- |
| POST /drafts/key | key_version省略時は認証/CSRF後の本人current鍵を競合安全に生成/取得。指定時は本人のその版だけ取得し、新規生成/current切替をしない。本人の未失効旧版は取得可、他人/他組織/存在しない版は404、本人の失効済み版は409 DRAFT_KEY_REVOKED。no-store、cookie/OIDC値は返さない |
| GET /drafts?form_type=&target_id=&context_id= | 現在の本人scopeのmetadata一覧、limit20/最大50、期限内のみ。復元前に対象認可を再確認 |
| GET /drafts/:id | 認可再確認後のpayload/revision/base_resource_version/schema_version/expires_at。復号できない/期限切れは復元しない |
| GET /candidates/:id/document-upload-outcome?key= | 本人/自社候補者/元登録userのupload結果を7日間照合。期限後409 OPERATION_RESULT_EXPIRED、詳細は次節のupload契約 |
| GET /drafts/:id/outcome?operation_id= | 本人scopeでcommitted（現在認可に応じた結果ID/status）、not_recorded、expiredを返す。consume済みでも結果期限内は照合可。not_recordedは未実行の保証ではなく再試行時も同じ操作キーで直列化する。payload本文や旧PII応答は返さない |
| PUT /drafts/:id | revision（新規0）、form_type/target/context/schema/base版/payload、mutation_id UUID。新規201/更新200、revision+1。厳密な同mutation_id+同payload再送は同じ結果参照、同ID異payload409。期限24hの冪等記録を業務POSTと別scopeで使用 |
| POST /documents/:id/recheck | 所有agencyの元登録者、Idempotency-Key必須。旧readyでAV未検査の原本を同じID/hashで検査。完了200、処理中202、障害503、検出422/利用禁止。新規ready作成とは別の検査job/120秒leaseで直列化。既存blockedは409 DOCUMENT_BLOCKED、clean済みの再送は現在結果。候補者アーカイブ後も既存文書への自社権限があれば可 |
| POST /drafts/:id/discard | revision/Idempotency-Key、本人の明示的破棄、204。本文を消しtombstoneを残す。自動の物理削除APIは作らない |

すべての書込みに認証/Origin/CSRFを要求。対象の現在の閲覧/編集可否も毎回確認する。DBの対象org FKとAPIのform_type/target/context対応検証を併用し、本文の候補者/job/document参照は保存/復元時に本人の権限で確認する。求人新規はemployer、候補者新規はagency、推薦作成はagency+公開job、企業のselection_noteはE_SHAREDかつ操作可能状態。検索draftも組織種別を確認する。権限喪失/共有失効は404、状態変更やbase version差異は409 DRAFT_CONTEXT_CHANGED、draft revision競合は409 DRAFT_VERSION_CONFLICT。不明schemaは409 DRAFT_SCHEMA_UNSUPPORTEDとして自動送信を止める。検索条件が求人非公開になっただけで条件draftを拒否しない。期限/consume/discardのtombstoneがあるIDはPUTで再作成できない。

書込みは1draftを直列化し、最新入力をcoalesceする。別タブ更新や不明な応答を新しいrevisionで盲目的に上書きしない。409は本人の入力と現行値の差を表示し、「最新から再開」「自分の入力を確認して適用」を選ぶ。自動mergeはしない。

通常の業務保存は、API互換のためdraft_id/draft_revision/operation_idの3項目をすべて省略することも許可するが、v0.4の入力フォームからの確定では3項目を必須送信する。フォーム入力を持たないお気に入り/公開/アーカイブ等のボタン操作は既存APIの冪等・version契約に従い、無関係なフォームdraftを流用しない。一部だけの指定は422。operation_idを当該POSTのIdempotency-Keyと同じUUIDにし、PATCHでも3項目付き要求の操作照合に使う。通常の業務保存はこれらを受け取り、業務変更とdraftのconsumeを同一transactionで確定する。業務lock順の後にdraftをlockし、draft保存側は業務行をlockせず認可/版を照合する。consumeは本文を消しtombstone化する。対象user/org・form_type・target/context・draft revisionと要求の業務入力の対応を確認し、別フォームのdraftを消費しない。draft_operationsへの結果ID/status/要求hashの記録も同じtransactionに含める。冪等replayはconsumeを繰り返さない。業務成功時に対応draftが新revisionなら業務をrollbackして競合を返す。確定ボタンの前に最新の自動保存を待ち、応答したdraft revisionを確定要求に含める。失敗/未同期なら確定を止めて理由を示す。検索/絞込みdraftは業務consume対象ではなく本人の最新条件として保持する。初回公開・推薦・採否の確定には既存version/同意/Idempotency-Keyを必須とし、draftだけから勝手に実行しない。

uploadは原本受付後の状態照合なので、このconsume方式で原本受付をrollbackしない。応答喪失時は既存upload key/状態から結果を確認し、消費済みupload draftを新規再送しない。成功後のdraft消去応答が失われても、復元時に原本/業務の現在状態・版を照合して再提出を止める。

### アップロード結果の7日照合と期限後の再実行禁止（再レビューP2）

uploadはファイルとDBをまたぐためdraft_operationsの業務consume処理とは分けるが、結果の照合期間は同じ7日間とする。既存のidempotency_recordsのupload scopeを拡張し、別の結果台帳を二重に作らない。

- scopeはorg/user/POST/正規化した候補者のupload path/Idempotency-Key。processingは期限なし、120秒leaseとCASで同じdocument IDを復旧する。completed/failedは**完了または拒否確定から7日間**、resource_id・request_hash・結果status/codeを保持する。再表示/照合/再送で期限を延長しない。ほかの通常の冪等記録の24時間とは区別する。
- GET /candidates/:id/document-upload-outcome?key=:uuidを追加する。本人の有効session・所属・自社候補者・元登録userを検証し、そのscopeだけを読む。200でcompleted/failed/processing/not_recordedと、記録がある場合のdocument_id/status_url/結果status・拒否code/結果期限を返す。hash/保存key/lease token/過去の本文は返さない。no-storeを付け、候補者のアーカイブ後も自社の既存文書照合は許可する。他人/他組織/候補者不正は404。
- ブラウザは送信前に元キー・候補者ID・種類・表示名等の要求metadataを暗号化してdocument_upload下書きへ保存する。応答喪失でdocument IDがなくても、再認証後は元キーから先に結果を照合する。completedなら同じdocumentを一覧へ戻し、failedなら保存された拒否理由を表示し、processingなら同じIDの状態確認/既存retryへ進む。元Fileの再選択や新しい原本登録を、結果照合の代わりに行わない。
- not_recordedはDB予約前/実行中の可能性もあるため、未実行の証明としない。元Fileを再選択し、架空データを再確認して元キー/同要求で本人が再試行できる。通常のPOST再送は従来どおり実bytesのhashを照合し、異payloadは409 IDEMPOTENCY_MISMATCH、同payloadは同resource/保存済み結果。先行要求との競合は同じ冪等lockで直列化する。
- サーバー時刻が結果期限以上なら、整理処理がまだ走っていなくても照合/同キー再送は409 OPERATION_RESULT_EXPIREDとし、元の結果DTOを返さず、新しいdocument/検査/ファイル配置を開始しない。POSTでは認証・現在の所有確認後に期限切れscopeを先に確認し、未検査bytesの受信/保存前に拒否できる構成にする。確定結果照合後にも同じlock内で再判定する。
- 期限後もscope/key/hash/期限とstate=expiredの最小tombstoneを残す。idempotency_recordsにupload専用のexpired状態と対応制約を追加する設計とし、通常の期限整理でこの識別子を削除しない。元キーを新規キー扱いに戻さず、古い端末キューから復活させない。期限切れを新しいキーで自動迂回せず、本人が文書一覧と現状を確認してから、別の新規登録を明示的に判断する。
- outcomeはGETで照合するだけなのでCSRF不要、upload/retryは既存のOrigin/CSRFを維持する。結果照合は登録の可否と配信の可否を分け、completedでも現在のAV利用禁止/共有失効を迂回しない。元キーは認可用の秘密として扱わず、必ず現在の認証と本人scopeを要求する。

この変更はv0.4の追加migrationで行い、0001〜0005は変更しない。残存する旧upload記録は元の終端確定時点を基準に7日へ揃え、移行時刻から7日に延長しない。移行前に既に整理されて追跡不能なキーは復元保証対象外と明示し、旧端末キューの自動再送を止めて一覧確認へ案内する。今回migration/整理/実験は実行しない。

### 業務要求の送信と応答喪失からの復帰（指摘1）

1. 確定前にdraft同期を完了し、操作対象フォームを一時固定する。ブラウザはoperation_id、draft ID/revision、method/path、正規化した要求のhash、再構成に必要な業務入力/元versionを、暗号化した送信予定記録としてIndexedDBへ保存する。この保存に失敗したら送信しない。CSRF/OIDC値と同意済みフラグは保存しない。確認値が必要な再送では本人に改めて確認し、元と同じ要求を組み立てる。
2. APIは認証/CSRFと現在の関係確認→org/user/operation_idから決めるtransaction-level操作lock→既存の冪等lock→draft_operationsの照合→未完了時だけ業務version/状態検査→業務更新/consume/結果記録の順に処理する。処理中は元の入力を変更・自動保存しない。失敗時は入力を戻して編集可能とする。結果記録と業務更新が別々にcommitされる状態を作らない。
3. 応答喪失/再読み込み後は本人再認証・対象認可を確認してからoutcomeを取得する。committedなら現在の結果IDへ移動し、端末の送信予定と下書きを終了扱いにする。既に共有が失効していれば許可されたmetadataのみ、閲覧不可なら結果本文を表示しない。新規求人/候補者のように送信前にresource IDがなくてもoperation_idから結果へ到達できる。
4. not_recordedなら自動で新しい操作キーを作らず、同じキー/要求での再試行を本人に提示する。先の要求がまだ実行中でも同じlockで直列化され、片方のcommit後に結果を参照する。同じoperation_idのmethod/path/hash違いは409 IDEMPOTENCY_MISMATCH。古い業務versionや、消費済みdraftだけを根拠に二重実行しない。
5. 通常の冪等記録は既存の24時間を維持するが、draft連動要求は先に7日保持のdraft_operationsも照合する（認証・現在の関係/閲覧認可は照合より前に確認）。24時間経過後もcommit済みを再実行しない。結果期限後は409 OPERATION_RESULT_EXPIREDとして自動/同キー再実行を禁止し、一覧から本人確認へ案内する。期限切れtombstoneも新規操作扱いにしない。

送信予定は通常の編集payloadと別に同じIndexedDB内へ暗号化保存する。操作のpayload変更を同じoperation_idへ流用しない。元操作の結果を確認する前に、別キーによる同じ確定操作へ進まない。これはログアウト/別アカウントの自動再送を許可する契約ではない。

### 全フォームと保存種別の対応（指摘4）

| フォーム/入力 | form_typeと対象 | 完了・復元の境界 |
| --- | --- | --- |
| 求人新規/編集 | job_new（targetなし）/job_edit（job ID） | 求人作成/更新で当該draftのみconsume |
| 候補者新規/編集 | candidate_new（targetなし）/candidate_edit（candidate ID） | 候補者作成/更新で当該draftのみconsume |
| 書類の種類・登録待ち一覧・処理状態 | document_upload（candidate ID、contextなし） | upload操作キー/選択時metadata/受付済みIDを保存。候補者編集とは独立、編集の保存/破棄で消さない。File bytesは保存せず再選択。全件終端を照合後に本人が完了/破棄しtombstone化 |
| 推薦新規/理由編集 | application_new（context=job ID）/application_reason（application ID） | 作成/理由更新で当該draftのみconsume |
| 提出書類選択 | application_submit（application ID） | 選択IDを復元し、同意/架空確認はやり直す。提出成功で当該draftだけconsume |
| 選考・辞退・共有取消の理由 | selection_note（application ID） | operation種別も保持。状態と権限を再確認し、該当する明示操作成功でconsume |
| 求人/候補者/推薦の検索・絞込み | job_filters/candidate_filters/application_filters（一覧scope） | 検索ではconsumeせず、本人の最新条件/表示位置として保持 |
| 後続の新しいフォーム | 実装時に専用schema/対象/consume条件を追記 | 保存種別と受入がないフォームを完成扱いにしない。ログインは対象外 |

複数tab/複数の新規draftはIDで区別し、一覧scopeに複数候補があれば保存時刻と種類を示して本人が選ぶ。自動で別draftを上書きしない。document_uploadは非アーカイブ時に追加受付可、アーカイブ後も本人の受付済み処理IDの照合/表示は可とし、新規送信を無効化する。業務操作で別種の下書きが古くなった場合はconsumeせず、復元時に現在の状態/版を再検証する。

## 6. 保存・復元・鍵と端末保管

通常は入力から500msのdebounce、連続入力中でも2秒ごとを目標に端末/サーバーへ保存する。これは通信・OSを含む完了時間保証ではない。日本語IME変換を妨げず、未確定文字も下書きとして保持し、composition終了で最新内容を保存する。最後の保存成功時刻と未同期状態を表示する。blur/visibilitychange/pagehideを補助にし、beforeunloadや終了時通信だけに依存しない。

- 入力中に端末側の暗号化IndexedDBへ最新payloadを保存し、通信があれば本人のサーバーdraftへ同期する。保存中・端末保存済み/未同期・同期済み・失敗を区別する。storage quota/暗号化/保存失敗時は保存済みと表示せず、入力を保持して警告する。
- AES-256-GCM、毎回新しい96bit IVを使う。AADにorigin/org/user/draft ID/schema/key_version/local sequenceを含め、別アカウントへ流用しない。鍵は認証済みAPIから取得しメモリだけに持つ。localStorage/sessionStorage/IndexedDBへ平文payload・復号鍵・File bytes・tokenを置かない。サーバーdraftも別のserver用鍵で暗号化し、DRAFT_MASTER_KEYから用途分離する（HKDFの固定contextでserver-payload/key-wrapを分ける）。master keyはGit外secret、wrap鍵とDBをセットで復旧する。端末鍵はuser/orgごとの暗号学的乱数で、revoked_atを持つ。通常のlogout/セッション期限では永続鍵を失効させずメモリだけ破棄する。鍵漏えい時の失効は以後の復元を拒否し、未同期分が復元不能になる影響を明示する。master keyの更新は端末鍵そのものを変更せず再wrapする。端末鍵の版更新時は新しいcurrent版で以後の保存を暗号化し、未失効の旧版も復元用に保持する。再起動後は各端末envelopeのkey_versionを指定して鍵を取得し、AAD/期限/認可を確認して復号、current版で再暗号化・同期が成功してから旧envelopeを終了扱いにする。失効版は取得・復号を禁止する。旧版取得失敗時に暗号文を消したり空draftで上書きせず、復元不可の理由を示す。
- 初期鍵取得失敗時は入力を無効化せず、永続保存が未準備と明示してメモリ内で保持し、成功後に保存する。消失保証ができない期間を「保存済み」としない。暗号化は端末保管時の対策で、ログイン中のXSSから守る保証ではない。
- TTLは最後の成功保存から7日、期限はサーバー時刻で確定。未同期端末データも復元時にサーバーで期限/認可を再評価し、既存draftの期限切れをオフライン入力だけで延長しない。新規の未同期draftは初回作成時から7日以内に認証後同期する。browser時刻の偽装で期限を延長しないよう、認証時のserver時刻を基準に保存する。
- 画面遷移/再読み込み/OIDC後はまず/meと対象認可・状態・版・draft期限を照合し、本人の下書きだけ復元する。復元中に既存値で空上書きしない。保存したcursorが現在の検索条件/権限で無効なら先頭へ戻し、その旨を案内する。focus/scroll位置は対応fieldがある場合のみ復元し、エラー/失効案内を隠さない。
- セッション切れ・logout・別userへの切替でメモリ内の鍵/平文/表示を破棄し、他タブへ秘密値なしの通知を送る。暗号化済み端末下書きは本人再認証後のため期限内だけ保持。未同期分は認証失効後に送らず、別userの鍵で復号しない。logout直前の未保存分も保証せず、未同期なら表示して本人が判断できるようにする。
- バックグラウンドから復帰したら機密フォームを一時ロックし、認証と対象権限を再照合する。オフラインでその照合ができなければ復元本文を表示せず、再接続を待つ。表示中の自社フォームで通信が切れた場合は端末保存を継続できるが、期限切れ判明時にはロックする。共有案件のフォームはオフライン時にロックする。
- 共有失効後の企業の自由記入理由も下書きから再表示しない。サーバーはE_SHAREDを確認し、端末復号前にも再確認する。既に閲覧/取得済みデータの完全回収や、オフライン端末へ即時に失効通知する保証はしない。
- タブごとにlocal sequenceを持ち、暗号化ローカル候補をtab ID別に保管する。BroadcastChannelは更新通知だけを運び、内容/鍵は送らない。単一tab内の古い保存応答で新しい入力を巻き戻さず、revisionとsequenceで照合する。
- 明示的破棄・正常consumeのtombstoneを端末同期へ伝え、古いキューから復活させない。期限切れ/consume/discard済みは復元APIで拒否。期限切れ/consume/discard後も最小の識別子・所有・状態・版・期限だけのtombstoneを残し、今回その行の物理削除は実装しない。期限切れIDのPUTは作成扱いにせず拒否する。7日後の本文（暗号文）の整理は下書き専用の保守権限で範囲を限定し、dry-runと運用者の対象確認後に実行する。今回その削除処理は実行しない。

**復元できるのは最後に永続保存へ成功した内容まで。** OSによる強制終了直前、ブラウザによるサイトデータ消去、利用者によるデータ削除、端末故障で未同期分を失う可能性は残る。navigator.storage.persist()の可否を確認できるが、許可や永久保持を前提にしない。オフライン再起動後の即時復号は行わず、本人のオンライン再認証後に復元する。別端末にはサーバー同期済み分だけを返す。

## 7. 追加受入条件（未実施）

| ID | 確認する振る舞い |
| --- | --- |
| A17 | 初期互換範囲のGoogleスプレッドシートから架空情報で実際に出力したXLSXとPDFの履歴書・職務経歴書を使用（Excel実出力は未検証）。出力製品/版/日付/hashを記録。複数版、画像/結合/内部数式/複数sheetを登録し選んだ版だけ推薦。旧snapshot/bytesは不変 |
| A18 | MIME/拡張子偽装、ZIP/XML bomb、path逸脱、重複entry、VBA/XLM/OLE/外部参照/危険式/暗号化/未知part、境界容量を拒否。解析のCPU/メモリ/時間も上限を維持 |
| A19 | 実ClamAVでEICAR無害テスト文字列入りのPDF/XLSXを拒否。正常fixtureのcleanを確認。mockだけで合格とせず、engine/署名DB版/日時/hashを記録。実マルウェアは用いない |
| A20 | scanner停止/定義なし/更新失敗と24h超/timeout/検査上限の途中skipでreadyにならない。更新後retry、公開世代とロード世代の不一致/再ロード失敗/検査中更新/更新なし確認、旧lease、同時quota/頻度制限、正常起動9サービスを確認 |
| A21 | 既存PDF/共有snapshotの追加検査前は配信不可、clean後のみ可、blocked優先。企業はdocuments原本を読まず、失効後はPDF/XLSX双方404 |
| A22 | 全form_typeについて入力→別画面→戻る、reload、別アプリ相当のhidden→visible、再ログインで復元。検索・選択・focus/scrollも確認。同意は再確認、業務確定/通知が勝手に起きない |
| A23 | 通信断→端末暗号化保存→ブラウザcontext終了→同一profile再起動→本人認証→復元/同期。未送信Fileは再選択、受付済みuploadはID/keyから復旧。候補者編集の保存/破棄でdocument_upload draftを消さず、書類登録と候補者編集を独立して復元、二重作成なし。PDF/XLSXともupload成功commit直後に応答を落としdocument ID未取得→3日後の再認証で元キーから同じdocumentを取得。24時間の整理後も結果が残ること、7日直前は照合可/期限ちょうど以後は409、再送/別キー自動発行をせずdocument数・検査・確定ファイルが増えないことを確認。拒否結果の7日保持、pendingの継続復旧、アーカイブ後/他user・org拒否も確認 |
| A24 | user/org差替え、共有失効、期限切れ、schema違い、容量不足、鍵取得失敗、暗号化改ざん、旧key_versionの未失効鍵で再認証復元/再暗号化でき、失効鍵/他人の版は取得・復元不可。Web Storage/IndexedDB/log/配布物へ平文/鍵/tokenを残さない |
| A25 | 2タブ/2端末のrevision競合、応答喪失・遅延・順序逆転、IME入力、業務保存と自動保存の競合、consume/discard後の古いキューで入力消失/二重業務/下書き復活なし。求人/候補者/推薦の作成・PATCH・確定でcommit直後に応答を落としbrowserを再起動、結果IDへ復帰する。24h超〜7日以内の照合、7日後の再実行禁止、別フォームdraftの誤consume拒否も確認 |

arm64ローカルとLinux/amd64 CIで同じsource/fixtureを使い、追加ケースと既存50件の回帰を確認する。スマホ相当viewport/ブラウザhidden試験は実機の電話/アプリ切替/OS killを再現した証拠とは分ける。iOS Safari/Androidでの実機中断確認が未実施なら、その限界を配布文書に明記する。既存50件の成功をv0.4の成功に転用しない。

### R0で準備・確認する実出力fixture（指摘5、完了条件）

初期対応のGoogleスプレッドシートで、架空の履歴書・職務経歴書を作り、XLSXで書き出す（最低2ファイル）。Excel契約なし・Sheetsで進めるという利用者判断により変更した。Excel出力を保証する段階では、別途Excel実出力2点以上の互換確認を追加する。写真相当PNG/JPEG、結合セル、複数sheet、印刷範囲/改ページ/余白、日付・年齢の内部式、日本語の長文を含む組合せを用意する。元製品で開けることと、対応予定の出力が検査を通ることを別々に確認する。元製品の種類・版（取得可能な範囲）・出力日・設定・hash、含まれるparts/namespace/式、検査結果と必要な利用者操作を記録する。手作りの攻撃fixtureと正常な実出力を分ける。R0は基本2点と抽出partの方式確認まで。印刷設定差を含む追加正常fixtureはR1/R6の相互運用受入で追加し、R0で全組合せが試験済みとは扱わない。

実出力に未知part/namespaceがあれば、その役割と外部作用を確認するまでは許可しない。既存の安全条件を維持して対応リストへ明示追加するか、対応外として具体的な代替操作を示すかをR0の結果として報告する。初期範囲の最低2ファイルが揃わない、または対応予定の主要な出力が通らない場合は互換確認未完了とし、R1以降を始めず相談する。Excelへのアクセスや出力操作が必要な場合も、R0着手前には行わない。設計時点では未実施。[初回R0結果](../validation/2026-10-15-r0-report.md)の未成立を受け、今回の承認範囲でSheetsを初期対応と明示し、空metadata例外を追加した。実出力2点と限定異常系の確認は[R0追補](../validation/2026-10-15-r0-followup-report.md)へ記録する。印刷設定を含む任意レイアウトやOffice全般の互換性を保証するものではない。

## 8. 一次資料と設計上の位置付け

2026-10-15参照。下記は方式の根拠で、上記の容量/時間/保持日数/工数は本プロジェクトの初期設計値。対応versionの独立確認と製品受入に残る範囲は[最新R0追補](../validation/2026-10-15-r0-followup-report.md)を参照。

- [OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)：認可、形式検査、隔離/AV、保管と容量制限。
- [Microsoft SpreadsheetML構造](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)：workbook/sheet/relationshipを持つZIP packageの構造。
- [ClamAV scanning](https://docs.clamav.net/manual/Usage/Scanning.html)、[signature management](https://docs.clamav.net/manual/Usage/SignatureManagement.html)、[clamd設定の公式source](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample)：INSTREAM、socketの境界、上限による検査skip、定義更新。
- [MDN beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)、[storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)、[Web Crypto encrypt](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)：終了イベント/端末永続化の限界、AES-GCMのIV管理。

## R1実装時点の境界

- 追加migrationは0006のみ。旧0001〜0005は保持する。旧PDFはpdf/other、共有参照も同じmetadataを補完し、状態・原本・提出内容を変えない。
- 新規uploadは必須document_kindと拡張子/MIME/構造を照合し、形式合格は202/pending・available=falseとする。形式検査済みの私有ファイルを保存しても配信・推薦には使えない。R2のAV応答を偽造するmockや設定flagは製品へ入れない。
- document_checksは追加済みだが、R1のapp_runtimeはSELECTのみ。新しいreadyには対応policyのclean記録が必要で、blockedがあれば原本・既存共有・提出を拒否する。企業のchecks SELECTはE_SHAREDからだけ。実AVの認証済みwriterと再検査job/leaseはR2で追加する。
- /documents/:id/recheckは認証/Origin/CSRF/元登録者とblockedを確認し、R1では未検査なら503 SCANNER_UNAVAILABLE。既存cleanの現在結果照合以外の検査処理は実装しない。
- upload outcomeは本人scope・7日照合・expired tombstoneを実装。期限後のPOSTは原本受信前と冪等lock内で再確認する。旧terminal期限は旧24h期限へ6日を加え、移行時刻から再延長しない。期限切れの結果詳細は返さない。
- R0旧fixtureのPNG CRC不正は画像検査を追加したR1で検出した。旧fixtureは変更せず拒否試料として保存し、正常PNGで作り直してSheetsから実出力した新しい2点をe2e/fixturesへ置く。R0の限定検証を画像内部まで確認済みだったとは扱わない。
- 型・画像・式の検査は対応subsetの静的判定。Officeの全schema互換、未知の脆弱性の不存在、AVの有効性を認定するものではない。全フォーム自動保存・複数書類選択UX・AV serviceは後続段階。
