# Stream Insight - API Specification

## 1. 概要

Stream Insightが提供するREST APIの仕様を定義する。

PoCでは、Web UIから配信情報およびコメント分析結果を取得するためのAPIを提供する。

APIはAmazon API GatewayおよびAWS Lambdaを利用して実装する。

ブラウザからAPIへアクセスする際は、
Frontendと同じCloudFront Distributionを利用し、
`/api/*`をAPI Gatewayへルーティングする。

これによりFrontendとAPIを同一オリジンとして提供する。

PoCではユーザー認証・認可を実装しないため、
API Gateway自体は認証なしの公開Read Only APIとして扱う。

想定外の大量アクセスによる負荷およびコスト増加を抑制するため、
API GatewayのThrottlingおよびAPI Lambdaの同時実行数制限を設定する。

---

## 2. API方針

### 2.1. REST API

HTTPメソッドおよびURLパスによってリソースを表現するREST APIとして設計する。

### 2.2. JSON

リクエストおよびレスポンスのデータ形式にはJSONを使用する。

### 2.3. Read Only

PoCでは分析結果の参照を目的とするため、
GET APIのみを提供する。

### 2.4. 公開範囲

PoCではAPI Gatewayにユーザー認証・認可を設定しない。

そのためAPI Gatewayのエンドポイントは、
技術的にはインターネットから直接アクセス可能な公開Read Only APIとして扱う。

ただし、外部利用者向けの正式な公開APIとして提供するものではなく、
Stream Insight Web UIからの参照用途を想定する。

想定外の大量アクセスに備え、
API GatewayのThrottlingおよびAPI LambdaのReserved Concurrencyによって
利用量とバックエンド負荷を制限する。

将来的に外部ユーザー向けAPIを正式に提供する場合は、
認証・認可、APIキー、利用量制限、課金等を追加する。

### 2.5. ブラウザからのAPIアクセス

FrontendとAPIは同一のCloudFront Distributionから提供する。

```text
Browser
   ↓
CloudFront
   ├── /*       → Frontend S3
   └── /api/*   → API Gateway
```

ブラウザからは以下のような相対パスでAPIへアクセスする。

```text
/api/streams
/api/streams/{streamId}
/api/streams/{streamId}/metrics
```

FrontendとAPIが同一オリジンとなるため、
PoCではブラウザからのAPIアクセスのためのCORS設定を不要とする。

将来的にAPIを別オリジンから直接利用させる場合は、
許可するOrigin、HTTP Method、Headerを明示したCORS設定を追加する。

### 2.6. 利用量制御

PoCでは認証を導入しない代わりに、
API GatewayでThrottlingを設定する。

初期値は以下を目安とする。

```text
Rate Limit: 5 requests/second
Burst Limit: 10 requests
```

制限はすべてのGET APIに適用する。

制限を超えたリクエストには、
API Gatewayから以下を返す。

```http
429 Too Many Requests
```

また、API LambdaにはReserved Concurrencyを設定する。

```text
Reserved Concurrency: 5
```

これによりAPI Gatewayを直接呼び出された場合でも、
API LambdaおよびAuroraへの負荷に上限を設ける。

具体的な値はPoCの利用状況を確認しながら調整する。

### 2.7. CloudFrontでのAPIパス変換

CloudFrontのCache Behaviorは転送先Originを選択するだけで、
リクエストURIから`/api`を自動的に除去しない。

`/api/*` Cache Behaviorのviewer-requestイベントにCloudFront Functionを関連付け、
URI先頭の`/api/`を`/`へ置換してからAPI Gatewayへ転送する。

変換はURI先頭に対して一度だけ行い、
`streamId`等を含む残りのパスおよびクエリ文字列は変更しない。
URI変換後も、選択済みのAPI Gateway Originへ転送する。

本書のEndpointはAPI Gatewayのリソースパスを示し、
API Gateway側には`/api`付きのリソースを追加しない。

