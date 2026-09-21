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

PoCでは必要以上にAWSサービスを導入せず、一連のデータフローを実現するために必要な構成に限定する。

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
                         └────────▲─────────┘
                                  │
                                  │ OAuth 2.0
                                  │
                         ┌────────┴─────────┐
                         │     Lambda       │
                         │ Data Collector   │
                         └────────▲─┬───────┘
                                  │ │
                    Task Invoke   │ │ Comments
                                  │ │
                         ┌────────┴─▼───────┐
                         │ Step Functions   │
                         │ Collection       │
                         │ Workflow         │
                         └───────┬──────────┘
                                 │
                                 │ Stream Metadata
                                 ▼
                         ┌──────────────────┐
                         │     Lambda       │
                         │ Stream Metadata  │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Aurora Serverless│
                         │   PostgreSQL     │
                         └──────────────────┘

Data Collector Lambda
         │
         │ Comments + streamId + batchId
         ▼
┌──────────────────┐
│       SQS        │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│     Lambda       │
│    Analyzer      │
└───────┬──┬───────┘
        │  │
   ┌────┘  └────────────┐
   ▼                     ▼
┌──────────────────┐  ┌──────────────────┐
│       S3         │  │ Aurora Serverless│
│   Raw Comments   │  │   PostgreSQL     │
└──────────────────┘  │ Analysis Results │
                      └────────▲─────────┘
                               │
                      ┌────────┴─────────┐
                      │     Lambda       │
                      │    API Handler   │
                      └────────▲─────────┘
                               │
                      ┌────────┴─────────┐
                      │   API Gateway    │
                      └────────▲─────────┘
                               │
                      ┌────────┴─────────┐
                      │   Next.js / FE   │
                      └──────────────────┘
```

データ保存先を以下のように分離する。

- **S3**：コメント等の取得した原データ
- **Aurora PostgreSQL**：Web UIやAPIから利用する配信メタデータ、分析結果およびアプリケーションデータ

大量のコメント原データをAuroraに保存せず、オブジェクトストレージであるS3に保存することで、データ量の増加に伴うデータベースコストを抑制する。

一方、Web UIから頻繁に参照する配信メタデータおよび分析結果はAuroraに保存し、APIから取得できるようにする。

---

## 4. コンポーネント

### 4.1. YouTube Data API

YouTubeから以下のデータを取得する。

- YouTube Live配信情報
- Live Chat情報
- コメント情報

取得にはYouTube Data APIを利用する。

Live Chat取得に必要なAPIについてはOAuth 2.0認可を利用する。

---

### 4.2. AWS Step Functions

YouTube Live Chatの継続的な収集処理を制御する。

Lambdaには1回あたりの実行時間上限があるため、
1つのData Collector Lambdaを配信終了まで実行し続ける方式は採用しない。

Step FunctionsからData Collector Lambdaを繰り返し呼び出し、
Live Chat取得を継続する。

収集開始時にはData Collector Lambdaから取得した配信メタデータを
Stream Metadata Lambdaへ渡し、Aurora PostgreSQLへ永続化する。

Stream Metadata Lambdaから返却された内部`streamId`を
Step Functionsの実行状態として保持し、
以降のコメント収集処理へ引き継ぐ。

Step Functionsの実行状態には主に以下の情報を保持する。

```text
streamId
videoId
liveChatId
nextPageToken
pollingInterval
collectionStatus
```

`nextPageToken`を次回のData Collector Lambda呼び出しへ引き継ぐことで、
前回取得した位置からコメント取得を再開する。

概念的な処理フロー：

```text
Start
  ↓
Get Stream Metadata
(Data Collector Lambda)
  ↓
Persist Stream Metadata
(Stream Metadata Lambda)
  ↓
internal streamId取得
  ↓
Collect Comments
(Data Collector Lambda)
  ↓
SQSへ送信
  ↓
nextPageToken取得
  ↓
配信終了？
  ├─ Yes → End
  │
  └─ No
      ↓
     Wait
      ↓
Collect Comments
      ↓
     ...
