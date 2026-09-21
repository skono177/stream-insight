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
- PoCの想定外利用による負荷・コスト増加の抑制

AWSリソースはAWS CDKで管理する。

---

## 2. 利用AWSサービス

PoCでは以下のAWSサービスを利用する。

| 用途                        | AWSサービス                            |
| --------------------------- | -------------------------------------- |
| フロントエンド配信          | Amazon S3                              |
| CDN / APIルーティング       | Amazon CloudFront                      |
| REST API                    | Amazon API Gateway                     |
| API処理                     | AWS Lambda                             |
| データ収集                  | AWS Lambda                             |
| 配信メタデータ保存          | AWS Lambda                             |
| コメント収集制御            | AWS Step Functions                     |
| コメント分析                | AWS Lambda                             |
| 非同期処理                  | Amazon SQS                             |
| Raw Data保存                | Amazon S3                              |
| 分析結果保存                | Amazon Aurora Serverless v2 PostgreSQL |
| API Key管理                 | AWS Systems Manager Parameter Store    |
| OAuth・DB管理者認証情報管理 | AWS Secrets Manager                    |
| DBスキーマ適用              | Amazon RDS Data API                    |
| ログ・監視                  | Amazon CloudWatch                      |
| コスト監視                  | AWS Budgets                            |
| IaC                         | AWS CDK                                |

---

## 3. 全体構成

```text
                            Browser
                               │
                               │ Same Origin
                               ▼
                      ┌─────────────────┐
                      │   CloudFront    │
                      └───────┬─────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
          Default Behavior              /api/*
                │                           │
                ▼                           ▼
       ┌─────────────────┐        ┌─────────────────┐
       │ S3 Frontend     │        │   API Gateway   │
       │   Next.js       │        │  Throttling     │
       └─────────────────┘        └────────┬────────┘
                                           │
                                           ▼
                                  ┌─────────────────┐
                                  │   API Lambda    │
                                  │ Reserved        │
                                  │ Concurrency     │
                                  └────────┬────────┘
                                           │
                                           ▼
                                  ┌────────────────────┐
                                  │ Aurora Serverless  │
                                  │ PostgreSQL         │
                                  └────────────────────┘


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

Step Functions
      │
      │ Stream Metadata
      ▼
┌─────────────────┐
│ Stream Metadata │
│ Lambda          │
└────────┬────────┘
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
└────────┬─────────┘ └────────────────────┘
         │
         ▼
┌──────────────────┐
│ S3 Raw Data      │
└──────────────────┘
```

CloudFrontには以下の2つのOriginを設定する。

```text
Frontend S3
API Gateway
```

Default BehaviorではFrontend S3へルーティングし、
`/api/*`へのリクエストはAPI Gatewayへルーティングする。

これによりブラウザからFrontendとAPIを同一オリジンとして利用する。

PoCではAPI利用者向けの認証・認可は実装しないため、
API GatewayおよびAPI Lambdaに利用量・同時実行数の上限を設定し、
想定外の大量アクセスによる負荷およびコスト増加を抑制する。

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

VPC外
└── Migration Lambda
      ↓ HTTPS
    RDS Data API
      ↓
    Aurora PostgreSQL
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

Stream Metadata Lambda、Analyzer LambdaおよびAPI LambdaはIAM DB認証を利用し、
Aurora管理者Secretへアクセスしない。
IAM認証トークンはLambda実行Roleの一時認証情報を使って実行環境内で署名生成するため、
トークン生成のためのSecrets Manager、RDS API、STSへの実行時通信は行わない。

DBスキーマ適用用のMigration LambdaはVPC外へ配置し、
HTTPSのRDS Data APIからAuroraへSQLを実行する。
Migration Lambda自身はAuroraのPrivate EndpointやSecrets Manager APIへ直接接続しないため、
Migration用のNAT GatewayおよびInterface VPC Endpointは作成しない。

VPC内コンポーネントが実行時にアクセスするAWSサービスについては、
インターネット接続またはVPC Endpointが必要かを確認し、
NAT Gatewayを使用せずに必要な通信経路を確保する。

PoC時点の主な通信経路は以下とする。

