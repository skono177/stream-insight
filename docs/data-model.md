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

PoCでは、要件として定義した分析指標の算出に必要なデータのみを収集・保存する。

将来拡張用のデータを先行して収集・保存することは行わない。

---

### 3.2. 保存対象

PoCでは以下のデータを保存対象とする。

- コメントID
- 配信ID
- コメント本文
- コメント投稿日時
- コメント集計・分析に必要な最小限の属性

保存対象は、以下のPoC分析指標の算出に必要なデータに限定する。

- 総コメント数
- 時間帯別コメント数
- コメント速度
- 平均コメント文字数
- コメント文字数分布
- 頻出ワード

PoCでは以下の情報は収集・保存対象としない。

- メンバーシップに関する情報
- メンバー・非メンバーを識別するための情報
- Super Chatに関する情報
- コメント投稿者の氏名・ユーザー名
- コメント投稿者を直接識別するためのID
- コメント投稿者のプロフィール情報
- その他、PoCの分析指標に不要な情報

メンバー・非メンバーの傾向分析およびSuper Chat分析は将来拡張として扱い、
実装する段階で利用目的、取得項目、保持期間、アクセス制御等を改めて設計する。

YouTube APIのレスポンスにPoCで利用しない情報が含まれる場合も、
Raw Dataへレスポンス全体をそのまま保存せず、
PoCの分析に必要な項目のみを抽出して保存する。

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

PoCでは`batchId`を利用して以下のような構成とする。

```text
s3://<bucket>/
└── raw/
    └── youtube/
        └── streams/
            └── <stream-id>/
                └── batches/
                    ├── <batch-id-1>.jsonl
                    ├── <batch-id-2>.jsonl
                    └── ...
```

S3オブジェクトキーを`batchId`から決定することで、
同じSQSメッセージが再処理された場合でも同一オブジェクトへ保存し、
重複したRaw Dataオブジェクトの生成を防止する。

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

頻出ワードは、コメント本文をそのまま文字列単位で集計するのではなく、
形態素解析によってトークン化したうえで集計する。

頻出ワード算出の詳細は「9.6. 頻出ワード算出仕様」に定義する。

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

### 4.8. Processed Comment Batch

SQSメッセージの重複配信による分析結果の二重更新を防止するため、
処理済みのコメントバッチを管理する。

主な情報：

- Batch ID
- Stream ID
- 処理日時

`batchId`には一意制約を設定する。

Analyzer Lambdaは分析結果を更新する際、
分析結果の更新とProcessed Comment Batchの登録を
同一のAuroraトランザクション内で実行する。

既に同じ`batchId`が登録されている場合は、
そのコメントバッチを処理済みと判断し、
分析結果を再更新しない。

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
           ├──< Collection Job
           │
           └──< Processed Comment Batch
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
必要項目のみ抽出
 ↓
SQS
 ↓
Analyzer Lambda
 ↓
S3
```

Data Collector Lambdaでは、
YouTube APIから取得したレスポンス全体を後続処理へ渡すのではなく、
PoCの分析に必要なコメントデータのみを抽出する。

S3には抽出済みのコメント原データを保存する。

S3オブジェクトキーには`batchId`を利用し、
同じコメントバッチが再処理された場合も同一オブジェクトへ保存する。

---

### 6.2. Analysis Data

```text
SQS
 ↓
Analyzer Lambda
 ↓
batchId確認
 ↓
分析処理
 ↓
Aurora PostgreSQL
```

Analyzer Lambdaはコメントデータを分析し、
Web UIおよびAPIから利用する分析結果をAurora PostgreSQLへ保存する。

分析結果の更新と`processed_comment_batches`への`batchId`登録は
同一のAuroraトランザクションで実行する。

---

## 7. SQSメッセージ

Data Collector LambdaからAnalyzer Lambdaへコメントデータを受け渡すため、SQSを利用する。

PoCでは、複数のコメントを1メッセージにまとめる方式を基本とする。

各メッセージにはコメントバッチを一意に識別する`batchId`を含める。

例：

```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "streamId": "stream-001",
  "videoId": "youtube-video-id",
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

