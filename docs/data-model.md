# Stream Insight - Data Model

## 1. 概要

Stream Insightで扱うデータおよびデータ間の関係を定義する。

PoCでは、YouTube Liveの配信情報、コメント原データ、コメント分析結果を中心にデータモデルを構成する。

大量のコメント原データと、Web UI・APIから利用する分析結果を分離し、それぞれ適したストレージに保存する。

- **S3**：コメント等の原データ
- **Aurora PostgreSQL**：配信情報および分析結果

データモデルは、将来的な配信者・配信数の増加、複数配信プラットフォームへの対応、高度なコメント分析を考慮して設計する。

---

## 2. データ分類

Stream Insightでは、データを以下の2種類に分類する。

| データ分類                  | 保存先            | 概要                                    | 主な用途           |
| --------------------------- | ----------------- | --------------------------------------- | ------------------ |
| Raw Data                    | S3                | YouTubeから取得したコメント等の原データ | 再分析・データ保持 |
| Application / Analysis Data | Aurora PostgreSQL | 配信情報・分析結果等                    | API・Web UI        |

---

## 3. Raw Data

### 3.1. 概要

YouTube Liveから取得したコメント等の原データをS3に保存する。

大量のコメントデータをAurora PostgreSQLに保存せず、オブジェクトストレージであるS3に保存することで、データ量増加に伴うデータベースコストを抑制する。

---

### 3.2. 保存対象

PoCでは主に以下のデータを保存する。

- コメントID
- 配信ID
- コメント本文
- コメント投稿日時
- 分析に必要なコメント属性
- メンバーシップに関する情報
- Super Chat等に関する情報
- その他、YouTube APIから取得した分析に必要な情報

個人を直接識別できる情報については、原則としてAurora PostgreSQLには保存しない。

APIから取得した個人を識別可能な情報が分析処理に必要な場合は、分析処理に必要な範囲で一時的に利用し、Raw Dataの保持期間内に削除する。

実際に保存する項目は、YouTube APIの利用規約・ポリシーを確認したうえで決定する。

---

### 3.3. 保存形式

PoCではJSON Lines（JSONL）形式を基本とする。

例：

```json
{"commentId":"001","streamId":"stream-001","text":"こんにちは","publishedAt":"2026-08-23T15:00:00Z"}
{"commentId":"002","streamId":"stream-001","text":"今日も楽しみ","publishedAt":"2026-08-23T15:00:05Z"}
{"commentId":"003","streamId":"stream-001","text":"きた！","publishedAt":"2026-08-23T15:00:08Z"}
```

将来的に大量データの分析効率を高める必要が生じた場合は、Parquet等の列指向フォーマットへの変更を検討する。

---

### 3.4. S3オブジェクト構成

PoCでは以下のような構成を想定する。

```text
s3://<bucket>/
└── raw/
    └── youtube/
        └── streams/
            └── <stream-id>/
                ├── comments-001.jsonl
                ├── comments-002.jsonl
                └── ...
```

実際のバケット名・パス構成はインフラ実装時に決定する。

---

## 4. Application / Analysis Data

Aurora PostgreSQLには、Web UIおよびAPIから利用するアプリケーションデータ・分析結果を保存する。

### 4.1. Channel

YouTube上の配信者・チャンネルを表す。

主な情報：

- 内部ID
- YouTube Channel ID
- チャンネル名
- チャンネルURL
- 作成日時
- 更新日時

---

### 4.2. Stream

YouTube Liveの配信を表す。

主な情報：

- 内部ID
- YouTube Video ID
- YouTube Live Chat ID
- Channel ID
- 配信タイトル
- 配信開始日時
- 配信終了日時
- 配信URL
- 作成日時
- 更新日時

---

### 4.3. Stream Metrics

配信単位の分析結果を表す。

主な情報：

- Stream ID
- 総コメント数
- 平均コメント文字数
- コメント速度
- その他の配信単位の指標

---

### 4.4. Comment Timeline

時間帯別のコメント集計結果を表す。

主な情報：

- Stream ID
- 集計開始日時
- 集計終了日時
- コメント数
- コメント速度

集計単位は実装時に決定する。

例：

```text
Stream
  ↓
1分単位
  ↓
Comment Timeline

15:00 - 15:01 → 120 comments
15:01 - 15:02 → 185 comments
15:02 - 15:03 → 210 comments
```

---

### 4.5. Comment Length Distribution

コメント文字数の分布を表す。

主な情報：

- Stream ID
- 文字数範囲
- コメント数

例：

```text
1 - 10文字    → 1,200件
11 - 20文字   → 850件
21 - 30文字   → 420件
31文字以上    → 180件
```

---

### 4.6. Frequent Words

コメント内に出現した頻出ワードを表す。

主な情報：

- Stream ID
- Word
- Count
- Rank

例：

```text
Stream
  ↓
Frequent Words

1. こんにちは → 350
2. かわいい   → 280
3. おめでとう → 210
```

---

### 4.7. Collection Job

YouTubeからのデータ収集処理を管理するための情報を表す。

主な情報：

- Stream ID
- 収集開始日時
- 収集終了日時
- 収集状態
- 最終取得位置
- 取得件数
- エラー情報

