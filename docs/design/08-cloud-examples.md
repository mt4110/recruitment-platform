# AWS・GCP・AzureのIaCサンプル設計

## サンプルの役割

同じWeb/API/PDF renderer/内部AVを各クラウドへ配置する参考構成。3クラウドを同時運用する仕組みは作らない。Terraformはプロバイダーごとの独立例とし、共通化のためだけの抽象モジュールを作らない。今回は構成と入出力の設計のみで、.tfファイルやクラウド資源は作成しない。

## 共通の境界

インターネットへ公開するのはHTTPSの入口と選択したOIDCのログイン先。Webと /auth・/api を同一オリジンに置く。アプリDB、ファイル、PDF rendererは直接公開しない。runtime identityとデプロイ権限を分け、objectアクセスは特定bucket/containerに限定する。

PDF serviceには検査用pikepdf/libqpdfと生成用Chromiumを含める。クラウド実装時も検査/生成の子process制限と外向き通信制限を維持し、サービス名がPDFでも文書volumeやDB認証を付与しない。v0.4では[追加契約](10-resumes-and-autosave.md)のscanner/updater分離、署名DBの版/更新確認、未検査/拒否原本の配信停止、下書き暗号鍵のsecret管理も保つ。署名付きupload URLはこの版のサンプル要件へ追加しない。

OIDC issuer/clientの登録は運用者の前提作業とする。クラウド例でKeycloakの本番運用一式を新設することは含めない。ローカルではKeycloak、クラウドでは同じOIDC契約を満たす設定済みissuerを入力する。

クラウド例を実装する際は、対応するS3/GCS/Azure BlobのBlobStore adapterと、内部renderer接続方式も実装・検証する必要がある。GCP例ではAPIからrendererへのID token認証を内部共有鍵に加えて使用する。Terraformだけでローカル版が全クラウド対応になるとは扱わず、これらは[ローカルv0.4の残計画](07-delivery.md)の範囲とは別に積算する。

## サービス対応と経路

| 領域 | AWS例 | GCP例 | Azure例 |
| --- | --- | --- | --- |
| HTTPS・同一origin | ALBでWeb/APIへpath routing | HTTPS Load Balancerとserverless NEGでpath routing | 外部ingressを持つ入口Container Appから内部Web/APIへproxy |
| Web/API/PDF | ECS Fargateの分離サービス | Cloud Runの分離サービス | Container Appsの分離アプリ |
| PostgreSQL | RDS PostgreSQL、private subnets | Cloud SQL PostgreSQL、private接続 | PostgreSQL Flexible Server、VNet private access |
| PDF保管 | 非公開S3 | 非公開Cloud Storage | 非公開Blob Storage |
| secret | Secrets Manager | Secret Manager | Key Vault |
| image | ECR | Artifact Registry | ACR |
| log | CloudWatch | Cloud Logging | Azure Monitor/Log Analytics |

AWSはALBからWeb/APIのtarget groupのみへ接続、APIからDB・S3・内部rendererへ接続する。rendererはALBへ登録せず、service discoveryで接続。RDSは公開IPなし、security groupでAPIからのみ許可。NATやprivate endpointは選択と費用を明記し、必要な通信を止めた構成を「安い」と扱わない。

GCPはWeb/APIのingressをload balancer経由に限定し、Cloud Runの直接URLによる迂回を検証する。rendererは認証必須・内部限定とし、APIのservice accountで呼ぶ。Cloud SQL接続はprivate network経路と接続方式を固定する。API最大instance数とpool数を乗算しDB接続上限を超えないようにする。

Azureは入口だけexternal ingress、Web/API/rendererはinternal ingressにする。private DB用のdelegated subnet、private DNS、実行環境のnetwork接続を設計する。BlobとKey Vaultはmanaged identityで必要な権限だけを付ける。内部だからrendererに任意の入力を許すことはしない。

サービス選択と経路は本設計の提案。実際のregion、SKU、ネットワーク機能、Terraform providerのバージョンは実装時の一次資料で確定し、planと到達性試験を実施する。

## Terraformの予定構造

各examples/terraform/{cloud}/にversions、main、variables、outputs、README、tfvars.exampleを置く。providerとTerraformのバージョンを固定、lockfileを含める。READMEに作る資源、課金項目、前提、起動確認、停止と削除時のデータ影響を示す。

| 入力 | 内容 |
| --- | --- |
| project_name / environment / region | 名前、環境、利用地域 |
| domain / certificate reference | HTTPSドメインと証明書の設定済み参照 |
| web/api/pdf/scanner/updater image digest | 確認済みコンテナのdigest |
| oidc_issuer / oidc_client_id | 認証設定。秘密値はsecret referenceのみ |
| db_size / app capacity / instance limits | サンプル初期値と費用・接続数への影響 |
| secret references / storage settings | DB/renderer/scanner/draft暗号鍵のsecret、原本/署名DB/下書きの保存領域と保持設定 |

出力はapp_url、resource IDs、image reference等の非秘密のみ。DB password、session secret、秘密鍵をoutputへ出さない。tfvars.exampleは架空値と設定方法だけを含める。

## stateと変更手順

stateは秘密を含み得るのでGitに置かない。remote stateのアクセス制限・暗号化・ロック・履歴を設定する。sensitive属性だけでstate内の値が消えるとは扱わない。

手順は資源/料金の確認→planレビュー→明示承認→apply→起動/ネットワーク確認。今回applyは行わない。destroyには対象とDB/ファイルへの影響を表示し、必要なバックアップと明示承認を求める。DB保護を解除する自動コマンドは用意しない。

## サンプルが完成したと呼ぶ条件

各providerでvalidate/plan、空の検証環境へのapply、TLS/OIDC、一巡、DB/ファイル/rendererへの直接アクセス拒否、secret/ログ、退避と停止の手順を確認し、クラウド・region・provider version・日付を記録する。実地確認していない例には未検証と明記する。費用は構成と料金表から算出し、無料枠だけを前提にしない。

## 一次資料

- [AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)、[RDS in VPC](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html)
- [Cloud Run](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run)、[Cloud RunからCloud SQLへの接続](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
- [Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/overview)、[PostgreSQL private network](https://learn.microsoft.com/en-us/azure/postgresql/network/concepts-networking-private)
- [Terraformの秘密データ管理](https://developer.hashicorp.com/terraform/language/manage-sensitive-data)
