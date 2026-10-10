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
                                  │ API Key / OAuth 2.0
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

公開・非所有ライブの読み取りではAPI Keyを第一候補とする。
`videos.list`は公開情報の取得にAPI Keyを利用できるが、`liveChatMessages.list`については
Google公式資料間でAPI Key対応の記述が一致していないため、実装開始前に4.3.10節の手順で実地検証する。
検証に成功した場合はAPI Key方式を採用し、失敗した場合だけOAuth 2.0方式を再検討する。
認証方式が確定するまでOAuth Client、Refresh TokenおよびAccess Token取得処理は実装しない。

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
youtubeVideoId
youtubeLiveChatId
checkpoint
pendingPage
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
START_COLLECTION
(Stream Metadata Lambda)
  ↓
internal streamId取得
  ↓
Collect Comments
(Data Collector Lambda)
  ↓
S3 OutboxへPayload保存
  ↓
REGISTER_BATCHES
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
  │  STOP_COLLECTION (Stream Metadata Lambda)
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

- 検証済みの認証方式によるYouTube Data APIアクセス（初期候補はAPI Key）
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
youtubeVideoId
youtubeChannelId
channelName
title
startedAt
youtubeLiveChatId
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

#### 4.3.1. 共通Contract

Data Collector Lambdaの入力は`operation`を持つplain JSON objectとし、
API Gateway形式の`statusCode` / `body`は使用しない。Operationは以下の4種類とする。

| Operation | 目的 |
| --- | --- |
| `GET_STREAM_METADATA` | 初回の配信メタデータとLive Chat IDを取得する |
| `COLLECT_COMMENTS` | 1ページを取得し、Page SnapshotとBatch Outboxを保存する |
| `SEND_REGISTERED_BATCHES` | 登録済みDescriptorのOutbox PayloadをSQSへ送信する |
| `GET_FINAL_STREAM_METADATA` | 終了時の最終配信メタデータを取得する |

各Operationは定義されたfieldだけを受け付け、未知field、空文字、不正なID、
不正なtimestampおよび条件不整合を外部APIやAWSサービスへ接続する前に拒否する。
optional fieldは原則として使用せず、値が存在し得ないfieldは明示的な`null`とする。
内部`streamId`と`collectionJobId`は`^[1-9][0-9]*$`、0を許容する件数は
`^(0|[1-9][0-9]*)$`の10進JSON stringとし、JavaScript `number`へ変換しない。

日時はUTCのRFC 3339文字列とする。Data Collectorが正規化して生成するtimestampは
`YYYY-MM-DDTHH:mm:ss.ffffffZ`とし、7桁以上の小数秒はties-to-evenでマイクロ秒へ丸める。

共通するエラー分類とStep Functionsの扱いは以下とする。

| Classification | 主な条件 | Retry |
| --- | --- | --- |
| `VALIDATION` | Contract、ID、timestamp、field不正 | 不可 |
| `YOUTUBE_AUTHENTICATION` | API KeyまたはToken不正 | 不可、運用対応 |
| `YOUTUBE_AUTHORIZATION` | `forbidden`、scope不足 | 不可、運用対応 |
| `YOUTUBE_QUOTA` | quota超過 | 短期Retry不可、運用判断 |
| `YOUTUBE_TRANSIENT` | timeout、429、5xx、一時的通信障害 | Backoff付きRetry |
| `LIVE_CHAT_UNAVAILABLE` | Live Chat無効・未取得・not found | 状態により待機または失敗 |
| `LIVE_CHAT_ENDED` | Live Chat終了 | Retryせず終了処理へ進む |
| `S3_TRANSIENT` | S3 timeout、5xx、継続する409 | Retry可 |
| `OUTBOX_CONFLICT` | 同一keyの内容またはrequest identity不整合 | 不可 |
| `OUTBOX_INTEGRITY` | 保存済みbytesのSHA-256不一致 | 不可 |
| `OUTBOX_EXPIRED` | 7日Lifecycle等によるobject欠落 | 不可、収集失敗 |
| `SQS_TRANSIENT` | 明確な未送信となる一時障害 | 送信OperationだけRetry |
| `SQS_SEND_OUTCOME_UNKNOWN` | timeout等で送信結果不明 | 同一Outboxを再送 |
| `COMMENT_ID_CONFLICT` | 同じIDで本文または投稿日時が異なる | 不可 |
| `MESSAGE_TOO_LARGE` | 1コメントで921,600 bytesを超える | 不可 |
| `TIME_BUDGET` | 安全な完了に必要な残り時間がない | Operation単位でRetry |
| `UNEXPECTED` | 分類不能な内部障害 | 原則失敗、調査対象 |

