# Stream Insight - Infrastructure Design

## 1. 概要

Stream Insight PoCをAWS上で動作させるためのインフラストラクチャ設計を定義する。

PoCでは以下を重視する。

- サーバレス中心の構成
- AWSマネージドサービスの活用
- 低コスト
- 高速な開発
- Infrastructure as Codeによる再現性
- 将来的なスケールアウトへの対応

AWSリソースはAWS CDKで管理する。

---

## 2. 利用AWSサービス

PoCでは以下のAWSサービスを利用する。

| 用途               | AWSサービス                            |
| ------------------ | -------------------------------------- |
| フロントエンド配信 | Amazon S3                              |
| CDN                | Amazon CloudFront                      |
| REST API           | Amazon API Gateway                     |
| API処理            | AWS Lambda                             |
| データ収集         | AWS Lambda                             |
| 配信メタデータ保存 | AWS Lambda                             |
| コメント収集制御   | AWS Step Functions                     |
| コメント分析       | AWS Lambda                             |
| 非同期処理         | Amazon SQS                             |
| Raw Data保存       | Amazon S3                              |
| 分析結果保存       | Amazon Aurora Serverless v2 PostgreSQL |
| API Key管理        | AWS Systems Manager Parameter Store    |
| OAuth認証情報管理  | AWS Secrets Manager                    |
| ログ・監視         | Amazon CloudWatch                      |
| IaC                | AWS CDK                                |

---

## 3. 全体構成

```text
                           Internet
                               │
                               ▼
                      ┌─────────────────┐
                      │   CloudFront    │
                      └────────┬────────┘
                               │
                               ▼
                      ┌─────────────────┐
                      │ S3 Frontend     │
                      │   Next.js       │
                      └─────────────────┘


                      ┌─────────────────┐
                      │ Step Functions  │
                      │ Collection      │
                      │ Workflow        │
                      └────────┬────────┘
                               │
                               ▼
                      ┌─────────────────┐
                      │ Data Collector  │
                      │ Lambda          │
                      └───────┬─────────┘
                              │ OAuth 2.0
                              ▼
                      ┌─────────────────┐
                      │ YouTube Data API│
                      └─────────────────┘
                              │
                              │ Stream Metadata
                              ▼
                      ┌─────────────────┐
                      │ Stream Metadata │
                      │ Lambda          │
                      └───────┬─────────┘
                              │
                              ▼
                      ┌────────────────────┐
                      │ Aurora Serverless  │
                      │ PostgreSQL         │
                      └────────────────────┘

Data Collector Lambda
         │
         │ Comments + streamId + batchId
         ▼
    ┌─────────┐
    │   SQS   │
    └────┬────┘
         │
         ▼
┌─────────────────────┐
│ Analyzer Lambda     │
└──────────┬──────────┘
           │
      ┌────┴───────────────┐
      │                    │
      ▼                    ▼
┌──────────────────┐ ┌────────────────────┐
│ S3 Gateway       │ │ Aurora Serverless  │
│ VPC Endpoint     │ │ PostgreSQL         │
└────────┬─────────┘ └─────────▲──────────┘
         │                      │
         ▼               ┌──────┴──────┐
┌──────────────────┐     │ API Lambda  │
│ S3 Raw Data      │     └──────▲──────┘
└──────────────────┘            │
                         ┌──────┴──────┐
                         │ API Gateway │
                         └──────▲──────┘
                                │
                             Next.js
```

Step Functionsは収集開始時に配信メタデータを永続化した後、
Data Collector Lambdaを繰り返し呼び出し、
配信終了までLive Chat取得を継続する。

---

## 4. AWSリージョン

PoCでは以下のリージョンを利用する。

```text
ap-northeast-1
```

東京リージョンを利用する。

理由：

- 日本国内からのアクセスを想定
- レイテンシ低減
- 利用予定サービスが利用可能
- 運用上分かりやすい

---

## 5. ネットワーク

### 5.1. VPC

Aurora Serverless v2を利用するため、VPCを構築する。

