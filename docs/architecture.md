# Stream Insight - Architecture

## 1. 概要

Stream Insightは、YouTube Liveの公開データを収集・分析し、分析結果をREST APIおよびWeb UIから提供するサーバレスアプリケーションである。

PoCでは、AWSのマネージドサービスおよびサーバレスサービスを中心に構成し、開発速度・低コスト・将来の拡張性を考慮する。

---

## 2. アーキテクチャ方針

### 2.1. サーバレス

可能な限りサーバレスサービスを利用し、サーバーの常時稼働・運用管理を不要とする。

### 2.2. 疎結合

データ収集、データ分析、API提供、Web UIを可能な限り分離する。

### 2.3. PoC優先

PoCでは必要以上にAWSサービスを導入せず、最小構成で一連のデータフローを実現する。

### 2.4. 将来拡張

PoC後に以下へ拡張可能な構成とする。

- 対象配信数の増加
- 対象配信者数の増加
- AI分析
- 複数の配信プラットフォームへの対応
- 外部ユーザー向けAPI提供

---

## 3. システム構成

```text
                         ┌──────────────────┐
                         │ YouTube Data API │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Lambda       │
                         │ Data Collector   │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │      SQS         │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Lambda       │
                         │    Analyzer      │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Aurora Serverless│
                         │   PostgreSQL     │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  API Gateway     │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │     Lambda       │
                         │    API Handler   │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Next.js / FE   │
                         └──────────────────┘
```

---

## 4. コンポーネント

### 4.1. YouTube Data API

YouTubeから以下の公開データを取得する。

- YouTube Live配信情報
- Live Chat情報
- コメント情報

取得にはYouTube Data APIを利用する。

---

### 4.2. Data Collector Lambda

YouTube Data APIから対象配信のデータを取得する。

主な責務：

- 配信情報取得
- Live Chat ID取得
- コメント取得
- 取得データの後続処理への送信

---

### 4.3. Amazon SQS

データ収集処理と分析処理の間に配置する。

主な目的：

- データ収集処理と分析処理の分離
- コメント量増加時のバッファリング
- Lambdaの処理負荷の平準化
- 一時的な処理失敗時の再実行

---

### 4.4. Analyzer Lambda

SQSから取得したコメントデータを分析する。

主な分析：

- コメント総数
- 時間帯別コメント数
- コメント速度
- 平均コメント文字数
- コメント文字数分布
- 頻出ワード

分析結果をデータベースへ保存する。

---

### 4.5. Aurora Serverless v2 PostgreSQL

配信情報および分析結果を保存する。

PoCではリレーショナルデータベースを採用し、SQLによる集計・検索・比較を容易にする。

保存対象の詳細は `data-model.md` で定義する。

---

### 4.6. Amazon API Gateway

Web UIから利用するREST APIのエンドポイントを提供する。

将来的には外部ユーザー向けAPIとして公開することも想定する。

PoCでは外部ユーザー向けAPI公開は対象外とする。

---

### 4.7. API Lambda

API Gatewayからのリクエストを受け付け、
データベースから分析結果を取得してレスポンスを返す。

主な責務：

- 配信情報取得
- 分析結果取得
- 配信一覧取得
- APIレスポンス生成

---

### 4.8. Next.js

分析結果をWeb UIとして表示する。

主な機能：

- 配信検索・選択
- 配信情報表示
- コメント分析結果表示
- コメント数推移表示
- 各種グラフ表示

---

## 5. データフロー

### 5.1. データ収集

```text
YouTube Data API
       ↓
Data Collector Lambda
       ↓
SQS
```

Data Collector LambdaがYouTube Data APIから
対象配信のコメントを取得し、SQSへ送信する。

---

### 5.2. データ分析

```text
SQS
 ↓
Analyzer Lambda
 ↓
Aurora PostgreSQL
```

Analyzer Lambdaがコメントデータを取得し、
分析結果を生成してデータベースへ保存する。

---

### 5.3. Web UIからの参照

```text
Next.js
   ↓
API Gateway
   ↓
API Lambda
   ↓
Aurora PostgreSQL
   ↓
API Lambda
   ↓
Next.js
```

---

## 6. PoCにおける処理方式

PoCでは、特定のYouTube Live配信を対象として
データ収集から分析、Web表示までの一連の処理を検証する。

ライブ配信の継続監視や定期的な配信検出は、
PoC完了後の拡張対象とする。

---

## 7. PoCで採用しないAWSサービス

PoCでは以下のサービスを必須としない。

### 7.1. EventBridge

ライブ配信の自動検出や定期的なコメント取得が必要になった段階で導入を検討する。

### 7.2. Step Functions

複数の非同期処理や複雑なワークフローが必要になった段階で導入を検討する。

### 7.3. Amazon Bedrock

高度なAI分析を実装する段階で導入を検討する。

### 7.4. Amazon Cognito

ユーザーアカウント機能を実装する段階で導入を検討する。

---

## 8. フロントエンド

### 8.1. 技術

- Next.js
- TypeScript
- MUI
- Apache ECharts

### 8.2. 配置

Next.jsを静的コンテンツとしてAWS上へ配置する。

想定構成：

```text
Next.js
  ↓
S3
  ↓
CloudFront
```

---

## 9. バックエンド

### 9.1. 技術

- TypeScript
- AWS Lambda
- API Gateway

PoCではサーバレス構成を優先し、
常時稼働するアプリケーションサーバは使用しない。

---

## 10. インフラストラクチャ

AWSリソースはInfrastructure as Codeで管理する。

PoCではAWS CDKの利用を想定する。

```text
infrastructure/
├── bin/
├── lib/
└── cdk.json
```

---

## 11. 将来の拡張

PoC完了後、以下の拡張を検討する。

- EventBridgeによるライブ配信自動検出
- Step Functionsによるデータ収集ワークフロー管理
- AIによるコメント傾向分析
- 「読まれたコメント」の推定
- メンバー・非メンバー分析
- Super Chat分析
- 複数配信の比較
- Twitch等への対応
- Cognitoによるユーザー管理
- 外部ユーザー向けAPI公開
- API利用量に応じた課金
- 広告による収益化