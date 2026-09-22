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
         │ 1. Outbox Payload保存
         ▼
┌──────────────────┐
│ S3 Outbox        │
└────────┬─────────┘
         │
         │ 2. Auroraへ送信予定登録後、同じPayloadを送信
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
collectionJobId
videoId
liveChatId
nextPageToken
pollingInterval
observationStartedAt
collectionStatus
analysisStatus
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
S3 OutboxへPayload保存
  ↓
Register Outbox Batch
(Stream Metadata Lambda)
  ↓
SQSへ送信
(Data Collector Lambda)
  ↓
nextPageToken取得
  ↓
配信終了？
  ├─ Yes
  │   ↓
  │  Get Final Stream Metadata (Data Collector Lambda)
  │   ↓
  │  Persist Final Metadata / Collection Status (Stream Metadata Lambda)
  │   ↓
  │  collectionStatus?
  │    ├─ FAILED → analysisStatus=FAILED → Fail
  │    └─ COMPLETED
  │         ↓
  │        Finalize Analysis (Analysis Finalizer Lambda)
  │         ↓
  │        未処理バッチあり？
  │          ├─ Yes → Wait 10秒 → Finalize Analysis
  │          └─ No  → analysisStatus=COMPLETED → End
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

配信またはLive Chatの終了検知時は6.5節の終了処理へ進み、
最終メタデータ、収集状態および確定済み分析状態の保存成功後にワークフローを正常終了する。

収集TaskのRetry上限到達等はCatchから終了処理へ進み、
`collectionStatus=FAILED`および`analysisStatus=FAILED`を記録してから異常終了する。
収集失敗時はAnalysis Finalizerを呼び出さず、0件区間を補完しない。
保存自体の失敗も通知対象とする。

---

### 4.3. Data Collector Lambda

YouTube Data APIから対象配信のデータを取得する。

主な責務：

- OAuth 2.0 Access Tokenの取得
- 終了時の最終メタデータ再取得（`videos.list`の`snippet,liveStreamingDetails`）
- 配信情報取得
- Live Chat ID取得
- コメント取得
- 初回の正常なコメント取得要求に対応する`observationStartedAt`の返却
- `nextPageToken`の取得
- ポーリング間隔の取得
- コメントバッチ単位の`batchId`生成
- コメントバッチのS3 Outboxへの保存
- Auroraへの登録が完了したOutbox PayloadのSQSへの送信
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

初回のコメント取得では、YouTube API要求を送る直前のUTC日時を候補値として保持する。
要求が正常終了した場合だけ、その候補値を`observationStartedAt`として返す。
初回レスポンスにそれ以前のコメントが含まれても、分析対象には含めない。

取得したコメントは、SQSへ直接送信する前に、
内部`streamId`、`collectionJobId`および`batchId`を含む送信Payloadとして
S3 Outboxへ保存する。

`batchId`はランダムUUID、Lambda Request ID、実行時刻、Retry回数から生成せず、
送信対象の内容から決定的に生成する。生成仕様は`data-model.md`の7.1節に定義する。
同じ内容のコメントバッチは、Lambdaの再実行やSQS再配信をまたいで同じIDとなる。

Data CollectorはS3への保存後、`batchId`、OutboxオブジェクトキーおよびPayload SHA-256を
Step Functionsへ返す。Step FunctionsはStream Metadata Lambdaを呼び出し、
全分割バッチを`collection_job_batches`へ登録する。

登録完了後、Data Collectorを送信モードで呼び出す。
送信モードではYouTube APIを再取得せず、登録済みのS3 Outbox Payloadを読み出し、
SHA-256が登録値と一致することを確認してSQSへ送信する。
これにより、SQSへ実際に送信されるすべてのバッチは送信前に追跡対象となる。

SQS送信後・Task結果返却前に失敗した場合は、同じOutbox Payloadを再送信する。
再取得による内容や分割境界の変化は送信再試行へ影響しない。
SQSの重複配信および送信結果不明時の再送信は`batchId`で排除し、
別の取得結果に同じコメントが含まれる場合は`(streamId, commentId)`で排除する。