| コンポーネント         | 接続先                                  | 通信経路                |
| ---------------------- | --------------------------------------- | ----------------------- |
| Data Collector Lambda  | YouTube Data API                        | VPC外からインターネット |
| Data Collector Lambda  | SQS / Parameter Store / Secrets Manager | VPC外からAWSサービス    |
| Stream Metadata Lambda | Aurora PostgreSQL Writer Endpoint       | VPC内、TCP 5432         |
| Analyzer Lambda        | Aurora PostgreSQL Writer Endpoint       | VPC内、TCP 5432         |
| Analyzer Lambda        | Raw Data S3                             | S3 Gateway VPC Endpoint |
| API Lambda             | Aurora PostgreSQL Cluster Endpoint      | VPC内、TCP 5432         |
| Migration Lambda       | RDS Data API / Aurora管理者Secret       | VPC外からAWSサービス    |

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
- 終了時の最終メタデータ（`endedAt`を含む）更新
- Execution ARNを一意キーとする`collection_jobs`の開始登録・終了状態更新
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

PoCではAPI LambdaにReserved Concurrencyを設定し、
同時実行数に上限を設ける。

初期値は以下を目安とする。

```text
Reserved Concurrency: 5
```

これによりAPI Gatewayへ大量のリクエストが送信された場合でも、
API LambdaからAuroraへ作成される同時接続およびLambda実行数を制限する。

値はPoCの負荷状況を確認しながら調整する。

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
- 終了時のメタデータ再取得と、配信情報・収集状態の永続化

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
  │    Get Final Stream Metadata (Data Collector Lambda)
  │     ↓
  │    Persist Final Metadata / Collection Status (Stream Metadata Lambda)
  │     ↓
  │    保存成功後にEnd（失敗時はRetry / Catch）
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

収集TaskのRetry上限到達時はCatchで終了処理へ進み、
収集失敗状態を保存してからState Machine Executionを失敗として終了させる。

終了時の最終メタデータ取得は初回を含め最大5回、30秒間隔のWaitで再試行する。
DB保存は初回を含め最大4回、2秒・4秒・8秒のBackoffで再試行する。
終了時の再試行・復旧手順は`architecture.md`の6.5節に従う。

---

### 7.5. 停止条件

以下のいずれかを検知した場合、コメント収集を停止して終了情報の永続化へ進む。

- YouTube Live配信終了
- Live Chat終了
- APIから継続取得不能であることを検知
- Retry上限到達

PoCではState Machine Executionを配信単位で作成する。

最終メタデータはVPC外のData Collectorが取得し、
VPC内のStream Metadata Lambdaが`streams`と`collection_jobs`を同一トランザクションで更新する。
Execution ARNと収集停止時刻を実行状態で保持し、再試行でも同じ終了要求を使用する。

実終了日時を取得・保存できない場合や収集失敗時は正常終了にせず、
可能な範囲で失敗状態を保存してFailへ遷移する。
DB保存自体に失敗した場合はCloudWatch Alarmで通知し、終了処理専用の実行で補完する。

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
- processed_comments

コメント原データは保存しない。

YouTube Channel IDおよびVideo IDを外部IDとして保持し、
内部`channelId`および`streamId`はAurora側で採番する。

`processed_comment_batches`では、
Standard SQSによる重複配信に対応するため処理済み`batchId`を管理する。

`batchId`には一意制約を設定し、
分析結果の更新と処理済み`batchId`の登録を
同一トランザクションで実行する。

Data Collectorの再実行時は、`data-model.md`の7.1節に従い同じ送信内容から同じ`batchId`を生成する。
再取得時にバッチ構成が変わった場合は、`processed_comments`の`(streamId, commentId)`一意制約で重複を排除する。
新規コメントの処理済み登録と分析結果更新も同一トランザクションで実行する。

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

### 10.2. 認証・接続

Aurora PostgreSQLではIAM DB認証を有効化する。

アプリケーション実行時に接続するLambdaごとに、以下のDBユーザーを作成する。