PoCではSQSメッセージについても、
分析に必要な項目のみを含める。

メンバーシップ情報、Super Chat情報、投稿者情報等の
PoCで利用しないデータはSQSメッセージへ含めない。

`batchId`はData Collector Lambdaでコメントバッチを生成する際に一度だけ生成し、
Analyzer Lambdaでは再生成しない。

SQSの再配信時にも同じ`batchId`を利用することで、
Analyzer Lambdaが処理済みメッセージを判定できるようにする。

SQSのメッセージサイズやコメント量に応じて、
1メッセージあたりのコメント数は実装時に調整する。

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
           ├── comment_timeline
           ├── comment_length_distribution
           ├── frequent_words
           ├── collection_jobs
           └── processed_comment_batches
```

コメント原データはAuroraではなくS3に保存する。

`processed_comment_batches`はRaw Dataそのものではなく、
SQSメッセージの冪等処理を実現するための処理管理情報として保存する。

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

### 9.5. 冪等性

Standard SQSでは同一メッセージが複数回配信される可能性があるため、
コメントバッチ単位で`batchId`を付与する。

Analyzer Lambdaでは`processed_comment_batches`を利用して
処理済み`batchId`を判定する。

分析結果の更新と処理済み`batchId`の登録は
同一のAuroraトランザクションで実行する。

S3については`batchId`から決定されるオブジェクトキーを使用し、
再処理時にも同じオブジェクトへ保存する。

---

### 9.6. 頻出ワード算出仕様

PoCでは日本語コメントを含むコメント本文から頻出ワードを算出する。

日本語は空白による単語分割を前提とできないため、
形態素解析を利用してコメントを単語単位へ分割する。

#### 9.6.1. 形態素解析

PoCでは以下を利用する。

```text
Tokenizer: SudachiPy
Dictionary: SudachiDict Core
Split Mode: C
```

SudachiPyおよびSudachiDict Coreのバージョンは、
実装時に利用するバージョンを依存関係ファイルで固定する。

同じRaw Dataを再分析した場合に結果を再現できるよう、
ライブラリまたは辞書を更新する場合はバージョン変更として管理する。

#### 9.6.2. 正規化

形態素解析前にコメント本文を以下の順序で正規化する。

```text
Original Comment
       ↓
Unicode NFKC正規化
       ↓
英字を小文字化
       ↓
URL除去
       ↓
形態素解析
```

Unicode正規化にはNFKCを使用する。

これにより、全角・半角等の表記差による集計の分散を抑制する。

例：

```text
ＡＢＣ
 ↓
abc
```

英字については小文字へ統一する。

```text
YouTube
YOUTUBE
youtube
 ↓
youtube
```

#### 9.6.3. 集計対象品詞

PoCでは、コメントの意味を表す主要な単語を対象とするため、
以下の品詞を頻出ワード集計対象とする。

```text
名詞
動詞
形容詞
```

助詞、助動詞、接続詞等は集計対象外とする。

動詞・形容詞等については、
表層形ではなくSudachiPyから取得できる正規化形を利用して集計する。

これにより活用形の違いによる集計の分散を抑制する。

例：

```text
楽しい
楽しかった
 ↓
楽しい
```

#### 9.6.4. 除外対象

以下は頻出ワード集計から除外する。

- URL
- 空白
- 改行
- 記号のみのトークン
- 絵文字のみのトークン
- stop word
- 空文字

URLについては形態素解析前に除去する。

絵文字および記号については、
PoCでは頻出ワードの対象外とする。

将来的に絵文字やリアクション自体を分析対象とする場合は、
頻出ワードとは別の分析指標として扱う。

#### 9.6.5. Stop Word

一般的に高頻度で出現するものの、
PoCのコメント傾向分析に有用性が低い単語については
stop wordとして除外する。

stop wordはリポジトリ内の固定ファイルとして管理する。

想定：

```text
analysis/
└── resources/
    └── stopwords-ja.txt