```text
VPC
├── Private Subnet AZ-A
└── Private Subnet AZ-C
```

PoCではAuroraをPrivate Subnetへ配置する。

Auroraへ直接アクセスするLambdaについてもVPC内へ配置する。

---

### 5.2. Lambda配置方針

Lambdaの責務に応じてVPC内外を分離する。

```text
VPC外
└── Data Collector Lambda
      ↓
   YouTube Data API

VPC内
├── Stream Metadata Lambda
├── Analyzer Lambda
├── API Lambda
├── Aurora PostgreSQL
└── S3 Gateway VPC Endpoint
```

Data Collector LambdaはAuroraへ直接接続しない。

これによりData Collector LambdaはVPC外からYouTube Data APIへアクセスでき、
YouTube Data APIアクセスのためだけにNAT Gatewayを配置することを避ける。

Analyzer LambdaからRaw Data S3へのアクセスには、
S3 Gateway VPC Endpointを利用する。

---

### 5.3. Public Subnet

PoCでは原則としてPublic Subnet上にEC2等のサーバーは配置しない。

サーバレスサービスを中心とするため、
インターネット公開用のEC2インスタンスやALBは使用しない。

---

### 5.4. NAT Gateway / VPC Endpoint

PoCではコスト削減のため、
NAT Gatewayは原則として使用しない。

VPC内LambdaからAWSサービスへアクセスする場合は、
通信先に応じてVPC Endpointを利用する。

Analyzer LambdaはPrivate Subnet内からRaw Data S3へアクセスするため、
S3 Gateway VPC Endpointを必須構成とする。

```text
VPC
├── Private Subnet
│   ├── Stream Metadata Lambda
│   ├── Analyzer Lambda
│   ├── API Lambda
│   └── Aurora PostgreSQL
│
└── S3 Gateway VPC Endpoint
        ↓
    Raw Data S3
```

S3 Gateway VPC Endpointは、
Analyzer Lambdaが配置されるPrivate SubnetのRoute Tableに関連付ける。

Endpoint PolicyおよびRaw Data S3のBucket Policyでは、
Analyzer LambdaによるRaw Data保存に必要なアクセスのみを許可する。

VPC内コンポーネントが実行時にアクセスするAWSサービスについては、
インターネット接続またはVPC Endpointが必要かを確認し、
NAT Gatewayを使用せずに必要な通信経路を確保する。

PoC時点の主な通信経路は以下とする。

| コンポーネント         | 接続先                                  | 通信経路                |
| ---------------------- | --------------------------------------- | ----------------------- |
| Data Collector Lambda  | YouTube Data API                        | VPC外からインターネット |
| Data Collector Lambda  | SQS / Parameter Store / Secrets Manager | VPC外からAWSサービス    |
| Stream Metadata Lambda | Aurora PostgreSQL                       | VPC内                   |
| Analyzer Lambda        | Aurora PostgreSQL                       | VPC内                   |
| Analyzer Lambda        | Raw Data S3                             | S3 Gateway VPC Endpoint |
| API Lambda             | Aurora PostgreSQL                       | VPC内                   |

新たにVPC内Lambdaから他のAWSサービスへアクセスする必要が生じた場合は、
対象サービスのVPC Endpoint追加を検討する。

---

## 6. Lambda

PoCでは以下のLambda Functionを作成する。

### 6.1. Data Collector Lambda

役割：

- YouTube Data APIへのアクセス
- OAuth 2.0 Access Tokenの取得
- 配信情報取得
- Live Chat ID取得
- コメント取得
- `nextPageToken`取得
- ポーリング間隔取得
- コメントバッチ単位の`batchId`生成
- SQSへのコメントデータ送信
- Step Functionsへの取得結果返却

想定Function名：

```text
stream-insight-data-collector
```

Data Collector LambdaはYouTube Data APIへアクセスするため、
VPC外へ配置する。

配信メタデータはStep Functions経由でStream Metadata Lambdaへ渡す。

配信終了まで単一のLambdaを実行し続けず、
1回の実行では一定範囲のコメント取得のみを行う。

