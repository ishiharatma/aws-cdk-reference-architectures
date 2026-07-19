# SQS Test Message Sender & S3 File Checker

SQSキューにテストメッセージを送信し、S3のファイルを確認するためのスクリプト集です。

## 概要

このディレクトリには、SQS→Lambda→S3連携のテストを行うためのスクリプトが含まれています：

### SQSメッセージ送信
- **send-sqs-messages.py**: Pythonスクリプト（boto3使用）
- **send-messages.sh**: Shellラッパースクリプト
- **quick-test.sh**: クイックテストスクリプト（5件送信）

### S3ファイル確認
- **check-s3-files.py**: S3ファイル存在確認Pythonスクリプト
- **check-s3.sh**: Shellラッパースクリプト

## 特徴

- ✅ 実行ごとにユニークなメッセージを生成（UUID、タイムスタンプ使用）
- ✅ バッチ送信対応（最大10件/バッチ）
- ✅ FIFO/標準キュー両対応
- ✅ AWS プロファイル切り替え対応
- ✅ 送信数をパラメータで制御可能
- ✅ CloudFormationスタックからキューURL自動取得

## 必要要件

### Python環境

```bash
# Python 3.6以上
python3 --version

# boto3のインストール
pip install boto3
```

### AWS認証情報

AWS認証情報が設定されている必要があります：

```bash
# デフォルトプロファイルを使用
aws configure

# または名前付きプロファイルを使用
aws configure --profile dev
```

## 使用方法

### 方法1: Shellスクリプト（推奨）

#### 基本的な使い方

```bash
# 開発環境に10件送信
./send-messages.sh --env dev --count 10

# 本番環境に50件送信（プロファイル指定）
./send-messages.sh --env prd --count 50 --profile production

# FIFOキューに20件送信
./send-messages.sh --env dev --fifo --count 20 --message-group my-group
```

#### キューURLを直接指定

```bash
# キューURLを指定して送信
./send-messages.sh \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue \
  --count 10 \
  --profile dev

# リージョンも指定
./send-messages.sh \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/my-queue \
  --count 10 \
  --region us-east-1
```

#### オプション一覧

```
OPTIONS:
    -h, --help              ヘルプを表示
    -e, --env ENV           環境 (dev, stg, prd)
    -q, --queue-url URL     SQSキューURL
    -c, --count N           送信メッセージ数 (デフォルト: 10)
    -p, --profile PROFILE   AWSプロファイル名
    -r, --region REGION     AWSリージョン
    -f, --fifo              FIFOキュー
    -g, --message-group ID  メッセージグループID (FIFO用)
    --no-batch              バッチ送信を無効化
```

### 方法2: Pythonスクリプト直接実行

```bash
# 基本的な使い方
python3 send-sqs-messages.py \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue \
  --count 10

# プロファイル指定
python3 send-sqs-messages.py \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue \
  --count 50 \
  --profile dev

# FIFOキュー
python3 send-sqs-messages.py \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue.fifo \
  --count 20 \
  --fifo \
  --message-group my-group

# バッチ送信を無効化（1件ずつ送信）
python3 send-sqs-messages.py \
  --queue-url https://sqs.ap-northeast-1.amazonaws.com/123456789012/my-queue \
  --count 10 \
  --no-batch
```

## メッセージフォーマット

生成されるメッセージは以下の構造を持ちます：

```json
{
  "messageId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-01-22T12:34:56.789012+00:00",
  "sequenceNumber": 1,
  "data": {
    "product": "Laptop",
    "category": "Electronics",
    "quantity": 42,
    "price": 999.99,
    "total": 41999.58,
    "status": "pending",
    "region": "ap-northeast-1"
  },
  "metadata": {
    "source": "test-script",
    "version": "1.0",
    "environment": "test"
  }
}
```

### メッセージの多様性

各実行で以下の要素がランダムに生成されます：

- **messageId**: UUID v4（毎回ユニーク）
- **timestamp**: 実行時のISO 8601形式タイムスタンプ
- **sequenceNumber**: メッセージのシーケンス番号
- **product**: ランダムな製品名（10種類）
- **category**: ランダムなカテゴリ（5種類）
- **quantity**: 1〜100のランダムな数量
- **price**: 10.00〜1000.00のランダムな価格
- **status**: ランダムなステータス（5種類）
- **region**: ランダムなAWSリージョン（5種類）

## 実行例

### 例1: 開発環境で10件テスト

