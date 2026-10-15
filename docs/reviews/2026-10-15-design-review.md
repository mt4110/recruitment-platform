# OSSプロトタイプ設計レビュー

2026-10-15 / 対象commit: 36523d71042feb042c60e76f340d3961a70e85e5

> この文書はv0.1のレビュー記録です。現在の設計への対応は[修正対応表](2026-10-15-design-revisions.md)を参照。以下の行番号・判定は対象commit時点のものです。

## 判定

骨格は実装に利用できる。ただし、共有情報の認可とトランザクションの契約に未決・不整合があり、現状のまま全機能の実装を始めることは勧めない。下記R1/R2は認可を実装する前に修正し、R3〜R6は該当機能の着手前に契約を固定する。

40〜100時間は実測に基づかない仮説。現在の範囲全体について40時間を引渡し品質の下限として提示する根拠は弱い。100時間も目標候補としては扱えるが、未選定のPDF検査・認証起動・RLSの共有経路を含む上限として約束できる状態ではない。今回のレビューから別の正確な工数を算出することもできない。

対象はREADMEとdocs/design配下の全10ファイル、計11ファイル。静的な文書レビューと一次資料の照合を実施した。以下の手順は実装時の検証案であり、実行済みの不具合再現ではない。設計の正本・コード・クラウド環境は変更していない。

## R1 [P1] 辞退後の共有PDFアクセス条件がAPIに固定されていない

根拠：[画面設計 40行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/02-experience.md)、[API契約 41行・60〜62行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/05-api.md)、[データ寿命 59行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/04-data-model.md)。

画面とDTOはwithdrawn後に企業の候補者/PDF閲覧を止める。一方、PDF取得APIの条件は「関係組織、提出済み、共有撤回なし」で、withdrawnの除外と、辞退時にshare_revoked_atを設定する規則がない。「提出済み」をsubmitted_atの存在と解釈すると辞退後にも条件を満たし、status=submittedだけと解釈するとscreening/hiredで必要なPDFも読めない。

修正案：企業の共有閲覧を、関係する求人企業であること、状態がsubmitted/screening/rejected/hiredのいずれか、share_revoked_atがNULL、という明示条件にする。紹介会社の自社閲覧とは分け、snapshot・PDF・一覧/詳細のDTO・RLSで共通の定義を参照する。辞退時に共有フラグも失効させる方式を採るなら、それを同一transactionの契約に追加する。

検証案：提出→選考中→辞退の後、企業が保存済みURLでPDFを直接取得しても404。screening/hiredでは共有が有効なPDFを取得できる。UIの非表示だけで合格としない。

## R2 [P1] 企業にPDFを返すDB参照経路とRLSの整合が未定義

根拠：[データモデル 21〜24行・47〜49行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/04-data-model.md)、[API契約 40〜41行・60行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/05-api.md)。

通常DBロールにはRLSを強制し、企業からdocuments原本のmetadataは読めない。ところがファイル保存先storage_keyはdocumentsにしかないため、企業のコンテキストでapplication_documentsからファイルを取得するクエリをそのまま組み立てると、必要な原本行が見えない。「専用認可経路」がどの権限で何を読むかを決める必要がある。

同様に、紹介会社には公開求人だけを見せる一方、推薦詳細は募集終了後も「現在の公開状態」を返す。jobsのRLSを公開のみとすると、この参照にも例外経路が必要になる。

修正案：表×操作×組織のアクセス表を追加し、共有情報の取得経路を具体化する。例えば提出時にapplication_documentsへ不変のstorage参照と表示名を保存し、企業はR1の共有条件でその行だけ読む方式なら、原本への特権的な読取りを増やさずに実装できる。保管参照はAPI内部だけで使いDTOには出さない。求人の現在状態は専用の許可済み参照を設計するか、v0.1では提出時点の求人表示に限定する。

RLSは行を絞る機構なので、API側のDTOで項目を削るだけではDBクエリに必要な行を取得できない。権限を拡げてその場をしのぐ設計にはしない。[PostgreSQL公式のRLS説明](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)を参照。

検証案：BYPASSRLSを持たない通常の実行ロールで、企業Xが共有済みPDFだけ取得できる。企業Yと辞退・共有撤回後のXは取得できない。求人の募集終了後も推薦詳細が定義どおり表示される。

## R3 [P2] 募集終了と推薦提出の競合時の扱いが未定義

