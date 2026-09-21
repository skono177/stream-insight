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

---

## 3. API構成

```text
Browser
   ↓
CloudFront
   │
   │ /api/*
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
  "averageCommentsPerMinute": 104.2
}
```

### 主な項目

- 総コメント数
- 平均コメント文字数
- 平均コメント速度
- その他の配信単位の指標

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
  "items": [
    {
      "startAt": "2026-08-23T15:00:00Z",
      "endAt": "2026-08-23T15:01:00Z",
      "commentCount": 120,
      "commentsPerMinute": 120
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
  "items": [
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