```bash
$ ./send-messages.sh --env dev --count 10

===================================================
  SQS Test Message Sender
===================================================

✓ Connected to SQS using profile: default

============================================================
Starting to send 10 messages to SQS queue
Queue URL: https://sqs.ap-northeast-1.amazonaws.com/123456789012/dev-sqs-lambda-queue
Queue Type: Standard
============================================================

Generating 10 unique messages...
✓ Generated 10 messages

Sending messages in batches...

✓ Successfully sent: 10 messages

Completed in 0.52 seconds
Average: 0.052 seconds per message

===================================================
  Successfully completed!
===================================================
```

### 例2: FIFOキューで20件テスト

```bash
$ ./send-messages.sh --env prd --fifo --count 20 --message-group test-group --profile production

===================================================
  SQS Test Message Sender
===================================================

✓ Connected to SQS using profile: production

============================================================
Starting to send 20 messages to SQS queue
Queue URL: https://sqs.ap-northeast-1.amazonaws.com/123456789012/prd-sqs-lambda-queue.fifo
Queue Type: FIFO
Message Group ID: test-group
============================================================

Generating 20 unique messages...
✓ Generated 20 messages

Sending messages in batches...

✓ Successfully sent: 20 messages

Completed in 0.89 seconds
Average: 0.045 seconds per message

===================================================
  Successfully completed!
===================================================
```

## トラブルシューティング

### boto3が見つからない

```bash
pip install boto3
# または
pip3 install boto3
```

### 認証情報エラー

```bash
# デフォルトプロファイルを確認
aws configure list

# プロファイルを確認
aws configure list --profile dev

# 認証情報を設定
aws configure --profile dev
```

### キューURLが見つからない

```bash
# CloudFormationスタック確認
aws cloudformation describe-stacks --stack-name sqs-lambda-firehose-dev

# 出力値を確認
aws cloudformation describe-stacks \
  --stack-name sqs-lambda-firehose-dev \
  --query 'Stacks[0].Outputs'
```

### 権限エラー

Lambda関数実行用のIAMロールではなく、自分のユーザー/ロールに以下の権限が必要です：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueUrl"
      ],
      "Resource": "arn:aws:sqs:*:*:*"
    }
  ]
}
```

## Lambda関数での処理例

送信されたメッセージをLambda関数で処理する例：

```python
import json

def lambda_handler(event, context):
    """SQSメッセージを処理"""
    batch_item_failures = []
    
    for record in event['Records']:
        try:
            # メッセージボディをパース
            message = json.loads(record['body'])
            
            # メッセージ処理
            print(f"Processing message: {message['messageId']}")
            print(f"Product: {message['data']['product']}")
            print(f"Quantity: {message['data']['quantity']}")
            print(f"Total: {message['data']['total']}")
            
            # ここにビジネスロジックを実装
            
        except Exception as e:
            print(f"Error processing message: {e}")
            # 失敗したメッセージをリストに追加
            batch_item_failures.append({
                "itemIdentifier": record['messageId']
            })
    
    # 部分バッチレスポンスを返す
    return {
        "batchItemFailures": batch_item_failures
    }
```

## パフォーマンス

- **バッチ送信**: 約0.05秒/メッセージ（推奨）
- **個別送信**: 約0.1-0.2秒/メッセージ
- **推奨**: 10件以上の送信にはバッチモードを使用

## 注意事項

1. **料金**: SQSへのメッセージ送信には料金が発生します
2. **制限**: 大量のメッセージ（1000件以上）を送信する場合は確認プロンプトが表示されます
3. **FIFO**: FIFOキューでは必ずメッセージグループIDが必要です（指定しない場合は`default-group`が使用されます）
4. **重複排除**: FIFOキューでは自動的にmessageIdが重複排除IDとして使用されます

---

## S3ファイル確認スクリプト

### 概要

Lambda関数がSQSメッセージを処理してS3に保存したファイルの存在を確認するスクリプトです。

### 使用方法

#### 方法1: Shellスクリプト（推奨）

```bash
# 環境指定でバケット名を自動取得
./check-s3.sh --env dev

# 特定のファイルを確認
./check-s3.sh --env dev --key output/data.json

# プレフィックスでファイル一覧
./check-s3.sh --env dev --prefix output/ --list

# パターンマッチング
./check-s3.sh --env dev --prefix output/ --pattern "*.json" --list
```

#### 方法2: Pythonスクリプト直接実行

```bash
# バケット内のファイル一覧（最大10件）
python3 check-s3-files.py --bucket my-bucket --list