継続取得に必要な`nextPageToken`等はStep Functionsへ返却する。

SQSへ送信するコメントデータには、
Stream Metadata Lambdaによって採番された内部`streamId`と
コメントバッチを一意に識別する`batchId`を含める。

---

### 6.2. Stream Metadata Lambda

役割：

- 配信メタデータの受信
- `channels`の作成・更新
- `streams`の作成・更新
- 内部`channelId`の採番・取得
- 内部`streamId`の採番・取得
- Step Functionsへの内部`streamId`返却

想定Function名：

```text
stream-insight-stream-metadata
```

YouTube Channel IDおよびVideo IDは外部IDとして扱う。

同一外部IDが既に登録されている場合は既存レコードを利用し、
重複レコードを作成しない。

Stream Metadata LambdaはAuroraへの接続が必要となるためVPC内へ配置する。

---

### 6.3. Analyzer Lambda

役割：

- SQSメッセージ受信
- `batchId`による処理済み判定
- Raw Data生成
- S3への保存
- コメント分析
- Auroraへの分析結果保存
- 処理済み`batchId`の保存

想定Function名：

```text
stream-insight-analyzer
```

SQSメッセージに含まれる内部`streamId`を利用して、
対象配信の分析結果を保存する。

Standard SQSの重複配信に対応するため、
Auroraの`processed_comment_batches`テーブルで処理済み`batchId`を管理する。

分析結果の更新と処理済み`batchId`の登録は、
同一のAuroraトランザクションで実行する。

既に処理済みの`batchId`を受信した場合は、
分析結果を再更新せず正常終了する。

Raw DataのS3オブジェクトキーには`batchId`を利用し、
同一バッチの再処理時にも同じオブジェクトへ保存する。

Analyzer LambdaからRaw Data S3へのアクセスには、
S3 Gateway VPC Endpointを利用する。

SQS Event Source MappingではPartial Batch Responseを有効化し、
Lambdaへ渡された複数メッセージの一部が失敗した場合は、
失敗したメッセージのみを再試行対象とする。

Auroraへの接続が必要となるためVPC内へ配置する。

---

### 6.4. API Lambda

役割：

- API Gatewayからリクエストを受信
- Auroraからデータ取得
- REST APIレスポンス生成

想定Function名：

```text
stream-insight-api
```

Auroraへの接続が必要となるためVPC内へ配置する。

---

## 7. AWS Step Functions

YouTube Live Chatの継続的な収集処理を管理するため、
Step Functions Standard Workflowを利用する。

想定State Machine名：

```text
stream-insight-dev-collection-workflow
```

### 7.1. 役割

- 配信メタデータ取得
- 配信メタデータ永続化
- 内部`streamId`の保持
- Data Collector Lambdaの繰り返し実行
- `nextPageToken`の保持
- ポーリング間隔の制御
- 配信終了判定
- 一時的なエラーのRetry
- コメント収集処理の終了制御

---

### 7.2. ワークフロー

概念的なState Machine：

```text
Start
  ↓
Get Stream Metadata
(Data Collector Lambda)
  ↓
Persist Stream Metadata
(Stream Metadata Lambda)
  ↓
internal streamId
  ↓
Collect Comments
(Data Collector Lambda)
  ↓
Live Chat終了？
  ├── Yes
  │     ↓
  │    End
  │
  └── No
        ↓
       Wait
        ↓
Collect Comments
        ↓
       ...
```

Data Collector LambdaおよびStream Metadata Lambdaから返却された
以下の情報をState Machineの実行状態として保持する。

```text
streamId
videoId
liveChatId
nextPageToken
pollingInterval
collectionStatus
```

これによりLambdaの実行時間上限を超える長時間配信についても、
Lambdaを複数回呼び出すことで収集を継続できる。

---

### 7.3. Wait

Data Collector Lambdaから取得したポーリング間隔を考慮して、
次回のLambda実行までWaitする。

短時間にYouTube Data APIを過剰に呼び出さないようにする。

---

### 7.4. Retry

