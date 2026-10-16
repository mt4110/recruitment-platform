# R5：全フォームの端末自動保存・復元

対象はログイン以外の既存12 form_type。R4のサーバー保存とS1〜S5の書類経路を維持し、共通useDraftへ端末保存を追加する。R6の横断負荷・配布監査、画面装飾、公開は含めない。

## 保存と復元

- 初回はオンラインで本人の鍵とサーバーdraft ID・revision・サーバー期限を取得する。空／途中入力も既存schemaで初期化し、既存の新規件数・容量制限を適用する。最初からオフラインで未初期化の場合は耐久保存を保証しない。取得失敗時は入力を保持し、保存・確定を止めて再試行を案内する。
- sessionStorageには認証に使わないランダムなtab IDだけを保持し、同じタブの再読込では自身の候補を優先する。複製時のID衝突は[Web Locks](https://www.w3.org/TR/web-locks/)で排他的に判定して新IDへ分岐する。非対応環境はページごとに新IDを使い、複数候補を本人が選ぶ。IndexedDBにはorg/user/draft/form/target/context/schema/base版/revision/期限/tab/sequence/key_versionと暗号文だけを保持する。AES-256-GCM、新しい96bit IV、これらのscopeとoriginをAADへ含める。CryptoKeyは非extractableでimportし、メモリにだけ保持する。localStorage/sessionStorageへ本文・鍵・tokenを置かない。
- File bytes・File参照・署名ticket・DEK・CSRF/OIDC値・同意済みフラグは保存しない。書類の既存ID／元操作キー等のmetadataは既存document_upload payloadとして暗号化する。未送信ファイルは本人が再選択する。
- 500ms debounce／連続入力2秒目標とblur・visibilitychange・pagehideを利用する。終了時通信だけに依存しない。入力とpending mutationの厳密な要求を別々に暗号化し、不明な保存結果を元mutationで解決してから最新入力を送る。storage失敗は成功と表示せず、業務確定前には端末保存の完了も必須にする。
- 未同期入力でサーバー期限を延長しない。再起動後はオンライン認証、現在のGET draftによる所有・状態・業務版・期限の確認、一覧のserver_timeと端末期限の照合、指定版の鍵取得を終えてから復号する。別user/orgを候補に含めない。認可や鍵取得の失敗で元の暗号文を消さず、空入力で上書きしない。
- 復元候補はtab別に保持する。複数なら本人が選択し、競合を自動merge／上書きしない。更新通知にはowner/draft IDだけを使い、平文・鍵はBroadcastChannelへ渡さない。旧未失効鍵で復号した後、現行鍵への保存とサーバー同期の成功後に旧slotを終了扱いにする。
- 正常consume／明示discardではowner＋draft ID単位の端末tombstoneを残す。同じIDB transactionで遅延writeも確認し、終了後に新tab slotを作って復活させない。物理削除・期限整理は追加しない。
- focus／visible復帰時は表示とhookの処理をロックし、再認証後に現在の対象権限を再確認する。認証失効・logoutでは画面、平文stateと鍵参照を破棄し、暗号文だけを本人の再認証用に保持する。共有フォームはオフライン時もロックする。

## 業務確定の応答喪失

求人／候補者の新規・編集、推薦の新規・理由・提出・選考・共有撤回は、draft同期後にoperation ID・method/path・元version・要求hash・確認フラグを除いた要求を別の暗号化送信予定として保存し、それから送信する。保存失敗時は業務要求を送らない。

再起動後は元operationのoutcomeを先に照合する。committedなら現在の認可された結果へ移動し、端末予定を終了する。not_recordedなら勝手に再送せず、本人が元入力と確認項目を再確認し、同じID・同じ要求hashで再試行する。異なる入力や新キーへすり替えない。404／失効／期限切れはnot_recordedと見なさない。7日保持・期限後拒否は既存draft_operationsを正本とする。

検索には確定予定を作らず、書類受付は既存のupload ticket／結果照合を利用する。業務／通知を自動確定しない。

## 検証の境界

Browser plugin not availableのため既存Playwrightを使う。隔離環境のChromiumで同一profileの実ブラウザプロセスを終了・再起動し、再認証後の未同期入力・要求結果の復元を確認する。API通信断・旧鍵／失効・改ざん・保存失敗・別本人・期限・競合・終了後復活防止を確認する。既存R4／S1〜S5を回帰し、同じソースのCIを確認してから受入を確定する。

復元保証は最後にIndexedDB transactionの完了を確認した内容まで。強制電断・サイトデータ消去・端末故障・実機iOS/Safari・別端末への未同期本文の転送は対象外。暗号化はログイン中のXSSに対する保証ではない。