全登録済みバッチのSQS送信成功を確認した後にのみ、
Step Functionsは`nextPageToken`を次の取得位置として採用する。
一部の送信失敗・結果不明時は取得位置を進めず、同じOutbox Payloadの送信を再試行する。
空のバッチは送信しないが、取得が正常終了した場合の次ページトークンは返却する。

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
- 内部`streamId`および`collectionJobId`をStep Functionsへ返却
- SQS送信前の`batchId`、OutboxオブジェクトキーおよびPayload SHA-256の`collection_job_batches`への冪等登録
- `collection_jobs.observationStartedAt`および`stream_metrics.analysisStartAt`の初回保存
- `collection_jobs`の開始登録および終了状態更新
- 終了時の`streams.endedAt`を含む最終メタデータ更新

配信メタデータの永続化はコメント収集開始前および収集終了時に実行する。
開始時にStep Functions Execution ARNを一意キーとして`collection_jobs`を登録し、
終了時は同じ実行のレコードを更新する。

PoCでは1配信につき収集ジョブを1件に限定する。
`collection_jobs.streamId`にも一意制約を設定し、既存ジョブがある配信への別Executionの開始は
状態がFAILEDであっても拒否する。同じExecution ARNの再試行は既存ジョブを再利用する。
これにより配信単位の集計・処理済み情報と別ジョブのバッチが混在しない。
開始登録は配信情報の作成・更新と同一トランザクションで行い、一意制約違反時は開始を失敗させる。
同一配信の再収集を可能にする場合は、ジョブ単位の集計・重複排除・確定条件を別途設計する。

コメントバッチの登録はSQS送信前に行い、同じ登録要求の再実行では既存行を返す。
同じ`collectionJobId`と`batchId`に異なるオブジェクトキーまたはPayload SHA-256が指定された場合は、
既存行を上書きせずエラーとする。

初回の正常な取得後、Outbox登録要求と同じStream Metadata Lambda呼び出しで
`observationStartedAt`を`collection_jobs`へ保存し、
`streams.startedAt`と`observationStartedAt`の遅い方を`stream_metrics.analysisStartAt`へ設定する。
取得コメントが0件で登録対象バッチがない場合も、この保存処理を実行する。
再試行や後続取得では既存値を変更しない。

終了時の`streams`更新と`collection_jobs`更新は同一Auroraトランザクションで確定する。
同じ終了要求を再実行しても重複レコードを作成せず、確定済みの終了情報を消さない。
Stream Metadata LambdaはYouTube APIを直接呼び出さず、Data Collectorから渡された必要項目だけを保存する。

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

SQSへ送信するコメントデータには内部`streamId`、`collectionJobId`および`batchId`を含める。

概念的なメッセージ：