PoCではAPI Gateway REST APIのStage名を`dev`とし、
CloudFrontのAPI Gateway OriginのOrigin Pathに`/dev`を設定する。
Stage名はOrigin Pathで付与し、CloudFront Functionでは付与しない。

| ブラウザのリクエスト              | Functionによる変換後          | API Gatewayへの転送パス（Origin Pathを含む） |
| --------------------------------- | ----------------------------- | -------------------------------------------- |
| `/api/streams`                    | `/streams`                    | `/dev/streams`                               |
| `/api/streams/stream-001/metrics` | `/streams/stream-001/metrics` | `/dev/streams/stream-001/metrics`            |
| `/api/streams?limit=20&offset=0`  | `/streams?limit=20&offset=0`  | `/dev/streams?limit=20&offset=0`             |

クエリ文字列はOrigin Request Policyでも転送を許可する。
CloudFront Function、OriginおよびPolicyの設定は`infrastructure.md`の12.2節に定義する。

---

## 3. API構成

```text
Browser
   ↓
CloudFront
   │
   │ /api/*
   ▼
CloudFront Function (viewer-request)
   │
   │ /api/ → /（Origin Path: /dev）
   ▼
API Gateway
   │
   │ Throttling
   ▼
API Lambda
   │
   │ Reserved Concurrency
   ▼
Aurora PostgreSQL
```

ブラウザからはCloudFront経由でアクセスする。

API Gatewayの直接エンドポイントからアクセスされた場合も、
API GatewayのThrottlingおよびAPI LambdaのReserved Concurrencyを適用する。

---

# 4. エンドポイント一覧

| Method | Endpoint                                  | 概要                     |
| ------ | ----------------------------------------- | ------------------------ |
| GET    | `/streams`                                | 配信一覧を取得           |
| GET    | `/streams/{streamId}`                     | 配信情報を取得           |
| GET    | `/streams/{streamId}/metrics`             | 配信メトリクスを取得     |
| GET    | `/streams/{streamId}/timeline`            | コメント推移を取得       |
| GET    | `/streams/{streamId}/length-distribution` | コメント文字数分布を取得 |
| GET    | `/streams/{streamId}/frequent-words`      | 頻出ワードを取得         |

CloudFront経由でブラウザからアクセスする場合は、
各エンドポイントの先頭に`/api`を付与する。

---

# 5. API仕様

## 5.1. 配信一覧取得

### Endpoint

```http
GET /streams
```

ブラウザ：

```http
GET /api/streams
```

### 概要

分析対象となっているYouTube Live配信の一覧を取得する。

### Query Parameters

| Parameter | Type    | Required | Description |
| --------- | ------- | -------- | ----------- |
| `limit`   | integer | No       | 取得件数    |
| `offset`  | integer | No       | オフセット  |

PoCではページングの詳細仕様は実装時に決定する。

### Response

```json
{
  "items": [
    {
      "streamId": "stream-001",
      "videoId": "youtube-video-id",
      "channelId": "channel-001",
      "title": "配信タイトル",
      "startedAt": "2026-08-23T15:00:00Z",
      "endedAt": "2026-08-23T17:00:00Z",
      "url": "https://www.youtube.com/watch?v=..."
    }
  ]
}
```

---

## 5.2. 配信情報取得

### Endpoint

```http
GET /streams/{streamId}
```

ブラウザ：

```http
GET /api/streams/{streamId}
```

### 概要

指定した配信の基本情報を取得する。

### Path Parameters

| Parameter  | Type   | Required | Description |
| ---------- | ------ | -------- | ----------- |
| `streamId` | string | Yes      | Stream ID   |

### Response

```json
{
  "streamId": "stream-001",
  "videoId": "youtube-video-id",
  "channelId": "channel-001",
  "title": "配信タイトル",
  "startedAt": "2026-08-23T15:00:00Z",
  "endedAt": "2026-08-23T17:00:00Z",
  "url": "https://www.youtube.com/watch?v=..."
}
```

---