収集処理の再実行や障害発生時の調査に利用する。

---

## 5. エンティティ間の関係

```text
Channel
   │
   └──< Stream
           │
           ├──< Stream Metrics
           │
           ├──< Comment Timeline
           │
           ├──< Comment Length Distribution
           │
           ├──< Frequent Words
           │
           └──< Collection Job
```

コメント原データについてはAuroraには保存せず、S3上のRaw Dataとして管理する。

```text
Stream
   │
   └──────> S3 Raw Comments
```

---

## 6. データフロー

### 6.1. Raw Data

```text
YouTube Data API
 ↓
Data Collector Lambda
 ↓
SQS
 ↓
Analyzer Lambda
 ↓
S3
```

YouTubeから取得したコメントデータをS3へ原データとして保存する。

---

### 6.2. Analysis Data

```text
SQS
 ↓
Analyzer Lambda
 ↓
分析処理
 ↓
Aurora PostgreSQL
```

Analyzer Lambdaはコメントデータを分析し、Web UIおよびAPIから利用する分析結果をAurora PostgreSQLへ保存する。

---

## 7. SQSメッセージ

Data Collector LambdaからAnalyzer Lambdaへコメントデータを受け渡すため、SQSを利用する。

PoCでは、複数のコメントを1メッセージにまとめる方式を基本とする。

例：

```json
{
  "streamId": "stream-001",
  "comments": [
    {
      "commentId": "comment-001",
      "text": "こんにちは",
      "publishedAt": "2026-08-23T15:00:00Z"
    },
    {
      "commentId": "comment-002",
      "text": "今日も楽しみ",
      "publishedAt": "2026-08-23T15:00:05Z"
    }
  ]
}
```

SQSのメッセージサイズやコメント量に応じて、1メッセージあたりのコメント数は実装時に調整する。

---

## 8. データベース

PoCではAurora Serverless v2 PostgreSQLを使用する。

想定テーブル：

```text
channels
    │
    └── streams
           │
           ├── stream_metrics
           │
           ├── comment_timeline
           │
           ├── comment_length_distribution
           │
           ├── frequent_words
           │
           └── collection_jobs
```

コメント原データはAuroraではなくS3に保存する。

---

## 9. データベース設計方針

### 9.1. 主キー

各エンティティに内部IDを付与する。

YouTube API上のIDは外部IDとして保持する。

---

### 9.2. 外部ID

YouTube上の以下のIDを保持する。

- Channel ID
- Video ID
- Live Chat ID
- Comment ID

外部IDは重複登録を防止するため、必要に応じて一意制約を設定する。

コメントIDについては、原則としてS3上のRaw Dataで管理する。

---

### 9.3. 時刻

日時データはUTCで保持する。

Web UIで表示する際に利用者のタイムゾーンへ変換する。

---

### 9.4. Raw DataとAnalysis Dataの分離

Raw DataとAnalysis Dataを分離する。

```text
Raw Data
 ↓
S3
 ↓
大量データの保存・再分析

Analysis Data
 ↓
Aurora PostgreSQL
 ↓
API・Web UIからの高速な参照
```

これにより、以下を実現する。

- 大量のコメントデータを低コストで保存
- APIから分析結果を高速に取得
- 将来的な再分析への対応
- Auroraのデータ量増加を抑制

---

## 10. データ保持方針

### 10.1. Raw Data

YouTube APIから取得した未承認データについては、YouTube API Services Developer Policiesの保存期間に関する要件を考慮し、Stream Insightでは7暦日を超えて保存しない。

S3 Lifecycleを利用し、保存開始から7暦日を経過したRaw Dataを自動削除する。

※ YouTube API Services Developer Policiesでは、対象となるデータについて最長30暦日の保存期間が定められている。
Stream Insightでは安全性を考慮し、独自に7暦日を保存上限とする。

長期保存が必要な分析結果については、当該データがYouTube APIデータの保存制限の対象となるかを確認したうえで、保存可否および保存期間を決定する。

---

### 10.2. Analysis Data

分析結果はWeb UIでの表示および将来的な比較分析に利用するため、可能な限り再利用可能な形式でAurora PostgreSQLへ保存する。

---

### 10.3. Collection Data

データ収集処理の状態を管理するために保存する。

収集処理の再実行や障害発生時の調査に利用する。

---

## 11. PoCで扱わないデータ

以下はPoCでは対象外とする。

- ユーザーアカウント情報
- 課金情報
- 広告情報
- 外部API利用者情報
- コメント投稿者の氏名・ユーザー名等の個人識別情報
- コメント投稿者を直接識別するためのID
- コメント投稿者の詳細なプロフィール情報

---

## 12. 将来拡張

将来的に以下のデータモデル拡張を検討する。

- 配信プラットフォーム
- 配信者
- メンバーシップ情報
- Super Chat情報
- コメントの感情分析結果
- コメントカテゴリ
- AI分析結果
- コメントが読まれた可能性を示す情報
- 配信間比較用の集計データ
- API利用者情報

大量のRaw DataをS3に蓄積することで、将来的にAthena等を利用した大規模な再分析も可能とする。
