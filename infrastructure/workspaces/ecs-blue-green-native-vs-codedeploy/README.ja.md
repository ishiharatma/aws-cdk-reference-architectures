# ECS のブルー/グリーン: ネイティブと CodeDeploy の比較 - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

Amazon ECS は、従来の **AWS CodeDeploy** 経由に加えて、ブルー/グリーンデプロイを自分で行えるようになりました(**ネイティブ**、2025年から)。このパターンは、同じアプリケーションを両方の方式で並べてデプロイし、それぞれに同じ4つのデプロイを実行します。正常なリリース、ライフサイクルフックが失敗するリリース、ベイク期間中のロールバック、コンテナが起動しないリリースです。プローブが、その間ずっと本番に毎秒5リクエストを送ります。機能の比較表ではなく、実測で違いが分かります。

| | ネイティブの ECS ブルー/グリーン | CodeDeploy のブルー/グリーン |
|---|---|---|
| 誰が実行するか | ECS サービス自身(`deploymentStrategy: BLUE_GREEN`) | CodeDeploy のアプリケーションとデプロイグループ。サービスは `CODE_DEPLOY` コントローラーを使う |
| デプロイの開始 | サービスのタスク定義を更新する | AppSpec を指定して `create-deployment` |
| ライフサイクルフック | 名前付きのステージ(`POST_TEST_TRAFFIC_SHIFT` など)に Lambda | AppSpec に書く Lambda(`AfterAllowTestTraffic` など) |
| 旧バージョンを残す | `bakeTime` | `terminationWaitTime` |
| 自動ロールバック | フックの失敗時 | デプロイの失敗時と、CloudWatch アラーム時 |
| 追加で管理するもの | なし | アプリケーション、デプロイグループ、サービスロール、AppSpec |

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#️-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ上の考慮事項](#-セキュリティ上の考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [動作確認スクリプト](#-動作確認スクリプト)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### 主要コンポーネント

- **VPC**: 2 AZ、パブリックサブネットのみ、NAT ゲートウェイなし。タスクはパブリックIPを持ち、イメージの取得とロードバランサーへの応答を行います。
- **2つの ECS サービス**(Fargate、ARM64、各2タスク): 同じ nginx アプリケーションを動かします。タスクは `{"version", "service", "task"}` を返し、新しいバージョンは `VERSION` を変えたタスク定義のリビジョンです。
- **2つのインターネット向き ALB**: サービスごとに1つで、それぞれ `:80` の本番リスナーと `:8080` のテストリスナーを持ちます。どちらも運用者の IP だけを許可します。
- **ネイティブのサービス**: 本番とテストのリスナーは **リスナールール** を経由します。サービスは、代替のターゲットグループ、両方のルール、Lambda のライフサイクルフック(`POST_TEST_TRAFFIC_SHIFT`)を指定し、ベイク時間は2分です。
- **CodeDeploy のサービス**: リスナーはブルーとグリーンのターゲットグループに転送します。デプロイグループは、その両方とテストリスナー、一斉切り替え、2分の終了待機、失敗時と 5xx アラーム時の自動ロールバックを指定します。
- **フックの Lambda**: 25秒待ち(新しいバージョンがテストリスナーで応答し、本番はまだ旧バージョンを返す時間帯です)、SSM パラメータ(方式ごとに1つ)に従って成功か失敗を返します。2つのフックの仕組みの両方に対応します。
- **`test-deployments.sh`**: 4つのシナリオを両方式で並行して実行し、比較します。

## 🎯 設計判断とベストプラクティス

### 1. 同じアプリケーションと同じ ALB の構成にして、違うのは仕組みだけにする

両方のサービスは、同じタスクの形、同じリスナーの構成(本番 `:80`、テスト `:8080`)、同じフック、旧バージョンの同じ2分の猶予で動きます。測定で差が出たら、それはデプロイを誰が実行するかによります。

### 2. テストリスナーで、本番より先にグリーンを確認できる

デプロイ中は、`:80` がブルーを返す間も、グリーンのタスクが `:8080` で応答します。スクリプトは両方式でこれを確認しました。テストリスナーが `v2` を返し、本番は `v1` のままでした。これがスモークテストの時間帯で、ライフサイクルフックが動く場所でもあります(ネイティブは `POST_TEST_TRAFFIC_SHIFT`、CodeDeploy は `AfterAllowTestTraffic`)。

### 3. 正常なリリース: 数値