```text
batchId
streamId
collectionJobId
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

別の`batchId`に同じコメントが含まれる場合は、
`processed_comments`の`(streamId, commentId)`一意制約で重複を排除する。
新規に登録できたコメントだけを集計し、コメント処理済み登録も同じトランザクションで確定する。

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
- SQS送信前のコメントバッチPayloadの一時的なOutbox保存
- 保持期間内における再分析
- 大量データの低コストな保存

S3には主に分析処理の入力となる原データを保存し、
Web UIから頻繁に参照する分析結果は保存しない。

Raw Dataのオブジェクトキーには`batchId`を利用し、
同一バッチを再処理した場合でも同一オブジェクトへ保存する。

Outbox Payloadも`batchId`から決まるキーへ保存する。
Data CollectorはAuroraへ登録済みのOutbox PayloadだけをSQSへ送信する。

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
- コメントID単位の処理済み情報（本文・投稿者情報は含めない）
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

### 4.11. Analysis Finalizer Lambda

配信終了後、SQS送信前に登録したコメントバッチがすべて分析済みであることを確認し、
配信全体の分析結果を確定する。

Analysis Finalizerは`collection_jobs.collectionStatus=COMPLETED`の場合だけ確定処理を行う。
`collectionStatus`がFAILEDまたはRUNNINGの場合は、タイムラインの補完、
`analysisEndAt`の更新および`analysisStatus=COMPLETED`への更新を行わずFAILEDを返す。

主な責務：

- `collection_job_batches`と`processed_comment_batches`の突合
- 未処理バッチがある場合の待機判定返却
- `stream_metrics.analysisStartAt`から`streams.endedAt`までのコメント0件区間の補完
- 部分区間を含むコメント速度の再計算
- `stream_metrics.analysisEndAt`の`streams.endedAt`への固定
- `collection_jobs.analysisStatus`および`analysisFinalizedAt`の更新

確定処理は一つのAuroraトランザクションで冪等に実行する。
未処理バッチが残っている場合は更新せず、Step FunctionsへPENDINGを返す。
FinalizerのRetry上限到達時はStep FunctionsのCatchからStream Metadata Lambdaの
失敗状態更新モードを呼び出し、対象`collectionJobId`の`analysisStatus=FAILED`を冪等に保存する。
この更新はFinalizerとは別のTaskとして再試行する。
既にCOMPLETEDのジョブはFAILEDへ戻さない。

---

### 4.12. Next.js

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
S3 OutboxへPayload保存
       ↓
Stream Metadata Lambda
       ↓
collection_job_batchesへ送信前登録
       ↓
Data Collector Lambda（送信モード）
       ↓
      SQS
       ↓
送信成功確認
       ↓
      Wait
       ↓
Data Collector Lambda
       ↓
      ...
```

Data Collector Lambdaは1回の実行で一定範囲のコメントを取得する。

初回の正常な取得では、取得要求の開始日時を`observationStartedAt`として一度だけ確定する。
Step Functionsはこの値を実行状態に保持し、Stream Metadata Lambdaによって
`collection_jobs.observationStartedAt`へ保存する。
`stream_metrics.analysisStartAt`には`streams.startedAt`と`observationStartedAt`の遅い方を保存する。

取得したコメントには内部`streamId`、`collectionJobId`および`batchId`を付与し、
SQSメッセージと同じPayloadをS3 Outboxへ保存する。

Step FunctionsはData Collectorから受け取った全分割バッチの記述子を
Stream Metadata Lambdaへ渡し、`collection_job_batches`へ一つのトランザクションで冪等登録する。
登録に失敗した場合はSQSへ送信せず、登録処理を再試行する。

登録成功後、Data Collectorの送信モードは登録済みのS3 Outbox PayloadをSQSへ送信する。
送信成功応答を失った場合もYouTube APIを再取得せず、同じPayloadを再送信する。
全バッチの送信成功を確認できるまで取得位置を進めない。

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

1. `batchId`が処理済みなら正常終了する（この事前確認だけでは並行実行を制御しない）
2. 未処理の場合、`batchId`から決定されるS3オブジェクトキーへコメント原データを保存する
3. Auroraトランザクションを開始し、`processed_comment_batches`へ`INSERT ... ON CONFLICT DO NOTHING RETURNING`で登録する。登録できなければ集計せず終了する
4. `processed_comments`へ`(streamId, commentId)`順で登録し、`ON CONFLICT DO NOTHING RETURNING`で新規登録できたコメントIDだけを取得する
5. 新規登録できたコメントだけを分析し、すべての集計値を更新する
6. バッチ登録、コメントID登録、分析結果更新を同一トランザクションでCommitする。失敗時はすべてRollbackする

重複コメントのみの新しいバッチも、集計値を変えずにバッチ処理済み登録をCommitする。
並行実行時も一意制約によって同じコメントを集計できるトランザクションを一つに限定する。
集計行の加算は原子的なSQL更新とし、平均・順位等の再計算に必要な行ロックを取得する。
デッドロック等はトランザクション全体をRollbackし、Partial Batch Responseで再試行する。
詳細は`data-model.md`の9.5節に従う。