| Lambda                 | DBユーザー             | DB権限                                                                                                  |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| Stream Metadata Lambda | `stream_metadata_user` | `channels`、`streams`、`collection_jobs`への必要なSELECT / INSERT / UPDATE、および採番用SequenceのUSAGE |
| Analyzer Lambda        | `analyzer_user`        | 分析結果・処理済み管理テーブルへの必要なSELECT / INSERT / UPDATE、および採番用SequenceのUSAGE           |
| API Lambda             | `api_readonly_user`    | APIが参照するテーブルへのSELECTのみ                                                                     |

各ユーザーにはPostgreSQLの`rds_iam`ロールを付与する。
アプリケーションLambdaへ管理者権限、DDL権限、他コンポーネント用テーブルへの不要な権限を付与しない。

各Lambdaの実行Roleには、自身のDBユーザーだけを対象とする
`rds-db:connect`を許可する。

```text
arn:aws:rds-db:<region>:<account-id>:dbuser:<cluster-resource-id>/<db-user-name>
```

IAM PolicyのリソースにはCluster ARNではなく、
Aurora DB Cluster Resource IDとDBユーザー名を使用する。
ワイルドカードのDBユーザー指定は行わない。

Lambdaは接続を新規作成する直前にAWS SDKでIAM認証トークンを生成し、
そのトークンをPostgreSQLのパスワードとして使用する。
トークンの有効期間は15分であり、環境変数、ログ、Secrets Manager、Parameter Storeには保存しない。
失敗時のログにもトークンおよび接続文字列を出力しない。

IAM認証トークンの生成は署名処理であり、RDS APIへの通信を必要としない。
Lambda実行環境に提供される実行Roleの一時認証情報を使用するため、
アプリケーションLambda用のSecrets Manager VPC EndpointおよびNAT Gatewayは不要とする。

DB接続ではTLSを必須とし、AWSが提供するRDS CA bundleで証明書とホスト名を検証する。
証明書検証を無効化しない。
以下はシークレットではない接続設定としてLambda環境変数へ設定する。

```text
DB_HOST=<Aurora cluster endpoint>
DB_PORT=5432
DB_NAME=stream_insight
DB_USER=<LambdaごとのDBユーザー>
AWS_REGION=<deployment region>
```

認証トークンはDBホスト名・ポート・ユーザー名・Regionに対して生成し、
接続設定と同じ値を使用する。
新しい物理接続ごとに新しいトークンを生成する。
既存接続の再利用は可能だが、期限切れトークンを新規接続へ再利用しない。
接続プールには上限を設定し、Lambdaの同時実行数と合わせてAuroraの最大接続数を超えないようにする。

Security Groupは、Stream Metadata Lambda、Analyzer LambdaおよびAPI Lambdaから
AuroraのTCP 5432への通信だけを許可する。
AuroraはPublic Accessを無効化し、インターネットからの接続を許可しない。

### 10.3. DBユーザー作成・スキーマ適用

Aurora Serverless v2ではRDS Data APIを有効化する。

Auroraの管理者パスワードはCDKで自動生成し、
Auroraが管理するSecrets Manager Secretとして保存する。
Secret名は以下を基本とする。

```text
stream-insight/dev/aurora/admin
```

管理者SecretはアプリケーションLambdaへ付与しない。
VPC外のMigration Lambdaだけが、RDS Data API実行時の`secretArn`として使用する。

Migration Lambdaはデプロイ時のCustom Resourceから呼び出し、
RDS Data APIのトランザクションおよびSQL実行APIを利用して、以下を冪等に実行する。

- テーブル、インデックスおよび制約の作成・更新
- `stream_metadata_user`、`analyzer_user`、`api_readonly_user`の作成
- 各DBユーザーへの`rds_iam`付与
- 各DBユーザーへの最小限のテーブル・シーケンス権限付与
- 不要な`PUBLIC`権限の取消し

Migration Lambdaの実行Roleには対象管理者Secretへの
`secretsmanager:GetSecretValue`、対象Clusterへの`rds-data:BeginTransaction`、
`rds-data:ExecuteStatement`、`rds-data:BatchExecuteStatement`、
`rds-data:CommitTransaction`および`rds-data:RollbackTransaction`を付与する。
Secretでカスタマー管理KMS Keyを使用する場合は、対象Keyへの`kms:Decrypt`も付与する。
Migration Lambdaは`rds-db:connect`を使用せず、
Auroraへ直接接続するためのSecurity GroupやDBドライバーも使用しない。

