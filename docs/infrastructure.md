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


YouTube Data API
       ▲
       │ OAuth 2.0
       │
┌─────────────────────┐
│ Data Collector      │
│ Lambda              │
└──────────┬──────────┘
           │
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
      ┌────┴────┐
      ▼         ▼
┌──────────┐ ┌────────────────────┐
│ S3 Raw   │ │ Aurora Serverless  │
│ Data     │ │ PostgreSQL         │
└──────────┘ └─────────┬──────────┘
                       │
                       ▼
                ┌─────────────┐
                │ API Lambda  │
                └──────┬──────┘
                       │
                       ▼
                ┌─────────────┐
                │ API Gateway │
                └──────┬──────┘
                       │
                       ▼
                    Next.js
```

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

LambdaからAuroraへアクセスする必要があるため、
DBアクセスを行うLambdaもVPC内へ配置する。

---

### 5.2. Public Subnet

PoCでは原則としてPublic Subnet上にEC2等のサーバーは配置しない。

サーバレスサービスを中心とするため、
インターネット公開用のEC2インスタンスやALBは使用しない。

---

### 5.3. NAT Gateway

PoCではコスト削減のため、
可能な限りNAT Gatewayを使用しない構成を検討する。

外部APIアクセスが必要なLambdaと、
Auroraアクセスが必要なLambdaの責務を分離する。

Analyzer Lambda等のVPC内LambdaからAWSサービスへアクセスする場合は、
必要に応じてVPC Endpointを利用する。

例：

```text
VPC
├── Private Subnet
│   ├── Analyzer Lambda
│   ├── API Lambda
│   └── Aurora
│
├── S3 Gateway Endpoint
└── 必要なVPC Endpoint
```

具体的なVPC Endpoint構成については、
CDK実装時に必要な通信経路を確認したうえで決定する。

---

## 6. Lambda

PoCでは以下のLambda Functionを作成する。

### 6.1. Data Collector Lambda

役割：

- YouTube Data APIへのアクセス
- OAuth 2.0 Access Tokenの取得・更新
- 配信情報取得
- Live Chat ID取得
- コメント取得
- SQSへのコメントデータ送信

想定Function名：

```text
stream-insight-data-collector
```

Data Collector LambdaはYouTube Data APIへアクセスするため、
インターネットアクセス可能な構成とする。

OAuth 2.0の認可情報はAWS Secrets Managerから取得する。

---

### 6.2. Analyzer Lambda

役割：

- SQSメッセージ受信
- Raw Data生成
- S3への保存
- コメント分析
- Auroraへの分析結果保存

想定Function名：

```text
stream-insight-analyzer
```

---

### 6.3. API Lambda

役割：

- API Gatewayからリクエストを受信
- Auroraからデータ取得
- REST APIレスポンス生成

想定Function名：

```text
stream-insight-api
```

---

## 7. Amazon SQS

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

---

### 7.1. Dead Letter Queue

処理に失敗したメッセージを保存するため、
Dead Letter Queueを作成する。

```text
stream-insight-comment-dlq
```

一定回数処理に失敗したメッセージをDLQへ移動する。

---

## 8. Raw Data S3

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
            ├── comments-001.jsonl
            └── comments-002.jsonl
```

---

### 8.1. Lifecycle

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

### 8.2. Public Access

Raw Data Bucketは非公開とする。

以下を有効にする。

```text
Block Public Access: ON
```

アクセスはIAM Roleを付与されたLambda等に限定する。

---

## 9. Aurora Serverless v2

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

コメント原データは保存しない。

---

### 9.1. ネットワーク

AuroraはPrivate Subnetへ配置する。

Public Accessは許可しない。

```text
Public Access: Disabled
```

Security Groupによって、
API LambdaおよびAnalyzer Lambdaからのアクセスのみ許可する。

---

### 9.2. キャパシティ

PoCでは可能な限り小さいキャパシティ設定から開始する。

実際の最小・最大ACUについては、
実装時のAurora Serverless v2仕様を確認したうえで決定する。

---

## 10. API Gateway

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

詳細は `api.md` に定義する。

PoCでは外部ユーザー向けAPIとしての公開は行わない。

---

## 11. Frontend

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