## 5.3. 配信メトリクス取得

### Endpoint

```http
GET /streams/{streamId}/metrics
```

ブラウザ：

```http
GET /api/streams/{streamId}/metrics
```

### 概要

指定した配信の全体的なコメント分析結果を取得する。

### Response

```json
{
  "streamId": "stream-001",
  "totalComments": 12500,
  "averageCommentLength": 12.8,
  "averageCommentsPerMinute": 104.2,
  "analysisStartAt": "2026-08-23T15:00:20Z",
  "analysisEndAt": "2026-08-23T17:00:00Z",
  "analysisStatus": "COMPLETED"
}
```

### 主な項目

- 総コメント数
- 平均コメント文字数
- 平均コメント速度
- 分析対象開始日時
- 分析基準終了日時
- 分析状態
- その他の配信単位の指標

`averageCommentsPerMinute`は、
`[analysisStartAt, analysisEndAt)`に含まれる総コメント数を同期間の分数で除して算出する。
`analysisStartAt`は配信の実開始日時とコメントの観測開始日時の遅い方であり、
配信開始後に収集を開始した場合は`startedAt`より後になる。
`analysisStartAt`より前は未観測期間であり、コメント0件として扱わない。
配信終了後の確定値では`analysisEndAt`に実終了日時を使用する。
配信中の値は`analysisEndAt`時点の暫定値とする。

`averageCommentLength`は、Raw Dataの元のコメント本文を
Unicode 15.1.0のUnicode Standard Annex #29で定義される
拡張書記素クラスタ単位で数えた文字数の合計を、`totalComments`で除して算出する。
空文字は文字数`0`として分母に含め、`totalComments`が`0`の場合は`0`を返す。
計算途中では丸めず、小数第1位へ四捨五入して返す。

`analysisStatus`はPENDING / FINALIZING / COMPLETED / FAILEDのいずれかを返す。
終了後の確定値として扱えるのはCOMPLETEDの場合だけとする。
収集処理が失敗した場合はFAILEDを返し、収集済み範囲の値が残っていても未確定値として扱う。
FAILEDの場合は未観測区間を0件として補完せず、`analysisEndAt`を`endedAt`へ固定しない。

---

## 5.4. コメントタイムライン取得

### Endpoint

```http
GET /streams/{streamId}/timeline
```

ブラウザ：

```http
GET /api/streams/{streamId}/timeline
```

### 概要

配信中の時間帯別コメント数およびコメント速度を取得する。

### Response

```json
{
  "streamId": "stream-001",
  "unit": "minute",
  "analysisStartAt": "2026-08-23T15:00:20Z",
  "analysisEndAt": "2026-08-23T15:02:00Z",
  "analysisStatus": "PENDING",
  "items": [
    {
      "startAt": "2026-08-23T15:00:20Z",
      "endAt": "2026-08-23T15:01:00Z",
      "commentCount": 120,
      "commentsPerMinute": 180
    },
    {
      "startAt": "2026-08-23T15:01:00Z",
      "endAt": "2026-08-23T15:02:00Z",
      "commentCount": 185,
      "commentsPerMinute": 185
    }
  ]
}
```

タイムラインはUTCの正分を基準とする1分区間で返す。
各項目は開始日時を含み、終了日時を含まない半開区間`[startAt, endAt)`とする。
観測開始を含む最初の区間と`analysisEndAt`直前までの最後の区間は、
配信の分析対象期間と重なる部分だけを返すため、60秒未満になる場合がある。
タイムラインの対象期間は`[analysisStartAt, analysisEndAt)`とし、
`analysisStartAt`より前の区間は返さない。