S3保存後に処理が失敗した場合でも、
再実行時には同一オブジェクトキーへ保存する。

AuroraトランザクションがCommitされる前に失敗した場合はRollbackされ、
再実行時に再度処理する。

AuroraトランザクションのCommit後にSQSメッセージが再配信された場合は、
`processed_comment_batches`によって処理済みと判定し、
分析結果の二重更新を防止する。

---

### 5.4. 分析完了待ち・確定

```text
Persist Final Metadata
        ↓
Analysis Finalizer Lambda
        ↓
未処理バッチあり？
   ├── Yes → Wait 10秒 → Analysis Finalizer Lambda
   └── No  → 分析結果確定 → End
Finalizer失敗・待機上限 → 失敗状態更新（別Task）→ Fail
```

Step Functionsは`streams.endedAt`および収集終了状態の保存後、
`collectionStatus=COMPLETED`の場合だけAnalysis Finalizer Lambdaを呼び出す。
`collectionStatus=FAILED`の場合は同じトランザクションで`analysisStatus=FAILED`を保存し、
Finalizerを呼び出さずState Machine Executionを失敗させる。

Analysis Finalizerは、SQS送信前に対象`collectionJobId`の`collection_job_batches`へ登録された全`batchId`が
`processed_comment_batches`へ登録済みかを確認する。
未処理バッチがある場合はPENDINGを返し、Step Functionsは10秒待機して再確認する。

未処理バッチが0件になった場合は、`stream_metrics.analysisStartAt`から
`streams.endedAt`までの空区間だけを補完し、
全体平均およびタイムラインを再計算して`analysisEndAt`を`endedAt`へ固定する。
`analysisStartAt`より前は未観測期間として扱い、0件区間を作成しない。
同じ確定要求の再実行では確定済み結果を重複更新しない。

DLQへの移動等で未処理バッチが残ったまま待機開始から30分を超えた場合、
または確定処理の再試行上限へ到達した場合は、Stream Metadata Lambdaによる
`analysisStatus=FAILED`の保存を再試行してからFailへ遷移し、
未確定の結果を確定済みとして公開しない。
Aurora障害により失敗状態を保存できない場合はExecutionを失敗させて通知し、
6.5節の終了状態復旧手順で元のジョブへFAILEDを反映する。

---

### 5.5. Web UIからの参照

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
- `observationStartedAt`以降の`nextPageToken`系列を欠落なく継続している
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

SQS送信後・Task結果返却前の失敗ではYouTube APIを再取得せず、
`collection_job_batches`に登録済みのS3 Outbox Payloadを再送信する。
登録前のData Collector失敗ではSQS送信が行われていないため、再取得内容が変わっても未追跡バッチは生じない。
別の取得結果に同じコメントが含まれる場合は、AnalyzerのコメントID単位の重複排除で扱う。

### 6.4. 自動配信検出

ライブ配信の自動検出および収集ワークフローの自動開始は、
PoCでは対象外とする。

PoC完了後、EventBridge等を利用した自動化を検討する。

---

### 6.5. 終了情報の永続化

配信またはLive Chatの終了検知時は、そのままEndへ遷移せず、以下を実行する。