```

Wait時間はYouTube Data APIから取得できるポーリング間隔を考慮して決定する。

一時的なエラーについてはStep FunctionsのRetry機能を利用する。

配信またはLive Chatの終了を検知した場合はワークフローを終了する。

一定回数のリトライ後も処理できない場合はワークフローを異常終了させ、
CloudWatch Logs等から確認できるようにする。

---

### 4.3. Data Collector Lambda

YouTube Data APIから対象配信のデータを取得する。

主な責務：

- OAuth 2.0 Access Tokenの取得
- 配信情報取得
- Live Chat ID取得
- コメント取得
- `nextPageToken`の取得
- ポーリング間隔の取得
- コメントバッチ単位の`batchId`生成
- コメントデータのSQSへの送信
- Step Functionsへの取得結果返却

収集開始時には、以下の配信メタデータをStep Functionsへ返却する。

```text
videoId
channelId
channelTitle
title
startedAt
liveChatId
```

Data Collector Lambda自身では配信メタデータをAuroraへ保存しない。

配信メタデータの永続化はStream Metadata Lambdaの責務とする。

Data Collector Lambda自身では配信終了まで待機しない。

1回のLambda実行では一定範囲のLive Chatを取得して処理を終了し、
取得継続に必要な`nextPageToken`等をStep Functionsへ返却する。

コメントをSQSへ送信する際には、
Stream Metadata Lambdaによって採番された内部`streamId`と、
コメントバッチを一意に識別する`batchId`を含める。

`batchId`はData Collector Lambdaでコメントバッチを生成した時点で一度だけ生成し、
SQSの再配信時にも同じ値を利用できるようメッセージに含める。

これによりAnalyzer Lambdaは外部Video IDから内部`streamId`を解決する必要がない。

Data Collector LambdaはYouTube Data APIへアクセスする必要があるため、
Auroraへ直接接続せず、VPC外で実行する構成を基本とする。

---

### 4.4. Stream Metadata Lambda

Data Collector Lambdaが取得した配信メタデータを
Aurora PostgreSQLへ永続化する。

主な責務：

- YouTube Channel IDを外部IDとして`channels`を作成または更新
- YouTube Video IDを外部IDとして`streams`を作成または更新
- 内部`channelId`の採番・取得
- 内部`streamId`の採番・取得
- 内部`streamId`をStep Functionsへ返却

配信メタデータの永続化はコメント収集開始前に実行する。

同じYouTube Channel IDまたはVideo IDが既に登録されている場合は、
既存レコードを利用し、重複レコードを作成しない。

概念的な処理：

```text
Stream Metadata
      ↓
YouTube Channel ID
      ↓
channels Upsert
      ↓
internal channelId
      ↓
YouTube Video ID
      ↓
streams Upsert
      ↓
internal streamId
      ↓