コメントがない区間も省略せず、`commentCount`と`commentsPerMinute`を`0`として返す。
部分区間の`commentsPerMinute`は、
`commentCount * 60 / (endAt - startAtの秒数)`で1分あたりに換算する。
全体平均およびタイムラインは同じ`analysisStartAt`と`analysisEndAt`を使用する。
`analysisStatus`がCOMPLETEDになるまではタイムラインを暫定値として扱う。
FAILEDの場合は収集済み範囲の部分的なタイムラインであり、確定済み結果として扱わない。
COMPLETEDの場合は、送信済みバッチの分析完了確認と
`analysisStartAt`から終了時刻までの0件区間補完が完了しており、
`analysisEndAt`は`endedAt`と一致する。

---

## 5.5. コメント文字数分布取得

### Endpoint

```http
GET /streams/{streamId}/length-distribution
```

ブラウザ：

```http
GET /api/streams/{streamId}/length-distribution
```

### 概要

指定した配信のコメント文字数分布を取得する。

### Response

```json
{
  "streamId": "stream-001",
  "analysisStartAt": "2026-08-23T15:00:20Z",
  "analysisEndAt": "2026-08-23T17:00:00Z",
  "analysisStatus": "COMPLETED",
  "items": [
    {
      "minLength": 0,
      "maxLength": 0,
      "count": 0
    },
    {
      "minLength": 1,
      "maxLength": 10,
      "count": 1200
    },
    {
      "minLength": 11,
      "maxLength": 20,
      "count": 850
    },
    {
      "minLength": 21,
      "maxLength": 30,
      "count": 420
    },
    {
      "minLength": 31,
      "maxLength": null,
      "count": 180
    }
  ]
}
```

分布区間は`0`、`1 - 10`、`11 - 20`、`21 - 30`、`31以上`の5区間に固定し、
該当コメントが0件の区間も省略せず返す。
`minLength`と`maxLength`はともに境界値を含み、`maxLength = null`は上限なしを表す。

文字数はRaw Dataの元のコメント本文を対象に、Unicode 15.1.0の
Unicode Standard Annex #29で定義される拡張書記素クラスタ単位で算出する。
算出前のUnicode正規化、小文字化、前後空白の除去、改行・URL等の除去は行わない。
空文字は`0`文字として扱う。
`analysisStartAt`、`analysisEndAt`、`analysisStatus`は配信メトリクスおよび
タイムラインと同じ値を返す。COMPLETED以外の分布は暫定値として扱う。

---

## 5.6. 頻出ワード取得

### Endpoint

```http
GET /streams/{streamId}/frequent-words
```

ブラウザ：

```http
GET /api/streams/{streamId}/frequent-words
```

### 概要

指定した配信のコメント内に出現した頻出ワードを取得する。

### Query Parameters

| Parameter | Type    | Required | Description      |
| --------- | ------- | -------- | ---------------- |
| `limit`   | integer | No       | 取得するワード数 |

### Response

```json
{
  "streamId": "stream-001",
  "analysisStartAt": "2026-08-23T15:00:20Z",
  "analysisEndAt": "2026-08-23T17:00:00Z",
  "analysisStatus": "COMPLETED",
  "items": [
    {
      "rank": 1,
      "word": "こんにちは",
      "count": 350
    },
    {
      "rank": 2,
      "word": "かわいい",
      "count": 280
    },
    {
      "rank": 3,
      "word": "おめでとう",
      "count": 210
    }
  ]
}
```

`analysisStartAt`、`analysisEndAt`、`analysisStatus`は配信メトリクスおよび
タイムラインと同じ値を返す。COMPLETED以外の頻出ワードは暫定値として扱う。

---

# 6. HTTPステータスコード

PoCでは以下のステータスコードを使用する。

| Status Code                 | 概要                         |
| --------------------------- | ---------------------------- |
| `200 OK`                    | 正常終了                     |
| `400 Bad Request`           | リクエストパラメータ不正     |
| `404 Not Found`             | 指定したリソースが存在しない |
| `429 Too Many Requests`     | API利用量制限超過            |
| `500 Internal Server Error` | サーバー内部エラー           |

---

# 7. エラーレスポンス