Migration LambdaおよびCustom Resourceのログには、
Secret値、DBパスワード、IAM認証トークン、完全な接続文字列を出力しない。
Migration成功後にアプリケーションLambdaを利用可能とする依存関係をCDKで設定する。
Migration失敗時はデプロイを失敗させ、アプリケーションを不完全なスキーマで稼働させない。

Data APIを利用できるAurora PostgreSQLのEngine VersionをCDKで明示し、
デプロイ対象Regionで利用可能であることを事前に確認する。

管理者Secretの自動ローテーションはPoCでは必須としない。
ローテーションを追加する場合は、利用する方式に応じて必要な通信経路を別途設計する。

---

### 10.4. キャパシティ

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

API GatewayはCloudFrontのAPI Originとして設定する。

CloudFrontでは`/api/*`をAPI Gatewayへルーティングする。

12.2節のCloudFront FunctionでURI先頭の`/api`を除去し、
Origin Path `/dev`を付与してAPI Gatewayの`dev` Stageへ転送する。

ブラウザからはCloudFront経由でAPIへアクセスする。

PoCではユーザー認証・認可を導入しない。

そのためAPI Gateway自体は公開Read Only APIとして扱い、
想定外の大量アクセスを抑制するためStage/Method Throttlingを設定する。

PoCの初期値は以下を目安とする。

```text
Rate Limit: 5 requests/second
Burst Limit: 10 requests
```

すべてのGET APIを対象とし、
PoCの利用状況を確認しながら調整する。

制限を超えたリクエストについては、
API Gatewayから`429 Too Many Requests`を返す。

CloudFrontを迂回してAPI Gatewayの直接URLへアクセスされた場合も、
同じThrottlingを適用する。

詳細は`api.md`に定義する。

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

ブラウザからAPIへアクセスする場合も同じCloudFront Distributionを利用する。

