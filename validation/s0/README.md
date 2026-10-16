# S0 isolated qualification harness

S0だけの実験コード。製品のupload/session/ticket/API、DB migration、常駐ジョブ、既存書類移行、R5、公開を実装しない。[確認計画](../../docs/design/13-s0-verification-plan.md)を参照。

## 再実行

既存のPDF依存imageをnative archで用意する。新規構築する場合は、製品の設定を変更せず次を実行する。image構築は依存取得のため外部通信を使い、検証中のroleはinternal networkのみを使う。

```sh
docker build --rm=false -t recruitment-s0-base:local services/pdf-renderer
mkdir -p .local/s0-browser
cp services/pdf-renderer/package.json services/pdf-renderer/package-lock.json .local/s0-browser/
npm ci --prefix .local/s0-browser --ignore-scripts
npx --prefix .local/s0-browser playwright install chromium --only-shell
S0_PLAYWRIGHT="$PWD/.local/s0-browser/node_modules/playwright" python3 validation/s0/run.py --base-image recruitment-s0-base:local --out .local/s0-qualification-new
python3 validation/s0/qualify.py --run .local/s0-qualification-new --trivy .local/m6-tools/trivy
```

Apple Siliconでは各Docker利用コマンドに`DOCKER_CONTEXT=colima-recruitment-m1`を指定する。既存contextやデモを切り替えない。出力先は毎回新しい未使用ディレクトリにする。

Linux/amd64は手動workflow `S0 isolated document feasibility`を実行し、両archのソースhashと結果を照合する。workflowはimageを公開しない。

## 境界と証拠

- broker/viewerのRSA3072鍵はそれぞれ専用volume、0600のテスト鍵。別UIDで動き、sandbox/relayへmountしない。古いテストvolumeと停止コンテナを保持し、削除/pruneは行わない。
- API/DB/別ジョブは秘密を持たない到達性確認用sentinel。製品API/DBの認可試験とは区別する。sandboxからの実通信probeとrootfs/cgroup/secret/namespaceを照合する。
- internal network上のroleへブラウザが到達するため、信頼したホスト制御ハーネスだけが`docker exec` IPCを橋渡しする。アプリ/relayにDocker socketや管理権限を渡さない。HTTP+IPCの時間は製品通信の速度ではない。
- Browserプラグイン未提供のため、既存lockと同じPlaywright 1.64.1/Chromium156をS0 scratchへ用意する。製品E2E lockを変更しない。暗号化は実ブラウザWeb Crypto、復号はNode/OpenSSLの別実装。
- PDFはpikepdf構造検査→Poppler150dpi/テキスト抽出。日本語CMapの`poppler-data=0.4.12-1`をS0 imageへ追加。通常/タグ/20ページは合成fixture。M5請求PDFはレジュメ構造policyを超えるため、拒否ケースとして保持し、policyを緩めない。
- Sheets正常2点はR1で適格化済みの`e2e/fixtures`（合成PNG修正版）。元の`validation/r0/fixtures`は画像CRC不正を拒否する負例として保持。Sheets由来の構造・式・表示の確認で、未修正の実出力やExcel全般の互換保証ではない。
- 型別/拒否fixtureは制御したOOXML変異。通常のオフィス保存や再計算では不正参照/欠落cached値が変わるため、bytesを生成して確認する。元fixtureは変更しない。
- 原本・正規化した内容・表示画像・build/audit全量は`private/`だけに置き公開しない。上位のJSONとcrypto-status.pngは本文/鍵を含まない公開証拠候補。最終記録前に目視/secret検査する。
- `resources.json`は実cgroup設定と、より小さい子プロセスのRLIMIT/timeout、実tmpfs容量超過の発動を区別する。1GiB cgroup OOMや全64PID枯渇まで実行したとは報告しない。
- `qualification.json`は全image指摘を保持したうえで候補の利用経路を分類する。候補High/CriticalなしでもM6監査の解消やimage配布許可ではない。GPL/Adobe CMap/ブラウザ規約と第三者再現はM7に残す。

鍵失効はfixture台帳、復旧は保存したテストbackupからKeyObjectを再構成する確認であり、製品の永続失効台帳/KMS/災害復旧を実装したわけではない。S0結果をS1以降の実装完了へ読み替えない。