根拠：[データモデル 37行・43行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/04-data-model.md)、[API契約 31行・53行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/05-api.md)。

提出時のpublished再確認はあるが、ロック対象はapplicationとcandidateのみ。通常のREAD COMMITTEDで求人を読んだ後に別transactionが募集終了をcommitすると、終了commitの後に推薦がcommitする順序も許される。重なった処理を求人確認時点で受け付けたとみなすのか、提出commitまで公開を保つのかが決まっていない。求人編集も並行でき、画面で確認した求人とsnapshotが違う場合の扱いも未定義。

修正案：まず競合時の受付時点を定義する。提出commitまでの公開を保証する案なら、求人行をtransaction内でロックし、取得後に状態を再確認する。R2のRLS・求人更新権限と両立するDB操作を選び、紹介会社への更新許可を広げない。複数行をロックする順序も統一する。閲覧した求人と同じversionへの提出を要求するならjob_versionを入力に追加する。最新求人への提出でよいなら、提出前プレビューとの関係を説明する。

FKが作るKEY SHARE相当の保護だけに依存しない。通常の非キー列の更新を止めるロックとは異なるため、必要な競合を防ぐ方式を選ぶ。[PostgreSQL公式の行ロック](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)を参照。

検証案：求人を閉じる処理と提出を同時に走らせ、いずれかの順序で整合した結果になること、提出失敗時にsnapshot/event/通知が残らないことを確認する。

## R4 [P2] 共有撤回の許可状態と後続動作が決まっていない

根拠：[API契約 53〜55行・62行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/05-api.md)、[状態図 28〜40行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/02-experience.md)、[部分一意制約 41行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/04-data-model.md)。

revoke-sharingは「agencyのみ」とされ、下書きでも実行できる記述。下書きでshare_revoked_atを設定してからsubmitすると、提出には成功しても企業に共有されない案件を作り得る。進行中の撤回後に状態をそのまま残す場合も、新しい推薦が部分一意制約で拒否されるため、辞退操作との関係を利用者と実装者が理解できる必要がある。

修正案：下書きの撤回は拒否し、各状態の許可/拒否を表で定義する。submitted/screeningでの撤回を辞退と同時に扱うか、別操作として残すかを選ぶ。採用決定後はplacementを維持して共有だけを止める、撤回後の再共有は初期版に設けない、といった規則も明記する。繰り返し要求、version更新、監査/通知の記録先を決める。

検証案：draft/submitted/screening/rejected/hired/withdrawnの各状態からの撤回、重複要求、撤回後の提出・選考・再推薦の期待結果を確認する。

## R5 [P2] 冪等処理とversion検査の実行順序がない

根拠：[API共通契約 9〜11行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/05-api.md)、[冪等記録 29行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/04-data-model.md)、[受入条件 A07/A08](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/07-delivery.md)。

同じキーでの再試行とversion必須は記載されているが、どちらを先に評価するか未定義。最初の処理が成功して応答だけ失われた場合、再要求のversionは古い。同じキーを確認する前にversion検査すると、成功済み処理を409として返してしまう。並行した同一キーの挿入競合も、単なるUNIQUE違反の500にしない手順が必要。

修正案：現在の認証・認可→冪等キーの取得/競合待ち→完了済みなら処理結果の参照→未実行ならversion/状態検証と書込み、という順序を契約化する。キーのscopeはHTTP methodと実resource IDを含む正規化pathまで指定する。共有撤回後の応答を返す際は、現在の閲覧条件をもう一度適用する。

検証案：応答喪失後の同一要求、同一キー2本同時、キーが同じで入力が違う場合を確認する。通常の二重クリックだけの確認では足りない。

## R6 [P2] PDF検査の研究要素と保存障害の処理が工数に埋もれている

