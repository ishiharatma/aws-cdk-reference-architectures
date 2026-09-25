# Aurora の Secrets Manager ローテーション - AWS CDK リファレンスアーキテクチャ

[![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md)
[![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **Level: 300 (Intermediate)**

**Aurora PostgreSQL(Serverless v2)** の認証情報を **AWS Secrets Manager のマネージドローテーション(hosted rotation)** で自動ローテーションします。AWS が提供する 2 つの戦略を使い分けます。

| シークレット | 戦略 | 理由 |
|---|---|---|
| **マスター**(`dbadmin`) | **単一ユーザー** — ユーザー自身がパスワードを変更 | 管理者ユーザーは複製できない(複製に管理者権限が必要なため) |
| **アプリケーション**(`appuser`) | **交互ユーザー** — `appuser` ↔ `appuser_clone` | 常に片方のユーザーが有効なので、直前の認証情報を保持するコンシューマーも動き続ける |

すべて **NAT ゲートウェイのない分離サブネット**で動作し、hosted rotation の関数は VPC インターフェイスエンドポイント経由で Secrets Manager API に到達します。サンプルのコンシューマーは **RDS Data API** を使うので、パスワードを保持せず、データベースへのネットワーク経路も不要です。

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [Well-Architected との対応](#-well-architected-との対応)
- [コスト最適化](#-コスト最適化)
- [セキュリティ](#-セキュリティ)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [動作確認スクリプト](#-動作確認スクリプト)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [クリーンアップ](#-クリーンアップ)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### 主要コンポーネント

- **VPC** — 2 AZ、プライベート分離サブネットのみ、NAT ゲートウェイなし、REJECT のフローログ。ローテーション関数用の **Secrets Manager インターフェイスエンドポイント**(プライベート DNS)。
- **Aurora PostgreSQL 16 Serverless v2** — ライターのみ、暗号化、IAM 認証有効、**Data API 有効**、バックアップ保持 1 日(dev 以外は 7 日)、dev 以外は削除保護。
- **マスターシークレット**(`<project>-<env>-rot/master`)— `dbadmin` 用に生成してクラスターにアタッチ。30 日ごとの**単一ユーザーの hosted rotation**。
- **アプリケーションシークレット**(`<project>-<env>-rot/app`)— `appuser` 用の `DatabaseSecret`。JSON にマスターシークレットの ARN(`masterarn`)を持ち、30 日ごとの**マルチユーザー(交互)の hosted rotation**。
- **Hosted rotation** — Secrets Manager が管理するローテーション関数(`createSecret` / `setSecret` / `testSecret` / `finishSecret`)。コードの記述もパッチ適用も不要です。分離サブネット内で専用のセキュリティグループ(エンドポイントへの 443 とデータベースへの 5432 のみ)で動作します。
- **`whoami` Lambda**(Node.js 24 / ARM64、VPC の**外**)— アプリケーションシークレットで Data API 経由の `SELECT current_user` を実行します。IAM はクラスターへの `rds-data:ExecuteStatement` と、その 1 つのシークレットへの `secretsmanager:GetSecretValue` のみ。

### アーキテクチャの特性

| 特性 | 値 | 根拠 |
|---|---|---|
| ローテーション間隔 | 30 日(パラメータ)、デプロイ時にはローテーションしない | Secrets Manager がスケジュールし、確認スクリプトが明示的に実行する |
| ネットワーク | インターネット経路なし、NAT なし | ローテーションに必要な出口は Secrets Manager エンドポイントだけ |
| コンシューマーのモデル | 実行時にシークレットを読む | ローテーションに再デプロイ・再起動・キャッシュ無効化のコードが不要 |
| 影響範囲 | ローテーション関数が到達できるのはエンドポイントと DB ポートのみ | 専用のセキュリティグループ、`allowAllOutbound: false` |

## 🎯 設計判断とベストプラクティス

### 1. 認証情報ごとに 2 つの戦略を選ぶ

**単一ユーザー**はユーザー自身のパスワードを上書きするため、変更後に古いパスワードで開かれた接続が失敗しうる短い時間帯があります。ユーザーを複製できない場合(マスターユーザー)に使います。**交互ユーザー**は 2 つのデータベースユーザー(`appuser`、`appuser_clone`)を持ちます。ローテーションは*使われていない*方のユーザーに新しいパスワードを設定して `AWSCURRENT` をそちらへ切り替え、もう片方のユーザーは以前の有効なパスワードを保ちます。アプリケーションの認証情報にはこちらを使います。

### 2. 最初のローテーションの前にアプリケーションユーザーが存在している必要がある

`DatabaseSecret` が作るのは*シークレット*だけで、CloudFormation はデータベースのロールを作りません。確認スクリプトのブートストラップ手順が、マスターの認証情報を使って Data API 経由で `appuser`(シークレットの初期パスワード)を作成します。実際のデプロイではスキーマ/マイグレーションの手順に含めます。**ロールが存在するまで、アプリケーションのローテーションは失敗します。**このため、デプロイ時にはローテーションしません(`rotateImmediatelyOnUpdate: false`)。

### 3. マルチユーザーのローテーションにはシークレットに `masterarn` が必要

ローテーション関数は、アプリケーションシークレットの `masterarn` フィールドから管理者の認証情報を見つけます。`DatabaseSecret({ masterSecret })` がこれを書き込み、`HostedRotation.postgreSqlMultiUser({ masterSecret })` が関数にそのシークレットへのアクセスを付与します。ユニットテストでフィールドの存在を検証しています。

### 4. NAT ゲートウェイなし: Secrets Manager のインターフェイスエンドポイント

hosted rotation の関数は VPC 内で動き、Secrets Manager API を呼ぶ必要があります。NAT ゲートウェイでも動きますが(時間課金 + GB 課金)、たった 1 つの宛先しか要らない関数にインターネット経路を開けることになります。インターフェイスエンドポイントならサブネットを真に分離でき、NAT の料金も避けられます。ローテーション用セキュリティグループにはエンドポイントへの 443 を許可します。

### 5. コンシューマーは認証情報を永久にキャッシュしてはいけない

Data API は認証情報の解決を代行してくれますが、**数分間キャッシュします**。ここでの実測(3 回のローテーション)では、`AWSCURRENT` が切り替わった後もコンシューマーは約 2.4 分、3.4 分、3.7 分の間*旧*ユーザーで接続し続け、その後新しいユーザーに切り替わりました。これには 2 つの意味があります。(1) 交互ユーザーでは旧認証情報が有効なままなので、この時間帯は**クエリの失敗がゼロ**(確認スクリプトが検証: 時間帯内のすべてのサンプルが、旧または新ユーザーとして成功したクエリ)。(2) 単一ユーザーのローテーションなら同じ時間帯は失敗を意味し、これこそ交互ユーザーが存在する理由です。コンシューマーが自前で接続を開く場合は、認証失敗時(またはローテーション期間より短い間隔)にシークレットを再取得して 1 回リトライしてください。

### 6. Aurora Serverless v2、ライターのみ

`serverlessV2MinCapacity: 0.5` でリファレンスを安価にしつつ、検証中は常時稼働させています。Data API は PostgreSQL 16 の Serverless v2 で動作します。

### 7. `cdk destroy` の後はシークレットを強制削除する

CloudFormation はシークレットを、名前を**予約**する復旧期間付きで削除するため、同じスタックの再デプロイは期間が終わるまで失敗します。`test-rotation.sh --destroy` はスタック削除後に 2 つのシークレットを強制削除します(本番では行わないこと — 復旧期間は安全網です)。

### 8. 環境別パラメータ

`parameters/<env>-params.ts` の `minCapacity`、`maxCapacity`、`rotationDays`、`appUsername`、`databaseName`。

## 🏛️ Well-Architected との対応

| 柱 | 実装 |
|---|---|
| **運用上の優秀性** | ローテーションはマネージド機能、`test-rotation.sh` が実際にローテーションして認証情報の動作を実証、拒否されたトラフィックのフローログ |
| **セキュリティ** | 長期間共有されるパスワードなし、交互ユーザーのローテーション、分離サブネットでインターネット経路なし、ストレージ暗号化、Data API のコンシューマーはシークレットを保持しない、最小権限のコンシューマー IAM、専用のローテーション用セキュリティグループ |
| **信頼性** | 交互ユーザーで認証情報変更による停止を回避、Serverless v2 のスケール、バックアップ |
| **パフォーマンス効率** | Serverless v2 のキャパシティが負荷に追従、ローテーションはリクエスト経路の外で実行 |
| **コスト最適化** | NAT ゲートウェイなし、hosted rotation(コード不要、従量課金)、小さな ACU 範囲 |
| **持続可能性** | データベースのキャパシティが弾力的、スケジュールの間はローテーション用に何も動かない |

## 💰 コスト最適化

概算(ap-northeast-1)です。**料金ページで単価を確認してください。**

```
Aurora Serverless v2:  最小 0.5 ACU x 730 時間 x (ACU 時間単価、約 $0.12〜0.20)   ≈ 月 $45〜75(支配的なコスト)
                       + ストレージと I/O(小)
インターフェイスエンドポイント: 2 AZ x 730 時間 x (約 $0.014/時間、要確認) + データ     ≈ 月 $20
Secrets Manager:       2 シークレット x $0.40 + API 呼び出し                          ≈ 月 $1
Hosted rotation:       2 関数、ローテーションの各ステップで 1 回(4 回)呼び出し        ≈ 数セント
フローログ / CloudWatch Logs: 少量
------------------------------------------------------------------------------------------------
≈ 稼働中は月 $70〜100。検証実行(数時間)なら数ドル程度。
```

レバー: Aurora Serverless v2 は auto-pause による 0 ACU までのスケールに対応(再開時のレイテンシが増える)、dev では単一 AZ のエンドポイントでエンドポイント料金が半分になる、**使い終わったらスタックを削除**(`--destroy`)— データベースとエンドポイントは時間課金です。

## 🔒 セキュリティ

### 実装済み
- ✅ 両方のシークレットの自動ローテーション、アプリケーションの認証情報は交互ユーザー
- ✅ 分離サブネット、NAT/IGW なし、ローテーション用 SG は 443(エンドポイント)と DB ポートに限定
- ✅ ストレージ暗号化、IAM 認証有効、dev 以外は削除保護
- ✅ コンシューマーはパスワードを保持せず、IAM も最小(クラスターへの `ExecuteStatement`、1 つのシークレットへの `GetSecretValue`)
- ✅ REJECT のフローログ

### CDK Nag の抑制(理由付き)

| ルール | 理由 |
|---|---|
| `AwsSolutions-RDS10` | 削除保護は環境依存(スタックを破棄できるよう dev/test では無効、本番では有効)。ユニットテストで両方を検証 |
| `CdkNagValidationFailure`(EC23) | エンドポイントのルールの送信元が VPC の CIDR(CloudFormation のトークン)でルールが評価できない。許可するのは VPC 内からの 443 のみ |
| `AwsSolutions-IAM4` / `IAM5` / `L1` | ライブラリが生成するフローログ/ログ保持用のロールと hosted rotation のコンポーネントは CDK/AWS が管理 |
| `AwsSolutions-RDS6` | IAM 認証は有効で、シークレットベースの経路が本パターンの要点 |

### 対象外(環境ごとに追加)
- シークレットとクラスターのカスタマー管理 KMS キー、シークレットのクロスリージョンレプリケーション、ローテーション失敗のアラーム(CloudTrail の `RotationFailed` イベント → SNS の EventBridge ルールなど)、リードレプリカ、`CONNECT`/`USAGE` を超える `appuser` の最小権限グラント。

## 📋 前提条件

- CDK の bootstrap 済みの AWS アカウント、`${PROJECT}-${ENV}` という名前のプロファイルを設定した AWS CLI v2、Node.js 20 以上、確認スクリプト用の `jq` と `sha256sum`
- 対象リージョンで **Aurora PostgreSQL 16.13** と **RDS Data API**(Serverless v2)が利用可能であること
- クラスターの作成に**約 10 分**かかります

## 🚀 デプロイ手順

```bash
cd infrastructure
npm install
export PROJECT=<project> ENV=dev

npm run bootstrap        -w workspaces/secrets-rotation-aurora   # 初回のみ
npm run synth            -w workspaces/secrets-rotation-aurora
npm run stage:deploy:all -w workspaces/secrets-rotation-aurora
```

その後、アプリケーションのロールを 1 回作成し(確認スクリプトも行います)、ローテーションを実行します。

```bash
CLUSTER=<ClusterArn の出力>; MASTER=<MasterSecretArn の出力>; APP=<AppSecretArn の出力>
PW=$(aws secretsmanager get-secret-value --secret-id $APP --query SecretString --output text | jq -r .password)
aws rds-data execute-statement --resource-arn $CLUSTER --secret-arn $MASTER --database appdb --sql "CREATE ROLE appuser LOGIN PASSWORD '$PW'"
aws secretsmanager rotate-secret --secret-id $APP
```

## 🧪 動作確認スクリプト

データベースや Secrets Manager API に到達できないローテーションは、実行されて初めて失敗します。デプロイの数週間後かもしれません。[`test-rotation.sh`](./test-rotation.sh) は実際にローテーションを実行します。

```bash
./test-rotation.sh --project <project> --env dev            # 検証
./test-rotation.sh --project <project> --env dev --destroy  # 検証後にスタックを削除し、シークレットも強制削除
```

(0) `appuser` を作成し、両方のシークレットで 30 日ごとのローテーションが有効であることを確認、(1) コンシューマーが `AWSCURRENT` のユーザーで接続、(2) アプリケーションシークレットをローテーションし、**新しいバージョン**、シークレットが**もう片方のユーザーを指す**こと、**新しいパスワード**(フィンガープリントで比較し、値は出力しない)、直前の認証情報が `AWSPREVIOUS` に残ること、両方のデータベースロールが存在すること、コンシューマーが**再デプロイなしで新しいユーザーに切り替わる**こと(数分後)と、その間に**クエリの失敗がゼロ**であることを検証、(3) 再度ローテーションしてユーザーが**交互になる**ことを検証、(4) マスターシークレットをローテーションし、新しいパスワードが**引き続き動く**こと(`current_user = dbadmin`)を検証します。`aws`、`jq`、`sha256sum` が必要で、所要時間は 10〜15 分です。

## 🧪 テスト戦略

```bash
npm test -w workspaces/secrets-rotation-aurora   # 18 テスト
```

| 種類 | 対象 |
|---|---|
| スナップショット(2) | テンプレート + リソース数(Lambda アセットのハッシュは正規化) |
| ユニット(14) | NAT/IGW なし、エンドポイント、フローログ、クラスター設定(Serverless v2、Data API、暗号化)、環境ごとの削除保護、DB へのインバウンドはローテーション用 SG のみ、2 つのローテーションスケジュール(間隔、デプロイ時にローテーションしない)、単一ユーザーとマルチユーザー + `masterarn`、シークレット名、コンシューマーが VPC の外にあること、コンシューマーの IAM |
| コンプライアンス(2) | CDK Nag `AwsSolutions` |
| 運用確認 | デプロイ済みスタックに対する `test-rotation.sh` |

## ⚙️ カスタマイズ

- **他のエンジン**: `HostedRotation.mysqlMultiUser` / `mysqlSingleUser`、`oracle…`、`sqlServer…`、`mariaDb…`、`mongoDb…`。パターンは同じです。
- **ローテーションの時間帯**: `rotationDays`。`automaticallyAfter` の `Duration` の代わりに、メンテナンスウィンドウ向けの cron の `ScheduleExpression` も使えます。
- **独自のローテーション関数**: データベース以外のシークレット(API キー)には `secret.addRotationSchedule('X', { rotationLambda })`。
- **接続を持つコンシューマー**: 認証失敗時にシークレットを再取得するか、AWS Secrets Manager のキャッシュクライアントを使います(TTL は設定可能で、古い認証情報を許容できる時間より短くします)。
- **マルチリージョン**: DR 用クラスターのためにシークレットをレプリケート(`replicaRegions`)。

## 🔧 トラブルシューティング

### アプリケーションのローテーションが `setSecret` で失敗する
データベースのロールが存在しない(設計判断 2 を参照)か、マスターシークレットを読めません(`masterarn` がない / 権限不足)。ローテーション関数のロググループ(`/aws/lambda/<project>-<env>-rot-app-rotation`)を確認してください。

### ローテーションがタイムアウトする
関数が Secrets Manager API またはデータベースに到達できません。インターフェイスエンドポイント(プライベート DNS が有効)、ローテーション用 SG の 443/5432 のルール、関数が分離サブネットで動いていることを確認してください。

### ローテーション後もコンシューマーが旧ユーザーのまま
RDS Data API はシークレットを数分キャッシュします(実測 2〜4 分)。交互ユーザーなら、その間も旧認証情報は有効です。待って再試行してください。

### `cdk deploy` が "secret ... is scheduled for deletion" で失敗する
以前のスタックのシークレットが復旧期間中で、名前を予約しています。強制削除してください: `aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery`(dev のみ)。

### しばらくすると `cdk deploy` が "no credentials" で失敗する
同梱の CDK は期限切れの SSO トークンを更新できません。短期認証情報をエクスポート(`aws configure export-credentials --format env`)するか、`aws sso login` をやり直してください。

## 🧹 クリーンアップ

```bash
./test-rotation.sh --project $PROJECT --env $ENV --destroy   # または npm run stage:destroy:all の後に 2 つのシークレットを強制削除
```

クラスターの削除には数分かかります。2 つのシークレットは、名前を再利用できるよう強制削除されます。

## 📚 参考資料

### AWS ドキュメント
- [AWS Secrets Manager シークレットのローテーション](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html)
- [ローテーション戦略: 単一ユーザーと交互ユーザー](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets_strategies.html)
- [RDS Data API の使用](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html)
- [Secrets Manager の VPC エンドポイント](https://docs.aws.amazon.com/secretsmanager/latest/userguide/vpc-endpoint-overview.html)

### 関連アーキテクチャ
- [alb-keycloak-auth](../alb-keycloak-auth/) — アプリケーションの背後の Aurora Serverless(生成したシークレットの認証情報)
- [fis-arch-a-ecs-aurora](../fis-arch-a-ecs-aurora/) — ECS + Aurora
- [cognito-apigw-auth](../cognito-apigw-auth/) — API のためのマネージドな ID

## 📄 ライセンス

このプロジェクトは MIT ライセンスです。詳細は [LICENSE](../../LICENSE) を参照してください。

## 👥 コントリビュート

コントリビュートを歓迎します。詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) を参照してください。

## 🏆 このリファレンスアーキテクチャについて

**対象レベル**: 300 (Intermediate)

---

**注意**: これはリファレンス実装です。本番利用の前に、カスタマー管理キー、ローテーション失敗のアラート、最小権限のデータベースグラントを追加してください。クラスターとエンドポイントは時間課金であることも忘れないでください。
