# FIS カオスエンジニアリング — アーキテクチャ B: CloudFront + API Gateway HTTP API + Lambda + DynamoDB

*他の言語で読む:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level](https://img.shields.io/badge/Level-300-blue?style=flat-square)
![Services](https://img.shields.io/badge/Services-FIS%20%7C%20CloudFront%20%7C%20API%20Gateway%20%7C%20Lambda%20%7C%20DynamoDB-orange?style=flat-square)

## はじめに

**サーバーレス Web API** アーキテクチャに対する AWS Fault Injection Service (FIS) カオスエンジニアリングのリファレンス実装です。1 つの CloudFront ディストリビューションが全トラフィックを API Gateway HTTP API 経由で Python Lambda 関数へルーティングし、その関数が DynamoDB テーブルを読み書きします。

4 つの FIS 実験テンプレートは `aws:lambda:function` アクションを使って **Lambda の呼び出しに対して**障害を注入します。これらのアクションは AWS FIS Lambda 拡張（レイヤーとして関数にアタッチ）を必要とし、**関数コードは一切変更しません**。

| シナリオ | 注入する障害 | 時間 | 検証内容 |
| -------- | ------------ | ---- | -------- |
| **B-1** 呼び出しエラー（完全停止） | `aws:lambda:invocation-error`、`preventExecution=true`、100% | 5 分 | 全リクエストが**ハンドラを実行せず** 500 で失敗。API の 500 伝播、CloudFront のエラー処理、完全停止時のクライアントリトライ挙動 |
| **B-2** 呼び出しレイテンシ | `aws:lambda:invocation-add-delay`、`+10 秒`、100% | 5 分 | 全呼び出しの開始時に固定 10 秒の遅延を付与（関数 29 秒 / API GW 30 秒のタイムアウト内）。タイムアウト予算、クライアントのデッドライン、レイテンシアラーム |
| **B-3** 部分的な呼び出しエラー | `aws:lambda:invocation-error`、`preventExecution=false`、50% | 5 分 | 半分の呼び出しがハンドラ**実行後**に失敗するため、副作用は既に発生している可能性がある。冪等性、部分障害処理、リトライ増幅 |
| **B-4** HTTP 統合レスポンスの上書き | `aws:lambda:invocation-http-integration-response`、`statusCode=500` | 5 分 | ハンドラを実行せず、API Gateway に合成された 500 `application/json` レスポンスを返す。「整形されているが失敗している」上流に対する API GW → CloudFront のエラーページ挙動 |

全実験は共通の CloudWatch アラーム停止条件を持ち、Lambda エラー数が **1 分あたり 100** を超えると実験を自動停止します。この閾値は実験が生成する負荷よりも十分高く設定してあり、注入した障害そのものではなく、暴走したブラスト半径を検知するためのものです。

> ### ⚠️ なぜ DynamoDB 障害を直接注入しないのか？
> 以前のバージョンでは `aws:fis:inject-api-internal-error` / `aws:fis:inject-api-throttle-error` を `service: dynamodb` で使い、さらに架空の `aws:lambda:put-function-concurrent-executions` アクションを使っていました。**どちらもデプロイ時に失敗します。** `aws:fis:inject-api-*` は `dynamodb` を `service` の値としてサポートしておらず（API が *"The service parameter value is not supported for the action"* で拒否）、Lambda の予約済み同時実行数を設定する FIS アクションは存在しません。このサーバーレス経路に障害を注入できる唯一の方法が `aws:lambda:function` アクション群で、現在の B-1〜B-4 はこれを使っています。詳細は[実装のポイント](#6-得られた知見)を参照。

## アーキテクチャ概要

![アーキテクチャ概要](docs/architecture.html)

```
Viewer (HTTPS)
    │
    ▼
CloudFront ディストリビューション  (price class 100, TLS 1.2+, HTTP/2+3, IPv6)
    │  キャッシュ無効のパススルー
    ▼
API Gateway HTTP API  (デフォルトステージ、アクセスログを CW Logs へ)
    │  Lambda プロキシ統合
    ▼
Lambda 関数  (Python 3.13, 256 MB, 29 秒タイムアウト)
    │  + AWS FIS Lambda 拡張レイヤー（障害注入）
    │  GET / POST / DELETE  /items
    ▼
DynamoDB テーブル  (PAY_PER_REQUEST, 文字列パーティションキー: id)

FIS ⇄ 拡張 の設定交換:
    S3 バケット  <project>-<env>-b-fis-config-<account>  (プレフィックス FisConfigs/)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIS 実験テンプレート (FisStack)   ターゲット: aws:lambda:function (API ハンドラの ARN)

B-1  aws:lambda:invocation-error                  preventExecution=true,  100%, PT5M
B-2  aws:lambda:invocation-add-delay              startupDelayMilliseconds=10000, 100%, PT5M
B-3  aws:lambda:invocation-error                  preventExecution=false, 50%,  PT5M
B-4  aws:lambda:invocation-http-integration-response  statusCode=500, contentTypeHeader=application/json, PT5M
```

### 設計上の利点

| 特徴 | 利点 |
| ---- | ---- |
| VPC 不要 | 完全サーバーレス — NAT Gateway なし、サブネット設計なし、VPC の時間課金なし |
| `aws:lambda:function` アクション | FIS が Lambda 拡張を通じて関数の呼び出しに障害を注入。ハンドラコードは無変更 |
| `preventExecution` の切り替え（B-1 と B-3） | 同じアクションで「即時停止（ハンドラ未実行）」と「作業後エラー（副作用は確定済み）」の両方をモデル化 |
| HTTP 統合レスポンスの上書き（B-4） | Lambda クラッシュとは異なる「整形された 500」を統合から返し、API GW / CloudFront のエラーマッピングを検証 |
| 共通の停止条件 | 1 つの CloudWatch アラームで 4 実験のいずれも自動停止 |
| 安定した入口としての CloudFront | 安定ドメイン、WAF アタッチポイント、実験中の 4xx/5xx レート観測に自然な場所 |

## 前提条件

- AWS CLI v2 のインストールと設定
- Node.js 20 以降
- AWS CDK CLI (`npm install -g aws-cdk`)
- TypeScript と Python の基礎知識
- FIS サービスリンクロールが作成済みの AWS アカウント（初回 FIS 利用時に自動作成）

> **VPC / NAT Gateway コストなし**: サーバーレスサービスのみを使用します。アイドル時の主要コストはゼロ（DynamoDB PAY_PER_REQUEST、Lambda 呼び出し、ほぼ空の S3 設定バケット）。[コスト見積り](#コスト見積り)を参照。

## プロジェクトディレクトリ構成

```text
fis-arch-b-apigw-lambda/
├── bin/
│   └── fis-arch-b-apigw-lambda.ts        # アプリのエントリポイント（Stage をインスタンス化）
├── lambda/
│   └── api-handler/
│       └── index.py                       # DynamoDB 用 Python 3.13 CRUD ハンドラ
├── lib/
│   ├── stages/
│   │   └── fis-chaos-stage.ts             # Stage: BaseStack → AppStack → FisStack
│   └── stacks/
│       ├── base-stack.ts                  # DynamoDB テーブル
│       ├── app-stack.ts                   # Lambda（+ FIS 拡張レイヤー）+ API GW HTTP API + CloudFront + FIS 設定バケット
│       └── fis-stack.ts                   # 4 つの FIS 実験テンプレート + IAM + アラーム
├── parameters/
│   ├── environments.ts                    # 環境パラメータ型
│   ├── dev-params.ts                      # 開発環境パラメータ
│   └── index.ts                           # パラメータのエクスポート
├── test/
│   ├── compliance/
│   │   └── cdk-nag.test.ts               # cdk-nag AwsSolutions コンプライアンスチェック
│   └── snapshot/
│       └── snapshot.test.ts              # CDK スナップショットテスト
├── docs/
│   └── architecture.html                 # インタラクティブ SVG アーキテクチャ図
├── cdk.json
├── package.json
└── tsconfig.json
```

## データフロー

```text
Viewer (ブラウザ or curl)
  │  HTTPS
  ▼
CloudFront ディストリビューション   (CACHING_DISABLED, ALL_VIEWER_EXCEPT_HOST_HEADER)
  ▼
API Gateway HTTP API  ($default ルート → Lambda プロキシ統合)
  ▼
Lambda 関数 (Python 3.13)   ── AWS FIS Lambda 拡張が呼び出しをインターセプト ──►
  ├── GET  /items          → table.scan()
  ├── POST /items          → table.put_item()   (body: {"name": "..."} )
  ├── GET  /items/{id}     → table.get_item()
  └── DELETE /items/{id}   → table.delete_item()
  ▼
DynamoDB テーブル  (パーティションキー: id、POST 時にハンドラが UUID を生成)
```

### FIS の注入ポイント

`aws:lambda:function` アクションは、レイヤーとして関数にアタッチした **AWS FIS Lambda 拡張**を通じて障害を注入します。実験開始時、FIS はアクティブな障害設定を S3 プレフィックスへ書き込み、拡張がそのプレフィックスをポーリングして、ハンドラ呼び出しの前後で障害（エラーを返す / 遅延を加える / 統合レスポンスを上書きする）を適用します。`index.py` は一切変わりません。

拡張は*ポーリング*するだけなので、障害は即時ではありません。

- **ランプアップ**: 実験開始から全呼び出しに影響が出るまで最大 ~60 秒（拡張の slow-poll 間隔）。実測では B-1 / B-4 は 15〜60 秒で完全反映、B-3（50%）は収束まで ~2.5 分。
- **ランプダウン**: アクション終了後、呼び出しがクリーンに戻るまで最大 ~20 秒。

## 主要コンポーネントと設計ポイント

| コンポーネント | 設計ポイント |
| -------------- | ------------ |
| DynamoDB テーブル | PAY_PER_REQUEST 課金。アイドル時コストゼロ。実験中のコスト最小化のため PITR は無効 |
| Lambda 関数 | Python 3.13、256 MB、29 秒タイムアウト（API GW の 30 秒制限より 1 秒下）。FIS 拡張レイヤー + `AWS_LAMBDA_EXEC_WRAPPER=/opt/aws-fis/bootstrap`、`AWS_FIS_CONFIGURATION_LOCATION=arn:aws:s3:::<bucket>/FisConfigs/`、`AWS_FIS_POLL_MAX_WAIT_MILLISECONDS=2000` を付与 |
| FIS 拡張レイヤー | リージョンごとにパブリック SSM パラメータ `/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x` から解決（x86_64 は Lambda のデフォルトアーキテクチャに一致） |
| FIS 設定バケット | `<project>-<env>-b-fis-config-<account>` — S3 管理暗号化、パブリックアクセス全ブロック、1 日のライフサイクル失効、リージョンごとに 1 つ。FIS が障害設定を書き込み、拡張が読み取る |
| API Gateway HTTP API | デフォルトステージ、`$default` キャッチオールルート、アクセスログを CloudWatch Logs へ、オーソライザーなし（公開デモ） |
| CloudFront ディストリビューション | `CACHING_DISABLED` キャッシュポリシー、`ALL_VIEWER_EXCEPT_HOST_HEADER` オリジンリクエストポリシー |
| FIS IAM ロール | `<bucket>/FisConfigs/*` への `s3:PutObject`/`s3:DeleteObject`、`*` への `lambda:GetFunction` と `tag:GetResources`、停止条件アラームへの `cloudwatch:DescribeAlarms`、CloudWatch Logs 配信権限 |
| CloudWatch 停止アラーム | `LambdaErrors >= 100`（1 分）— 4 テンプレート共通 |
| FIS ロググループ | `/fis/<project>-<env>-b` — 保持 1 か月、スタック削除時に自動削除 |

## 実装のポイント

### 1. DynamoDB 用 Lambda CRUD ハンドラ

Lambda 関数は意図的にシンプルです。プロダクショングレードのサービスではなく、FIS 障害注入のターゲットとして存在します。DynamoDB 例外を HTTP 500 として API Gateway へ伝播するため、障害の効果は HTTP ステータスコード分布と CloudWatch メトリクスに即座に現れます。

### 2. FIS Lambda 拡張は必須の前提条件

`aws:lambda:function` アクションは**素の関数では動作しません**。一度きりのセットアップ（すべて `app-stack.ts` 内）は以下のとおりです。

```typescript
// このリージョンの拡張レイヤー ARN をパブリック SSM パラメータから解決
const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
    this, '/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x',
);

new lambda.Function(this, 'ApiFunction', {
    // ...
    layers: [lambda.LayerVersion.fromLayerVersionArn(this, 'FisExtensionLayer', fisExtensionLayerArn)],
    environment: {
        TABLE_NAME: props.table.tableName,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
        AWS_FIS_CONFIGURATION_LOCATION: `arn:aws:s3:::${this.fisConfigBucket.bucketName}/FisConfigs/`,
        AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000', // preventExecution=true のときに推奨
    },
});

// 拡張（関数の実行ロールで動作）が S3 から障害設定を読む
this.apiFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [`${this.fisConfigBucket.bucketArn}/FisConfigs/*`],
}));
```

S3 バケットは FIS と拡張の通信チャネルです。FIS のロールはプレフィックスへの `s3:PutObject`/`s3:DeleteObject` を、関数のロールは `s3:GetObject`/`s3:ListBucket` を持ちます。

### 3. B-1 と B-3 — `preventExecution` は 2 つの異なる障害をモデル化する

```typescript
// B-1: 即時失敗 — ハンドラは実行されず副作用なし、全リクエストの 100%
parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true' }

// B-3: 作業後失敗 — ハンドラは実行され（書き込みが確定しうる）、その後 50% がエラーを返す
parameters: { duration: 'PT5M', invocationPercentage: '50',  preventExecution: 'false' }
```

B-1 は「API が完全にダウンしたときフロントエンドはきれいに劣化するか？」に答えます。B-3 はより難しい「DynamoDB への書き込みは成功したがクライアントには 500 が見えてリトライした場合、二重書き込みしないか？」— つまり冪等性テストです。

### 4. B-2 のレイテンシと B-4 の統合レスポンス上書き

```typescript
// B-2: 呼び出し前に固定 10 秒の遅延 — 意図的に 29 秒 / 30 秒のタイムアウト未満
{ actionId: 'aws:lambda:invocation-add-delay',
  parameters: { duration: 'PT5M', invocationPercentage: '100', startupDelayMilliseconds: '10000' } }

// B-4: ハンドラを実行せず API Gateway に合成 500 を返す
{ actionId: 'aws:lambda:invocation-http-integration-response',
  parameters: { duration: 'PT5M', invocationPercentage: '100', preventExecution: 'true',
                statusCode: '500', contentTypeHeader: 'application/json' } }
```

B-4 は B-1 と*形*が異なります。B-1 は Lambda エラー（API Gateway が 502/500 を合成）、B-4 は統合からの整形された 500 レスポンスボディです。`Lambda Errors` と `5xx` を別々に見ているダッシュボードやアラームは、この 2 つを違う形で観測します。

### 5. 共通の停止条件と自動復旧

4 テンプレートすべてが 1 つの CloudWatch アラーム（`LambdaErrors >= 100`、1 分）を参照します。ブラスト半径が暴走した場合、FIS が実験を停止し、拡張はランプダウン時間内に元に戻ります。アラームは SNS トピックにも通知します（`alarmEmail` パラメータで任意のメール購読）。

### 6. 得られた知見

- **`aws fis list-actions` が真実の情報源。** 元の設計は存在しない `aws:lambda:put-function-concurrent-executions` を使っており、CloudFormation は `Invalid actionId ... Status Code: 404` で失敗しました。テンプレートを書く前に、対象リージョンの `aws fis list-actions` でアクション ID を必ず確認すること。
- **`aws:fis:inject-api-*` のサービス許可リストは短い。** `service: dynamodb` は即座に拒否されます。現時点でこれらのアクションが実用的なのは少数のサービス（EC2 など）だけで、「任意の AWS API を失敗させる」汎用ツールでは**ありません**。
- **拡張はポーリングする — ランプアップを見込む。** ヘルスチェックやダッシュボードは `start-experiment` 後、障害が完全反映されるまで ~60 秒の許容が必要で、B-3 のような部分割合はさらに収束に時間がかかります。
- **`preventExecution=true` では `AWS_FIS_POLL_MAX_WAIT_MILLISECONDS` が重要。** これがないと、ランプアップ中の最初の数リクエストが、拡張が設定を取得する前にすり抜けます。ドキュメント推奨値は 2000 ms です。
- **S3 設定バケットはリージョンごとに 1 つ。** 実験を開始するリージョンにバケットが存在する必要があり、複数の実験・アカウントで共有できます。
- **レスポンスストリーミングは非互換。** FIS Lambda 拡張は障害が無効でもストリーミングを抑制します。本構成では問題なし（バッファされた JSON レスポンス）。

## デプロイ手順

### 1. 依存関係のインストール

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメータの設定

`parameters/dev-params.ts` でリージョンと（任意で）アラームメールを設定します。

```typescript
const devParams: EnvParams = {
    region: 'ap-northeast-1',
    // alarmEmail: 'ops@example.com',
};
```

### 3. CDK ブートストラップ（初回のみ）

```bash
PROJECT=<project> ENV=dev npm run bootstrap -w workspaces/fis-arch-b-apigw-lambda
```

### 4. 全スタックのデプロイ

```bash
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-b-apigw-lambda -- --require-approval never
```

依存順に 3 スタックをデプロイします。
1. `<project>-dev-b-base` — DynamoDB テーブル
2. `<project>-dev-b-app` — Lambda + FIS 拡張レイヤー + API GW + CloudFront + FIS 設定バケット
3. `<project>-dev-b-fis` — FIS テンプレート + IAM + アラーム

### 5. API のスモークテスト

```bash
CF=$(aws cloudformation describe-stacks --stack-name <project>-dev-b-app \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)

curl -s https://$CF/items                                   # → {"items": []}
curl -s -XPOST https://$CF/items -d '{"name":"hello"}'      # → 201 {"id": "...", "name": "hello"}
curl -s https://$CF/items                                   # → アイテムが一覧に出る
```

### 6. FIS 実験の実行

**コンソール**: FIS → 実験テンプレート → `B-1`〜`B-4`（`Scenario` タグ）を選択 → **実験を開始**。

**CLI**:

```bash
# テンプレート ID を調べる（Scenario=B-1 .. B-4 でタグ付け）
aws fis list-experiment-templates \
  --query "experimentTemplates[].{id:id, scenario:tags.Scenario, desc:description}" --output table

# 開始して実験 ID を取得
EXP=$(aws fis start-experiment --experiment-template-id <EXT...> \
      --query "experiment.id" --output text)

# 状態を監視
watch -n5 "aws fis get-experiment --id $EXP --query 'experiment.state'"

# 別シェルで効果を観測
while true; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://$CF/items; sleep 2; done
```

### 実測結果（ap-northeast-1、5 分実行）

| シナリオ | 実験中 | 復旧 |
| -------- | ------ | ---- |
| **B-1** | API / CloudFront とも全期間 **HTTP 500**。ハンドラ未実行（DynamoDB 書き込みなし） | 実験完了の数秒後に 200 |
| **B-2** | 約 60 秒のランプアップ後、応答時間が ~0.09 秒 → **~11.2 秒**。ステータスは 200 のまま | 約 60 秒でベースラインに復帰 |
| **B-3** | 約 2.5 分のランプアップ後、**約 50% のリクエストが 500**。残りは正常実行（書き込み確定） | 約 20 秒でクリーン |
| **B-4** | 約 60 秒のランプアップ後、API / CloudFront が **空ボディの 500**。ハンドラ未実行 | 数秒後に 200 |

停止条件アラーム（`LambdaErrors >= 100/分`）はどの実行でも発火しませんでした — デモのリクエストレートが 100/分を大きく下回るためです。自動停止経路を試すにはリクエストレートを上げるか閾値を下げてください。

## テスト

```bash
cd infrastructure
npm ci

npm run test         -w workspaces/fis-arch-b-apigw-lambda
npm run test:snapshot -w workspaces/fis-arch-b-apigw-lambda
npm run test:compliance -w workspaces/fis-arch-b-apigw-lambda

# 意図的な変更の後:
npm run test:snapshot:update -w workspaces/fis-arch-b-apigw-lambda
```

| テストスイート | ファイル | アサーション |
| -------------- | -------- | ------------ |
| スナップショット | `test/snapshot/snapshot.test.ts` | 3 スタックの完全な CFn テンプレートスナップショット、DynamoDB PAY_PER_REQUEST、FIS 拡張レイヤー付き Python 3.13 Lambda、CloudFront / API GW の数、ちょうど 4 つの FIS テンプレート、全テンプレートに停止条件 |
| CDK Nag | `test/compliance/cdk-nag.test.ts` | AwsSolutions パック — 未抑制の指摘なし |

## コスト見積り

価格は **オンデマンドのリスト価格（2026 年 9 月）**で、AWS 無料利用枠（下記の FIS 以外のほとんどをカバー）は除外しています。2 リージョンを表示: **バージニア北部 `us-east-1`** と **東京 `ap-northeast-1`**。

### アイドル / 定常状態（月あたり、トラフィックなし）

以下はすべて従量課金で、API が呼ばれていないときはほぼゼロにスケールします。

| サービス | 基準 | us-east-1 | ap-northeast-1 |
| -------- | ---- | --------- | -------------- |
| DynamoDB (PAY_PER_REQUEST) | RCU/WCU 予約なし。数個の小さなアイテムのストレージ | ~$0.00 | ~$0.00 |
| Lambda | 呼び出しなし | $0.00 | $0.00 |
| API Gateway HTTP API | リクエストなし | $0.00 | $0.00 |
| CloudFront | リクエスト / 転送なし | $0.00 | $0.00 |
| S3 FIS 設定バケット | ほぼ空、1 日で失効 | <$0.01 | <$0.01 |
| CloudWatch | アラーム 1 個 ($0.10) + わずかなログストレージ | ~$0.10 | ~$0.10 |
| **合計** | | **≈ $0.10 / 月** | **≈ $0.12 / 月** |

### 1 テストサイクル（デプロイ → 4 実験すべて実行 → 削除、約 1〜2 時間）

| サービス | 使用量の前提 | us-east-1 | ap-northeast-1 |
| -------- | ------------ | --------- | -------------- |
| **FIS** | 4 実験 × 1 アクション × 約 5 アクション分 = **約 20 アクション分** @ $0.10 | **$2.00** | **$2.00** |
| Lambda | 数千回の呼び出し、256 MB、<300 ms | <$0.02 | <$0.02 |
| DynamoDB | 数千の読み書きリクエストユニット | <$0.01 | <$0.01 |
| API Gateway HTTP API | 数千リクエスト @ $1.00〜$1.11 / 100 万 | <$0.01 | <$0.01 |
| CloudFront | 数千 HTTPS リクエスト + <1 GB 転送（無料枠内） | ~$0.00 | ~$0.00 |
| CloudWatch Logs | 実験 + アクセス + 関数ログ、1 GB 未満 @ $0.50 / $0.76 per GB | <$0.05 | <$0.05 |
| **1 サイクル合計** | | **≈ $2.10** | **≈ $2.10** |

**このドキュメントの以前のバージョンからの重要な訂正:** FIS は**無料ではありません**。**アクション分あたり $0.10**（両リージョン同一）で課金されます。「アクション分」は実行中の 1 アクションの 1 分です。5 分・単一アクションの実験は約 $0.50、B-1〜B-4 を 1 回ずつ実行すると約 $2.00 です。実験レポート（オプトイン）は 1 件 $5 追加で、本構成では使用しません。

価格の参照（リスト価格、AWS Price List API で 2026 年 9 月に取得）:
FIS `ActionMinute` $0.10（両リージョン） · Lambda / DynamoDB / API GW は両リージョンでほぼ同一 · CloudWatch アラーム $0.10 · CloudWatch Logs 取り込み $0.50/GB (us-east-1) vs $0.76/GB (ap-northeast-1)。

## セキュリティに関する考慮事項

- **Lambda 実行ロール — 最小権限**: 特定テーブルへの `dynamodb:GetItem/PutItem/DeleteItem/Scan`（`table.grantReadWriteData()` 経由）、加えて拡張のために設定バケットの `FisConfigs/` プレフィックスに限定した `s3:GetObject`/`s3:ListBucket`。
- **FIS ロール — 最小権限**: `<bucket>/FisConfigs/*` に限定した `s3:PutObject`/`s3:DeleteObject`、`lambda:GetFunction` と `tag:GetResources`（ターゲット解決）、停止条件アラーム 1 個への `cloudwatch:DescribeAlarms`、CloudWatch Logs 配信アクション。`lambda:UpdateFunctionConfiguration` なし、DynamoDB アクセスなし。
- **FIS 設定バケット**: パブリックアクセス全ブロック、S3 管理暗号化、TLS 強制、1 日でオブジェクト失効（古い障害設定を残さない）。
- **VPC 露出なし**: VPC・サブネット・セキュリティグループなし。唯一の接点は CloudFront / API GW のパブリックエンドポイントで、公開デモ API として妥当。プロダクションではルートに Cognito または IAM オーソライザーを追加。
- **停止条件は必須**: 全テンプレートが Lambda エラーアラーム停止条件を持ち、最大ブラスト半径を制限。

## トラブルシューティング

| 症状 | 考えられる原因 | 解決策 |
| ---- | -------------- | ------ |
| `cdk deploy` が `No parameters found for environment` で失敗 | `dev-params.ts` の登録漏れ | `parameters/index.ts` が `dev-params` を import し、`params[Environment.DEVELOPMENT] = …` を呼んでいるか確認 |
| FIS テンプレート作成が `Invalid actionId ... 404` で失敗 | そのリージョンに存在しないアクション ID | `aws fis list-actions` で確認 |
| FIS テンプレート作成が `The service parameter value is not supported for the action` で失敗 | `aws:fis:inject-api-*` にサポート外の `service`（例: `dynamodb`） | 代わりに `aws:lambda:function` アクションを使う（本ワークスペースの方式） |
| 実験は動くが API がエラーを返さない | 関数に FIS 拡張レイヤー / 環境変数がない、または S3 設定バケットに到達できない | レイヤー + `AWS_LAMBDA_EXEC_WRAPPER` + `AWS_FIS_CONFIGURATION_LOCATION` を確認。関数ログの `AWS FIS EXTENSION` 行を確認 |
| エラーが出るまで約 1 分かかる | 想定どおり — 拡張の slow-poll ランプアップ | ~60 秒待つ。部分割合シナリオは 2〜3 分見込む |
| 実験がすぐ停止する | 停止条件アラームが既に `ALARM` | `aws cloudwatch set-alarm-state --alarm-name <name> --state-value OK --state-reason reset` |

## クリーンアップ

```bash
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-b-apigw-lambda -- --force
```

全リソースが `removalPolicy: DESTROY`（S3 設定バケットは `autoDeleteObjects` も）なので、destroy で DynamoDB テーブル、Lambda、API GW、CloudFront ディストリビューション、FIS テンプレート、S3 設定バケット、CloudWatch ロググループが完全に削除されます。

## まとめ

本ワークスペースは、`aws:lambda:function` アクション群と AWS FIS Lambda 拡張を使った、サーバーレス CRUD API に対する FIS カオスエンジニアリングを示します。

- **B-1** — 即時の完全停止（ハンドラ未実行）: フロントエンドはきれいに劣化するか？
- **B-2** — +10 秒の呼び出しレイテンシ: タイムアウト予算とレイテンシアラームは正しいか？
- **B-3** — 実行後 50% 失敗: クライアントリトライ下で書き込み経路は冪等か？
- **B-4** — 合成 500 統合レスポンス: API GW / CloudFront のエラーマッピングは機能するか？

サーバーレス構成なので定常コストは月 ~$0.10、4 実験のフルテストサイクルは約 **$2**（大半が FIS のアクション分課金）です。

## 参考資料

- [AWS FIS — アクションリファレンス](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [AWS FIS `aws:lambda:function` アクションの使用](https://docs.aws.amazon.com/fis/latest/userguide/use-lambda-actions.html)
- [AWS FIS Lambda 拡張の利用可能バージョン](https://docs.aws.amazon.com/fis/latest/userguide/actions-lambda-extension-arns.html)
- [AWS FIS の料金](https://aws.amazon.com/fis/pricing/)
- [CDK `aws-fis` モジュール（L1 コンストラクト）](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)
- [API Gateway HTTP API — Lambda 統合](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)