Step Functions
```

Stream Metadata LambdaはAuroraへアクセスするためVPC内へ配置する。

---

### 4.5. Amazon SQS

データ収集処理と分析処理の間に配置する。

主な目的：

- データ収集処理と分析処理の分離
- コメント量増加時のバッファリング
- Lambdaの処理負荷の平準化
- 一時的な処理失敗時の再実行

PoCでは、複数のコメントを1メッセージにまとめて送信する方式を基本とする。

SQSへ送信するコメントデータには内部`streamId`および`batchId`を含める。

概念的なメッセージ：

```text
batchId
streamId
videoId
comments
```

Standard Queueでは同一メッセージが複数回配信される可能性があるため、
Analyzer Lambdaでは`batchId`を利用して冪等性を確保する。

---

### 4.6. Analyzer Lambda

SQSからコメントデータを取得し、
原データの保存および分析処理を行う。

主な責務：

- SQSからコメントデータを取得
- `batchId`による処理済み判定
- コメント原データをS3へ保存
- コメントデータの集計・分析
- 分析結果をAurora PostgreSQLへ保存
- 処理済み`batchId`をAurora PostgreSQLへ保存

Analyzer LambdaはSQSメッセージに含まれる内部`streamId`を利用して、
対象配信の分析結果を保存する。

Standard SQSによるメッセージの重複配信に対応するため、
`processed_comment_batches`テーブルで処理済み`batchId`を管理する。

分析結果の更新と`processed_comment_batches`への処理済み登録は、
同一のAuroraトランザクション内で実行する。

既に処理済みの`batchId`を受信した場合は、
分析結果を再更新せず正常終了する。

S3へのRaw Data保存では`batchId`から決定されるオブジェクトキーを利用する。

```text
raw/youtube/streams/<stream-id>/batches/<batch-id>.jsonl
```

同じSQSメッセージが再処理された場合でも同じオブジェクトキーを使用することで、
Raw Dataの重複オブジェクト生成を防止する。

SQS Event Source MappingではPartial Batch Responseを有効にし、
複数メッセージの一部で処理に失敗した場合は、
失敗したメッセージのみを再試行対象とする。

主な分析：

- コメント総数
- 時間帯別コメント数
- コメント速度
- 平均コメント文字数
- コメント文字数分布
- 頻出ワード

---

### 4.7. Amazon S3

YouTube Liveから取得したコメント等の原データを保存する。

主な用途：

- コメント原データの保存
- 保持期間内における再分析
- 大量データの低コストな保存

S3には主に分析処理の入力となる原データを保存し、
Web UIから頻繁に参照する分析結果は保存しない。

Raw Dataのオブジェクトキーには`batchId`を利用し、
同一バッチを再処理した場合でも同一オブジェクトへ保存する。

保存形式、オブジェクト構成および保持期間の詳細は`data-model.md`で定義する。

---

### 4.8. Aurora Serverless v2 PostgreSQL

Web UIやAPIから利用する分析結果およびアプリケーションデータを保存する。

主な保存対象：

- 配信情報
- 配信者・チャンネル情報
- コメント集計結果
- 時間帯別コメント数
- 頻出ワード
- コメントバッチ処理済み情報
- その他のBI表示用データ

大量のコメント原データはAuroraには保存せず、S3に保存する。

PoCではリレーショナルデータベースを採用し、
SQLによる集計・検索・比較を容易にする。

YouTube Channel IDおよびVideo IDは外部IDとして保持し、
アプリケーション内部ではAurora側で採番した
`channelId`および`streamId`を利用する。

保存対象の詳細は`data-model.md`で定義する。

---

### 4.9. Amazon API Gateway

Web UIから利用するREST APIのエンドポイントを提供する。

将来的には外部ユーザー向けAPIとして公開することも想定する。

PoCでは外部ユーザー向けAPI公開は対象外とする。

---

### 4.10. API Lambda

API Gatewayからのリクエストを受け付け、
Aurora PostgreSQLから分析結果を取得してレスポンスを返す。

主な責務：

- 配信情報取得
- 分析結果取得
- 配信一覧取得
- APIレスポンス生成

---

### 4.11. Next.js

分析結果をWeb UIとして表示する。

主な機能：

- 配信検索・選択
- 配信情報表示
- コメント分析結果表示
- コメント数推移表示
- 各種グラフ表示

---

## 5. データフロー

### 5.1. データ収集開始

PoCでは対象となる配信を指定してStep Functionsの収集ワークフローを開始する。

ライブ配信そのものを自動検出してワークフローを開始する機能は、
PoC完了後の拡張対象とする。

```text
Target Stream
     ↓
Step Functions
     ↓
Data Collector Lambda
     ↓
YouTube Data API
     ↓
Stream Metadata
     ↓
Stream Metadata Lambda
     ↓
Aurora PostgreSQL
     ↓
internal streamId
     ↓
Step Functions
```

コメント収集を開始する前に、
`channels`および`streams`をAurora PostgreSQLへ永続化する。

---

### 5.2. 継続的なコメント取得

```text
Step Functions
       ↓
Data Collector Lambda
       ↓
YouTube Data API
       ↓
Comments + nextPageToken
       ↓
       ├──────────────→ SQS
       │
       ▼
Step Functions
       ↓
      Wait
       ↓
Data Collector Lambda
       ↓
      ...