YouTube Data APIへのアクセスで一時的なエラーが発生した場合は、
Step FunctionsのRetry機能を利用する。

RetryではBackoffを設定する。

一定回数のRetry後も処理できない場合は、
State Machine Executionを失敗として終了させる。

---

### 7.5. 停止条件

以下のいずれかを検知した場合、収集ワークフローを終了する。

- YouTube Live配信終了
- Live Chat終了
- APIから継続取得不能であることを検知
- Retry上限到達

PoCではState Machine Executionを配信単位で作成する。

---

## 8. Amazon SQS

Data Collector LambdaとAnalyzer Lambdaの間にSQSを配置する。

Queue名：

```text
stream-insight-comment-queue
```

用途：

- データ収集処理と分析処理の疎結合
- コメント急増時のバッファリング
- Lambda障害時のリトライ
- Analyzer Lambdaへのイベント通知

PoCでは複数コメントを1つのSQSメッセージとして送信する。

SQSメッセージには対象配信を識別する内部`streamId`と、
コメントバッチを一意に識別する`batchId`を含める。

Standard Queueでは同じメッセージが複数回配信される可能性があるため、
Analyzer Lambda側で`batchId`を利用した冪等性制御を行う。

Analyzer LambdaのEvent Source Mappingでは
Partial Batch Responseを有効化する。

---

### 8.1. Dead Letter Queue

処理に失敗したメッセージを保存するため、
Dead Letter Queueを作成する。

```text
stream-insight-comment-dlq
```

一定回数処理に失敗したメッセージをDLQへ移動する。

---

## 9. Raw Data S3

コメント原データを保存するS3 Bucketを作成する。

例：

```text
stream-insight-raw-<account-id>
```

想定構成：

```text
raw/
└── youtube/
    └── streams/
        └── <stream-id>/
            └── batches/
                ├── <batch-id-1>.jsonl
                └── <batch-id-2>.jsonl
```

S3オブジェクトキーには`batchId`を利用する。

同一SQSメッセージが再処理された場合でも同一キーへ保存することで、
Raw Dataの重複オブジェクト生成を防止する。

---

### 9.1. Lifecycle

YouTube APIから取得したRaw Dataは、
Stream Insightのデータ保持方針に従い、
7暦日を超えて保存しない。

S3 Lifecycle Ruleを設定し、
7日経過後に自動削除する。

```text
Raw Data
   ↓
S3 Standard
   ↓
7日
   ↓
Delete
```

Raw DataについてはGlacier等への長期アーカイブは行わない。

---

### 9.2. Public Access

Raw Data Bucketは非公開とする。

以下を有効にする。

```text
Block Public Access: ON
```

アクセスはIAM Roleを付与されたLambda等に限定する。

Analyzer LambdaからRaw Data Bucketへのアクセスは、
S3 Gateway VPC Endpoint経由とする。

Endpoint PolicyおよびBucket Policyによって、
必要なRaw Data Bucketへのアクセスのみを許可する。

---

## 10. Aurora Serverless v2

分析結果およびアプリケーションデータを保存する。

Database Engine：

```text
PostgreSQL
```

保存対象：

- channels
- streams
- stream_metrics
- comment_timeline
- comment_length_distribution
- frequent_words
- collection_jobs
- processed_comment_batches

コメント原データは保存しない。

YouTube Channel IDおよびVideo IDを外部IDとして保持し、
内部`channelId`および`streamId`はAurora側で採番する。

`processed_comment_batches`では、
Standard SQSによる重複配信に対応するため処理済み`batchId`を管理する。

`batchId`には一意制約を設定し、
分析結果の更新と処理済み`batchId`の登録を
同一トランザクションで実行する。

`nextPageToken`等のLambda間の継続処理状態については、
Step Functionsの実行状態で管理するため、
Auroraへの保存を収集継続の必須条件とはしない。

`collection_jobs`は収集結果・状態等のアプリケーションデータや
運用上必要な履歴の保存に利用する。

---

### 10.1. ネットワーク

AuroraはPrivate Subnetへ配置する。

Public Accessは許可しない。