| | ネイティブ | CodeDeploy |
|---|---|---|
| 本番が新バージョンを返すまで | 171秒 | 168秒 |
| デプロイが終わるまで | 316秒 | 277秒 |
| 実行全体のリクエスト | 5,811件、HTTP エラー 0 | 4,327件、HTTP エラー 0 |

切り替えまでの時間の大半は、グリーンのタスクの起動、ターゲットが正常になるまでの待機、25秒のフックで、両方式でほぼ同じでした。その後、ベイク時間(ネイティブ)や終了待機(CodeDeploy)の間デプロイが開いたままなので、「終了」は「切り替え」より後になります。プローブは、トラフィックの切り替えとロールバックを含め、一度も HTTP エラーのレスポンスを見ませんでした。両方の実行で、まったく応答がないリクエスト(2秒の curl のタイムアウト)が1分に1回ほどありましたが、デプロイしていない間にも起き、バージョンの変更の2秒以内には一度もありませんでした。原因はデプロイではなくクライアント側です。

### 4. フックが失敗するとロールバックし、本番は気づかない

判定を `fail` にすると、フックは待った後に失敗を返し、本番に触れずにロールバックします。

| | ネイティブ | CodeDeploy |
|---|---|---|
| 断念するまで | 260秒 | 155秒 |
| その後の本番 | v2 | v2 |
| 報告 | `ROLLBACK_SUCCESSFUL`: 「POST_TEST_TRAFFIC_SHIFT ライフサイクルフックが失敗したためロールバック。フックのターゲット…が FAILED を返した」 | `Failed`、その後に CodeDeploy 自身のロールバックのデプロイ |

ネイティブの ECS は、どのフックが失敗したかをデプロイのステータスの理由に書きます。CodeDeploy では、失敗したデプロイが2つ目のロールバックのデプロイを始め、別のデプロイ ID として見えます。

### 5. 本番が切り替わった後のロールバック

旧バージョンがまだ残っている間(ベイク時間、終了待機)は、ロールバックでタスクを1つも起動せずに本番が旧バージョンに戻ります。

| | ネイティブ | CodeDeploy |
|---|---|---|
| ロールバックのコマンド | `aws ecs stop-service-deployment --stop-type ROLLBACK` | `aws deploy stop-deployment --auto-rollback-enabled` |
| 本番が旧バージョンに戻るまで | 20秒 | 14秒 |

ベイク時間や終了待機が過ぎるとブルーはなくなり、ロールバックは旧バージョンの新しいデプロイ(数分)になります。この待機は、即時のロールバックの代償です。その間は旧タスクの費用を払います。

### 6. コンテナが起動しないリリースを、どちらも自分では断念しなかった

コンテナがすぐ終了するリリースは、どちらの方式でも7分以内には自分で失敗しませんでした。ECS はタスクの起動を試み続けます。本番は旧バージョンのままだったのでユーザーは安全でしたが、デプロイは止められるまで止まったままでした(スクリプトは7分後にロールバックで止めます)。これを自動にするには、タイムアウト、アラーム、サーキットブレーカーが必要です。CodeDeploy は CloudWatch アラームでロールバックでき、このスタックには 5xx のアラームがありますが、この障害に対して、アラームもデプロイのサーキットブレーカーも試していません。実際のパイプラインでは、自分で追加して試してください。

### 7. 何を管理したいかで選ぶ

| 選ぶもの | 使う場面 |
|---|---|
| ネイティブの ECS ブルー/グリーン | 動かすサービスと絞り込む権限を1つ減らしたい。Lambda のフックで足りる。デプロイが「タスク定義の更新」で済む |
| CodeDeploy | すでに CodeDeploy のパイプラインがある、CodeDeploy のデプロイ設定(アラーム付きのカナリアや線形の切り替え、パイプラインの AppSpec)や、コンピュートをまたぐコンソールの履歴が必要 |

ネイティブの ECS には線形とカナリアの戦略もありますが、このパターンは公平な比較のため、両方で一斉切り替えのブルー/グリーンを比べています。

### 8. 環境別パラメータ

`parameters/<env>-params.ts` で、CIDR、タスク数、イメージ、ベイク時間、終了待機、フックの遅延を設定します。

## 🏛️ Well-Architected との対応

