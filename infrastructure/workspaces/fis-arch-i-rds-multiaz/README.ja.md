# FIS カオスエンジニアリング: RDS マルチ AZ DB インスタンスとマルチ AZ DB クラスター (PostgreSQL) — クライアント側からフェイルオーバーを計測する

*他の言語で読む(Read this in other languages):* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

アーキテクチャ A と C は **Aurora** のフェイルオーバーを扱いました。このパターンが扱うのは、Aurora ではない **RDS for PostgreSQL** の2種類のマルチ AZ 構成です。Aurora とも、また互いにも挙動が大きく違います。同じ障害注入の方法で、それぞれのクライアントから見たダウンタイムを測ります。VPC 内のプローブ Lambda が両方のエンドポイントへ1秒ごとに新しく接続し、接続できなかった区間と、エンドポイントの先にあるサーバー IP の変化を記録します。

このアーキテクチャで確認できること:

- 2つのマルチ AZ 構成を同じ VPC に並べ、違いが構成だけになるようにする
- それぞれを対象にする FIS アクション。インスタンスは `forceFailover` 付きの `aws:rds:reboot-db-instances`、クラスターは `aws:rds:failover-db-cluster`
- 1秒ごとに新規接続するプローブ(コネクションプールなし)で、「フェイルオーバーは1分ほどかかる」というドキュメント上の説明を実測値に置き換える
- フェイルオーバーなしの再起動を対照群にして、フェイルオーバーが速いと決めつけずに比べる
- 非 Aurora のマルチ AZ DB クラスターを L1 の `CfnDBCluster` で定義する方法と、実際のデプロイで失敗した4つの設定
- 2026-10-02 に実機でデプロイ検証済み。[デプロイ検証結果](#-デプロイ検証結果)を参照

| 構成 | レイアウト | スタンバイの参照 | フェイルオーバーの仕組み |
| ---- | ---------- | :--------------: | ------------------------ |
| **マルチ AZ DB インスタンス**(非クラスター) | プライマリ1台と同期スタンバイ1台、2 AZ | 不可 | インスタンスエンドポイントの DNS がスタンバイへ切り替わる |
| **マルチ AZ DB クラスター** | ライター1台と参照可能なスタンバイ2台、3 AZ、準同期 | 可 | スタンバイが昇格し、クラスターのライターエンドポイントが追随する |

| シナリオ | 注入する障害 | 確認すること |
| -------- | ------------ | ------------ |
| **I-1** マルチ AZ インスタンスの強制フェイルオーバー | `aws:rds:reboot-db-instances`、`forceFailover=true` | インスタンス構成で、クライアントから見たダウンタイム |
| **I-2** マルチ AZ DB クラスターのフェイルオーバー | `aws:rds:failover-db-cluster` | クラスター構成で、クライアントから見たダウンタイム |
| **I-3** マルチ AZ インスタンスの再起動(フェイルオーバー**なし**) | `aws:rds:reboot-db-instances`、`forceFailover=false` | 対照群。スタンバイを使わない単純な再起動の停止時間 |

各テンプレートには、対象エンドポイントのプローブ指標 `ProbeFailure` に基づく CloudWatch アラームを、停止条件として付けています。条件は、1分あたりの失敗が15回以上の状態が5分続くことです。それまでに復旧しないフェイルオーバーは、通常のものではないと判断します。

## 📑 目次

- [アーキテクチャ概要](#️-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティ考慮事項](#-セキュリティ考慮事項)
- [前提条件](#-前提条件)
- [デプロイ手順](#-デプロイ手順)
- [デプロイ検証結果](#-デプロイ検証結果)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#️-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![アーキテクチャ概要](overview.drawio.svg)

### 主要コンポーネント

| コンポーネント | 設計のポイント |
| -------------- | -------------- |
| VPC | 10.90.0.0/16、**3 AZ**(マルチ AZ DB クラスターは3つ必要)、パブリック/プライベート/分離の3層、NAT Gateway 1台(プローブが Secrets Manager を読むため) |
| マルチ AZ DB インスタンス | PostgreSQL 17.9、`db.t4g.small`、`multiAz: true`、gp3 20 GiB、暗号化、認証情報は Secrets Manager |
| マルチ AZ DB クラスター | L1 の `CfnDBCluster`、エンジン `postgres` 17.9、`dbClusterInstanceClass: db.m6gd.large`(このプロパティがマルチ AZ DB クラスター構成を選ぶ)、gp3 20 GiB、暗号化。マスターパスワードは Secrets Manager の動的参照 |
| プローブ Lambda | プライベートサブネット上の Node.js 24(arm64)、タイムアウト 15 分、`pg` を esbuild でバンドル。開始時にシークレットを取得 |
| 停止条件 | `FisRdsProbe/ProbeFailure` のアラーム2つ(Sum、1分、15以上、5データポイント中5つ)。欠損データは正常扱いなので、プローブが動いていなくても実験の開始を妨げない |
| FIS ロール | インスタンス ARN への `rds:RebootDBInstance`、クラスター ARN への `rds:FailoverDBCluster`、アラームの参照、ログ配信 |

### プロジェクト構成

```text
fis-arch-i-rds-multiaz/
├── bin/fis-arch-i-rds-multiaz.ts      # アプリのエントリポイント
├── lib/
│   ├── stages/fis-chaos-stage.ts      # Stage: BaseStack → ProbeStack → FisStack
│   └── stacks/
│       ├── base-stack.ts              # VPC + マルチ AZ DB インスタンス + マルチ AZ DB クラスター (L1)
│       ├── probe-stack.ts             # プローブ Lambda + 停止条件アラーム + SNS
│       └── fis-stack.ts               # FIS ロール + 実験テンプレート 3 つ
├── src/probe/index.ts                 # プローブ Lambda のハンドラー (pg クライアント)
├── run-scenario.sh                    # 動作確認: プローブ + FIS 実行 + 停止区間のレポート
├── parameters/                        # EnvParams (VPC、インスタンスクラス、通知先メール)
└── test/                              # スナップショット、ユニット、cdk-nag
```

### アーキテクチャ特性

| 特性 | 値 | 根拠 |
|---|---|---|
| 可用性 | インスタンスは 2 AZ、クラスターは 3 AZ | 比較する2つの構成そのもの |
| スケーラビリティ | 小さい固定サイズ | 本番のサイジングではなく、計測用の設備 |
| セキュリティ | 分離サブネット、SG はプローブのみ許可、ストレージ暗号化 | [セキュリティ考慮事項](#-セキュリティ考慮事項)を参照 |
| コスト | 短時間だけ存在するスタック | データベースと NAT Gateway は時間課金のため、実験が終わったら削除する |

## 🎯 設計判断とベストプラクティス

### 1. 2つの構成を同じ VPC に置き、同じクライアントで測る

**決定**: インスタンスとクラスターを並べてデプロイし、同じ方法で障害を注入して、同じプローブで両方を測ります。

**根拠**:
- ✅ 違いが構成だけになる
- ✅ プローブは、コネクションプールを持たないアプリケーションが体験する時間(DNS、TCP、TLS、認証を毎回行う)をそのまま測れる

**トレードオフ**:
- ❌ クラスターの `db.m6gd.large` 3台が費用の大半を占めるため、スタックは数週間ではなく数時間だけ動かす前提になる

### 2. フェイルオーバーが本当に起きたことを示すプローブ

**決定**: 各プローブは、新しい接続で `SELECT pg_is_in_recovery(), inet_server_addr()` を実行します。

**根拠**:
- ✅ `pg_is_in_recovery()` により、書き込み可能なプライマリを返したときだけ正常と数えられる
- ✅ `inet_server_addr()` が変われば、エンドポイントの先のノードが実際に入れ替わったと言える
- ✅ EMF の `ProbeFailure` 指標も出すので、停止条件のアラームは RDS 内部の指標ではなく、クライアントから見た状態に基づく

### 3. フェイルオーバーなしの対照群

**決定**: I-3 は `forceFailover=false` でインスタンスを再起動します。

**根拠**: I-1 の強制フェイルオーバーが何を変えるのかを、速いはずだと決めつけずに確かめられます。

### 4. マルチ AZ DB クラスターには L2 コンストラクトがない

**決定**: `CfnDBCluster` で定義します。間違えやすい設定が4つあり、どれも実際のデプロイを失敗させました([トラブルシューティング](#-トラブルシューティング)を参照)。

```typescript
new rds.CfnDBCluster(this, 'MultiAzCluster', {
    engine: 'postgres',
    engineVersion: '17.9',
    port: 5432,                          // L1 は postgres でも既定が 3306
    dbClusterInstanceClass: 'db.m6gd.large',
    allocatedStorage: 20,
    storageType: 'gp3',                  // 400 GiB 未満では iops を指定しない
    // ...
});
```

**両構成の FIS アクション**:

```typescript
// I-1 / I-3: マルチ AZ DB インスタンス。違うのは forceFailover だけ
actionId: 'aws:rds:reboot-db-instances', parameters: { forceFailover: 'true' }   // I-1
actionId: 'aws:rds:reboot-db-instances', parameters: { forceFailover: 'false' }  // I-3

// I-2: マルチ AZ DB クラスター
actionId: 'aws:rds:failover-db-cluster', targets: { Clusters: 'MultiAzCluster' }
```

### 5. 循環依存を避けるスタックの境界

**決定**: プローブを許可する DB セキュリティグループのインバウンドルールは、`ProbeStack` が持つ L1 の `CfnSecurityGroupIngress` にします。アラームの通知先の SNS トピックも `ProbeStack` に作ります。

**根拠**: `addIngressRule()` で足すとルールが `BaseStack` にできてしまい、Base と Probe が循環します。トピックをアラームの隣に置けば、`FisStack` はアラームの ARN だけに依存します。

### 6. Well-Architected Framework との整合性

| 柱 | 実装 |
| -- | ---- |
| **運用上の優秀性** | `run-scenario.sh` で実験を繰り返せて、証跡も出力される。FIS のログは CloudWatch Logs へ |
| **セキュリティ** | 分離サブネット、プローブだけを許可するセキュリティグループ、ストレージ暗号化、Secrets Manager の認証情報、最小権限の FIS ロール |
| **信頼性** | 同じ障害に対して2つのマルチ AZ 設計を比べる。停止条件のアラームで影響範囲を限定 |
| **パフォーマンス効率** | ドキュメント上の数値に頼らず、クライアントから見た実際のフェイルオーバー時間を測る |
| **コスト最適化** | 短時間だけ存在するスタック。各構成が対応する最小のインスタンスクラス |
| **持続可能性** | 実験の期間中だけリソースが存在する |

## 💰 コスト最適化

### 費用の要因(スタックがある間、時間単位で課金)

```text
RDS マルチ AZ DB クラスター:  db.m6gd.large 3台 × 稼働時間 + gp3 ストレージ    (最大の要因)
RDS マルチ AZ インスタンス:   db.t4g.small 2ノード × 稼働時間 + gp3 ストレージ
NAT Gateway:                  稼働時間 + 処理したデータ量
FIS:                          1アクション分あたり $0.10(このパターンの各シナリオは数分で終わる)
Lambda / CloudWatch / SNS:    無視できる額
```

リージョンごとの1時間あたりの合計は、[AWS 料金見積りツール](https://calculator.aws/#/estimate)で確認してください。この検証では、スタックを数時間で作成して削除しました。

### コスト最適化戦略

1. **実験が終わったらすぐ削除する。** 上の費用はすべて時間に比例します。
2. **シナリオは1つずつ実行する。** 実験そのものは短く、費用がかかるのは障害ではなくデータベースです。
3. **インスタンスクラスは小さく保つ。** 試したいのは処理性能ではなくフェイルオーバーの挙動なので、インスタンスは `db.t4g.small`、クラスターも対応する最小のクラスで足ります。

## 🔒 セキュリティ考慮事項

### ネットワークセキュリティ

1. **分離サブネット。** どちらのデータベースもインターネットへの経路がなく、パブリックアクセスもありません。
2. **許可する接続元は1つだけ。** DB のセキュリティグループは、プローブのセキュリティグループからの TCP 5432 だけを許可します。

### 実装されているセキュリティベストプラクティス

- ✅ 両方のデータベースでストレージを暗号化
- ✅ 認証情報は Secrets Manager に置く。クラスターのマスターパスワードは CloudFormation の動的参照で、テンプレートには展開されない
- ✅ 最小権限の FIS ロール。`rds:RebootDBInstance` と `rds:FailoverDBCluster` を、特定の ARN に限定
- ✅ プローブは TLS で接続するが、サーバー証明書は検証しない(`rejectUnauthorized: false`)。測るのは到達性だけなので、アプリケーションのコードには持ち込まないでください

### 意図的に対象外にしたもの

- シークレットのローテーションと削除保護。このスタックは、削除できなければならない短時間用の計測設備です。

### CDK Nag 準拠

`test/compliance/cdk-nag.test.ts` が、3つのスタックすべてに `AwsSolutionsChecks` を実行します。抑制した指摘(VPC フローログ、IAM データベース認証、削除保護、シークレットのローテーション、CDK 管理の Lambda ロール)には、それぞれ理由を書いています。

```bash
npm run test:compliance -w workspaces/fis-arch-i-rds-multiaz
```

## 📋 前提条件

- AWS CLI v2 と `jq`
- Node.js 20 以降、AWS CDK CLI
- FIS のサービスリンクロールがある AWS アカウント(初回の利用時に自動で作られる)

## 🚀 デプロイ手順

### 1. デプロイする

```bash
cd infrastructure
PROJECT=<project> ENV=dev npm run stage:deploy:all -w workspaces/fis-arch-i-rds-multiaz
```

最も時間がかかるのはマルチ AZ DB クラスターの作成で、Base スタックが遅い原因です。

### 2. シナリオを実行する

```bash
cd workspaces/fis-arch-i-rds-multiaz
./run-scenario.sh I-1 --project <project> --env dev --profile <profile>
./run-scenario.sh I-2 --project <project> --env dev --profile <profile>
./run-scenario.sh I-3 --project <project> --env dev --profile <profile>
```

`run-scenario.sh` は、プローブ Lambda を起動し、正常な状態を確かめるために 45 秒待ってから FIS の実験を始めます。そのあと、FIS の結果とプローブが観測した停止区間を出力します(1シナリオ約 7 分)。シナリオは1つずつ実行してください。

### 3. 片付ける

```bash
cd infrastructure
PROJECT=<project> ENV=dev npm run stage:destroy:all -w workspaces/fis-arch-i-rds-multiaz
```

## ✅ デプロイ検証結果

2026-10-02 に `ap-northeast-1`(PostgreSQL 17.9)で検証しました。プローブは各エンドポイントへ1秒ごとに新規接続し、接続タイムアウトは1秒です。各シナリオは最終のコードで1回ずつ実行しました。I-1 だけは、同じスタックの初期のデプロイでも1回実行していて、そのときは13秒でした。

| シナリオ | エンドポイント | プローブが観測した停止 | エンドポイントの先のサーバー IP | 停止中のエラー |
| -------- | -------------- | ---------------------- | ------------------------------- | -------------- |
| I-1 強制フェイルオーバー | インスタンス | **14 秒** | 10.90.7.13 → 10.90.6.107(変化) | 接続タイムアウト |
| I-2 クラスターのフェイルオーバー | クラスター | **13 秒** | 10.90.6.63 → 10.90.7.74(変化) | `ECONNREFUSED` |
| I-3 フェイルオーバーなしの再起動 | インスタンス | **7 秒** | 10.90.6.107(変化なし) | `ECONNREFUSED` |

障害の対象ではないエンドポイントは、どの実行でも失敗が 0 回でした(I-1 と I-3 ではクラスター、I-2 ではインスタンス)。各障害は対象だけに収まっています。停止条件のアラームは作動していません。

この数値から言えることと、言えないことは次のとおりです。

- I-1 と I-2 のあとで IP が変わったので、実際にフェイルオーバーが起きたと分かります。エンドポイントは、元のスタンバイを指すようになりました。I-3 は IP が変わらず、プライマリがその場で再起動されたと分かります。
- アイドル状態の小さなデータベースでは、どちらのフェイルオーバーも 13〜14 秒で終わりました。マルチ AZ インスタンスで一般に言われる 60〜120 秒を大きく下回ります。ただし保証ではありません。フェイルオーバーの時間は、インスタンスの大きさ、書き込みの負荷、クラッシュリカバリの量で変わります。
- このアイドルなデータベースでは、フェイルオーバーなしの再起動(I-3)の方が、フェイルオーバーより*短く*済みました。強制フェイルオーバーが常に速いわけではなく、その価値はプライマリが戻ってこない場合に生き残れることです。この実験では、その場面は試していません。
- 各シナリオは1回ずつの実行なので、数秒の差は実行ごとのばらつきの範囲です。

## 🧪 テスト戦略

### テスト構成

```text
test/
├── compliance/        # cdk-nag の AwsSolutionsChecks、スタックごと (6 テスト)
├── snapshot/          # テンプレート全体とリソース数、スタックごと (6 テスト)
├── unit/              # Fine-grained Assertions (13 テスト)
├── helpers/           # スタックを組み立てる共通処理
└── parameters/        # テスト用パラメータ
```

### 1. スナップショットテスト

**目的**: 合成されたテンプレートの意図しない変更を検知する。バンドルした Lambda のコードでスナップショットが毎回変わらないよう、アセットのハッシュは正規化しています。

```bash
npm run test:snapshot -w workspaces/fis-arch-i-rds-multiaz
```

### 2. ユニットテスト

**目的**: 比較が成り立つための設定を確かめる。

- ✅ インスタンスは通常の PostgreSQL で `MultiAZ: true`。クラスターは非 Aurora で、`DBClusterInstanceClass` によって選ばれ、`Port: 5432`
- ✅ クラスターのマスターパスワードが、Secrets Manager の動的参照になっている
- ✅ プローブ Lambda は VPC 内で動き、タイムアウトは 15 分。アラームは5分連続の失敗を条件にし、欠損データを無視する
- ✅ 3つのテンプレートが、期待どおりのアクションと `forceFailover` の値を持ち、アラームの停止条件が1つずつあり、FIS ロールがインスタンスとクラスターの ARN に限定されている

```bash
npm test -w workspaces/fis-arch-i-rds-multiaz
```

## ⚙️ カスタマイズ

### インスタンスクラスを変える

`parameters/dev-params.ts` の `dbInstanceClass` と `clusterInstanceClass` を変更します。マルチ AZ DB クラスターが使えるクラスは限られます(`db.m5d`、`db.m6gd`、`db.r*d`)。`aws rds describe-orderable-db-instance-options` の `SupportsClusters` で確認してください。

### プローブの時間や間隔を変える

```bash
PROBE_SECONDS=600 LEAD_SECONDS=60 ./run-scenario.sh I-2 --project <project> --env dev --profile <profile>
```

プローブ Lambda には、`{"durationSeconds": ..., "intervalMs": ...}` を直接渡すこともできます。

### シナリオの前に書き込み負荷をかける

フェイルオーバーの時間は、書き込みの負荷とクラッシュリカバリの量で変わります。負荷がある状態で測るには、`run-scenario.sh` の前に、インスタンスまたはクラスターのエンドポイントへ書き込みのワークロードを流してください。

## 🔧 トラブルシューティング

### 問題: クラスターのプローブがいつも `timeout expired` で失敗する

**症状**: インスタンスのプローブは成功するが、クラスターのプローブは一度も成功しない。

**解決策**: `CfnDBCluster` が、**ポート 3306** でクラスターを作っています。`postgres` でも L1 の既定値は 3306 です。`port: 5432` を指定してください。マルチ AZ DB クラスターのポートは、あとから変更できません(`You can't modify the port for a Multi-AZ DB cluster`)。スタックの作り直しが必要です。

### 問題: `You can't specify IOPS or storage throughput for engine postgres and a storage size less than 400`

**解決策**: `iops` を指定しないでください。400 GiB 未満の gp3 には、ベースラインの 3000 IOPS が適用されます。

### 問題: `Can't create a Multi-AZ DB cluster because there aren't enough Availability Zones`

**解決策**: クラスターには 3 AZ のサブネットが必要なので、`maxAzs: 3` にします。3 AZ あっても一度だけ一時的に出たことがあります。サブネットグループがすでに 3 AZ に広がっているなら、デプロイをやり直してください。

### 問題: `You can't create a db.t4g.micro Multi-AZ instance because there are not two Availability Zones with sufficient capacity`

**解決策**: gp3 でそのクラスのリージョン内の空きが足りませんでした。`db.t4g.small` を使います。

### 問題: 変更できないプロパティを変えたあと、スタックが `UPDATE_ROLLBACK_FAILED` になる

**解決策**: RDS がその場での更新を拒否しています。スタックを削除して、デプロイし直してください。

### 問題: 合成時に Base と Probe、または Probe と Fis の循環依存になる

**解決策**: セキュリティグループのルールやアラームのアクションが、相手側のスタックに置かれています。利用する側を持つスタックでルールやトピックを持つようにします(設計判断 5 を参照)。

## 📚 参考資料

### AWS 公式ドキュメント

- [AWS Fault Injection Service の Amazon RDS 向けアクション](https://docs.aws.amazon.com/fis/latest/userguide/fis-actions-reference.html)
- [マルチ AZ DB インスタンスのデプロイ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)
- [マルチ AZ DB クラスターのデプロイ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/multi-az-db-clusters-concepts.html)

### AWS Well-Architected

- [AWS Well-Architected Framework: 信頼性の柱](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)

### AWS CDK

- [aws-rds モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds-readme.html)
- [aws-fis モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_fis-readme.html)

### 関連アーキテクチャ

- [`fis-arch-a-ecs-aurora`](../fis-arch-a-ecs-aurora/)、[`fis-arch-c-ec2-asg-rds`](../fis-arch-c-ec2-asg-rds/)(同じ FIS アクションで Aurora のフェイルオーバーを扱う)

## 📄 ライセンス

このプロジェクトは Apache License, Version 2.0 の下でライセンスされています。詳細は [LICENSE](../../../LICENSE) ファイルを参照してください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は[コントリビューションガイド](../../../docs/contribution/CONTRIBUTING.md)を参照してください。

## 🏆 このリファレンスアーキテクチャについて

このリファレンスアーキテクチャは、障害注入とクライアント側のプローブでデータベースのフェイルオーバーを計測するための、AWS CDK のベストプラクティスを示しています。

**対象レベル**: 300(上級)

---

**注意**: これはリファレンス実装です。本番環境にデプロイする前に、必ず特定の要件および組織のポリシーに従ってレビューおよびカスタマイズしてください。
