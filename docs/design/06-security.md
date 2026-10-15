# 認証・権限・ファイル保護

## 認証と組織

OIDC Authorization Code + PKCEをAPIで処理し、issuer/audience/署名/nonce/state/期限/固定redirect URIを検証する。auth attemptは5分・単回消費。M1ではstate hashと短期cookieのbinding hashをDBで照合して原子的に消費し、PKCE verifierはAES-256-GCMで暗号化する。stateとcookie原文をAADへ関連付ける。ブラウザとコンテナから同じissuerを解決できるネットワーク設定にし、ローカル環境でも検証を省略しない。

userのキーは(issuer,subject)、所属はusers.organization_idの1件。メールから所属を推定しない。未登録/無効user、無効組織はログイン不可。所属変更・切替は初期版にない。通常要求では毎回userと組織の有効性を確認する。

認証後は256bit以上の不透明sessionを発行し、DBにhashだけを保存、有効期限は8時間。CSRF tokenはsession原文と専用secretからHMACで導出して/meで返す。状態変更ではconstant-time比較とOrigin検査を行う。cookieはHttpOnly/SameSite=Lax/Path=/、HTTPSではSecure/Host限定。HTTP例外はloopback開発だけ。CORSは同一オリジンのみ。

ログアウトでアプリsessionを失効、画面の機密状態を破棄する。デモの利用者交代は別browser contextを推奨。同じbrowserではlogout後prompt=loginを付けて再認証し、Keycloakで別のデモアカウントを入力できることを受入で確認する。prompt=login自体がアカウント選択を保証するとは扱わない。v0.4では401/logout時に機密表示・メモリ鍵を破棄し、本人の再認証と対象認可を確認して暗号化した個人下書きを復元する。端末鍵は本人のkey_version指定で未失効旧版を取得でき、失効版では復号しない。PIIをlocalStorageへ保存しない。端末保存/鍵/保持期限/失効時の詳細は[追加安全性契約](10-resumes-and-autosave.md#6-保存復元鍵と端末保管)に従う（未実装）。M1画面はfocus/再表示/既知のsession期限で/meを再照合し、401時に所属表示を消す。logoutは同一originの他タブへ秘密値を含まない通知を送り、処理中の/me応答をabortと世代番号で無効化して古い所属を復活させない。

## 認可と共有の失効（R1/R2/R4）

認証→組織種別→所有/案件関係→共有状態→許可操作の順に確認する。新規処理ではその後versionを検査するが、同一キーの完了処理は[冪等性契約](05-api.md)に従う。org IDはuserから取得し、bodyの値を権限根拠にしない。

企業の候補者snapshotと共有PDFは **E_SHARED**、agencyは **A_OWNER** を使う。定義とtable別RLSは[データモデル](04-data-model.md)を正本にする。辞退はwithdrawnとshare_revoked_atを同時更新する。進行中の共有撤回も辞退、rejected/hiredの撤回は元状態を維持。再共有しない。

企業のファイル取得はapplication_documentsの不変参照だけを読む。documents原本へアクセスできる特権ロールや公開static URLを使わない。企業が共有失効後も読める案件metadataには候補者本文・共有ファイル一覧・自由記入reasonを含めない。無関係な組織や共有失効後の候補者/書類取得は404。

認可クエリ時点で開始済みのstreamと、取得済みファイルの回収は保証できない。撤回commit後の新しい取得を拒否する。v0.1で署名URLを配布しない。no-storeとUIの状態破棄を組み合わせ、ブラウザのキャッシュから再共有しない。

## PDF構造検査の方式と対応範囲（R6）

v0.4は以下の既存PDF構造policyにウイルス検査を重ね、PDF/XLSX双方を対象にする。[受付・AV・移行の追加契約](10-resumes-and-autosave.md)を優先して合わせて適用する。以下のPDF専用記述をXLSX許可の根拠には使わない。

**pikepdf/libqpdfによる構文検査と全オブジェクトの禁止要素検査**を採用する設計とする。元PDFは改変せず、検査合格したbytesだけを保管する。qpdf系の構文検査合格だけでactive contentがないとは判定しない。具体的なversion/ライセンスと下記fixtureの実動作はM0で確認して固定する。

許可するのは架空レジュメの静的PDF、最大10MiB、1〜20ページ。構造属性を持つタグ付きPDFも、下記の文脈・型検証を満たせば対象とする。暗号化（空passwordでも暗号化されたものを含む）、構文の例外/警告、注釈/フォーム/添付/起動時動作を拒否する。リンク注釈を含むPDFも初期版では拒否し、利用者には「リンクやフォームを含めずPDFを書き出してください」と具体的に案内する。構造属性の型不正や対応外の/Aは「このPDFの構造には対応していません。添付のサンプルPDFでお試しください」と分けて案内する。

検査はattempt_recovery=Falseで開き、is_encrypted、check_pdf_syntaxの結果、get_warningsを確認。pdf.objectsの全間接オブジェクト、各dictionary/array/stream dictionary内の直接オブジェクトを循環検出付きで走査し、名前をparserで解釈した上で、次のkeyがあれば拒否する：/Annots、/AcroForm、/XFA、/OpenAction、/AA、/JS、/JavaScript、/EmbeddedFiles、/EF、/Launch、/RichMedia、/Collection。dictionaryの/Type=/Action、および/Sが/JavaScript・/Launch・/URI・/GoToR・/GoToE・/SubmitForm・/ImportData・/Renditionのいずれかでも拒否する。keyだけでなく解釈済みname値を判定する。構造数の上限は10,000 objects、直接構造の深さ64。上限超過や解釈不能も拒否し、単純なbytes検索では代替しない。

/Aはkey名だけで一律拒否せず、次の文脈で判定する（再レビューF2）。Catalogの/StructTreeRootから/Kをたどって構造要素として到達し、/Type=/StructElem、/Sのname、/Pの親参照が整合する辞書では、/Aを属性辞書または属性辞書とそのrevision番号を含む配列として型検証し、許可する。revision番号は直前の属性辞書に対応する非負整数とし、番号のない属性辞書も許可する。構造属性以外の/Aは初期版では拒否する。アクションを保持する文脈の/Aは、/Type=/Actionが省略されていても拒否する。/Type=/StructElemの自己申告だけでは例外にせず、同一オブジェクトがアクションを保持する位置でも参照される場合は拒否する。許可する属性の配下も全オブジェクト走査と禁止要素判定を継続し、走査済みオブジェクトの再参照でも参照位置の文脈判定を省略しない。

M0の許可fixtureには通常の静的PDFと、上記/Aを持つ静的なタグ付きPDFを入れる。拒否fixtureには型名を偽装した/A、アクション側と構造側で参照を共有する辞書、属性配下の禁止要素、リンク注釈、フォーム、JavaScript、添付を入れる。文脈の例外で禁止要素を通過させない。

これは対応するPDFを限定した受付policyであり、既知/未知の悪性PDFをすべて検出する保証ではない。メディア型はapplication/pdf、検査後もAPI経由・認可付きで配信する。共用公開デモでは任意ファイルのアップロードを公開しない。

## 検査の隔離

既存の内部PDF service内で、検査は1要求ごとのPython子processとして実行する。APIのファイルvolume・DB認証情報をserviceへ渡さず、PDF bytesだけを送る。入力10MiB、子processのメモリ256MiB/CPU時間5秒/wall time5秒、同時検査1件、tmpfsを用いる。非root、read-only root filesystem、不要capabilityなし、外向き通信なし。制限値は初期設計値で、実測した性能や安全性の認定ではない。

M0のarm64/amd64確認では、drop ALLにSYS_CHROOTだけを追加し、no-new-privilegesと[Playwright公式seccomp profile](../../validation/m0/seccomp_profile.json)を維持する構成でsandboxが起動した。SYS_ADMIN/privileged/--no-sandboxは使わない。HOME/XDG_CONFIG_HOME/XDG_CACHE_HOMEはtmpfs内の専用ディレクトリへ置く。Playwrightと同梱Chromiumは対応する版を同時に固定し、namespaceとSeccomp-BPFの有効性を実行環境ごとに確認する。Linux/amd64の再現結果は[完了記録](../validation/2026-10-15-m0-completion.md)へ保存した。

内部endpointはPOST /internal/pdf/check（bytes→ok/sha256/policy/rejection_code）とPOST /internal/pdf/render-invoice（固定schema→PDF）。内部共有鍵とネットワーク制限を両方使う。待ち過多/検査サービス障害/timeoutは503で受付を保留し、検査不合格の422と区別する。失敗を検査合格に変換しない。

## アップロードと復旧の順序（R5/R6）

1. APIが現在の認証/CSRF・架空データ確認と、短いorg context付き参照transactionで候補者の所有を検証。ここでは非アーカイブ条件を検査しない。multipartをAPI専用の管理stagingへstreamし、30秒/10MiB上限を適用。ランダムattempt IDの一時名を使い、SHA-256を計算する。この時点のファイルはどの閲覧APIからも見えない。
2. org contextと冪等lockを設定した短いtransactionで同じscopeの記録を読み、実bytesを含むrequest_hashを照合する。不一致は409 IDEMPOTENCY_MISMATCH。同一キーがcompleted/failedなら現在の認可を再確認し、記録済みHTTP status/codeと同じresource_idへの参照を返す。completedのDTOは現在の状態から作り直す。候補者のアーカイブだけでは既存文書の自社閲覧は失効しないため、完了済み要求に非アーカイブ条件を再適用しない。無効user/組織や所有外の要求は拒否する。processingで有効leaseがあれば現在の認可で202と既存document IDを返す。既存結果を返す要求が作った重複stagingは、その要求の管理対象として整理する。
3. 新規またはlease切れなら手順2と同じtransactionを続ける。新規は候補者を再取得して非アーカイブを確認し、アーカイブ済みなら409 CANDIDATE_ARCHIVEDとして予約しない。許可された新規だけにdocument ID、staging_key、確定先storage_key、size/hashを保存しpending、冪等記録はprocessingにする。lease切れはCASで既存documentに新lease tokenを取得し、別documentを作らない。いずれもv0.4では120秒のlease（M3実装時は60秒）を設定してcommitし、新規は検査へ、復旧は下記の保存状態別手順へ進む。再送分のstagingは既存参照を照合して整理し、復旧対象を消さない。
4. DB transactionの外でAVと形式別構造検査を依頼する（R2実装）。不合格なら同じlease tokenを条件にdocumentをrejected、冪等記録をfailed、422のerror_codeを保存する。インフラ障害ならpendingを維持して503、再試行可能とする。生の検査診断をログへ流さない。
5. v0.4では両検査合格時だけ形式policy名（static-resume-v2/xlsx-resume-v1）、検査日時/hashとdocument_checksのengine/DB版/cleanを同じ短いtransactionで保存する。readyへの変更はこの記録を必須とする。stagingと確定先は同一filesystemに置き、完全なファイルをcreate-onlyでatomicに配置する。既存の確定ファイルを上書きしない。同じ保存先があればexpected hashとの一致を確認し、異なれば503 STORAGE_CONFLICTで停止する。
6. candidate→documentの行順で再取得し、現在の所有/有効性、policy/hash、lease tokenを確認してreadyへ更新する。冪等記録もcompleted/201としcommitする。候補者がアーカイブ済みに変わっていた場合はrejected/CANDIDATE_ARCHIVEDとし、冪等記録はfailed/409を保存する。leaseを失った旧processはreadyへ変更できない。readyのbytes/keyは以後不変。

冪等記録のprocessingは期限だけで消さない。v0.4改訂2のuploadは完了/拒否確定後から7日間、同じresourceと結果を照合できる。通常のJSON業務要求の24時間とは区別する。期限以後は409 OPERATION_RESULT_EXPIREDとし、scope/key/hash/期限を持つexpired tombstoneを残して同キーの新規実行を禁止する。outcomeとPOSTの両方で現在認可と期限を判定する。期間内の422は同キーで同じ拒否結果を返す。修正した別ファイルの新規登録は本人の明示操作とし、期限切れの別キー自動迂回は行わない。request hash不一致は409。詳細は[uploadの7日契約](10-resumes-and-autosave.md#アップロード結果の7日照合と期限後の再実行禁止再レビューp2)。

DB予約のcommit前に停止した場合は、永続的なdocument ID・冪等記録・leaseがまだない。同じ要求の再送で初めて単一documentを予約し、未検査stagingを公開しない。孤立stagingは下記の管理手順で整理する。commit後の停止は、検査前・合格後・配置後・ready commit前のどの段階でも既存document IDと元の冪等記録を使って復旧する（再レビューC1）。

API再起動後も、同じupload要求の再試行またはPOST /documents/:id/retryで、lease切れpendingを復旧できる。retryは元の登録者かつ自社agencyだけを許可し、元の冪等記録のleaseをCAS取得して同じdocumentを処理する。readyは200、lease有効なpendingは202、rejectedなら409 DOCUMENT_REJECTEDを返して新規登録へ案内する。元のupload keyでの再要求は保存した拒否status/codeを返す。確定ファイルがあり保存済み検査policy/hashと一致し、v0.4では同hashの両検査cleanかつblockedなしを確認できればreadyを完了する。必要な検査情報がなければ再検査し、利用可能へ推定しない。stagingだけなら再検査から再開。両方なければrejected/UPLOAD_INTERRUPTEDとし、新キーで再登録する。hash不一致は自動置換せず管理上の障害として止める。UIは状態確認で期限切れpendingを検知したら元の登録者に再試行ボタンを出す。自動の組織横断recoveryロールや常駐workerは初期版に作らない。

失敗後の一時/拒否ファイルは、管理manifest・DB参照・leaseを照合して整理する。受信中のrequestはmanifestを更新し、処理中/ready/参照中のファイルを消さない。管理下の孤立stagingは最終更新から24時間後を整理候補とし、候補一覧と結果を記録する。未知の保存先やready領域の一括削除はしない。今回、この整理処理やファイル削除を実行することはない。

## 請求プレビュー・配信

請求PDFは固定schemaの文字列をHTML escapeして固定1ページのテンプレートへ配置する。任意HTML/URL/pathを受け付けず、rendererの外向き通信を止める。フォントを同梱し、page count=1を検証する。Chromiumは非rootでsandboxが有効な設定を検証し、起動のためにsandboxを無効化しない。

ファイルはAPIの認可後にstreamし、形式に対応するContent-Type（PDFはapplication/pdf、XLSXはapplication/vnd.openxmlformats-officedocument.spreadsheetml.sheet）、X-Content-Type-Options:nosniff、no-storeを付ける。原本取得はattachment、請求PDFはinline。readyの文書は送信前に保存時sizeとhashの整合を確認し、破損なら503で止める。

## ログ・秘密・運用

OIDC client secret、session cookie、候補者/レジュメ本文、未加工の入力body、内部共有鍵はGit/logへ出さない。監査はactor/org/resource ID/操作/結果/時刻/request IDのみ。拒否記録は業務rollbackで消えない独立security logへ出す。

ローカルでも秘密を生成する。架空ログインの説明をREADMEに置く場合も、クラウドへ固定の公開passwordを持ち込まない。本番の保持/削除・復旧・脆弱性対応・法的整理は運用前ガイドで扱う。

参照：[OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html)、[pikepdfの検査/open/objects API](https://pikepdf.readthedocs.io/en/stable/api/main.html)、[qpdfの構文検査](https://qpdf.readthedocs.io/en/stable/cli.html#option-check)、[PDFBoxの構造要素属性/Aの説明](https://pdfbox.apache.org/docs/2.0.10/javadocs/org/apache/pdfbox/pdmodel/documentinterchange/logicalstructure/PDStructureElement.html)。PDFBoxはPDFの用語・構造の参照資料であり、新しい実装依存ではない。検査policyと処理順は本設計の判断で、M0で最小fixtureによる方式確認を実施済み。製品実装での統合検証は後続段階。

## M3実装の保存・隔離（2026-10-15）

pikepdf 10.17.0とPython推移依存を版・wheel SHA-256で固定する。検査子processはstdinからbytesを受け、内部共有鍵を含む親環境を引き継がない。256MiBの子process制限に親の余裕を加え、service全体のmemoryは384MiB、pidsは32にする。検査同時実行1件、APIのupload/retryは同時2件。rendererにはDB環境変数もresumes volumeも渡さない。

APIは管理stagingをcreate_newで作り、fsync後に同じvolumeの確定先へhard linkする。リンク先があればsize/hashを確認し、上書きしない。確定後はdirectoryもfsyncする。重複・拒否・孤立stagingと受信開始manifestを保持し、今回の処理には削除/自動GCを含めない。整理候補の判定にはDB参照・lease・受信中の状態の照合が別途必要。容量の増加を運用時の制約として記録する。

検査policyはM0の構造検査を製品workerへ移し、直接objectも構造数の上限に数える。間接objectだけを訪問済みに記録し、直接objectのラッパーidentityの再利用で配下走査を省略しない。検査例外/時間超過/worker異常は503、PDFのpolicy拒否は422とする。


## M4の共有境界（2026-10-15）

共有PDFの取得は通常runtimeによるapplication_documentsのRLS判定と、保存済み参照のsize/hash検査を使う。企業の処理でdocuments原本へJOINしない。snapshot/共有参照の子policyだけがapplicationsを参照し、親policyは子を参照しない。RLSの定義とadvisory lockの動作は[PostgreSQL 17 RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)・[17のlock](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)を参照した。

案件metadataとevent行は撤回後も企業へ返すが、候補者本文・PDFは行レベルで拒否し、推薦/履歴の自由記入reasonはDTOから省く。end userへDB接続を渡さない前提で、server runtimeが読めるevent行のreasonと、利用者へ返すJSONの範囲を区別する。再取得済みの画面は失効表示に更新するが、既に許可したstream/取得済みbytesの回収は保証しない。

## v0.4改訂1の追加安全性契約（未実装）

AVの新規clean確定は公開manifestと実ロードmanifestの世代/版/hashの一致、その世代の24時間以内の確認を必須とする。更新成功時刻だけで旧ロード版を許可しない。業務応答喪失は本人の操作結果台帳から復帰し、別userの自動再送や、結果不明のまま別キーでの二重実行を禁止する。[改訂仕様](10-resumes-and-autosave.md)と[対応表](../reviews/2026-10-15-v04-revisions.md)を参照。