エラー発生時は以下の形式を基本とする。

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Stream not found."
  }
}
```

### エラーコード例

| Code                 | HTTP Status | Description          |
| -------------------- | ----------: | -------------------- |
| `INVALID_REQUEST`    |         400 | リクエスト不正       |
| `RESOURCE_NOT_FOUND` |         404 | リソースが存在しない |
| `TOO_MANY_REQUESTS`  |         429 | API利用量制限超過    |
| `INTERNAL_ERROR`     |         500 | 内部エラー           |

API GatewayのThrottlingによって拒否されたリクエストについては、
API Gatewayが返す429レスポンスを利用する。

---

# 8. APIレスポンス設計方針

## 8.1. 内部ID

APIでは、原則としてStream Insight内部のIDを利用する。

```text
streamId
channelId
```

YouTube API上のIDとは分離して管理する。

---

## 8.2. YouTube固有情報

必要な範囲で以下の情報をレスポンスに含める。

- YouTube Video ID
- YouTube Channel ID
- YouTube URL
- 配信タイトル

---

## 8.3. 個人識別情報

コメント投稿者を直接識別できる情報はAPIレスポンスに含めない。

以下のような情報はPoCでは提供対象外とする。

- コメント投稿者のユーザーID
- ユーザー名
- プロフィール情報
- その他、個人を直接識別できる情報

分析結果として必要な場合は、個人を識別しない集計値として提供する。

---

## 8.4. 配信終了日時

`GET /streams`および`GET /streams/{streamId}`の`endedAt`は、
`streams.endedAt`に保存したYouTubeの実終了日時を返す。
配信中または実終了日時が未取得の場合は`null`を返す。
収集停止時刻を代用せず、`null`だけで配信継続中とは判定しない。

終了メタデータの保存成功後は両APIに実終了日時を反映する。
終了日時の反映は、非同期のコメント分析完了を意味しない。

---

# 9. APIとデータモデルの対応

| API                                           | 主な参照テーブル              |
| --------------------------------------------- | ----------------------------- |
| `GET /streams`                                | `streams`                     |
| `GET /streams/{streamId}`                     | `streams`, `channels`         |
| `GET /streams/{streamId}/metrics`             | `stream_metrics`              |
| `GET /streams/{streamId}/timeline`            | `comment_timeline`            |
| `GET /streams/{streamId}/length-distribution` | `comment_length_distribution` |
| `GET /streams/{streamId}/frequent-words`      | `frequent_words`              |

CloudFront経由でブラウザからアクセスする場合は、
上記パスの先頭に`/api`を付与する。

---

# 10. PoCで対象外とするAPI

以下のAPIはPoCでは実装しない。

## 10.1. コメント関連

```text
POST /comments
```

コメント投稿機能は提供しない。

---

## 10.2. 分析実行

```text
POST /analysis
```

PoCでは分析処理をデータ収集・非同期処理側で実行するため、
外部から分析処理を開始するAPIは提供しない。

---

## 10.3. ユーザー

```text
GET /users
POST /users
```

ユーザーアカウント機能はPoCでは対象外とする。

---

## 10.4. 外部ユーザー向けAPI

PoCのAPI Gatewayは認証なしでインターネットから到達可能だが、
外部ユーザー向けの正式なAPIサービスとしては提供しない。

外部ユーザー向けAPIキー発行、ユーザー認証、課金等はPoCでは対象外とする。

PoCではAPI Gateway Throttling、
API Lambda Reserved Concurrency、
AWS Budgetsによって利用量・バックエンド負荷・コストを制御する。

---

# 11. 将来拡張

PoC完了後、以下のAPI追加を検討する。

- ライバー・チャンネル検索
- 複数配信の比較
- メンバー・非メンバーの分析
- Super Chat分析
- コメントコミュニティ分析
- AI分析結果取得
- コメント傾向分析
- 「読まれたコメント」の推定結果取得
- Twitch等の他プラットフォーム対応
- ユーザーアカウント
- お気に入り配信者
- 通知
- 外部ユーザー向けAPI
- APIキー管理
- API利用量取得