```text
Browser
   ↓
CloudFront
   ├── /*       → Frontend S3
   └── /api/*   → API Gateway
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

CloudFrontには以下の2つのOriginを設定する。

```text
Frontend S3
API Gateway
```

Cache Behaviorは以下を基本とする。

| Path Pattern  | Origin      | 用途                  |
| ------------- | ----------- | --------------------- |
| Default (`*`) | Frontend S3 | Next.js静的コンテンツ |
| `/api/*`      | API Gateway | REST API              |

`/api/*`についてはGETリクエストをAPI Gatewayへ転送する。

PoCのAPIはRead Onlyであるため、
API用Behaviorで許可するHTTPメソッドはGETおよび必要なHEADに限定する。

APIレスポンスについては、
PoCでは分析結果の更新を速やかに反映できるよう、
原則としてCloudFrontキャッシュを無効化する。

### 12.2.1. APIパス変換とOrigin設定

CloudFrontのCache BehaviorはURIを書き換えないため、
`/api/*` Cache Behaviorのviewer-requestイベントに
APIパス変換用CloudFront Functionを関連付ける。

FunctionはURI先頭の`/api/`を`/`へ一度だけ置換し、
残りのパスおよびクエリ文字列を変更しない。
Default BehaviorにはこのFunctionを関連付けない。

```javascript
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf("/api/") === 0) {
    request.uri = request.uri.substring(4);
  }
  return request;
}
```

URI変換後も選択済みのCache BehaviorおよびAPI Gateway Originは変わらない。
API Gatewayのリソースパスは`/streams`以下の既存定義を維持する。

PoCでは以下の設定とする。

| 設定項目                   | 値                                            |
| -------------------------- | --------------------------------------------- |
| API Gateway REST API Stage | `dev`                                         |
| API Gateway Origin Domain  | `<api-id>.execute-api.<region>.amazonaws.com` |
| Origin Protocol Policy     | HTTPS Only                                    |
| Origin Path                | `/dev`                                        |
| Function関連付け           | `/api/*` Behaviorのviewer-request             |
| Cache Policy               | `CachingDisabled`                             |
| Origin Request Policy      | `AllViewerExceptHostHeader`                   |

Origin Domainにはパスを含めず、Stage名はOrigin Pathで一度だけ付与する。
CDKでOrigin Pathが自動設定される場合も、最終的な値が`/dev`となるようにし、
FunctionやリソースパスでStage名を重複付与しない。

`AllViewerExceptHostHeader`でクエリ文字列を転送し、
ブラウザのHostヘッダーは転送せず、API Gateway Originのホスト名を使用する。

転送例：

```text
Browser:       /api/streams?limit=20&offset=0
Function後:    /streams?limit=20&offset=0
Origin送信時:  /dev/streams?limit=20&offset=0
API Resource:  /streams（Stage: dev）
```

CloudFront FunctionはFrontendStackで作成・公開し、
LIVEステージのFunctionをBehaviorに関連付ける。

デプロイ後は、`api.md`に定義した全6エンドポイントについて
CloudFront経由で既存のAPIリソースへ到達できること、
`limit`・`offset`が維持されること、
Frontend静的ファイルの配信が維持されることを確認する。

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

### 13.3. Aurora PostgreSQL

アプリケーションLambdaはIAM DB認証を使用するため、
DBパスワードを保持・取得しない。

Aurora管理者資格情報だけをSecrets Managerで管理し、
DBユーザー作成およびスキーマ適用を行うMigration Lambdaからのみ利用する。
Migration LambdaはVPC外からRDS Data APIを呼び出すため、
Secrets Manager Interface VPC Endpointは作成しない。
詳細は10.2節および10.3節に定義する。

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
rds-db:connect
Resource: arn:aws:rds-db:<region>:<account-id>:dbuser:<cluster-resource-id>/stream_metadata_user
CloudWatch Logs
```

### Analyzer Lambda

```text
SQS ReceiveMessage
SQS DeleteMessage
S3 PutObject
rds-db:connect
Resource: arn:aws:rds-db:<region>:<account-id>:dbuser:<cluster-resource-id>/analyzer_user
CloudWatch Logs
```

### API Lambda

```text
rds-db:connect
Resource: arn:aws:rds-db:<region>:<account-id>:dbuser:<cluster-resource-id>/api_readonly_user
CloudWatch Logs
```

### Migration Lambda

```text
rds-data:BeginTransaction
rds-data:ExecuteStatement
rds-data:BatchExecuteStatement
rds-data:CommitTransaction
rds-data:RollbackTransaction
Resource: <Aurora cluster ARN>
secretsmanager:GetSecretValue
Resource: <stream-insight/dev/aurora/admin Secret ARN>
KMS Decrypt（カスタマー管理KMS Keyを使用する場合のみ）
CloudWatch Logs
```

`rds-db:connect`のResourceはLambdaごとのDBユーザーへ限定する。
Migration Lambda以外のアプリケーションLambdaには、
Aurora管理者Secretへのアクセスを許可しない。

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

Lambda、API GatewayおよびStep FunctionsのログはCloudWatch Logsへ出力する。

PoCではログを無期限に保持せず、
CDKによって各Log Groupの保持期間と削除ポリシーを明示的に設定する。

### 15.1. ログ保持期間

PoCではCloudWatch Logsの保持期間を以下とする。

| ログ                         | 保持期間 | スタック削除時 |
| ---------------------------- | -------: | -------------- |
| Data Collector Lambda        |      7日 | 削除           |
| Stream Metadata Lambda       |      7日 | 削除           |
| Analyzer Lambda              |      7日 | 削除           |
| API Lambda                   |      7日 | 削除           |
| API Gateway Access Log       |      7日 | 削除           |
| Step Functions Execution Log |      7日 | 削除           |

CDKでは各Log Groupに対して以下を設定する。

```text
Retention: 7 days
Removal Policy: DESTROY
```

Lambdaのロググループについても、
Lambdaによる暗黙的な無期限保持に依存せず、
CDK管理下で保持期間を明示する。

PoCの`dev`環境では、
CloudFormation Stack削除時に対象Log Groupも削除する。

本番環境を構築する場合は、
監査・障害調査要件を確認したうえで保持期間およびRemoval Policyを再設計する。

---

### 15.2. ログ出力方針

ログには運用・障害調査に必要な情報のみを出力する。

以下はログへ出力しない。

- コメント本文
- YouTube APIレスポンス全体
- SQSメッセージ本文全体
- Raw Data
- OAuth Client Secret
- Refresh Token
- Access Token
- YouTube Data API Key
- その他の認証情報

コメント処理の追跡が必要な場合は、
本文ではなく以下のような処理管理用情報を利用する。

```text
streamId
batchId
処理件数
処理時間
処理結果
エラー種別
```

エラー発生時も、
外部APIレスポンスやSQSメッセージをそのままログへ出力しない。

必要なエラーコードやステータス等のみを抽出して記録する。

---

### 15.3. 監視対象

主な監視対象：

- Lambda Error
- Lambda Duration
- Lambda Throttle
- API Lambda Throttle
- Step Functions Execution Failed
- Step Functions Execution Timed Out
- SQS Queue Depth
- SQS DLQ Messages
- API Gateway 4xx
- API Gateway 5xx
- API Gateway 429
- Auroraエラー
- YouTube APIエラー
- OAuth 2.0 Token取得エラー

PoCでは最低限のCloudWatch Alarmを設定する。

対象：

```text
API Gateway 5xx
API Gateway 429
API Lambda Throttle
SQS DLQ Messages
Step Functions Execution Failed
Step Functions Execution Timed Out
```

---

### 15.4. コスト監視

PoCの想定外利用による課金増加を早期に検知するため、
AWS Budgetsを設定する。

月額予算を設定し、
実績コストまたは予測コストが設定したしきい値を超えた場合に通知する。

具体的な月額予算額および通知先は、
利用開始時の想定コストに基づいて決定する。

PoCでは少なくとも以下の通知段階を設定する。

```text
50%
80%
100%
```

AWS Budgetsはコスト超過を自動的に完全停止する仕組みではないため、
API Gateway ThrottlingおよびLambda Reserved Concurrencyと組み合わせて利用する。

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

CloudWatch LogsについてもCDK管理対象とし、
保持期間およびRemoval Policyをコード上で明示する。

---

## 17. CDK Stack構成

PoCでは以下のStack構成を基本とする。

### NetworkStack

管理対象：

- VPC
- Subnet
- Security Group
- S3 Gateway VPC Endpoint

### StorageStack

管理対象：

- Raw Data S3
- Aurora Serverless v2（IAM DB認証およびRDS Data API有効）
- Aurora管理者Secret
- Aurora Security Group

### BackendStack

管理対象：

- SQS
- DLQ
- Data Collector Lambda
- VPC外のMigration Lambda / Custom Resource
- Stream Metadata Lambda
- Analyzer Lambda
- API Lambda
- Step Functions State Machine
- API Gateway
- API Gateway Throttling
- Lambda Log Groups
- API Gateway Access Log Group
- Step Functions Log Group
- Parameter Store
- YouTube OAuth用Secrets Manager Secret
- Lambda実行RoleおよびDBユーザー単位の`rds-db:connect` Policy
- CloudWatch Alarm
- AWS Budget

CloudWatch Log Groupsには以下を設定する。

```text
Retention: 7 days
Removal Policy: DESTROY
```

Analyzer LambdaのSQS Event Source Mappingでは
Partial Batch Responseを有効化する。

API LambdaにはReserved Concurrencyを設定する。

### FrontendStack

管理対象：

- Frontend S3
- CloudFront
- Frontend S3 Origin
- API Gateway Origin
- `/api/*` Cache Behavior
- APIパス変換用CloudFront Function（公開およびviewer-requestへの関連付け）
- API Gateway Origin Path（`/dev`）
- API用Cache PolicyおよびOrigin Request Policyの関連付け

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
- DB実行時認証にはIAM DB認証を利用し、アプリケーションLambdaへDBパスワードを配布しない
- DBスキーマ適用にはRDS Data APIを利用し、Migration用Interface VPC Endpointの固定費を発生させない
- API GatewayにThrottlingを設定する
- API LambdaにReserved Concurrencyを設定する
- AWS Budgetsでコストを監視する
- Auroraのキャパシティを必要最小限にする
- CloudWatch Logsの保持期間を7日に設定する
- PoCのdev Stack削除時にCloudWatch Log Groupsを削除する
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