| 柱 | この構成での対応 |
|---|---|
| 運用上の優秀性 | `test-deployments.sh` が、成功、検証の失敗、ロールバック、壊れたリリースを両方式で予行演習する。デプロイは `describe-service-deployments` と `get-deployment` で観察できる |
| セキュリティ | ロードバランサーは運用者の IP だけを許可、タスクは ALB だけを許可、最小権限のフックのロール、シークレットなし |
| 信頼性 | 新バージョンを検証する間も、本番は旧バージョンを返し続ける。ベイク中は数秒でロールバック。失敗したフックはユーザーに届かない |
| パフォーマンス効率 | ARM64 の Fargate タスク。新タスクが正常になってからトラフィックを移す |
| コスト最適化 | NAT ゲートウェイなし、短いベイク時間、使わないときは両方式を削除(下記) |
| 持続可能性 | 小さなタスクと、短期間だけ動かすスタック |

## 💰 コスト最適化

`ap-northeast-1` の概算です(料金ページで確認してください)。

| 項目 | 目安 |
|---|---|
| ALB 2つ | 1時間あたり約0.045 USD + キャパシティユニット |
| Fargate、ARM64 の4タスク(0.25 vCPU、0.5 GiB)。デプロイ中は最大8 | 1時間あたり約0.1 USD |
| パブリック IPv4 アドレス(タスクと ALB) | 1つあたり1時間約0.005 USD |
| ECS 向けの CodeDeploy | 無料 |

合計は1時間あたり約0.2〜0.3 USD です。検証一式(約45分)は1 USD をはるかに下回りました。終わったらスタックを削除してください。ブルー/グリーンは、デプロイ中とベイク時間の間、動かすタスクが2倍になります。これが安全の代償です。

## 🔒 セキュリティ上の考慮事項

### 実装済み

- 両方の ALB は、運用者の IP(検出するか、`ALLOWED_IPS` / `ALLOWED_IPV6S`)の 80 と 8080 番だけを許可します。タスクは ALB のセキュリティグループからの 80 番だけを許可します。
- フック関数は、2つの判定パラメータの読み取りと CodeDeploy への報告だけができ、ECS の権限はありません。
- CodeDeploy のサービスロールは、AWS マネージドのものに、フックを呼び出す権限を足したものです。
- ロードバランサーは不正なヘッダーフィールドを破棄します。

### CDK Nag の抑制(理由付き)

| ルール | 理由 |
|---|---|
| AwsSolutions-IAM4 / IAM5 | Lambda、ECS 向けの CodeDeploy、ECS のタスク実行ロールの、AWS が文書化したマネージドポリシー。デプロイ用のロールは、AWS がそれ以上細かく定義していないワイルドカードを必要とする |
| AwsSolutions-ELB2 | 運用者に限定した短期間の ALB で、アクセスログにはこの範囲外のバケットが要る |
| AwsSolutions-EC23 | 許可するのは運用者の IP で、`0.0.0.0/0` ではない。ルールがパラメータの CIDR を読めない |
| AwsSolutions-ECS2 / ECS4 | 環境変数はバージョンのラベルとフラグだけ。Container Insights はメトリクス単位の課金 |
| AwsSolutions-VPC7、L1、CdkNagValidationFailure | 短期間の比較なので通信ログなし、作成時点の最新の Node.js、ルールが評価できない参照 |

### スコープ外(環境ごとに追加)

リスナーの HTTPS(ドメインと証明書が要る)、WAF、NAT や VPC エンドポイント付きのプライベートサブネット、タスク定義のリビジョンを作るパイプライン、カナリアや線形のトラフィック切り替え。

## 📋 前提条件

- Node.js 24 以上、AWS CDK v2、CDK ブートストラップ済みの AWS アカウント
- `test-deployments.sh` 用の `aws`(`ecs describe-service-deployments` がある最近の v2)、`curl`、`jq`
- テストするマシンは、スタックが許可する IP のマシンであること

## 🚀 デプロイ手順

```bash
export PROJECT=<project> ENV=dev
npm install
npm run stage:deploy:all -w workspaces/ecs-blue-green-native-vs-codedeploy   # 約7分
./workspaces/ecs-blue-green-native-vs-codedeploy/test-deployments.sh --project $PROJECT --env $ENV   # 約45分
```

テストするマシンとは別のマシンからデプロイする場合は、デプロイ時に `ALLOWED_IPS=<ip>[,<ip>]` を設定してください。

## 🧪 動作確認スクリプト

`./test-deployments.sh --project <project> --env <env> [--only native|codedeploy]` は、`v1` から始め、本番に毎秒5回プローブを送りながら、各方式(両方を並行)で次を実行します。

