# code-server on EC2 vs AWS Lambda MicroVMs — 同じブラウザIDEを2つのコンピュートモデルで動かし、Claude CodeからAmazon Bedrockを使う

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

[code-server](https://github.com/coder/code-server)(ブラウザで動く VS Code)を2つのコンピュートモデルで動かし、並べて比較するリファレンス実装です。1つは、CloudFront の背後に EC2 を常時稼働させる構成で、AWS のサンプル [sample-code-server-on-aws](https://github.com/aws-samples/sample-code-server-on-aws) と同じ形です。もう1つは、必要なときに起動し、使われていなければサスペンドし、次のリクエストでレジュームする [AWS Lambda MicroVM](https://aws.amazon.com/lambda/lambda-microvms/) です。どちらにも、Amazon Bedrock を使う設定済みの Claude Code CLI と VS Code 拡張機能が入っています。

このアーキテクチャで確認できること:

- 同じプロダクトを2つの課金モデルで動かす。1時間ごとに課金されるインスタンスと、動いている間だけ課金される MicroVM
- それぞれのモデルでブラウザから届く入口を用意する。EC2 側は CloudFront と送信元を絞ったセキュリティグループ、MicroVMs 側はトークン認証付きのエンドポイントとローカルリレー
- MicroVM 内のランチャーが、プラットフォームのライフサイクルフックに応答し、`/run` フックで MicroVM ごとに取得したパスワードを使って code-server を起動し、HTTP と WebSocket をリバースプロキシする
- API キーを置かずに、インスタンスロールまたは MicroVM 実行ロールで Claude Code から Bedrock を呼ぶ
- 計測した比較。MicroVM の起動は3〜16秒、サスペンド後の最初のリクエストは0.65秒、EC2 スタックの作成は約5.5分
- 2026-10-08 に実機でエンドツーエンドのデプロイ検証を実施。見つかって直した不具合は[実機デプロイ検証](#-実機デプロイ検証)にまとめている

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [使い方](#使い方)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [実機デプロイ検証](#-実機デプロイ検証)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Overview](overview.drawio.svg)

1つの CDK アプリに、独立した2つのスタックがあります。どちらか一方だけをデプロイすることもできます。

| | EC2 版 | Lambda MicroVMs 版 |
| --- | --- | --- |
| コンピュート | `t4g.medium` を1台、常時稼働 | セッションごとに MicroVM を1台、オンデマンドで起動 |
| 入口 | CloudFront(HTTPS) | MicroVM エンドポイント(HTTPS、`X-aws-proxy-auth` ヘッダの JWE トークン) |
| ブラウザからの接続 | CloudFront の URL を開く | `scripts/microvm-session.sh connect` が `localhost:8443` にローカルリレーを立てる |
| ログイン | Secrets Manager の code-server パスワード | 同じ。エンドポイントのトークンに加えて必要 |
| シェル | SSM Session Manager | code-server のターミナル |
| アイドル時 | 動き続けて課金も続く | 15分アイドルでサスペンドし、次のリクエストでレジューム |
| 停止後の状態 | EBS ボリュームに残る | サスペンド中は保持、終了すると消える |
| 起動時間 | 数分(インスタンス起動と UserData) | 計測値で3〜16秒 |

### 主要コンポーネント

**EC2 スタック**(`lib/stacks/code-server-ec2-stack.ts`)

- **VPC**: パブリックサブネット2つ。NAT Gateway はなし
- **EC2 インスタンス**: Amazon Linux 2023(arm64)。IMDSv2 必須、暗号化した gp3 ルートボリューム。code-server は UserData でインストールし、systemd サービスとして動かす
- **セキュリティグループ**: インバウンドは1本だけ。CloudFront のオリジン向けマネージドプレフィックスリストからの TCP 8080
- **CloudFront**: キャッシュ無効、全ビューアヘッダーを転送、HTTPS へリダイレクト。HTTP/1.1 の WebSocket アップグレードを通す
- **Secrets Manager**: 自動生成した24文字のログインパスワード。インスタンスロールが起動時に読む
- **インスタンスロール**: `AmazonSSMManagedInstanceCore`、シークレットの読み取り、設定したモデルへの `bedrock:InvokeModel*`

**MicroVMs スタック**(`lib/stacks/code-server-microvms-stack.ts`)

- **MicroVM イメージ**(`AWS::Lambda::MicrovmImage`): `src/microvm-image/`(Dockerfile、ランチャー、Claude Code CLI と拡張機能)からビルド。arm64、最小メモリ 2 GiB。ポート 8080 で `run`、`terminate`、`ready`、`validate` の各フックを有効にしている
- **ランチャー**(`src/microvm-image/server/index.mjs`): ライフサイクルフックに応答し、`/run` で code-server を起動し、それ以外を WebSocket のアップグレードも含めてリバースプロキシする
- **ビルドロールと実行ロール**: ビルドロールはアセットバケットの読み取りとログの書き込み。実行ロールはパスワードの読み取り、ログの書き込み、Bedrock の呼び出し
- **Secrets Manager**: 自動生成したログインパスワード
- **ロググループ**: イメージのビルドログと、`--logging` を指定した各 MicroVM の実行ログ
- **運用スクリプト**(`scripts/`): `microvm-session.sh`(start、connect、status、stop)と `relay.mjs`(ローカルリレー)

MicroVMs 側には VPC も NAT Gateway もありません。AWS マネージドの `INTERNET_EGRESS` ネットワークコネクタで、拡張機能、パッケージレジストリ、Bedrock へのアウトバウンド通信を行います。

### リクエストの流れ

```
EC2 版
  ブラウザ ──HTTPS──▶ CloudFront ──HTTP :8080──▶ EC2 (code-server)
                                                    ├─ GetSecretValue (パスワード、起動時)
                                                    └─ InvokeModel (Claude Code → Bedrock)

MicroVMs 版
  ブラウザ ──HTTP──▶ localhost:8443 (relay.mjs) ──HTTPS + X-aws-proxy-auth──▶ MicroVM エンドポイント
                                                                                └─ ランチャー :8080 ──▶ code-server :8081
  /run フック ─▶ GetSecretValue (パスワード) ─▶ code-server を起動 ─▶ トラフィックの受け付けを開始
```

### ローカルリレーが必要な理由

MicroVM のエンドポイントは、すべてのリクエストに `X-aws-proxy-auth` ヘッダの JWE トークンを要求します。ブラウザは、ページ遷移や WebSocket のハンドシェイクにカスタムヘッダーを付けられません。`scripts/relay.mjs` は `127.0.0.1` で待ち受け、新しいトークン(AWS CLI で25分ごとに再発行)を付けて HTTP と WebSocket を転送します。あわせて、code-server 自身のオリジンチェックを通すために `Host` と `Origin` をエンドポイントの値に書き換え、ブラウザが `localhost` でセッション Cookie を保持できるように `Set-Cookie` の `Domain` 属性を取り除きます。

## 🎯 設計判断とベストプラクティス

### 1. 1つのワークスペースに2つのスタック

2つの構成は同じプロダクトを動かすので、比較することがこのパターンの目的です。各スタックは単独でデプロイと削除ができます(`cdk deploy '**/Ec2'`、`cdk deploy '**/Microvms'`)。MicroVMs だけを試すときに、EC2 版の固定費がかかりません。

### 2. EC2 をパブリックサブネットに置くのは CloudFront から届かせるため

CloudFront は、インターネットから名前解決できる DNS 名を必要とします。そこでインスタンスにパブリック IPv4 アドレスを付け、セキュリティグループは CloudFront のオリジン向けプレフィックスリスト以外を許可しません。インスタンスの公開 DNS 名の 8080 に直接アクセスすると、タイムアウトします。NAT Gateway を使わないので、月額ではインスタンスより高くなる NAT のコストも避けられます。引き換えに、オリジンまでの区間は AWS ネットワーク内の平文 HTTP になります。プライベートなインスタンスへ CloudFront VPC オリジンで接続すればパブリックアドレスをなくせますが、UserData のダウンロード用に NAT か VPC エンドポイントが必要です。

### 3. code-server はイメージビルドではなく `/run` フックで起動する

プラットフォームは `/ready` が 200 を返した後でメモリとディスクのスナップショットを取り、すべての MicroVM をそのスナップショットから再開します。ビルド時に code-server を起動すると、パスワードがスナップショットに含まれ、全 MicroVM で共通になります。`/run` で起動すれば、MicroVM ごとに自分の実行ロールでシークレットを読めます。`/run` には約2秒かかり、フックが 200 を返すまでエンドポイントはトラフィックを通しません。

### 4. code-server の前にランチャーを置く

プラットフォームは、1つのポートの `/aws/lambda-microvms/runtime/v1/<hook>` にフックを呼び出します。code-server はこれに応答できません。そこでランチャーが 8080 を持ち、フックに応答し、それ以外をループバックの 8081 にある code-server へプロキシします。WebSocket のアップグレードは code-server へ再送したあと生のバイト列として中継します。VS Code のターミナル、拡張機能ホスト、ファイル監視が使います。ランチャー用の変数名を `PORT` にしないのにも理由があります。code-server は `$PORT` を読んで、それにバインドしてしまいます。

### 5. MicroVM にはトークンが必要で、パスワードも残す

エンドポイントのトークンは、MicroVM に届いてよい相手かどうかを確認するものです。code-server のパスワードは IDE そのものを守ります。トークンが漏れても、ワークスペースは開けません。どちらも期限付き、または環境ごとのシークレットで、テンプレートにもイメージにも入りません。

### 6. アイドル中は終了ではなくサスペンド

`idlePolicy` で、15分間トラフィックがなければサスペンドし、`autoResumeEnabled` で次のリクエストに復帰させます。サスペンド中もメモリとディスクの状態は保持されるので、開いているエディタやターミナルは残り、課金はスナップショットの保存料金だけです。このデプロイでは、サスペンド後の最初のリクエストが0.65秒で返りました。`suspendedDurationSeconds`(スクリプトの既定は1時間)が、放置されたセッションが残る時間の上限です。`maximumDurationInSeconds` は全体の寿命の上限で、最大8時間です。

### 7. Claude Code はロールの認証情報で Bedrock を使う

`parameters/dev-params.ts` の `bedrock`(`enabled`、`modelId`、`smallFastModelId`)で設定します。有効にすると、インスタンスロールまたは実行ロールに、2つの推論プロファイルと対応する基盤モデルへの `bedrock:InvokeModel` と `InvokeModelWithResponseStream` が付きます。クロスリージョン推論プロファイルは別リージョンの基盤モデルへルーティングされるので、基盤モデル ARN のうちリージョン部分だけをワイルドカードにしています。CLI と拡張機能は `~/.claude/settings.json` を読みます。ここに `CLAUDE_CODE_USE_BEDROCK=1`、リージョン、モデル ID が入っています。パラメータに書く前に `aws bedrock-runtime converse` でモデルを確認してください。一覧に出ていても、アカウントによっては `AccessDeniedException` になるモデルがあります。

### 8. Well-Architected Framework との対応

| 柱 | このパターンの対応 |
| --- | --- |
| 運用上の優秀性 | 2つのスタックを独立してデプロイ・削除できる。`microvm-session.sh` が start、connect、status、stop をまとめる。MicroVM の実行ログは CloudWatch Logs へ |
| セキュリティ | CloudFront 以外からインスタンスへの入口がない。IMDSv2。暗号化ボリューム。パスワードは Secrets Manager で生成。MicroVM エンドポイントはトークン認証。Bedrock は名前を指定したモデルだけに許可。長期キーなし |
| 信頼性 | EC2 は systemd が code-server を再起動する。MicroVM はサスペンドとレジュームの前後で状態を保つ。どちらも単一インスタンスで、フェイルオーバーはない |
| パフォーマンス効率 | MicroVM は1秒未満でレジューム。どちらも arm64。CloudFront はキャッシュ無効で WebSocket を通す |
| コスト最適化 | MicroVM は動いている間だけ課金。EC2 版は NAT Gateway を使わない。`bedrock.enabled` とインスタンスサイズはパラメータ |
| 持続可能性 | 入力がないときはサスペンドや終了でコンピュートを解放する。Graviton と MicroVM を使う |

## 💰 コスト最適化

単価はリージョンごとに異なります。実際のワークロードを見積もる前に、AWS の料金ページで確認してください。以下は、2つのモデルの形を比べるために米国東部(バージニア北部)の定価を使っています。

| 項目 | EC2 版 | MicroVMs 版 |
| --- | --- | --- |
| コンピュート | `t4g.medium`(2 vCPU、4 GiB): 1時間 $0.0336、730時間の月で約 $24.5 | 1 vCPU と 2 GiB を基準とした arm64: 1 vCPU 秒あたり $0.0000276944 と 1 GiB 秒あたり $0.0000036667、実行1時間で約 $0.126 |
| ストレージ | gp3 30 GiB: 1 GiB 月あたり $0.08、$2.4 | サスペンド中のスナップショット保存料金が 1 GB 月あたり $0.08 |
| パブリック IPv4 | 1時間 $0.005、月約 $3.65 | なし |
| NAT Gateway | なし | なし |
| Secrets Manager | 1シークレット月 $0.40 | 1シークレット月 $0.40 |
| CloudFront | 個人利用なら無料枠に収まる | なし |

コンピュートだけの損益分岐は、$24.5 ÷ 1時間あたり $0.126 で約195時間、月の約27%です。これを下回るなら MicroVM のほうが安く、1日に数時間コーディングする使い方なら大きく下回ります。上回るなら、常時稼働のインスタンスのほうが安くなります。Bedrock のトークン料金は、どちらも同じです。

コストの調整先:

- `microvm-session.sh start` の `--idle-seconds`: アイドルの MicroVM がサスペンドするまでの時間
- `suspendedDurationSeconds`: スナップショットを保存し続ける時間の上限
- `ec2.instanceType` と `ec2.volumeSizeGiB`: インスタンスのサイズ
- EC2 版を残す場合は、業務時間外に EventBridge のスケジュールでインスタンスを停止する。停止中もボリュームとパブリック IPv4 アドレスは課金される

## 🔒 セキュリティ考慮事項

### 実装済み

- インスタンスのセキュリティグループ: CloudFront のオリジン向けプレフィックスリストからの TCP 8080 だけを許可
- IMDSv2 必須、暗号化した gp3 ルートボリューム、SSH キーなし、ポート 22 なし
- code-server のパスワードは Secrets Manager で生成し、EC2 では起動時、MicroVM では `/run` フックで読む。テンプレート、ユーザーデータ、イメージには含まれない
- MicroVM エンドポイントのトークン: JWE。1つの MicroVM とそのポートに限定し、リレーでは有効期間30分
- リレーは `127.0.0.1` にバインド
- Bedrock の権限は、2つの推論プロファイルと対応する基盤モデルに限定
- MicroVM のビルドロールと実行ロールを分離。ビルドロールはパスワードを読めない

### 意図的に範囲外としているもの(環境に応じて追加)

- CloudFront の前段の AWS WAF(CloudFront 用の Web ACL は us-east-1 に作る)
- カスタムドメインと証明書。デフォルト証明書の最小 TLS バージョンの制約もなくなる
- インスタンスのパブリックアドレスをなくす CloudFront VPC オリジン
- CloudFront のアクセスログと VPC フローログ
- 認証付きコントロールプレーンの背後にあるユーザー単位の MicroVM([`lambda-microvms-codex-appserver`](../lambda-microvms-codex-appserver/README.ja.md)を参照)

### CDK Nag

`test/compliance/cdk-nag.test.ts` が、両スタックに AwsSolutions パックを適用します。抑制には、それぞれ理由を付けています。デモ用インスタンスのフローログ、詳細モニタリング、終了保護。CloudFront の地理的制限、WAF、ログ、デフォルト証明書。HTTP のみのオリジン。シークレットのローテーション。SSM のマネージドポリシー。Bedrock の基盤モデル ARN のリージョンのワイルドカードです。

## 📋 前提条件

- Node.js 20 以上と、リポジトリの依存関係(`infrastructure/` で `npm ci`)
- 対象アカウントのプロファイルを設定した AWS CLI v2
- `microvm-session.sh` を実行するマシンに `jq`、`curl`、`node`
- 対象アカウントとリージョンで Lambda MicroVMs プレビューが有効で、AWS マネージドのベースイメージが見えること: `aws lambda-microvms list-managed-microvm-images`
- `bedrock` に設定するモデルの Amazon Bedrock モデルアクセス(`aws bedrock-runtime converse` で確認)
- 対象アカウントとリージョンでの CDK ブートストラップ

## 🚀 デプロイ手順

```sh
cd infrastructure/workspaces/code-server-ec2-vs-lambda-microvms

# どちらか一方、または両方をデプロイする
PROJECT=<project> ENV=dev npx cdk deploy '**/Ec2' --require-approval never
PROJECT=<project> ENV=dev npx cdk deploy '**/Microvms' --require-approval never
```

2つのデプロイは続けて実行せず、1つずつ実行してください。2つの CDK プロセスが同じ `cdk.out` に synth すると衝突します。

リージョンは `CDK_DEFAULT_REGION` か `parameters/dev-params.ts` で決まります。`microvm` のベースイメージ ARN はリージョン固有です。

## 使い方

### EC2 版

```sh
# URL とパスワードのシークレット名はスタックの出力にある
aws cloudformation describe-stacks --stack-name <project>-dev-code-server-ec2 \
  --query 'Stacks[0].Outputs' --output table
aws secretsmanager get-secret-value --secret-id <PasswordSecretName> --query SecretString --output text
```

出力の `CodeServerUrl` を開き、パスワードでサインインします。インスタンスのシェルは `aws ssm start-session --target <InstanceId>` で開けます。スタックの作成が終わっても、インスタンスでは UserData が数分動き続けます。code-server が起動すると URL が応答します。

### Lambda MicroVMs 版

```sh
cd infrastructure/workspaces/code-server-ec2-vs-lambda-microvms

# 1. MicroVM を起動し、code-server が応答するまで待つ(経過秒数を表示)
#    スタック名の既定は ${PROJECT}-${ENV:-dev}-code-server-microvms。--stack で変更できる
export PROJECT=<project>
./scripts/microvm-session.sh start --profile <profile>

# 2. ローカルリレーを立て、http://localhost:8443 をブラウザで開く
./scripts/microvm-session.sh connect --profile <profile>

# 3. パスワード
aws secretsmanager get-secret-value --secret-id <project>-dev-code-server-microvms-password \
  --query SecretString --output text

# 4. 確認と停止
./scripts/microvm-session.sh status --profile <profile>
./scripts/microvm-session.sh stop --profile <profile>
```

`start` は `--idle-seconds`(既定 900)と `--max-seconds`(既定 14400、最大 28800)を受け取ります。リレーはエンドポイントのトークンを自分で再発行するので、作業中はそのターミナルを開いたままにしてください。MicroVM がサスペンドしても、リレー経由の次のリクエストでレジュームします。

### Claude Code

code-server の Claude Code パネルを開くか、ターミナルで `claude` を実行します。どちらも `~/.claude/settings.json` を読み、`parameters/dev-params.ts` の Amazon Bedrock とモデルを使います。

## 🧪 テスト戦略

```sh
npm run test:unit -w workspaces/code-server-ec2-vs-lambda-microvms        # リソースプロパティの検証
npm run test:snapshot -w workspaces/code-server-ec2-vs-lambda-microvms    # テンプレート全体の回帰テスト
npm run test:compliance -w workspaces/code-server-ec2-vs-lambda-microvms  # cdk-nag AwsSolutions パック
```

- ユニットテストでは、NAT Gateway がないこと、IMDSv2、CloudFront のプレフィックスリストのルール、CloudFront のキャッシュとリクエストのポリシー、パスワードが生成されテンプレートに埋め込まれていないこと、MicroVMs スタックでは VPC やインスタンスがないこと、イメージのアーキテクチャ、メモリ、フック、実行ロールのシークレット読み取りを確認します。
- スナップショットテストは、両スタックのテンプレート全体とリソース数を対象にします。
- コンプライアンステストは、両スタックに CDK Nag を実行します。

`cdk synth` も、`AWS::Lambda::MicrovmImage` の CloudFormation スキーマでテンプレートを検証します。

## ⚙️ カスタマイズ

### Claude Code を無効にする、またはモデルを変える

```typescript
bedrock: {
  enabled: false, // CLI、拡張機能、Bedrock の権限を外す
  modelId: 'jp.anthropic.claude-sonnet-4-6',
  smallFastModelId: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
},
```

### インスタンスサイズや code-server のバージョンを変える

```typescript
ec2: { instanceType: 't4g.large', volumeSizeGiB: 60, codeServerVersion: '4.141.0' },
microvm: { baseImageArn: '...', baseImageVersion: '1', minimumMemoryInMiB: 4096 },
```

### MicroVM イメージにツールを追加する

`src/microvm-image/Dockerfile` にパッケージを追加します。イメージのビルドではネットワークが使えるので、`apt-get`、`npm`、`curl` が動きます。イメージを変更すると新しいイメージバージョンができ、その後に起動した MicroVM から使われます。

## ✅ 実機デプロイ検証

2026-10-08 に、開発用アカウントの ap-northeast-1 へデプロイし、外部から動作を確認しました。

| 確認項目 | 結果 |
| --- | --- |
| EC2 スタックの作成 | 331秒。ほとんどが CloudFront ディストリビューションの作成 |
| EC2 版: ログイン、ワークベンチ、WebSocket アップグレード | CloudFront 経由で 200、200、101 |
| EC2 版: インスタンスの 8080 への直接リクエスト | タイムアウト。セキュリティグループで遮断 |
| MicroVMs イメージのビルド | 初回は約190秒、以降のバージョンは約210秒 |
| MicroVM の起動から正常応答まで | 3回の起動で3秒、11秒、16秒 |
| MicroVMs 版: リレー経由のログイン、ワークベンチ、WebSocket アップグレード | 200、200、101 |
| `suspend-microvm` 後の最初のリクエスト | 0.65秒で 200。状態は `RUNNING` に戻った |
| EC2 上の Claude Code | `claude -p` が Bedrock 経由で応答(`BEDROCK_OK`) |
| MicroVM 内の Claude Code | `/run` フックのスモークチェックが、実行ロールで Bedrock 経由の応答を返した |
| モデルアクセス | `jp.anthropic.claude-sonnet-4-6` と `jp.anthropic.claude-haiku-4-5` は応答。`sonnet-5-5`、`opus-5-5`、`haiku-5-5` のプロファイルは、このアカウントで `AccessDeniedException` |

実機デプロイで見つかり、修正した不具合:

1. **code-server が別のポートにバインドした。** ランチャーが `PORT` 環境変数を使っていて、code-server は `--bind-addr` より先に `$PORT` を読みます。8080 にバインドしてランチャーと衝突し、`/run` フックが 500 を返し、MicroVM は `Run lifecycle hook returned HTTP status 500` で終了しました。ランチャーは `LAUNCHER_PORT` を読むようにしました。
2. **ブラウザがセッション Cookie を拒否した。** code-server は、セッション Cookie に `Domain=<MicroVM エンドポイント>` を付けます。`localhost` のブラウザはこれを破棄するので、ログイン後のリクエストがすべてログイン画面へ戻りました。リレーで `Domain` 属性を取り除きます。
3. **`AWS_REGION` はイメージの環境変数名として予約されている。** `AWS::Lambda::MicrovmImage` に設定すると、`Environment variable key 'AWS_REGION' is reserved` で更新が失敗し、スタックがロールバックしました。ランチャーはシークレット ARN からリージョンを取り出します。
4. **既定では実行ログが出ない。** `/run` で失敗した MicroVM は、実行ロールが書き込めるロググループを `--logging` で指定するまで、CloudWatch に何も残しませんでした。`start` はイメージのロググループを渡し、スタックは書き込み権限を付けます。

あわせて確認したこと: `maximumDurationInSeconds` を過ぎた MicroVM は、実行中でもサスペンド中でも `MicroVM exceeded maximum lifetime` で終了します。その後、リレーは 502 `MICROVM_CONNECT_FAILED` を返します。

## 🔧 トラブルシューティング

### `microvm-session.sh start` が `/healthz` を待ってタイムアウトする

MicroVM の状態と理由を確認します。

```sh
aws lambda-microvms get-microvm --microvm-identifier <id> --query '{state:state,reason:stateReason}'
```

`Run lifecycle hook returned HTTP status 500` は、ランチャーが code-server を起動できなかったことを表します。イメージのロググループ(`/lambda-microvms/<project>-<env>-code-server-image`、ストリーム名は `<日付>[<イメージバージョン>]<microvm id>`)のログを読みます。

### ブラウザがログイン画面に戻り続ける(MicroVMs 版)

セッション Cookie が保存されていません。Cookie の `Domain` 属性を取り除く、このリポジトリのリレーを使い、リレーが表示する `http://localhost:<port>` をそのまま開いてください。

### リレーが `x-aws-proxy-error: MICROVM_CONNECT_FAILED` の 502 を返す

MicroVM がなくなっています(終了したか、最大寿命を過ぎた)。`microvm-session.sh start` をもう一度実行してから `connect` します。

### 約1時間後にリレーの認証が通らなくなる

リレーは AWS CLI でトークンを再発行します。シェルの認証情報(SSO セッションなど)が切れていたら、更新してから `connect` をやり直してください。

### EC2 版: デプロイ直後に CloudFront の URL が 502 を返す

インスタンスが UserData を終える前に、CloudFront のほうが先に使えるようになります。数分待ってください。進み具合は `aws ssm start-session` で入り、`/var/log/cloud-init-output.log` を読むと分かります。

### Claude Code がサインインを求める

Amazon Bedrock の選択肢を選ぶか、`~/.claude/settings.json` に `CLAUDE_CODE_USE_BEDROCK` があることを確認してください。MicroVM では、その MicroVM のログストリームに `[bedrock-check]` の行があれば、実行ロールがモデルを呼べています。

### Bedrock から `AccessDeniedException` が返る

アカウントでモデルが有効になっていないか、`modelId` がロールのポリシーに含まれていません。`aws bedrock-runtime converse --model-id <id>` で確認し、`bedrock.modelId` に応答するプロファイルを設定してください。

## 🧹 クリーンアップ

```sh
# 先に実行中の MicroVM を終了する。cdk destroy は MicroVM を終了しない
./scripts/microvm-session.sh stop --profile <profile>

cd infrastructure/workspaces/code-server-ec2-vs-lambda-microvms
PROJECT=<project> ENV=dev npx cdk destroy '**/Microvms' --force
PROJECT=<project> ENV=dev npx cdk destroy '**/Ec2' --force
```

## 📚 参考資料

### AWS ドキュメント

- [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)
- [MicroVM の実行と利用(ライフサイクルフック、認証、WebSocket)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html)
- [Lambda MicroVMs のネットワーク(イングレスとイグレスのコネクタ)](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html)
- [AWS Lambda の料金](https://aws.amazon.com/lambda/pricing/)
- [CloudFront のオリジン向け IP アドレスのマネージドプレフィックスリスト](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/LocationsOfEdgeServers.html)
- [Amazon Bedrock の推論プロファイル](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
- [Amazon Bedrock での Claude Code](https://docs.claude.com/en/docs/claude-code/amazon-bedrock)

### code-server

- [code-server](https://github.com/coder/code-server)
- [AWS サンプル: CloudFront 付きの EC2 上の code-server](https://github.com/aws-samples/sample-code-server-on-aws)

### 関連アーキテクチャ

- [`lambda-microvms-codex-appserver`](../lambda-microvms-codex-appserver/README.ja.md): Cognito 認証のコントロールプレーンの背後で、セッションごとに MicroVM を使うパターン
- [`cloudfront-vpc-origin`](../cloudfront-vpc-origin/README.ja.md): プライベートなオリジンの前段に置く CloudFront

## 📄 ライセンス

このプロジェクトは Apache License, Version 2.0 のもとで公開されています。詳細は [LICENSE](../../../LICENSE) を参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、同じブラウザ IDE を常時稼働とオンデマンドの2つのコンピュートモデルで動かして比較し、トークン認証付きの MicroVM エンドポイントをブラウザにつなぐ方法を示します。

**対象レベル**: 300(上級)

---

**注意**: このリファレンス実装です。本番環境へデプロイする前に、要件と組織のポリシーに合わせて必ず見直してください。