ログにはOperation、AWS Request ID、内部ID、Batch ID、Page ID、件数、byte数、
HTTP status、機密情報を含まない外部API error reason、Retry回数および処理時間だけを記録する。
API Key、OAuth情報、YouTube APIレスポンス全体、コメント本文、SQS MessageBodyおよびLambda event全体は記録しない。

#### 4.3.2. `GET_STREAM_METADATA`

Input：

```json
{
  "operation": "GET_STREAM_METADATA",
  "youtubeVideoId": "youtube-video-id"
}
```

Output：

```json
{
  "youtubeVideoId": "youtube-video-id",
  "youtubeChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "channelName": "チャンネル名",
  "title": "配信タイトル",
  "startedAt": "2026-08-23T14:58:00.000000Z",
  "endedAt": null,
  "youtubeLiveChatId": "youtube-live-chat-id",
  "streamStatus": "LIVE"
}
```

すべてのfieldを必須とし、`startedAt`、`endedAt`および`youtubeLiveChatId`はnullableとする。
`streamStatus`は`UPCOMING`、`LIVE`または`ENDED`とする。
`videos.list(part=snippet,liveStreamingDetails,id=<youtubeVideoId>)`を使用し、
0件、複数件、要求IDと異なるID、必須property欠落を外部レスポンス不正として拒否する。
`START_COLLECTION`は`streamStatus=LIVE`で`startedAt`と`youtubeLiveChatId`が非NULLの場合だけ呼び出す。
同じVideo IDへのRetryは安全だが、YouTube側の状態変化によりOutputが変わり得る。

#### 4.3.3. `COLLECT_COMMENTS`

Input：

```json
{
  "operation": "COLLECT_COMMENTS",
  "streamId": "1",
  "collectionJobId": "1",
  "youtubeVideoId": "youtube-video-id",
  "youtubeLiveChatId": "youtube-live-chat-id",
  "streamStartedAt": "2026-08-23T14:58:00.000000Z",
  "checkpoint": {
    "nextPageToken": null,
    "observationStartedAt": null,
    "pollingIntervalMillis": null,
    "collectedCommentCount": "0"
  }
}
```

Output：

```json
{
  "pendingPage": {
    "requestPageToken": null,
    "responseNextPageToken": "next-page-token",
    "snapshotObjectKey": "outbox/youtube/collection-jobs/1/pages/page-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
    "snapshotSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "observationStartedAt": "2026-08-23T15:00:20.123456Z",
    "pollingIntervalMillis": 5000,
    "collectedCommentCount": "120",
    "batches": [
      {
        "batchId": "batch-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "outboxObjectKey": "outbox/youtube/collection-jobs/1/batches/batch-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
        "payloadSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
      }
    ]
  }
}
```

`checkpoint.nextPageToken`、`checkpoint.observationStartedAt`および
`checkpoint.pollingIntervalMillis`はnullable、その他のfieldは必須とする。
`pollingIntervalMillis`は0以上のsafe integerとし、Step FunctionsのWaitでは秒へ切り上げる。
初回要求ではYouTube API要求直前のUTC時刻を候補として保持し、正常応答時だけ
`pendingPage.observationStartedAt`へ設定する。2回目以降はcheckpointの同じ値を引き継ぐ。
`collectedCommentCount`は10進文字列の累積件数とし、Lambda内で`BigInt`加算する。
Batch Payloadの`analysisStartAt`は`streamStartedAt`と確定した`observationStartedAt`の遅い方とし、
Stream Metadata Lambdaも`REGISTER_BATCHES`で同じ値を独立に算出して永続化する。