### 11.1. Frontend S3

Frontend専用Bucketを作成する。

例：

```text
stream-insight-web-<account-id>
```

Bucket自体はPublicにしない。

CloudFront経由のみでアクセスできる構成とする。

---

### 11.2. CloudFront

CloudFrontからFrontend S3へアクセスする。

用途：

- HTTPS
- CDN
- キャッシュ
- S3の直接公開防止

---

## 12. シークレット管理

YouTube Data API KeyやOAuth 2.0認証情報等のシークレット情報は、
ソースコードやGitHub Repositoryへ保存しない。

情報の性質に応じて、
AWS Systems Manager Parameter StoreとAWS Secrets Managerを使い分ける。

### 12.1. YouTube Data API Key

YouTube Data API KeyはParameter Storeで管理する。

例：

```text
/stream-insight/youtube/api-key
```

Data Collector LambdaはIAM Role経由でParameter Storeへアクセスする。

---

### 12.2. YouTube OAuth 2.0

YouTube Live Chat取得にOAuth 2.0認可が必要となるため、
Data Collector Lambdaから利用する認可情報を安全に管理する。

PoCでは、初回認可は開発者または運用者が手動で実施する。

認可フロー：

```text
Developer / Operator
        ↓
YouTube OAuth 2.0 Authorization
        ↓
Authorization Code
        ↓
Access Token / Refresh Token
        ↓
AWS Secrets Manager
        ↓
Data Collector Lambda
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

Access TokenはRefresh Tokenを利用して必要に応じて更新する。

Refresh Tokenの失効、認可取り消し等によってAccess Tokenを更新できない場合は、
運用者が再度OAuth 2.0認可を実施する。

PoCではOAuth 2.0認可画面および認可管理用Web UIは実装しない。

---

## 13. IAM

各Lambdaには必要最小限の権限のみを付与する。

### Data Collector Lambda

```text
SQS SendMessage
SSM GetParameter
Secrets Manager GetSecretValue
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

最小権限の原則を適用する。

---

## 14. ログ・監視

LambdaのログはCloudWatch Logsへ出力する。

主な監視対象：

- Lambda Error
- Lambda Duration
- Lambda Throttle
- SQS Queue Depth
- SQS DLQ Messages
- API Gateway 4xx
- API Gateway 5xx
- Auroraエラー
- YouTube OAuth 2.0 Token更新エラー

OAuth Client Secret、Refresh Token、Access Token等の認証情報はログへ出力しない。

PoCではCloudWatch Alarmの作り込みは最低限とする。

---

## 15. AWS CDK

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

## 16. CDK Stack構成

PoCでは以下のStack構成を基本とする。

### NetworkStack

管理対象：

- VPC
- Subnet
- Security Group
- VPC Endpoint

### StorageStack

管理対象：

- Raw Data S3
- Aurora Serverless v2

### BackendStack

管理対象：

- SQS
- DLQ
- Data Collector Lambda
- Analyzer Lambda
- API Lambda
- API Gateway
- Parameter Store
- Secrets Manager

### FrontendStack

管理対象：

- Frontend S3
- CloudFront

---

## 17. 環境

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

## 18. リソース命名規則

基本形式：

```text
stream-insight-<environment>-<resource>
```

例：

```text
stream-insight-dev-raw
stream-insight-dev-comment-queue
stream-insight-dev-analyzer
stream-insight-dev-api
```

グローバルに一意な名前が必要なリソースについては、
AWS Account ID等を付与する。

---

## 19. タグ

AWSリソースには可能な限り以下のタグを付与する。

```text
Project     = stream-insight
Environment = dev
ManagedBy   = cdk
```

コスト確認およびリソース管理に利用する。

---

## 20. コスト方針

PoCでは以下を重視する。

- 常時稼働サーバーを使用しない
- Lambdaを利用する
- Raw DataはS3へ保存する
- Raw Dataを7日で削除する
- NAT Gatewayを可能な限り使用しない
- Auroraのキャパシティを必要最小限にする
- CloudWatch Logsの不要な長期保存を避ける
- Secrets Managerに保存するSecret数を必要最小限にする

---

## 21. 将来拡張

PoC完了後、以下を検討する。

- EventBridge
- Step Functions
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