```text
Public Access: Disabled
```

Security Groupによって、
Stream Metadata Lambda、API LambdaおよびAnalyzer Lambdaからのアクセスのみ許可する。

---

### 10.2. キャパシティ

PoCでは可能な限り小さいキャパシティ設定から開始する。

実際の最小・最大ACUについては、
実装時のAurora Serverless v2仕様を確認したうえで決定する。

---

## 11. API Gateway

REST APIをAPI Gatewayで公開する。

想定API：

```text
GET /streams
GET /streams/{streamId}
GET /streams/{streamId}/metrics
GET /streams/{streamId}/timeline
GET /streams/{streamId}/length-distribution
GET /streams/{streamId}/frequent-words
```

詳細は`api.md`に定義する。

PoCでは外部ユーザー向けAPIとしての公開は行わない。

---

## 12. Frontend

Next.jsを静的サイトとして出力し、
S3へ配置する。

```text
Next.js
   ↓
Static Export
   ↓
S3
   ↓
CloudFront
```

---

### 12.1. Frontend S3

Frontend専用Bucketを作成する。

例：

```text
stream-insight-web-<account-id>
```

Bucket自体はPublicにしない。

CloudFront経由のみでアクセスできる構成とする。

---

### 12.2. CloudFront

CloudFrontからFrontend S3へアクセスする。

用途：

- HTTPS
- CDN
- キャッシュ
- S3の直接公開防止

---

## 13. シークレット管理

YouTube Data API KeyやOAuth 2.0認証情報等のシークレット情報は、
ソースコードやGitHub Repositoryへ保存しない。

情報の性質に応じて、
AWS Systems Manager Parameter StoreとAWS Secrets Managerを利用する。

### 13.1. YouTube Data API Key

YouTube Data API KeyはParameter Storeで管理する。

例：

```text
/stream-insight/youtube/api-key
```

Data Collector LambdaはIAM Role経由でParameter Storeへアクセスする。

### 13.2. YouTube OAuth 2.0

YouTube Live Chat取得にOAuth 2.0認可が必要となるため、
Data Collector Lambdaから利用する認証情報を安全に管理する。

PoCでは初回認可を開発者または運用者が手動で実施する。

認可フロー：

```text
Developer / Operator
        ↓
YouTube OAuth 2.0 Authorization
        ↓
Authorization Code
        ↓
Refresh Token
        ↓
AWS Secrets Manager
        ↓
Data Collector Lambda
        ↓
Access Token取得
        ↓
YouTube Data API
```

以下の情報はGitHub Repositoryやソースコードへ保存しない。

- OAuth Client ID
- OAuth Client Secret
- Refresh Token
- Access Token

OAuth Client情報およびRefresh TokenはAWS Secrets Managerで管理する。

例：

```text
stream-insight/dev/youtube/oauth
```

Data Collector Lambdaには、
対象Secretを取得するための最小限のIAM権限を付与する。

Data Collector LambdaはRefresh Tokenを利用して
必要に応じてAccess Tokenを取得する。

Access Tokenは原則としてLambda実行中のみ利用し、
永続保存を必須としない。

Refresh Tokenの失効や認可取り消し等によって
Access Tokenを取得できない場合は、
運用者が再度OAuth 2.0認可を実施する。

PoCではOAuth 2.0認可画面および認可管理用Web UIは実装しない。

---

## 14. IAM

各サービスには必要最小限の権限のみを付与する。

### Data Collector Lambda

```text
SQS SendMessage
SSM GetParameter
Secrets Manager GetSecretValue
CloudWatch Logs
```

### Stream Metadata Lambda

```text
Aurora Access
CloudWatch Logs
```

### Analyzer Lambda

```text
SQS ReceiveMessage
SQS DeleteMessage
S3 PutObject
Aurora Access
CloudWatch Logs
```

### API Lambda

```text
Aurora Access
CloudWatch Logs
```

### Step Functions

```text
Lambda InvokeFunction
CloudWatch Logs
```