`liveChatMessages.list(part=id,snippet,liveChatId=<youtubeLiveChatId>)`を使用し、
2回目以降は`pageToken=checkpoint.nextPageToken`を指定する。
`textMessageEvent`だけを抽出して正規化し、4.3.6節のPage Snapshotを保存した後、
`data-model.md`の7章に従ってBatch Outboxを生成する。
Snapshotと全Batch Outboxの保存が完了する前に成功Outputを返さない。

同じcheckpointからのRetryでは、決定的なSnapshot keyを最初に確認し、保存済みならYouTube APIを再取得しない。
Snapshotがまだ存在しない場合だけ再取得する。YouTube API応答後から最初のSnapshot保存前までの障害では、
再取得結果が変化し得るため完全なデータ保全を保証できない。

#### 4.3.4. `SEND_REGISTERED_BATCHES`

Input：

```json
{
  "operation": "SEND_REGISTERED_BATCHES",
  "streamId": "1",
  "collectionJobId": "1",
  "registeredBatchCount": 0,
  "pendingPage": {
    "requestPageToken": null,
    "responseNextPageToken": "next-page-token",
    "snapshotObjectKey": "outbox/youtube/collection-jobs/1/pages/page-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
    "snapshotSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "observationStartedAt": "2026-08-23T15:00:20.123456Z",
    "pollingIntervalMillis": 5000,
    "collectedCommentCount": "120",
    "batches": []
  }
}
```

Output：

```json
{
  "sentBatchCount": 0,
  "checkpoint": {
    "nextPageToken": "next-page-token",
    "observationStartedAt": "2026-08-23T15:00:20.123456Z",
    "pollingIntervalMillis": 5000,
    "collectedCommentCount": "120"
  }
}
```

すべてのfieldを必須とし、`requestPageToken`だけをnullableとする。
`registeredBatchCount`は0以上のsafe integerで、`pendingPage.batches.length`との一致を必須とする。
空配列かつ登録数0はSQSを呼ばず成功とする。

送信前にSnapshotと各OutboxをGETし、実バイト列のSHA-256、key内の内部IDとBatch ID、
Payload内の`streamId`、`collectionJobId`および`batchId`を検証する。
SQSへは原則として`SendMessage`で1件ずつ送信する。このOperationではYouTube APIを呼び出さない。
一部成功、送信結果不明、Task成功応答前の障害では同じ全Descriptorを再送してよい。
Standard Queueの重複とAnalyzerの冪等性によって同じ結果へ収束させる。

`registeredBatchCount`はDB登録の暗号学的証明ではない。登録済み保証は、
Step Functionsの状態遷移、Stream Metadata Lambdaの`REGISTER_BATCHES`検証、同一Descriptorの受け渡し、
および4.3.8節のIAM境界を組み合わせて成立させる。

#### 4.3.5. `GET_FINAL_STREAM_METADATA`

Input：

```json
{
  "operation": "GET_FINAL_STREAM_METADATA",
  "youtubeVideoId": "youtube-video-id"
}
```

Output：

```json
{
  "youtubeVideoId": "youtube-video-id",
  "title": "最終配信タイトル",
  "startedAt": "2026-08-23T14:58:00.000000Z",
  "endedAt": "2026-08-23T17:00:00.000000Z",
  "streamStatus": "ENDED"
}
```

すべてのfieldを必須とし、`endedAt`だけをnullableとする。
`videos.list(part=snippet,liveStreamingDetails,id=<youtubeVideoId>)`で最新値を取得する。
`endedAt=null`の場合はYouTube側の反映待ちとしてStep Functionsが30秒Wait後に再試行する。
既存設計どおり初回を含め最大5回とし、取得不能時は`STOP_COLLECTION`へFAILEDとNULLの終了日時を渡す。

#### 4.3.6. Page Snapshot

YouTube APIの1回の正常応答は、Batch生成前に次のkeyへ保存する。

```text
outbox/youtube/collection-jobs/<collectionJobId>/pages/<pageId>.json
```

`pageId`は`page-v1-`と、次の固定配列を`canonical-json-v1`でJSON化したUTF-8バイト列の
SHA-256小文字hex 64桁を連結する。

```text
["page-v1", streamId, collectionJobId, youtubeLiveChatId,
 requestPageTokenOrEmptyString]
```

