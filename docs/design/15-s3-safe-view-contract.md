# S3 安全な閲覧の実装契約

[正本 v0.5](12-secure-document-pipeline.md)のS3だけを具体化する。S4移行・R5・外部公開は含めない。検証の結果と制限は完了記録を参照する。

## 処理と確定

暗号化受付 → fresh brokerによる復号・実AV → 鍵のないrelay → fresh sandboxの形式検査・変換 → brokerによる個別暗号化 → APIの不変保存 → 現在のlease／所有／鍵／AVの照合 → ready。S2のcheckedだけでは閲覧できず、view_readyが必要になる。

- 原本鍵はbrokerだけ。sandboxは鍵・DB・blob・host mountを持たない。Docker権限をアプリへ渡さず、ホストの `scripts/document_job.py` が1件ずつ起動・停止する。常駐処理は追加しない。
- PDFはPNGページごと、抽出テキストJSON、manifestをそれぞれ新DEK／nonce／成果物IDで暗号化する。XLSXは限定表JSONとmanifestを同様に暗号化する。OAEP/SHA-256・RSA3072、AES256-GCMは既存のNode/OpenSSLを利用する。
- AADは `rp-artifact-v1`、org、document、不変原本hash、`safe-view-v1`、generation、成果物ID、kind、page、鍵版の固定JSON配列。原本用鍵とは別用途とし、manifestに各成果物の暗号文／平文hashと版を束縛する。
- 追加migration 0013でderivativesを追加。APIは各成果物の容量をDBに予約してからcreate_newで保存し、fsync／directory fsync後にstoredを確定する。応答喪失時に原本や別成果物を上書きしない。失敗世代の予約は残す。確定時だけ、余ったmanifest予約を既知の実保存量へ精算する。既存の1GiB全体上限を緩和しない。readyは未完了受付10件／100MiBの枠から外すが、原本・成果物の物理保存量は残す。まだdocuments行がない予約と受信中も未完了枠に数える。
- 形式合格だけでreadyにしない。manifestと全成果物の対応・保存完了、実AVの現在世代を確認後、検証済み原本名/hash・検査記録・利用可能状態・7日結果照合を同じDB transactionで確定する。S2の変換待ちcheckedも新generationで処理対象にする。

## 閲覧と失効

通常APIは成果物ciphertextを読むが、原本用・成果物用の秘密鍵を持たない。`artifact-viewer` は成果物専用鍵と専用認証だけを持ち、DB・原本volume・原本鍵・native parserを持たない。固定の内部decrypt routeだけを受ける。初期のartifact-v1とartifact専用keyringを保持し、原本keyringをmountしない。鍵のidentityをDBの公開鍵と照合する。

`safe_document_view` はSECURITY DEFINERの固定窓口。agencyは自社の書類、employerは現在のE_SHAREDとapplication_documentsの選択版からだけ解決する。app_runtimeへderivativesの任意SELECT／UPDATEを許さない。雇用企業がdocumentsを直接読む経路を追加しない。

GET `/documents/:id/view` と `/view/pages/:page`、共有側の `/applications/:id/documents/:document_id/view` と同ページrouteを提供する。任意URL／path／変換指示は受け付けない。現在session・所属・選択版・共有・原本鍵／成果物鍵・blocked・AV世代／鮮度を照合し、AEAD tag／AAD／実hashとmanifest対応を検証する。返却直前にも現在認可とAVを再照合する。JSON／PNGはno-store／nosniff。ビュー処理は全体同時2件を上限とし、混雑は503にする。

ブラウザはPDF埋込みviewerや任意HTMLを使わず、認可済みPNGの一時blobとReactのエスケープしたテキスト／表を表示する。閉じる・移動・失効時はblobを破棄する。2秒ごととfocus時に現在認可を再確認し、拒否・接続不能で本文／画像を消す。既に閲覧者が取得した内容の回収は保証しない。

## PDF／XLSXの制約

PDFは20ページ・150dpi、辺4096px・8M画素／ページ・80M画素／文書。無断で縮小しない。PNG8MiB／枚・64MiB合計、抽出テキスト1MiB、manifest256KiB。ページは数値順に生成し、画像だけのPDFは文字を捏造せず「抽出できる文字がありません」と示す。日本語CMap用poppler-dataはS0で確認した0.4.12-1を利用する。構造検査のAS256MiB／CPU5秒を維持し、変換用sandboxはS0で確認した2CPU／1GiB／64PID／tmpfs256MiB、変換wall60秒を上限にする。brokerの個別呼出しは30秒以下で、超過時に利用可能へ昇格しない。

XLSXは既存ZIP/XML検査後に正規化する。数式を計算せず保存値を型検証する。有限数は元の表記を保ち、真偽は0／1だけ、日付は正本の1900／1904規則、共有・inline・rich stringを限定処理する。保存値なし・保存エラー・未再現書式を区別し、cached値を計算結果の正しさとみなさない。結合は参照で示し巨大なrowspan／colspanを作らない。非表示部分は初期表示せず明示操作で開く。画像・図形・罫線・書式の省略とPDF再提出案内を常時示す。

20,000実セル・32KiB／セル・1MiB正規化テキストの上限超過や解釈不能は準備失敗とし、切捨ててreadyにしない。画面では空セルを省略し、200件ずつ表示を増やす。保存した表データ自体は切り捨てない。外部画像・自動リンク・任意HTMLを表示しない。実Excel出力の互換性を確認済みとはしない。

## 請求と旧経路

`GET /applications/:id/invoice-view` はhiredのA_OWNER／E_SHAREDだけに固定請求JSONを返し、Reactが請求HTMLを表示する。金額・宛先・発行者は既存の不変採用記録／snapshotから取得し、URLの金額やHTMLを採用しない。PDF生成サービスの停止中でもこのHTMLは表示できる。

旧own／shared `/content` と `invoice-preview.pdf` は、未知ID・未認証を含め一律 **410・空body**。原本bytesへフォールバックしない。旧内部PDF rendererは互換検証用に残るが、利用者へのPDF返却には接続しない。

S4前なので、既存の平文書類・共有snapshot・backupは移行・削除しない。旧書類の従来のstatus／AV判定も保持するが、安全な閲覧準備とは区別し `view_prepared=false` を返す。画面に準備が必要と表示し、新しい閲覧routeは拒否する。既存互換uploadの検証経路は残り、暗号化受付を標準にする。実データ利用・公開への切替を承認したものではない。旧原本の閲覧を再開するにはS4の対応・検証が必要。

## 確認の扱い

Browser plugin not availableのため、既存の隔離Playwrightを使用する。組織分離・選択版・共有失効・鍵失効・session期限・AV障害・成果物異常・変換の型／資源境界を対象とする。実AV／実parser／実コンテナと、DBで作る期限・状態fixtureを区別する。スクリーンショットは架空データだけ。秘密鍵・ticket・認証情報・原本／通信dumpは公開証拠に含めない。

S4・S5の受入をS3に読み替えない。新しい鍵漏えい／未知のparser脱出への完全防御、物理電源断・独立監査・本番運用の証明ではない。M6監査の保留は継続する。
