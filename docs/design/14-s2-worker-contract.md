# S2 鍵管理・隔離ワーカーの実装契約

S2の承認範囲だけを具体化する。S3の変換・閲覧、旧原本配信の閉鎖、S4移行、R5、公開は含めない。検証結果は完了記録を正本とする。

## 実行境界

- 認証済みブラウザのcompleteで確定したジョブを、ホスト管理者が `python3 scripts/document_job.py` で1件処理する。常駐コンテナへDocker socketやホスト起動権限を渡さない。
- 毎回、新しいbroker／relay／sandboxコンテナと二つのinternal networkを作る。ホスト側のinstance lockとDBの全体leaseで同時1件に制限する。
- brokerは専用control networkのAPI窓口、内部AV、relayだけへ接続する。DB、Next、請求サービス、外部へ接続しない。原本volumeをmountせず、現在のjob/leaseを確認したAPIから暗号文だけを取得する。
- relayは鍵・DB・永続volumeを持たない。固定 `/check`、既知media type、最大10MiB、固定schemaだけを扱い、任意URL／pathを受け付けない。
- sandboxはrelayとの内部networkだけを持つ。別UID／PID／mount namespace、非root、read-only、capability全drop、no-new-privileges、seccomp、CPU／メモリ／PID／tmpfs上限を持つ。1回だけ入力を受ける。
- 各ジョブ終了時はホストが全3コンテナを停止する。次のジョブは新しい名前・tmpfs・generationを使う。停止済みコンテナ、証拠、暗号文を自動削除しない。
- 旧形式検査サービスは検査routeだけ、請求生成サービスは固定請求schemaの生成routeだけを受ける。新sandboxからいずれにも到達しない。請求サービスの認証鍵は旧形式検査の認証鍵とも分離する。

## 認可と処理状態

workerの内部窓口は利用者用Routerと分けた8081。専用共有認証、job IDとランダムlease tokenが必要。gatewayからrouteを公開しない。利用者用8080はdefault interfaceとloopback、worker用8081はcontrol interfaceだけで待ち受ける。制御認証はユーザーsession、upload ticket、AV認証、暗号鍵と別用途。

DB資格情報はbroker／relay／sandboxへ渡さない。app_authには固定SECURITY DEFINER関数だけを許し、任意の書類SELECT／UPDATE権限は与えない。関数は固定search_path、PUBLICからの実行権剥奪、現在のuser/org/candidate、canonical attempt、pending書類、processing outcome、鍵の有効性を確認する。原本の所有組織をジョブ入力から変更できない。

`pending → processing → checked`。インフラ障害はretryable、改ざん・AV検出・形式拒否はrejected。checkedは**検査済み・変換待ち**であり、利用可能ではない。合格書類のdocumentsはpending、拒否書類はrejectedで、原本配信と推薦は拒否したまま。原本名/hashは検証済みjob metadataに保存し、S3が変換・成果物確定時に公開DTOのメタデータへ反映する。偽のready／AV cleanを作らない。

leaseは120秒、延長なし。期限内の別worker claimを拒否し、期限後の再処理は同じdocumentに新generation／成果物IDを作る。旧tokenは復号認可・確定に使えない。APIは復号前の認可と結果確定時の現在状態を照合する。停止後の再起動は明示的な次のhost起動で行い、無限retryはしない。各原本の試行上限は5回。

鍵・本人・組織・候補者の失効後は新しい認可と確定を拒否する。失効前に既に取得・復号した内容の回収は保証しない。共有閲覧の認可実装はS3。

## 暗号と保存

原本のRSA-3072 OAEP/SHA-256とAES-256-GCMはS1のenvelope/AADをそのまま照合する。暗号文hash／実長、AEAD tag、フレーム、原本長、暗号化metadataを確認してからAVへ渡す。復号秘密鍵はbroker専用mountにだけ渡し、native parserと同居させない。

成果物はS2では検査manifestだけ。ページ画像／テキスト／XLSX正規化はS3。manifestごと新しいDEK／nonceを作り、成果物専用の公開鍵でwrapする。対応する秘密鍵はS2のサービスへmountせず、保護されたローカル鍵として保持する。復号APIはS3の現在認可と一緒に実装する。

AADは固定JSON配列：schema、org、document、不変原本hash、policy、generation、成果物ID、kind、page、鍵版。原本DEK、別成果物のDEK、nonceを流用しない。原本用・成果物用の別鍵、tag、AAD、hashを試験で照合する。

APIはUUIDの固定保存先へcreate_newし、fsync→directory fsync→現在lease/権限の再確認→DB参照確定とする。応答喪失時も同じ成果物のバイト一致だけを再利用し、違う内容で上書きしない。期限後の新generationから旧孤児を参照しない。孤児も容量を保持する。

S2の成果物上限はmanifest256KiB／暗号文262160byte。各generationに1MiBを先に予約し、既存の全体1GiB admissionへ合算する。失敗・中断による物理予約を解放済みと数えない。S3のページ画像容量は別の設計済み上限を実装する。

## 鍵の運用

初期設定は原本 `original-v1` と成果物 `artifact-v1`。版ごとの有効状態と新規wrapに使う版を分離する。`rotate --version original-v2` 等の管理操作で新鍵を追加し、新規受付を切り替える。既存jobは元の原本鍵／claim時の成果物鍵へ結び付き、有効な旧鍵を維持する。鍵の欠落時は新しい鍵へ自動交換せず停止する。public keyのidentityをDBと照合し、setup／migrationの再実行で失効を解除しない。

管理用 `scripts/document_key.py` はローカル管理者だけが実行する。原本と成果物の失効を分け、Git／ログへ秘密鍵を出さず、暗号文と旧秘密鍵を保持する。鍵操作の版・用途・操作名・時刻をDBの監査記録へ保存する。漏えい時の鍵更新・参照切替は管理者の明示操作を必要とする。失効解除だけでは漏えいした鍵の秘密性は回復しない。

バックアップはDB、全暗号blob、不変参照、対応する原本／成果物秘密鍵、鍵の有効／失効状態を一組として保管する。復元後にpublic identityと原本/成果物のtag/hashを照合する。鍵だけを新規生成して既存の参照を復旧したとは扱わない。

## 資源・検証

broker512MiB／1CPU／64PID、relay512MiB／1CPU／64PID、構造sandbox256MiB／1CPU／64PID。scratchはbroker16MiB＋relay16MiB＋sandbox64MiB。原本は10MiBまで。parserは従来のAS256MiB／CPU5秒、ホスト側wall6秒。relay応答8.5秒、broker個別呼出し30秒以下、AV23秒、全ジョブ120秒を上限にする。

E2Eは通常デモから隔離したinstanceで行う。Browser plugin not availableのため、既存Playwright runnerを使う。実AV／実parser／実コンテナと、DBで作る期限・失効・旧leaseの合成条件を区別して記録する。秘密を含む.env、通信dump、trace、storageState、private composeはGitへ入れない。

一次資料： [Node.js 24 Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)、[Docker bridge isolation](https://docs.docker.com/engine/network/drivers/bridge/)、[PostgreSQL SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html)。これらの一般的な仕様を、製品の侵害不能性の証明として扱わない。