Snapshot schemaは`comment-page-v1`とし、`schemaVersion`、要求時と応答時のPage Token、
`observationStartedAt`、`pollingIntervalMillis`および正規化済みコメントを含める。
コメントには`commentId`、`text`および`publishedAt`だけを含める。

`PutObject`は`If-None-Match: *`を使用する。同じrequest identityのSnapshotが既に存在する場合は、
既存objectの実バイト列、schema、内部ID、Live Chat IDおよび`requestPageToken`を検証して再利用し、
新しく取得した結果は破棄する。並列実行では最初に保存が完了したSnapshotを正とする。

#### 4.3.7. CheckpointとPendingPage

Step Functionsは確定済み状態を`checkpoint`、未送信の取得結果を`pendingPage`として分離する。

```json
{
  "checkpoint": {
    "nextPageToken": null,
    "observationStartedAt": null,
    "pollingIntervalMillis": null,
    "collectedCommentCount": "0"
  },
  "pendingPage": null
}
```

処理順序は次に固定する。

```text
COLLECT_COMMENTS
  → Page Snapshot保存
  → 全Batch Outbox保存
  → REGISTER_BATCHES
  → SEND_REGISTERED_BATCHES
  → checkpoint確定、pendingPage破棄
```

`REGISTER_BATCHES`成功前はSQSへ送信しない。全BatchのSQS送信成功前は
`responseNextPageToken`、累積件数およびポーリング間隔をcheckpointへ反映しない。
送信失敗・結果不明時は`pendingPage`を維持し、送信Operationだけを再試行する。

#### 4.3.8. Step FunctionsとIAMの境界

Data CollectorはDBの登録状態を直接確認しない。Step Functionsは`REGISTER_BATCHES`成功時に返された
`registeredBatchCount`と元のDescriptor配列を同じ送信入力へ渡し、送信Operationは件数と配列長を検証する。

送信Stateは`REGISTER_BATCHES`の成功分岐からだけ到達可能とする。
State Machine実行Roleには対象Data Collector LambdaとStream Metadata LambdaのInvokeだけを許可する。
Data Collector Lambdaには広いprincipalを許可するresource-based policyを追加せず、同一account内の
IAM identity policyで対象State Machine実行Roleおよび明示した運用RoleだけにInvokeを許可する。
Data Collector実行RoleにはAurora、
`rds-db:*`、`rds-data:*`およびVPC ENI操作を許可しない。

この境界は悪意ある呼び出し元に対する暗号学的証明ではない。
署名付き登録receiptやDB照会APIは既存Contract変更と複雑性を伴うためPoCでは採用しない。

#### 4.3.9. 障害復旧

| 障害位置 | 復旧方法 |
| --- | --- |
| YouTube応答後、Snapshot保存前 | 同じcheckpointから再取得。結果変化の可能性が残る |
| Snapshot Put結果不明 | 決定的keyをGETし、存在すれば検証して再利用する |
| Snapshot保存後、Batch保存途中 | Snapshotから全Batchを再生成し、不足objectだけ保存する |
| Batch保存後、登録前 | 同じDescriptorで`REGISTER_BATCHES`を実行する |
| 登録Commit結果不明 | 同一入力で`REGISTER_BATCHES`を再実行する |
| 登録成功後、送信前 | `SEND_REGISTERED_BATCHES`だけを実行する |
| SQS部分成功・結果不明 | 全Descriptorを同じOutboxから再送する |
| SQS成功後、checkpoint確定前 | pendingPageを維持して再送後、同じcheckpointを確定する |
| Outbox欠落・7日Lifecycle期限切れ | YouTubeから再生成せず`OUTBOX_EXPIRED`で収集を失敗させる |

YouTube API応答と最初のS3保存は同一トランザクションにできず、投稿者またはmoderatorによる
コメント削除も起こり得るため、YouTube上に一時的に存在した全コメントの完全収集は保証しない。
耐久保存済みSnapshot以降について、取得位置の先行、未登録送信および二重集計を防止する。

#### 4.3.10. YouTube API認証の検証

`videos.list`は公開動画の`snippet,liveStreamingDetails`取得にAPI Keyを使用する。
`liveChatMessages.list`はGoogle公式のData API共通説明およびLive Chat streaming sampleでは
API Keyを利用可能と読める一方、Live Streaming APIのCredential説明には全methodでOAuth必須との記載がある。
そのため、公開・非所有ライブに対して次の実地検証を行うまでAPI Key方式を確定しない。