1. **正常なリリース(v2)**: テストリスナーが `v2` を返す間も本番は `v1` を返し、その後本番が切り替わり、デプロイが成功し、HTTP エラーのリクエストがない
2. **失敗するフック(v3)**: デプロイが自動でロールバックし、本番は `v2` のまま
3. **正常なリリース(v4)を、ベイクや待機の間にロールバック**: 本番が `v2` に戻る。時間を測る
4. **壊れたリリース(v5、コンテナが終了する)**: 方式が自分で断念するかを7分間観察し、その後デプロイを止める。本番は `v2` のままであること

2026-10-10 に `ap-northeast-1` で検証し、両方式ですべて成功しました。数値は上の設計判断にあります。

## 🧪 テスト戦略

```bash
npm test -w workspaces/ecs-blue-green-native-vs-codedeploy
```

- **スナップショット**: テンプレート全体とリソース数。
- **ユニット**: ネイティブの戦略、ベイク時間、代替ターゲットの設定、ライフサイクルフックのステージ、リスナールール、CodeDeploy のコントローラーとデプロイグループ(一斉切り替え、終了待機、ロールバックのイベント、テストリスナー、アラーム)、共通のタスクの形とパブリックサブネットの構成、運用者だけを許可する ALB の許可(IP 単体と CIDR)、方式ごとの判定パラメータ、フックのロール、サンプルコンテナの BREAK の切り替え。
- **コンプライアンス**: 上記の理由付きの CDK Nag `AwsSolutionsChecks`。

## ⚙️ カスタマイズ

| パラメータ | 意味 |
|---|---|
| `vpcCidr`、`desiredCount`、`containerImage` | ネットワーク、タスク数、サンプルのイメージ |
| `nativeBakeMinutes` | 本番が切り替わった後、ネイティブの ECS がブルーを残す時間 |
| `codeDeployTerminationWaitMinutes` | CodeDeploy がブルーを残す時間 |
| `hookDelaySeconds` | サンプルのフックが待つ時間(テストリスナーを確認する時間帯) |

CodeDeploy の別の戦略を使うには `deploymentConfig` を変えます(たとえば `CANARY_10PERCENT_5MINUTES`)。ネイティブの ECS では、`deploymentStrategy` で線形とカナリアを選べます。

## 🔧 トラブルシューティング

### テストリスナーが `503` を返す

CodeDeploy の ALB では、デプロイしていない間はグリーンのターゲットグループが空で、これは想定どおりです。ネイティブの ALB では、デプロイが始まるまで、テストリスナーが本番と同じタスクを返します。

### デプロイが止まったように見える

正常にならないコンテナがあると、デプロイは開いたままになります(設計判断6を参照)。止めてください。`aws ecs stop-service-deployment --service-deployment-arn <arn> --stop-type ROLLBACK`、または `aws deploy stop-deployment --deployment-id <id> --auto-rollback-enabled` です。

### CodeDeploy が新しいデプロイを拒否する

デプロイグループごとに同時に動くデプロイは1つだけです。前のデプロイ(とそのロールバックのデプロイ)が終わるのを待ってください。

### ALB に対して `curl` がタイムアウトする

あなたの IP が、スタックが許可している IP ではありません。`ALLOWED_IPS` を付けて再デプロイしてください。

### 両方のフックが同じ判定を共有しているように見える

方式ごとに別の SSM パラメータ(`/<project>/<env>/bluegreen/hook-verdict-native` と `...-codedeploy`)があります。正しい方を設定してください。

## 🧹 クリーンアップ

```bash
npm run stage:destroy:all -w workspaces/ecs-blue-green-native-vs-codedeploy
```

## 📚 参考資料

- [Amazon ECS blue/green deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-blue-green.html)
- [Choosing between Amazon ECS blue/green native or AWS CodeDeploy in AWS CDK](https://aws.amazon.com/blogs/devops/choosing-between-amazon-ecs-blue-green-native-or-aws-codedeploy-in-aws-cdk/)
- [Lifecycle hooks for Amazon ECS service deployments](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-lifecycle-hooks.html)
- [Deployments on an Amazon ECS compute platform (CodeDeploy)](https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-steps-ecs.html)
- [AppSpec "hooks" section for an Amazon ECS deployment](https://docs.aws.amazon.com/codedeploy/latest/userguide/reference-appspec-file-structure-hooks.html)