1. 取得済みコメントの全分割バッチについて、SQS送信前の`collection_job_batches`への登録と、その登録済みPayloadのSQS送信成功を確認する。失敗時は正常終了扱いにしない
2. Step Functionsで`collectionStoppedAt`を一度だけ確定し、Execution ARN、内部`streamId`、`videoId`、停止理由とともに保持する
3. Data Collectorを最終メタデータ取得モードで呼び出し、`videos.list(part=snippet,liveStreamingDetails, id=videoId)`からタイトル、実開始日時、実終了日時を再取得する。このモードではコメントを再送信しない
4. Stream Metadata Lambdaへ必要項目を渡し、`streams`の最終メタデータと対象`collection_jobs`の終了状態を同一トランザクションで保存する。欠落のない収集と実終了日時の保存に成功した場合だけ`collectionStatus=COMPLETED`、`analysisStatus=FINALIZING`とし、それ以外は両方をFAILEDとする
5. `collectionStatus=FAILED`の場合はFinalizerを呼び出さずFailへ遷移する
6. `collectionStatus=COMPLETED`の場合だけAnalysis Finalizer Lambdaで送信済みバッチの分析完了を確認する。未処理の場合は10秒待機して再確認する
7. 未処理バッチが0件になったら、`analysisStartAt`から終了時刻までの分析結果と`analysisEndAt`を確定し、`analysisStatus=COMPLETED`の保存成功後にのみ正常終了する

`streams.endedAt`には`liveStreamingDetails.actualEndTime`をUTCで保存する。
収集停止時刻、現在時刻、予定終了時刻を代用しない。
Live Chatの終了・無効化だけで配信自体が終了したとは判定しない。

最終メタデータが未取得、または`actualEndTime`が未反映の場合は、
Step FunctionsのWaitで30秒間隔、初回を含め最大5回まで再取得する。
この回数はAPIエラー時の試行も含む上限とし、Lambda内で待機しない。
認証失効・アクセス拒否等の継続不能エラーは再試行を打ち切る。

上限到達・継続不能時は取得できた項目だけを保存し、
未取得の`endedAt`はNULLのまま（既存値がある場合は保持）とする。
`collection_jobs.collectionStatus=FAILED`、`analysisStatus=FAILED`、停止理由・エラー種別を保存し、
Analysis Finalizerを呼び出さずFailへ遷移する。
配信継続中にLive Chatだけが閉じた場合も、終了日時を捏造せずこの経路で扱う。

収集中のエラーで停止した場合もCatchから同じ終了処理へ進める。
実終了日時を取得できても、収集失敗があった実行をCOMPLETEDに変更しない。
収集失敗がなく、実終了日時と終了状態を保存できた場合のみ`collectionStatus=COMPLETED`とする。
`observationStartedAt`以降の`nextPageToken`系列に欠落がないこともCOMPLETEDの必須条件とする。
`collectionStatus=COMPLETED`は収集完了、`analysisStatus=COMPLETED`はSQS消化後の分析確定を表す。
State Machine Executionは両方がCOMPLETEDになった場合だけ正常終了する。

DB保存は初回を含め最大4回、2秒・4秒・8秒のBackoffで再試行する。
保存失敗またはCommit後の応答喪失では、保持済みの同じ終了要求を再送する。
再試行で`collectionStoppedAt`を現在時刻へ置き換えない。
DB保存のRetry上限到達時はFailとし、実行ID・エラー種別を記録して通知する。
DB障害時に収集状態まで保存できたとは扱わない。

運用者は失敗したExecution ARNと`videoId`を指定し、
コメント収集を行わない終了処理専用の実行からメタデータ再取得・保存を再実行する。
更新対象は元のCollection Jobとし、復旧実行のARNで別の収集ジョブを作らない。
収集失敗履歴は保持し、欠けていた実終了日時だけを補完できるようにする。
Finalizer失敗後に`analysisStatus=FINALIZING`が残った場合も、
同じExecution ARNと`collectionJobId`を指定して失敗状態更新モードを再実行し、
`analysisStatus=FAILED`を保存する。収集は再開せず、分析結果も確定しない。
手動停止・State Machine全体のタイムアウト等でCatchを実行できなかった場合も、この手順で補完する。

実装時は、正常終了、実終了日時の反映遅延、Live Chatのみ終了、
API取得失敗、DB Commit前の失敗・Commit後の応答喪失、
Analyzerの遅延、重複バッチ、0件配信、DLQ移動および分析確定タイムアウトを検証する。
終了保存後に`GET /streams`と`GET /streams/{streamId}`が同じ実終了日時を返すことも確認する。

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