根拠とするGoogle公式資料：

- [YouTube Data API v3 Overview](https://developers.google.com/youtube/v3/docs)
- [`videos.list`](https://developers.google.com/youtube/v3/docs/videos/list)
- [`liveChatMessages.list`](https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list)
- [Stream live chat](https://developers.google.com/youtube/v3/live/streaming-live-chat)
- [Authorizing Live Streaming API Requests](https://developers.google.com/youtube/v3/live/registering_an_application)

1. YouTube Data API v3だけに制限したAPI Keyを用意する
2. Live Chatが有効な公開・非所有ライブを選ぶ
3. API Keyだけで`videos.list`を実行し、`activeLiveChatId`を確認する
4. 同じAPI Keyで`liveChatMessages.list(part=id,snippet)`を実行する
5. `pollingIntervalMillis`経過後、返却された`nextPageToken`で2回目を実行する
6. 200応答と必要fieldを確認できればAPI Key方式を採用する
7. 認証・認可エラーになる場合は最小のread-only scopeによるOAuth方式を再検討する

検証完了までOAuth Client、Refresh Token管理およびToken更新処理を実装しない。

---

### 4.4. Stream Metadata Lambda

Stream Metadata Lambdaは、Data Collector Lambdaが取得し、Step Functionsが保持する
配信・収集処理情報をAurora PostgreSQLへ永続化する。
YouTube API、S3およびSQSへは直接アクセスしない。

主な責務：

- YouTube Channel IDを外部IDとして`channels`を作成または更新
- YouTube Video IDを外部IDとして`streams`を作成または更新
- `collection_jobs`の開始登録および終了状態更新
- `collection_jobs.observation_started_at`および`stream_metrics.analysis_start_at`の初回保存
- SQS送信前の`collection_job_batches`への冪等登録
- 終了時の`streams.ended_at`を含む最終メタデータ更新
- Analysis Finalizerの再試行上限到達時に`analysis_status=FAILED`を記録
- 内部`streamId`および`collectionJobId`をStep Functionsへ返却

Data Collector LambdaはYouTube APIからメタデータとコメントを取得し、S3 Outboxへの保存と
登録済みPayloadのSQS送信を担当する。Step FunctionsはExecution ARN、取得位置、累積件数、
開始・停止時刻および処理状態を実行状態として保持し、適切なOperationで本Lambdaを呼び出す。
Analyzer Lambdaはコメント分析結果と処理済み情報を更新する。Analysis Finalizer Lambdaは
未処理バッチの確認、分析結果の確定、`analysis_status=COMPLETED`および
`analysis_finalized_at`の更新を同一トランザクションで担当する。

#### 4.4.1. 共通Contract

入力は`operation`を持つplain JSON objectとし、API Gateway形式の`statusCode` / `body`は使用しない。
Operationは以下の4種類とする。

| Operation | 呼び出し元 | 目的 |
| --- | --- | --- |
| `START_COLLECTION` | Step Functions | 配信メタデータとCollection Jobを開始登録する |
| `REGISTER_BATCHES` | Step Functions | 観測開始時刻を初回保存し、SQS送信前のOutbox batchを登録する |
| `STOP_COLLECTION` | Step Functions | 最終配信メタデータとCollection Jobの終了状態を保存する |
| `MARK_ANALYSIS_FAILED` | Step FunctionsのFinalizer Catch | 分析確定失敗を記録する |

外部IDは`youtubeChannelId`、`youtubeVideoId`、`youtubeLiveChatId`、
内部IDは`channelId`、`streamId`、`collectionJobId`と命名する。
PostgreSQL `BIGINT`である内部IDおよびコメント件数は、Node.jsの安全整数範囲を超えても
精度を失わないよう、Lambda Input / OutputおよびStep Functions stateでは10進JSON stringとする。
値は`0`または先頭ゼロのある形式を許可せず、内部IDは`^[1-9][0-9]*$`、
0を許容する件数は`^(0|[1-9][0-9]*)$`として検証する。

日時はUTCのRFC 3339文字列として受け取り、DBへは`TIMESTAMPTZ`として保存する。
各Operationは定義された項目だけを受け取り、未知の項目、空文字、不正な日時、
不正なIDおよびOperationごとの状態条件を満たさない入力をDB接続前に拒否する。

#### 4.4.2. `START_COLLECTION`

Data Collectorが配信メタデータとLive Chat IDを取得した後、コメント収集開始前に
Step Functionsが呼び出す。Live Chat IDが取得できない配信はコメント分析を実行できないため、
PoCの分析開始対象外とし、このOperationを呼び出さない。

Input：

```json
{
  "operation": "START_COLLECTION",
  "executionArn": "arn:aws:states:ap-northeast-1:123456789012:execution:stream-insight:example",
  "collectionStartedAt": "2026-08-23T15:00:00Z",
  "stream": {
    "youtubeChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
    "channelName": "チャンネル名",
    "youtubeVideoId": "youtube-video-id",
    "youtubeLiveChatId": "youtube-live-chat-id",
    "title": "配信タイトル",
    "startedAt": "2026-08-23T14:58:00Z"
  }
}
```

Channel URLおよびStream URLは入力で受け取らず、検証済みの外部IDから本Lambdaが次の形式で生成する。

```text
channels.url = https://www.youtube.com/channel/<youtubeChannelId>
streams.url  = https://www.youtube.com/watch?v=<youtubeVideoId>
```

1つのトランザクションで次を実行する。

1. `youtube_channel_id`を競合対象として`channels`をUPSERTし、内部`channelId`を取得する
2. `youtube_video_id`を競合対象として`streams`をUPSERTし、内部`streamId`を取得する
3. `execution_arn`および`stream_id`の一意制約を利用して`collection_jobs`を開始登録する
4. `collection_status=RUNNING`、`analysis_status=PENDING`で内部`collectionJobId`を取得する

同じYouTube Channel IDでは`name`、決定的に生成した`url`および`updated_at`を更新する。
同じYouTube Video IDでは`title`、`started_at`、決定的に生成した`url`および`updated_at`を更新する。
既存Streamの`channel_id`または`youtube_live_chat_id`が入力と異なる場合は、別の配信関係へ
付け替えずデータ不整合としてトランザクションを失敗させる。開始処理では`ended_at`を更新せず、
既存の確定済み終了日時を保持する。

既存Channel / Streamの業務項目と入力から導出した業務項目が完全一致する再実行では、
ChannelおよびStreamに対するUPDATE SQL自体を実行せず、`updated_at`も変更しない。
既存行をそのまま使用して後続処理へ進む。上記の更新対象となる業務項目に実際の差分がある場合だけ、
許可された業務項目をUPDATEし、同じUPDATEで`updated_at`を更新する。

同じExecution ARNの再実行は、同じStreamおよび同じ`collectionStartedAt`である場合だけ
既存Collection Jobを返す。同じStreamに別Execution ARNが存在する場合、または同じExecution ARNが
別Stream・別開始時刻を指す場合は拒否する。PoCでは状態にかかわらず1 Streamにつき1 Jobとする。

`analysis_start_at`は初回の正常なコメント取得時刻が未確定であるため、
このOperationでは`stream_metrics`を作成しない。

Output：

```json
{
  "streamId": "1",
  "collectionJobId": "1"
}
```

#### 4.4.3. `REGISTER_BATCHES`

Data Collectorがコメント取得要求を正常終了し、送信PayloadをS3 Outboxへ保存した後、
SQS送信前にStep Functionsが呼び出す。初回取得が0件で`batches`が空の場合も呼び出す。

Input：

```json
{
  "operation": "REGISTER_BATCHES",
  "streamId": "1",
  "collectionJobId": "1",
  "executionArn": "arn:aws:states:ap-northeast-1:123456789012:execution:stream-insight:example",
  "observationStartedAt": "2026-08-23T15:00:20Z",
  "batches": [
    {
      "batchId": "batch-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "outboxObjectKey": "outbox/youtube/collection-jobs/1/batches/batch-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json",
      "payloadSha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
    }
  ]
}
```

同一Request内の`batchId`重複は入力不正とする。1つのトランザクションで対象Collection Jobを
行ロックし、`streamId`、`collectionJobId`、`executionArn`の対応と`RUNNING`状態を確認して次を行う。

1. `observation_started_at`がNULLなら入力値を保存し、既存値がある場合は同じ値であることを確認する
2. `analysis_start_at = max(streams.started_at, observation_started_at)`として`stream_metrics`を初回作成する
3. 各Descriptorを`collection_job_batches`へ登録する

`stream_metrics`が既に存在する場合は`analysis_start_at`が同じことを確認し、変更しない。
Batchは`(collection_job_id, batch_id)`を競合対象として登録する。同じキー・同じ
`outbox_object_key`・同じ`payload_sha256`の再登録は成功とするが、どちらかが異なる場合は
既存行を上書きせず、Payload同一性違反としてトランザクション全体を失敗させる。

Output：

```json
{
  "registeredBatchCount": 1
}
```

`registeredBatchCount`は新規行数ではなく、同一性を確認して今回の要求で登録済みとなったDescriptor数とする。

#### 4.4.4. `STOP_COLLECTION`

配信またはLive Chatの終了を検知し、Data Collectorが最終メタデータを取得した後、
Step Functionsが呼び出す。Step Functionsは`collectionStoppedAt`を一度だけ確定し、
再試行でも同じ値と累積件数を渡す。

Input：

```json
{
  "operation": "STOP_COLLECTION",
  "streamId": "1",
  "collectionJobId": "1",
  "executionArn": "arn:aws:states:ap-northeast-1:123456789012:execution:stream-insight:example",
  "youtubeVideoId": "youtube-video-id",
  "title": "最終配信タイトル",
  "startedAt": "2026-08-23T14:58:00Z",
  "endedAt": "2026-08-23T17:00:00Z",
  "collectionStoppedAt": "2026-08-23T17:00:10Z",
  "collectionStatus": "COMPLETED",
  "lastPageToken": null,
  "collectedCommentCount": "1200",
  "stopReason": "STREAM_ENDED",
  "errorCode": null
}
```

`collectionStatus`は`COMPLETED`または`FAILED`だけを許可する。`COMPLETED`では`endedAt`を必須、
`errorCode`をNULLとし、`FAILED`では機密情報を含まない`errorCode`を必須とする。
`stopReason`は両状態で必須とする。`endedAt`はFAILEDの場合だけNULLを許容する。

1つのトランザクションで対象Collection Jobを行ロックし、内部ID、Execution ARNおよび
YouTube Video IDの対応を確認して、`streams`の最終メタデータと`collection_jobs`の終了状態を更新する。
`COMPLETED`へ更新するには`observation_started_at`と`stream_metrics`が存在することも確認する。
取得系列に欠落がないことおよび全登録済みOutbox PayloadのSQS送信が成功したことは、
Step Functionsが確認したうえで`COMPLETED`を指定する。

`COMPLETED`では`analysis_status=FINALIZING`、`FAILED`では`analysis_status=FAILED`とする。
`analysis_finalized_at`は更新しない。`title`と`started_at`は最終取得値で更新する。
`endedAt=NULL`で既存の非NULL値を消さず、既存値がNULLなら非NULLの実終了日時を保存する。
既存の非NULL終了日時と異なる非NULL値は不整合として拒否する。

許可する状態遷移は`RUNNING → COMPLETED`または`RUNNING → FAILED`だけとする。
終端状態への再実行では、入力`youtubeVideoId`が保存済み`streams.youtube_video_id`と一致し、
`title`、`startedAt`、`endedAt`、`collectionStoppedAt`、`collectionStatus`、`lastPageToken`、
`collectedCommentCount`、`stopReason`および`errorCode`も保存済みの値と一致する場合だけ成功とする。
いずれかが相違する場合は`STATE_CONFLICT`として拒否する。
終端状態を別の状態へ変更せず、FAILEDをCOMPLETEDへ、COMPLETEDをFAILEDへ変更しない。
終了日時未取得でFAILEDとなったJobの復旧実行では、他の終端情報を保持したまま
`ended_at`だけをNULLから実終了日時へ補完できる。この補完を終端状態への再実行における唯一の例外とする。

Output：

```json
{
  "streamId": "1",
  "collectionJobId": "1",
  "collectionStatus": "COMPLETED",
  "analysisStatus": "FINALIZING"
}
```

#### 4.4.5. `MARK_ANALYSIS_FAILED`

Analysis FinalizerのRetry上限到達または分析完了待ちのtimeoutをStep FunctionsがCatchした場合に呼び出す。

Input：

```json
{
  "operation": "MARK_ANALYSIS_FAILED",
  "streamId": "1",
  "collectionJobId": "1",
  "executionArn": "arn:aws:states:ap-northeast-1:123456789012:execution:stream-insight:example",
  "errorCode": "ANALYSIS_FINALIZATION_TIMEOUT"
}
```

1つのトランザクションで対象Collection Jobを行ロックし、IDとExecution ARNの対応を確認する。
収集中のJobは拒否する。`analysis_status`がPENDINGまたはFINALIZINGならFAILEDへ更新し、
機密情報を含まない`error_code`を保存する。既にFAILEDなら再実行を成功とし、最初のエラー種別を保持する。
既にCOMPLETEDならDBを更新せず、`analysis_status`をFAILEDへ戻さず、`error_code`も上書きしない。
この場合は現在のCOMPLETED状態を返す。
`analysis_finalized_at`はAnalysis Finalizerによる正常確定時刻であるため、このOperationでは設定しない。

Outputの`analysisStatus`は`"FAILED"`または`"COMPLETED"`とし、処理後の実際の保存状態を返す。

PENDING、FINALIZINGまたはFAILEDの場合：

```json
{
  "streamId": "1",
  "collectionJobId": "1",
  "analysisStatus": "FAILED"
}
```

COMPLETEDの場合：

```json
{
  "streamId": "1",
  "collectionJobId": "1",
  "analysisStatus": "COMPLETED"
}
```

#### 4.4.6. Transactionとエラー

各Operationは1つのAuroraトランザクションで完結させる。途中失敗時は全変更をRollbackし、
部分状態を残さない。冪等性はPrimary Key、Unique Constraint、`INSERT ... ON CONFLICT`、
行ロックおよび状態遷移条件で保証し、事前SELECTだけに依存しない。

Commit開始前の失敗ではRollbackする。Commit要求後に応答を確認できない場合は結果不明として
Rollbackせず、接続を破棄して再試行可能エラーを返す。呼び出し元は同じ入力を再実行し、
各Operationの冪等性によって保存済みまたは未保存のどちらでも同じ結果へ収束させる。

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
youtubeVideoId
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
`MARK_ANALYSIS_FAILED`を呼び出し、対象`collectionJobId`の`analysisStatus=FAILED`を冪等に保存する。
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
Comments + responseNextPageToken
       ↓
S3 Page Snapshotへ取得結果を固定
       ↓
S3 Batch Outboxへ全Payload保存
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

Step Functionsは確定済み取得位置を`checkpoint`、取得済みで未送信の結果を`pendingPage`として保持する。
`responseNextPageToken`は全登録済みBatchの送信成功後にだけ`checkpoint.nextPageToken`へ反映し、
次回のLambda呼び出しへ引き継ぐ。送信失敗時は`pendingPage`を維持し、YouTube APIを再取得しない。

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
STOP_COLLECTION
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
2. Step Functionsで`collectionStoppedAt`を一度だけ確定し、Execution ARN、内部`streamId`、`youtubeVideoId`、停止理由とともに保持する
3. Data Collectorを最終メタデータ取得モードで呼び出し、`videos.list(part=snippet,liveStreamingDetails, id=youtubeVideoId)`からタイトル、実開始日時、実終了日時を再取得する。このモードではコメントを再送信しない
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

運用者は失敗したExecution ARNと`youtubeVideoId`を指定し、
コメント収集を行わない終了処理専用の実行からメタデータ再取得・保存を再実行する。
更新対象は元のCollection Jobとし、復旧実行のARNで別の収集ジョブを作らない。
収集失敗履歴は保持し、欠けていた実終了日時だけを補完できるようにする。
Finalizer失敗後に`analysisStatus=FINALIZING`が残った場合も、
同じExecution ARNと`collectionJobId`を指定して`MARK_ANALYSIS_FAILED`を再実行し、
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
