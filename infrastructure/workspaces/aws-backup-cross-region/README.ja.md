# AWS Backup クロスリージョン(東京→大阪) - AWS CDK リファレンスアーキテクチャ

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

> **レベル: 300 (上級)**

東京リージョン(`ap-northeast-1`)の**EC2インスタンス・RDSデータベース・S3バケット・CloudFormationスタック全体**を、リソースタイプ別に選択条件を分けることなく**単一のタグベースBackup Selection**でまとめて保護し、すべての復旧ポイントを大阪リージョン(`ap-northeast-3`)の事前作成済みセカンダリVaultへコピーする、単一のAWS Backup Planパターン。

## 📑 目次

- [アーキテクチャ概要](#-アーキテクチャ概要)
- [設計判断とベストプラクティス](#-設計判断とベストプラクティス)
- [コスト最適化](#-コスト最適化)
- [セキュリティに関する考慮事項](#-セキュリティに関する考慮事項)
- [前提条件](#-前提条件)
- [デプロイガイド](#-デプロイガイド)
- [テスト戦略](#-テスト戦略)
- [カスタマイズ](#-カスタマイズ)
- [トラブルシューティング](#-トラブルシューティング)
- [参考資料](#-参考資料)

## 🏗️ アーキテクチャ概要

![overview](overview.drawio.svg)

```text
Stack 1 — AwsBackupCrrOsakaStack (ap-northeast-3、最初にデプロイ)
  KMSキー + Backup Vault "<project>-<env>-backup-osaka"
    (コピーされた復旧ポイントの受け皿。同一アカウント内なのでVaultアクセスポリシーは不要)

Stack 2 — SampleAppStack (ap-northeast-1)
  S3バケット + SSMパラメータ、Backup=true タグ付与
    「別チームのCloudFormationスタック」の代役 —
    AWS BackupはスタックまるごとをAWS::CloudFormation::Stackとして1つの復旧ポイントで保護できる

Stack 3 — AwsBackupCrrTokyoStack (ap-northeast-1、Stack 1に依存)
  SampleWorkloadConstruct: VPC + EC2インスタンス + RDS(MySQL) + S3バケット、すべてBackup=trueタグ付与
  KMSキー + Backup Vault "<project>-<env>-backup-tokyo"
  Backup Plan「DailyBackup」ルール(cron、JST 01:00、保持35日)
    CopyAction → 大阪Vault ARN(決定的に構築)、保持90日
  Backup Selection: ListOfTags [Backup = true] (ロール: AWSBackupServiceRolePolicyForBackup/Restores)
    ─┬─ EC2インスタンスにマッチ (SampleWorkloadConstruct)
     ├─ RDSインスタンスにマッチ (SampleWorkloadConstruct)
     ├─ S3バケットにマッチ    (SampleWorkloadConstruct)
     └─ CloudFormationスタックにマッチ (SampleAppStack) ─── 1つのPlanで4種類のリソースタイプ
```

### 主要コンポーネント

- **`AwsBackupCrrOsakaStack`** – 大阪にセカンダリBackup Vaultを専用KMSキー付きで事前作成。東京スタックより先にデプロイされ、最初のコピージョブが実行される時点で既に存在している。
- **`SampleAppStack`** – 東京側のワークロードと同じタグを付けた、それ自体は無関係な最小構成のスタック(S3バケット+SSMパラメータ)。AWS Backupが「CloudFormationスタックまるごと」を1つの復旧ポイントとして保護できることを示すための例。
- **`SampleWorkloadConstruct`**(`lib/constructs/`) – 東京にある小さなVPC+EC2+RDS+S3の「アプリケーション」。すべてのリソースに`Backup=true`タグを付与。
- **`AwsBackupCrrTokyoStack`** – プライマリVault、Backup Plan(日次ルール+クロスリージョンコピーアクション)、AWS Backupが引き受けるIAMロール、そして上記すべてを対象とする単一のタグベースBackup Selectionを作成する。

### アーキテクチャの特性

| 特性 | 値 | 根拠 |
|---|---|---|
| 可用性 | 東京リージョン全体の障害でも復旧ポイントが生き残る | すべての復旧ポイントが同じ日次スケジュールで大阪にコピーされる |
| スケーラビリティ | バックアップ対象を追加してもBackup側のコード変更は不要 | タグベース選択が`Backup=true`を付けた新しいEC2/RDS/S3/CloudFormationリソースを自動的に検出する |
| セキュリティ | 両Vaultともローテーション有効なKMSキーで暗号化。IAMロールはAWS Backup自身のマネージドポリシーのみ使用 | [セキュリティに関する考慮事項](#-セキュリティに関する考慮事項)を参照 |
| コスト | 両リージョンのバックアップストレージ+クロスリージョンコピーの分だけ課金 | [コスト最適化](#-コスト最適化)を参照 |

## 🎯 設計判断とベストプラクティス

### 1. リソースタイプ別に分けず、単一のタグベースBackup Selectionにまとめる

**決定**: `AwsBackupCrrTokyoStack`が宣言する`BackupSelection`は`backup.BackupResource.fromTag(backupTagKey, backupTagValue)`を使った1つのみ。EC2・RDS・S3・CloudFormation用に個別のSelectionは作らない。

**根拠**:
- ✅ AWS Backupのタグベース選択はリソースタイプを問わない — マッチするタグを持つアカウント/リージョン内の**あらゆる**サポート対象リソースタイプを自動的に検出する。1つのSelectionで実際に4種類すべてをカバーできる。
- ✅ Backup Planへの新規リソース追加は1行の変更(`Tags.of(resource).add('Backup', 'true')`)で済み、Backup Plan/Selection側のCDK変更は一切不要。
- ✅ このパターンの核となる価値 — 無関係な複数スタック(`SampleAppStack`と`AwsBackupCrrTokyoStack`)や複数リソースタイプにまたがる、単一の中央集権的Backup Plan — を体現している。

**トレードオフ**:
- ❌ タグベース選択は粒度が粗い — リージョン内で`Backup=true`が付いていれば、無関係な理由で追加されたリソースも含まれてしまう。ARNベースの選択であればこのトレードオフを精度側に振れる。
- ❌ タグ付けを忘れたリソースは静かにバックアップ対象から除外される。CDK側に「本来含めるべきリソースが未タグである」ことを検知するガードは存在しない。

### 2. クロスリージョンのCDK参照ではなく、決定的なコピー先Vault ARNを構築する

**決定**: `AwsBackupCrrTokyoStack`は`this.formatArn({ region: 'ap-northeast-3', ... })`で大阪VaultのARNを組み立て、`BackupVault.fromBackupVaultArn`でインポートする。`AwsBackupCrrOsakaStack`のVaultコンストラクト/出力をステージ経由で直接渡すことはしない。

**根拠**:
- ✅ CloudFormationのエクスポート/`Fn::ImportValue`はリージョンをまたげないため、大阪Vaultの`CfnOutput`を東京スタックから直接`Ref`することはできない。アカウント・リージョン・Vault名という既知かつ決定的な要素からARNを再構築する必要がある。
- ✅ 本リポジトリの[ECR Cross-Region Replication](../ecr-cross-region-replication/)パターンで既に採用している手法と一致しており、リファレンスアーキテクチャ全体でクロスリージョン配線の作法を統一できる。
- ✅ `AwsBackupCrossRegionStage`は依然として`tokyoStack.addDependency(osakaStack)`でデプロイ順序を強制しているため、最初のコピージョブが実行される時点で参照先のVaultは確実に存在する。

**トレードオフ**:
- ❌ Vault名はステージと両スタックの間で共有される命名規約(`${project}-${environment}-backup-osaka`)であり、型で保証された参照ではない。片方だけ手動でリネームすると、デプロイ時にコピーアクションが解決できないVault ARNを参照して静かに壊れる。

### 3. Vaultごとに独立した保持期間(プライマリ35日/セカンダリ90日)

**決定**: プライマリ(東京)Vaultの復旧ポイントは35日で失効し、セカンダリ(大阪)Vaultへのコピーは90日保持する。それぞれ`primaryRetentionDays`/`copyRetentionDays`として独立して設定可能。

**根拠**:
- ✅ コピー先のライフサイクルがコピー元と一致する必要はないことを示している — 実務でもよくある要件(DRリージョンのみコンプライアンス上長期保持が必要、あるいは検知に時間がかかるインシデントに備えてDRリージョンだけ意図的に深い履歴を持たせる、など)。
- ✅ コストと保持ポリシーをリージョンごとに独立してチューニングできる。

**トレードオフ**:
- ❌ 大阪側の保持期間が長い分、時間の経過とともに東京より多くの復旧ポイント(=より多くのストレージコスト)が蓄積する — [コスト最適化](#-コスト最適化)を参照。

### 4. コピーアクションによる自動作成に任せず、セカンダリVaultを事前作成する

**決定**: `AwsBackupCrrOsakaStack`が専用のKMSキー付きで大阪Vaultを明示的に作成し、`AwsBackupCrrTokyoStack`より先にデプロイされる。

**根拠**:
- ✅ コピーアクションによって自動作成されたVaultはAWS Backupのデフォルト(AWS所有)暗号化キーを使用し、カスタマーマネージドKMSキーにはならない — 事前作成することで、レプリカ側にも独自のローテーション対応CMKを持たせられる。
- ✅ 同一アカウント内のクロスリージョンコピーには、コピー先Vaultへの**Vaultアクセス(リソースベース)ポリシーは不要**(クロス**アカウント**コピーの場合のみ必要)。これにより大阪スタックを最小限に保てる。

**トレードオフ**:
- ❌ 1つではなく3つのスタック(とデプロイ順序の依存関係)を管理する必要がある。

### Well-Architected Framework との整合性

| 柱 | 実装内容 |
|---|---|
| **運用上の優秀性** | 両Vaultスタックが`CfnOutput`(`VaultArnOutput`)を出力し検証を容易化。タグ1つで新規リソースをBackup Planに追加できる |
| **セキュリティ** | 両Vaultともローテーション有効なKMSキーで暗号化。AWS BackupのIAMロールはAWS自身のマネージドサービスロールポリシーのみ使用(カスタムワイルドカード権限なし)。RDSストレージも暗号化 |
| **信頼性** | クロスリージョンにコピーされる日次バックアップが東京リージョン全体の障害から保護。`tokyoStack.addDependency(osakaStack)`によりVault作成と最初のコピージョブの間の競合状態を排除 |
| **パフォーマンス効率** | AWS Backupのオーケストレーション・スケジューリング・クロスリージョンコピーはすべてフルマネージド — カスタムのポーリング/オーケストレーション用コンピュートは不要 |
| **コスト最適化** | Vaultごとに独立した保持期間(プライマリ35日/セカンダリ90日)により、リージョンごとにストレージ増加を個別に抑制。[コスト最適化](#-コスト最適化)を参照 |
| **持続可能性** | サンプルワークロード自体(バックアップ対象を用意するためのEC2/RDS)以外にアイドルコンピュートは存在しない。AWS Backupのスケジューリングはマネージド基盤上で実行される |

## 💰 コスト最適化

### 月額コスト試算(ap-northeast-1 / ap-northeast-3、本リファレンスアーキテクチャのサンプルワークロード)

```text
プライマリ(東京)Vaultストレージ
  EC2 (EBS 8GB スナップショット、35日保持):                    ~$0.40
  RDS (20GB バックアップストレージ、35日保持):                  ~$1.90
  S3 (デモ用の最小限データ、35日保持):                          ~$0.05
  CloudFormationスタック復旧ポイント(テンプレートのみ):          ~$0.00
セカンダリ(大阪)Vaultストレージ
  同じリソース、90日保持(復旧ポイント数は約2.6倍):              ~$6.10
クロスリージョンコピーのデータ転送(増分、目安):                 ~$0.50-1.00
サンプルワークロード自体(t3.micro EC2 + RDS + NAT Gateway):     ~$45-55
-------------------------------------------
合計(開発環境、デモ利用、サンプルワークロード込み):              ~$55-65/月
合計(AWS Backup Vault/コピーのみ):                             ~$9-10/月
```

*数値はあくまで概算・目安です。AWS Backupのストレージ/コピー料金はリージョンやリソースタイプによって異なり、時間とともに変動します。必ず[AWS Pricing Calculator](https://calculator.aws/)で最新料金をご確認ください。このデモの合計コストはサンプルのEC2/RDS/NAT Gatewayワークロードが支配的です — 実際の導入では、AWS Backupは既に稼働中のワークロードに追加する形になるため、実質的な追加コストは上記のバックアップストレージ/コピー分のみです。*

### コスト最適化戦略

1. **参照頻度が低いリージョンほど保持期間を短く** — 本パターンでは、運用上「本番」として頻繁にリストアが参照されるであろう東京を短め(35日)に、DRリージョンで復元速度よりも履歴の深さが重要になる大阪を長め(90日)に設定している。
2. **タグベース選択で過剰バックアップを回避** — `Backup=true`タグを明示的に付けたリソースのみが対象となり、アカウント全体/サービス全体を対象とするバックアップポリシーのように「意図せず」バックアップされることがない。
3. **`moveToColdStorageAfter`**(本リファレンスでは未使用だが`BackupPlanRule`で利用可能) — 大阪のような長期保持Vaultでは、古い復旧ポイントをコールドストレージへ移行することでさらにコストを削減できる。自身の保持ポリシーに合わせて検討すること。

## 🔒 セキュリティに関する考慮事項

### ネットワークセキュリティ

サンプルのEC2インスタンスとRDSデータベースはプライベートサブネットに配置し、セキュリティグループはVPC内通信のみに限定。EC2インスタンスへのアクセスはSSM Session Manager経由のみ(SSH用のIngressルールなし)。AWS Backup自体はAWS APIを通じて通信しており、顧客VPCネットワーキングは経由しないため、バックアップ構成自体が追加のインバウンド通信経路を生むことはない。

### 実装済みのセキュリティベストプラクティス

- ✅ 両Backup Vaultとも、専用のローテーション有効なKMSキー(AWS所有のデフォルトキーではない)で暗号化。
- ✅ AWS BackupのIAMロールはAWS自身のマネージドポリシー(`AWSBackupServiceRolePolicyForBackup`、`AWSBackupServiceRolePolicyForRestores`)のみを使用 — カスタムのワイルドカード権限は追加していない。
- ✅ RDSストレージは保存時暗号化(`storageEncrypted: true`)。認証情報はSecrets Manager生成のパスワードを使用し、ハードコードは一切なし。
- ✅ EC2インスタンスはIMDSv2を必須化し、暗号化EBSボリュームを使用、SSM Session Manager経由でのみアクセス可能。
- ✅ サンプルワークロードのVPCに対してVPC Flow LogsをCloudWatch Logsへ有効化。
- ✅ 同一アカウント内のクロスリージョンコピーにはVaultアクセス(リソースベース)ポリシーが不要 — ポリシーサーフェスが小さいほどレビューすべき範囲も小さくて済む。

### CDK Nag準拠

3つのスタックすべてが`cdk-nag`の`AwsSolutionsChecks`をパスしており、サプレッションはサンプルワークロードに関するもの(バックアップ構成自体ではない)のみを明記している — スタックを破棄可能に保つための削除保護の意図的な無効化、デモコストを抑えるためのRDSシングルAZ、MySQLのデフォルトポート、そして代替手段のないAWSマネージドなBackupサービスロールポリシー、の4点。各サプレッションの正確な理由は`test/compliance/cdk-nag.test.ts`を参照。

```bash
npm run test:compliance -w workspaces/aws-backup-cross-region
```

## 📋 前提条件

- 適切な権限を持つAWSアカウント
- AWS CLI v2.x のインストールと設定
- Node.js 20.x 以降
- AWS CDK 2.x (`aws-cdk-lib` ^2.265、本ワークスペースに同梱)
- Git

### 必要なIAM権限

デプロイを実行するユーザー/ロールには、以下の作成・管理権限が必要です:
- AWS Backup(Vault、Backup Plan、Backup Selection)— `ap-northeast-1`と`ap-northeast-3`の両方
- EC2(VPC、インスタンス、セキュリティグループ)、RDS、S3、SSM Parameter Store、KMS、IAM(ロール/ポリシーアタッチ)— `ap-northeast-1`
- CloudFormation(スタックデプロイ)— 両リージョン

## 🚀 デプロイガイド

### 1. クローンとセットアップ

```bash
cd infrastructure
npm install
```

### 2. 環境パラメータの設定

コピー先リージョン、バックアップタグ、スケジュール、保持期間を変更したい場合は`parameters/dev-params.ts`を編集してください。デフォルトはJST 01:00に日次実行、東京35日/大阪90日保持です。

### 3. デプロイ

```bash
export PROJECT_NAME=backup-crr-demo
export ENV=dev
npm run bootstrap -w workspaces/aws-backup-cross-region   # 初回のみ、アカウント/リージョンごと
npm run deploy:all -w workspaces/aws-backup-cross-region
```

CDKは`AwsBackupCrrOsakaStack`を`AwsBackupCrrTokyoStack`より先にデプロイします([設計判断4](#4-コピーアクションによる自動作成に任せず セカンダリvaultを事前作成する)を参照)。`SampleAppStack`はどちらとも順序依存関係を持ちません。

### 4. デプロイの確認

`scripts/check-backup-status.sh` は、以下の個別チェックを1回の実行でまとめて確認できるスクリプトです。
Vaultの存在、Planの`CopyAction`のコピー先、Backup Selectionの有無に加え、直近のバックアップ/コピージョブが
(`cdk deploy`が成功しているだけでなく)実際に完了しているかまで判定します。

```bash
./scripts/check-backup-status.sh --project backup-crr-demo --env dev
# --days N で直近ジョブの参照期間を広げられます(デフォルト: 2日)
```

個別に確認したい場合の手動コマンドは以下の通りです:

```bash
# 両Vaultの存在を確認:
aws backup describe-backup-vault --region ap-northeast-1 --backup-vault-name backup-crr-demo-dev-backup-tokyo
aws backup describe-backup-vault --region ap-northeast-3 --backup-vault-name backup-crr-demo-dev-backup-osaka

# タグベース選択が期待通りのリソースを解決しているか確認:
aws backup list-backup-selections --region ap-northeast-1 --backup-plan-id <Plan出力から得たplan-id>

# 最初のスケジュール実行(またはオンデマンドのバックアップジョブ)後、両Vaultに復旧ポイントがあるか確認:
aws backup list-recovery-points-by-backup-vault --region ap-northeast-1 --backup-vault-name backup-crr-demo-dev-backup-tokyo
aws backup list-recovery-points-by-backup-vault --region ap-northeast-3 --backup-vault-name backup-crr-demo-dev-backup-osaka
```

## 🧪 テスト戦略

### テスト構成

```text
test/
├── snapshot/          # CloudFormationテンプレート全体+リソース数のスナップショット(全3スタック)
│   └── snapshot.test.ts
├── unit/               # スタックごとの詳細なリソース/プロパティ/関係性アサーション
│   ├── aws-backup-crr-osaka-stack.test.ts
│   ├── aws-backup-crr-tokyo-stack.test.ts
│   └── sample-app-stack.test.ts
└── compliance/         # cdk-nag AwsSolutionsチェック(スタックごとにtest.each)
    └── cdk-nag.test.ts
```

### 1. スナップショットテスト

**目的**: リファクタリング時の意図しないCloudFormationテンプレート変更を検出する。

```bash
npm run test:snapshot -w workspaces/aws-backup-cross-region
npm run test:snapshot:update -w workspaces/aws-backup-cross-region   # 意図した変更の後に更新
```

### 2. ユニットテスト

**目的**: 各スタックが期待通りのリソース・プロパティ・関係性を生成することを検証する。

**テストカテゴリ**:
- ✅ 大阪スタック: 決定的な共有名を持つKMS暗号化(ローテーション有効)Vaultがちょうど1つ存在し、スタック出力として公開され、Vaultアクセスポリシーが存在しないこと
- ✅ 東京スタック: プライマリVaultが1つ、決定的な大阪Vault ARNへ独立した保持期間でコピーする日次ルールを持つBackup Planが1つ、設定したタグにスコープされたタグベースBackup Selectionが1つ、サンプルEC2/RDS/S3リソースがすべてタグ付けされて存在すること
- ✅ SampleAppスタック: S3バケットとSSMパラメータがそれぞれ1つずつ存在し、EC2/RDS/Backup関連リソースは自身で作成せず、スタック自体にバックアップタグが付与されている(CloudFormationスタック復旧ポイントとして検出可能)こと

### 3. コンプライアンステスト

```bash
npm run test:compliance -w workspaces/aws-backup-cross-region
```

### すべて実行

```bash
npm run build -w workspaces/aws-backup-cross-region
npm test -w workspaces/aws-backup-cross-region
npm run lint -w workspaces/aws-backup-cross-region
```

## ⚙️ カスタマイズ

### コピー先リージョンの変更

```typescript
// parameters/dev-params.ts
awsBackupCrr: {
    destinationRegion: 'us-west-2',   // AWS Backupがサポートする任意のリージョン
    // ...
},
```

### バックアップスケジュール・保持期間の変更

```typescript
// parameters/dev-params.ts
awsBackupCrr: {
    scheduleExpression: 'cron(0 18 * * ? *)',  // JST 01:00ではなくJST 03:00
    primaryRetentionDays: 14,
    copyRetentionDays: 365,                     // 例: DRリージョン側でのコンプライアンス上の長期保持
    // ...
},
```

### 対象リソースを変更する

タグのキー/値を変更し、保護したいリソースにそのタグを付けるだけで済みます。他のコード変更は不要です:

```typescript
// parameters/dev-params.ts
awsBackupCrr: {
    backupTagKey: 'DataClassification',
    backupTagValue: 'critical',
    // ...
},
```

```typescript
// CDKアプリの任意の場所で
cdk.Tags.of(myResource).add('DataClassification', 'critical');
```

## 🔧 トラブルシューティング

### 問題: `cdk deploy`が東京のBackup Planのコピーアクション作成で失敗する

**症状**: `AWS::Backup::BackupPlan`の作成/更新が、大阪Vault ARNの参照で失敗する。

**解決策**:
1. `AwsBackupCrrOsakaStack`が先に正常にデプロイされているか確認する — `AwsBackupCrossRegionStage`は`tokyoStack.addDependency(osakaStack)`を宣言しているが、大阪側のデプロイが部分的に失敗/ロールバックしているとVaultが存在しないままになりうる。
2. スタック間でVault名が一致しているか確認する — `AwsBackupCrrOsakaStack.vaultName`と`AwsBackupCrrTokyoStack`内で構築されるARNはどちらも`${project}-${environment}-backup-osaka`という同じ命名規約から導出される([設計判断2](#2-クロスリージョンのcdk参照ではなく-決定的なコピー先vault-arnを構築する)を参照)。デプロイ間で`PROJECT_NAME`/`ENV`が食い違うとこれが崩れる。

### 問題: タグを付けたリソースがバックアップに現れない

**症状**: `aws backup list-recovery-points-by-backup-vault`に期待するリソースが含まれない。

**解決策**:
1. タグのキー/値が`parameters/dev-params.ts`の`backupTagKey`/`backupTagValue`と完全に一致しているか確認する(大文字小文字を区別)。
2. リソースがBackup Planと**同じリージョン**(`ap-northeast-1`)にあるか確認する — Backup Selectionは自身と同じリージョンのリソースしか検出しない。
3. リソースタイプがAWS Backupのサポート対象か確認する — [AWS Backupのリソース別機能対応表](https://docs.aws.amazon.com/aws-backup/latest/devguide/backup-feature-availability.html)を参照。
4. 最初のバックアップは次のスケジュール実行(`scheduleExpression`)まで走らない — 早く確認したい場合はオンデマンドのバックアップジョブ(`aws backup start-backup-job`)を実行する。

### 問題: 大阪Vaultに復旧ポイントが現れない

**症状**: 東京Vaultには復旧ポイントがあるが、大阪の`list-recovery-points-by-backup-vault`は空。

**解決策**:
1. コピージョブはプライマリのバックアップジョブが完了した**後**に実行される(並行ではない) — `aws backup list-copy-jobs --region ap-northeast-1`でステータスを確認する。
2. Backup Selectionに渡しているIAMロール(`AWSBackupServiceRolePolicyForBackup`)がアタッチされたままか確認する — CDKの外で手動でデタッチすると、次の`cdk deploy`まで静かにコピージョブが失敗し続ける。

## 📚 参考資料

### AWS公式ドキュメント
- [AWS Backup 開発者ガイド](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html)
- [バックアッププランの作成](https://docs.aws.amazon.com/aws-backup/latest/devguide/creating-a-backup-plan.html)
- [バックアップのコピージョブ(クロスリージョン)](https://docs.aws.amazon.com/aws-backup/latest/devguide/copy-backups.html)
- [AWS Backupのリソース別機能対応表](https://docs.aws.amazon.com/aws-backup/latest/devguide/backup-feature-availability.html)
- [AWS CloudFormationスタックの保護](https://docs.aws.amazon.com/aws-backup/latest/devguide/cfn-stacks.html)

### AWS Well-Architected
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [信頼性の柱 — バックアップと障害復旧](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/backup-and-restore.html)

### AWS CDK
- [aws-cdk-lib.aws_backup モジュール](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_backup-readme.html)
- [CDK ベストプラクティス](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)

### 関連アーキテクチャ
- [ecr-cross-region-replication](../ecr-cross-region-replication/) – バックアップ/リストアではなくECRイメージレプリケーションに、同じ東京→大阪クロスリージョンの作法(決定的な命名、コピー先を先にデプロイ)を適用したパターン
- [ecs-fargate-alb](../ecs-fargate-alb/) / [ec2-advanced](../ec2-advanced/) – 本パターンのサンプルEC2/RDSワークロードを置き換える先として参照可能なコンピュートパターン

## 📄 ライセンス

このプロジェクトはMITライセンスの下でライセンスされています。詳細は[LICENSE](../../LICENSE)ファイルをご覧ください。

## 👥 コントリビューション

コントリビューションを歓迎します。詳細は[CONTRIBUTING.md](../../CONTRIBUTING.md)をお読みください。

## 🏆 本リファレンスアーキテクチャについて

本リファレンスアーキテクチャは、本番運用可能なインフラストラクチャを構築するためのAWS CDKベストプラクティスを示すものです。

**対象レベル**: 300(上級)

---

**注記**: これはリファレンス実装です。本番環境へデプロイする前に、必ずご自身の要件や組織のポリシーに照らしてレビュー・カスタマイズしてください。