根拠：[安全性設計 26〜28行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/06-security.md)、[実装計画 10行・22行](https://github.com/mt4110/recruitment-platform/blob/36523d71042feb042c60e76f340d3961a70e85e5/docs/design/07-delivery.md)。

暗号化・破損・JavaScript・添付・起動アクションの拒否、隔離、5秒制限まで要求する一方、検査ツールは未選定。これを「アップロード6〜14時間」に含めて確定的に扱うのは難しい。例えばqpdfの構文検査合格は、active contentの不存在の証明にはならない。qpdfは採用済みのツールではなく、選定時の注意例。[qpdf公式の--check説明](https://qpdf.readthedocs.io/en/stable/cli.html#option-check)を参照。

また、stream保存・検査・ready更新はDBとファイルをまたぐ。プロセス停止時にpendingが残った場合、ファイル配置後にDB更新が失敗した場合、再要求で別ファイルが増える場合の復旧順序が決まっていない。

修正案：実装前の短い技術確認でツール、対応するPDFの範囲、拒否fixture、CPU/メモリ/時間制限を決める。保存は一時領域→検査→確定配置→readyの各段階を定義し、再起動時にpending/孤立ファイルをどう整合させるかを追加する。検査不能を許可扱いにしない。

時間を厳しく絞る場合、同梱サンプルだけを選べるデモへ限定する案はあるが、任意PDFアップロードの範囲を変えるため、機能変更として明示して判断する。現在の仕様のまま検査を省略して完了とはしない。

## 40〜100時間の評価

| 対象 | 観察した内容 | 工数上の判断 |
| --- | --- | --- |
| 起動・認証 | 空のコードから7コンテナ、OIDC、所属、独自session、CSRF、秘密値生成 | M1の6〜12時間は既存の検証済み雛形がある場合に寄った値。今のrepoに雛形はない |
| 業務とDB | 17テーブル、約30の認証/業務API操作、snapshot、RLS、制約、監査、冪等性 | CRUD以外の統合がM4へ集中。APIとDBの権限不整合を先に解決する必要がある |
| PDF | 任意PDF検査と、別の日本語請求PDF生成サービス | 未選定ツールとコンテナ・フォントの確認を含むため変動が大きい |
| 検証と引渡し | 13の受入観点、RLS結合試験、E2E、CI、第三者の起動確認 | 正常系のデモが動いた段階からも作業が残る。M6/M7を残余時間任せにしない |
| 対象外 | 3クラウド実装・実地確認、LP本文、包括的運用ガイド、移行、本番 | 対象外の整理は適切。40〜100時間へ加算して評価していない |

40時間は進捗を見て残作業を判断する節目として使い、全条件を満たす引渡し工数とは約束しない。100時間を上限目標にするなら、まずR1〜R6を閉じ、未選定部分を技術確認し、機能単位で残工数を積み直す。AI支援の削減率や新しい精密な時間幅を、実測なしに作らない。

## 範囲を抑える提案

以下は設計へまだ反映していない提案。基本的な認証・組織分離・異常系・必要な検証を維持した上で判断する。

1. v0.1は1ユーザー1組織に限定し、組織切替UI/APIを後回しにする。4つの架空アカウントで紹介会社/企業の体験は確認できる。
2. 請求PDFは固定額・固定1明細・1ページにし、長い組織名の上限/折返しだけを定義する。日本語表示と実PDF生成は維持する。
3. ローカルのPostgreSQLを1サービスとし、app/OIDCを別database・別credentialにする案を検討する。デモの障害分離との交換条件を明記する。
4. 確認環境は開発OSとCI環境、ブラウザを明示する。任意のOS/全ブラウザの起動保証へ広げない。
5. 任意の大規模fixtureや追加分析は、基本の一巡と受入が成立した後に判断する。

## 重大な欠陥として数えなかった点

- 複数タブの組織切替は、session tokenのrotateと、sessionから導出するCSRF tokenによって、古いタブの書込みを拒否できる設計になっている。この保護を無視して越権書込みが必ず起きるとは判断しなかった。古いCSRFを自動更新して古いフォームを無条件に再送しないことを明記し、受入試験を追加するとよい。
- ログイン期限切れのフォーム保持は、OIDCへのページ遷移を挟むとメモリだけでは維持できない。v0.1では「再ログインの遷移前まで保持。再表示後は再入力」と文言を合わせる程度の整理が必要。永続的なPII保存を追加する理由にはしない。
- 依存バージョンとライセンスの最終確定、クラウド実地検証、LP本文は、既に後続段階として明記されている。未実施そのものを設計漏れとして数えていない。

## 実装へ進むためにそろえるもの

共有状態ごとの認可表、通常DBロールによる共有PDF取得の経路、提出/募集終了のtransaction順序、冪等処理の順序、PDF検査と保存復旧の契約を正本へ反映する。その後、技術確認の結果と残工数を記録して、実装範囲と作業上限をオーナーが判断する。