```

例：

```text
する
ある
いる
なる
これ
それ
あれ
ここ
そこ
```

stop wordの追加・削除はソースコード変更と同様に
Gitによってバージョン管理する。

外部サービスから実行時にstop wordを取得する方式は使用しない。

#### 9.6.6. 集計

正規化および除外処理後の単語について、
Stream単位で出現回数を集計する。

同じコメント内に同じ単語が複数回出現した場合も、
出現した回数分をカウントする。

例：

```text
かわいい かわいい かわいい
```

の場合：

```text
かわいい → 3
```

として扱う。

集計結果は`frequent_words`へ保存する。

```text
Stream ID
Word
Count
Rank
```

#### 9.6.7. Rank

頻出ワードの順位は以下の順序で決定する。

```text
1. Count DESC
2. Word ASC
```

出現回数が多い単語を上位とする。

Countが同数の場合は、
Wordの昇順によって順位を一意に決定する。

これにより同じ分析結果に対して常に同じ順位を生成できる。

#### 9.6.8. 処理フロー

頻出ワード分析の概念的な処理フローは以下とする。

```text
Comment
   ↓
NFKC正規化
   ↓
英字小文字化
   ↓
URL除去
   ↓
SudachiPy
   ↓
形態素解析
   ↓
名詞 / 動詞 / 形容詞抽出
   ↓
正規化形取得
   ↓
記号 / 絵文字 / Stop Word除外
   ↓
Word Count
   ↓
Count DESC / Word ASC
   ↓
Rank
   ↓
frequent_words
```

この処理仕様をAnalyzer Lambdaで共通して利用し、
実装者やLambda実行ごとに異なる方法で頻出ワードを算出しない。

---

## 10. データ保持方針

### 10.1. Raw Data

YouTube APIから取得した未承認データについては、
YouTube API Services Developer Policiesの保存期間に関する要件を考慮し、
Stream Insightでは7暦日を超えて保存しない。

S3 Lifecycleを利用し、
保存開始から7暦日を経過したRaw Dataを自動削除する。

※ YouTube API Services Developer Policiesでは、
対象となるデータについて最長30暦日の保存期間が定められている。
Stream Insightでは安全性を考慮し、独自に7暦日を保存上限とする。

長期保存が必要な分析結果については、
当該データがYouTube APIデータの保存制限の対象となるかを確認したうえで、
保存可否および保存期間を決定する。

---

### 10.2. Analysis Data

分析結果はWeb UIでの表示および将来的な比較分析に利用するため、
可能な限り再利用可能な形式でAurora PostgreSQLへ保存する。

---

### 10.3. Collection Data

データ収集処理の状態を管理するために保存する。

収集処理の再実行や障害発生時の調査に利用する。

`processed_comment_batches`についても、
SQSメッセージの重複処理を防止するための処理管理情報として保存する。

---

## 11. PoCで扱わないデータ

以下はPoCでは対象外とし、収集・保存しない。

- ユーザーアカウント情報
- 課金情報
- 広告情報
- 外部API利用者情報
- メンバーシップ情報
- メンバー・非メンバーを識別するための情報
- Super Chat情報
- コメント投稿者の氏名・ユーザー名等の個人識別情報
- コメント投稿者を直接識別するためのID
- コメント投稿者の詳細なプロフィール情報

YouTube APIレスポンスにこれらの情報が含まれる場合も、
PoCのRaw DataやSQSメッセージには含めない。

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

メンバーシップ情報やSuper Chat情報を将来取得する場合は、
機能要件へ追加したうえで、
利用目的、取得項目、保持期間、アクセス制御および
YouTube APIの利用規約・ポリシーへの適合性を確認してから設計・実装する。

大量のRaw DataをS3に蓄積することで、
将来的にAthena等を利用した大規模な再分析も可能とする。