```

Data Collector Lambdaは1回の実行で一定範囲のコメントを取得する。

取得したコメントには内部`streamId`および`batchId`を付与してSQSへ送信する。

次回取得位置を示す`nextPageToken`はStep Functionsの実行状態として保持し、
次回のLambda呼び出しへ引き継ぐ。

この処理を配信またはLive Chatが終了するまで繰り返す。

---

### 5.3. データ保存・分析

```text
                     SQS
                      ↓
               Analyzer Lambda
                      ↓
               batchId確認
                  ↙       ↘
                 ↓         ↓
                S3      Aurora PostgreSQL
                 ↓         ↓
          コメント原データ   分析結果
                              +
                      processed_comment_batches
```

Analyzer LambdaがSQSからコメントデータを取得し、以下の処理を行う。

1. `batchId`が処理済みか確認する
2. 未処理の場合、`batchId`から決定されるS3オブジェクトキーへコメント原データを保存する
3. コメントデータを分析する
4. 分析結果の更新と`batchId`の処理済み登録を同一Auroraトランザクションで実行する
5. 処理済みの場合は分析結果を再更新せず正常終了する

S3保存後に処理が失敗した場合でも、
再実行時には同一オブジェクトキーへ保存する。

AuroraトランザクションがCommitされる前に失敗した場合はRollbackされ、
再実行時に再度処理する。

AuroraトランザクションのCommit後にSQSメッセージが再配信された場合は、
`processed_comment_batches`によって処理済みと判定し、
分析結果の二重更新を防止する。

---

### 5.4. Web UIからの参照

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
API Gateway
   ↓
Next.js
```

Web UIから参照する配信情報および分析結果はAurora PostgreSQLから取得する。

PoCでは、Web UIからS3上のコメント原データを直接参照する機能は提供しない。

---

## 6. PoCにおけるコメント収集方式

PoCでは、特定のYouTube Live配信を対象として、
データ収集から分析、Web表示までの一連の処理を検証する。

配信ごとにStep FunctionsのState Machine Executionを開始し、
配信終了までコメント収集処理を継続する。

Data Collector Lambdaは短時間の処理単位として実行し、
配信終了まで単一Lambdaを実行し続けない。

コメント収集開始前にStream Metadata Lambdaによって
配信メタデータをAurora PostgreSQLへ永続化し、
内部`streamId`を確定させる。

### 6.1. 継続条件

以下の条件を満たす間、コメント取得を継続する。

- 対象Live Chatが有効である
- 次回取得可能な状態である
- ワークフローが異常終了していない

### 6.2. 停止条件

以下のいずれかを検知した場合、収集処理を終了する。

- YouTube Live配信の終了
- Live Chatの終了
- APIから継続取得不能であることを検知
- 設定したリトライ回数を超える継続的なエラー

### 6.3. 再試行

YouTube Data APIへのアクセスで一時的なエラーが発生した場合は、
Step FunctionsのRetry機能を利用する。

RetryではBackoffを設定し、
短時間にAPIを過剰に呼び出さないようにする。

### 6.4. 自動配信検出

ライブ配信の自動検出および収集ワークフローの自動開始は、
PoCでは対象外とする。

PoC完了後、EventBridge等を利用した自動化を検討する。

---

## 7. PoCで採用しないAWSサービス

PoCでは以下のサービスを必須としない。

### 7.1. Amazon EventBridge

ライブ配信の自動検出や収集ワークフローの自動開始が必要になった段階で導入を検討する。

### 7.2. Amazon Bedrock

高度なAI分析を実装する段階で導入を検討する。

### 7.3. Amazon Cognito

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
- AWS Step Functions
- Amazon API Gateway
- Amazon SQS

PoCではサーバレス構成を優先し、
常時稼働するアプリケーションサーバは使用しない。

---

## 10. インフラストラクチャ

AWSリソースはInfrastructure as Codeで管理する。

PoCではAWS CDKを利用する。

```text
infrastructure/
├── bin/
├── lib/
└── cdk.json
```

詳細は`infrastructure.md`で定義する。

---

## 11. 将来の拡張

PoC完了後、以下の拡張を検討する。

- EventBridgeによるライブ配信自動検出
- データ収集ワークフローの高度化
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