S3 Gateway VPC EndpointのEndpoint Policyでは、
Raw Data Bucketへの必要なアクセスのみを許可する。

Raw Data BucketのBucket Policyについても、
Analyzer LambdaからのRaw Data保存に必要なアクセスのみを許可する。

最小権限の原則を適用する。

---

## 15. ログ・監視

LambdaおよびStep FunctionsのログはCloudWatchへ出力する。

主な監視対象：

- Lambda Error
- Lambda Duration
- Lambda Throttle
- Step Functions Execution Failed
- Step Functions Execution Timed Out
- SQS Queue Depth
- SQS DLQ Messages
- API Gateway 4xx
- API Gateway 5xx
- Auroraエラー
- YouTube APIエラー
- OAuth 2.0 Token取得エラー

OAuth Client Secret、Refresh Token、Access Token等の認証情報はログへ出力しない。

PoCではCloudWatch Alarmの作り込みは最低限とする。

---

## 16. AWS CDK

AWSリソースはAWS CDKで管理する。

利用言語：

```text
TypeScript
```

想定ディレクトリ：

```text
infrastructure/
├── bin/
│   └── stream-insight.ts
│
├── lib/
│   ├── network-stack.ts
│   ├── storage-stack.ts
│   ├── backend-stack.ts
│   └── frontend-stack.ts
│
├── test/
├── cdk.json
├── package.json
└── tsconfig.json
```

---

## 17. CDK Stack構成

PoCでは以下のStack構成を基本とする。

### NetworkStack

管理対象：

- VPC
- Subnet
- Security Group
- S3 Gateway VPC Endpoint

S3 Gateway VPC Endpointは、
Analyzer Lambdaが配置されるPrivate SubnetのRoute Tableへ関連付ける。

### StorageStack

管理対象：

- Raw Data S3
- Aurora Serverless v2

### BackendStack

管理対象：

- SQS
- DLQ
- Data Collector Lambda
- Stream Metadata Lambda
- Analyzer Lambda
- API Lambda
- Step Functions State Machine
- API Gateway
- Parameter Store
- Secrets Manager

Analyzer LambdaのSQS Event Source Mappingでは
Partial Batch Responseを有効化する。

### FrontendStack

管理対象：

- Frontend S3
- CloudFront

---

## 18. 環境

PoCでは環境を増やしすぎない。

当初は以下のみとする。

```text
dev
```

本番公開を検討する段階で、

```text
dev
prod
```

へ分離する。

---

## 19. リソース命名規則

基本形式：

```text
stream-insight-<environment>-<resource>
```

例：

```text
stream-insight-dev-raw
stream-insight-dev-comment-queue
stream-insight-dev-stream-metadata
stream-insight-dev-analyzer
stream-insight-dev-api
stream-insight-dev-collection-workflow
```

グローバルに一意な名前が必要なリソースについては、
AWS Account ID等を付与する。

---

## 20. タグ

AWSリソースには可能な限り以下のタグを付与する。

```text
Project     = stream-insight
Environment = dev
ManagedBy   = cdk
```

コスト確認およびリソース管理に利用する。

---

## 21. コスト方針

PoCでは以下を重視する。

- 常時稼働サーバーを使用しない
- Lambdaを利用する
- Step Functionsによって長時間処理を分割する
- Raw DataはS3へ保存する
- Raw Dataを7日で削除する
- NAT Gatewayを原則として使用しない
- S3アクセスにはGateway VPC Endpointを利用する
- Auroraのキャパシティを必要最小限にする
- CloudWatch Logsの不要な長期保存を避ける
- Secrets Managerに保存するSecret数を必要最小限にする

---

## 22. 将来拡張

PoC完了後、以下を検討する。

- EventBridgeによるライブ配信自動検出
- EventBridgeによる収集ワークフロー自動開始
- Step Functionsワークフローの高度化
- Amazon Bedrock
- Amazon Athena
- Amazon Cognito
- AWS WAF
- APIキー管理
- Custom Domain
- Route 53
- CI/CD
- dev / staging / prod環境分離
- OAuth 2.0認可管理UI