# プレフィックス指定で一覧（最大100件）
python3 check-s3-files.py --bucket my-bucket --prefix output/ --list --max-keys 100

# 特定ファイルの存在確認
python3 check-s3-files.py --bucket my-bucket --key output/2024/01/data.json

# パターンマッチング
python3 check-s3-files.py --bucket my-bucket --prefix output/ --pattern "*.json" --list
```

### オプション

#### 共通オプション

| オプション | 説明 | デフォルト |
|----------|------|-----------|
| `--bucket` | S3バケット名 | - |
| `--key` | 確認する特定ファイルのキー | - |
| `--prefix` | ファイル検索のプレフィックス | - |
| `--pattern` | ファイル名のパターン（例: *.json） | - |
| `--list` | ファイル一覧を表示 | false |
| `--max-keys` | 一覧表示の最大件数 | 10 |
| `--profile` | AWSプロファイル名 | default |
| `--region` | AWSリージョン | ap-northeast-1 |

#### Shellスクリプト専用オプション

| オプション | 説明 | デフォルト |
|----------|------|-----------|
| `--env` | 環境名（dev/prd）、スタックからバケット名取得 | - |

### 実行例

#### 例1: 特定ファイルの確認

```bash
$ ./check-s3.sh --env dev --key output/data.json

===================================================
  S3 File Existence Checker
===================================================

✓ Checking file in bucket: dev-sqs-lambda-bucket
✓ File key: output/data.json

✓ File exists!

File Details:
  Size: 1.2 KB
  Last Modified: 2024-01-15 10:30:45+00:00
  ETag: "abc123def456"
  Content-Type: application/json

===================================================
```

#### 例2: プレフィックスでファイル一覧

```bash
$ ./check-s3.sh --env dev --prefix output/ --list --max-keys 5

===================================================
  S3 File Existence Checker
===================================================

✓ Listing files in bucket: dev-sqs-lambda-bucket
✓ Prefix: output/

Found 5 files:

1. output/2024/01/15/data-001.json
   Size: 1.2 KB
   Last Modified: 2024-01-15 10:30:45+00:00

2. output/2024/01/15/data-002.json
   Size: 1.5 KB
   Last Modified: 2024-01-15 10:31:02+00:00

3. output/2024/01/15/data-003.json
   Size: 980 B
   Last Modified: 2024-01-15 10:31:15+00:00

===================================================
  Total: 5 files (3.7 KB)
===================================================
```

#### 例3: パターンマッチング

```bash
$ python3 check-s3-files.py --bucket my-bucket --prefix logs/ --pattern "error-*.log" --list

Found 3 files matching pattern 'error-*.log':

1. logs/error-2024-01-15.log
   Size: 45.3 KB
   Last Modified: 2024-01-15 10:30:00+00:00

2. logs/error-2024-01-14.log
   Size: 32.1 KB
   Last Modified: 2024-01-14 10:30:00+00:00

Total: 2 files (77.4 KB)
```

### 戻り値

- **0**: ファイルが存在する、または一覧表示成功
- **1**: ファイルが存在しない、またはエラー

### ユースケース

1. **Lambda処理後の確認**: SQSメッセージをLambdaが処理してS3に保存したファイルを確認
2. **バッチ処理の確認**: 特定の日時範囲でファイルが正しく作成されているか確認
3. **エラーログ確認**: エラーログファイルの存在確認とサイズ確認
4. **データパイプライン監視**: データフローの各ステージでファイル生成を確認

---

## 統合テストワークフロー

SQSメッセージ送信からS3ファイル確認までの一連のテストフローです。

```bash
# 1. テストメッセージを送信
./send-messages.sh --env dev --count 10

# 2. Lambdaの処理を待つ（数秒）
sleep 5

# 3. S3にファイルが作成されたか確認
./check-s3.sh --env dev --prefix output/ --list

# 4. 特定のファイルを確認
./check-s3.sh --env dev --key output/2024/01/15/data.json
```

## 関連リンク

### SQS関連
- [Amazon SQS - AWS Documentation](https://docs.aws.amazon.com/sqs/)
- [boto3 SQS Documentation](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/sqs.html)
- [AWS Lambda with SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)

### S3関連
- [Amazon S3 - AWS Documentation](https://docs.aws.amazon.com/s3/)
- [boto3 S3 Documentation](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/s3.html)
