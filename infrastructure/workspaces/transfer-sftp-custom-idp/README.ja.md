# Transfer Family SFTP カスタムIdP: PUBLICエンドポイントでSSH鍵認証と接続元IP制限を実現する

*Read this in other languages:* [![🇯🇵 日本語](https://img.shields.io/badge/%F0%9F%87%AF%F0%9F%87%B5-日本語-white)](./README.ja.md) [![🇺🇸 English](https://img.shields.io/badge/%F0%9F%87%BA%F0%9F%87%B8-English-white)](./README.md)

![Level 300](https://img.shields.io/badge/Level-300-orange?style=flat-square)

## はじめに

VPCホスト型エンドポイントが使えない環境向けに、**PUBLICエンドポイント**のAWS Transfer Family SFTPサーバーを構築します。PUBLICエンドポイントにはSecurity Groupを付けられないため、認証時にLambda（カスタムIdP）が接続元IPを検証します。Lambdaは DynamoDB からユーザー情報を取得し、登録済みのSSH公開鍵を返します。許可IP以外からの接続は認証で拒否します。ユーザーの追加、変更、削除は頻度が低いため、管理APIや画面は作らず、AWS CloudShellのシェルスクリプトで管理します。

このアーキテクチャで示すこと:

- PUBLICエンドポイントで使えないSecurity Groupの代わりに、認証時の `sourceIp` 検証でIP制限を行う方法と、その方式で守れる範囲、守れない範囲
- 鍵認証のみ（`SftpAuthenticationMethods: PUBLIC_KEY`）。署名検証はTransfer Familyが行い、Lambdaは秘密鍵を扱わない
- AWS公式Custom IdP Solutionに合わせたDynamoDBスキーマ、無停止の鍵ローテーションに使える複数鍵登録、作成と更新を分ける条件付き書き込み
- LOGICALホームディレクトリと、Lambdaが生成するセッションポリシーによるユーザー別アクセス制御（IAMロールは共有1つ）
- すべての異常系でFail Closed。実環境で検証済み
- 常時起動、スケジュール起動、手動起動の3つの起動モード。停止中のTransfer Familyサーバーにも課金されるため、停止時はサーバーを削除する
- 認証失敗、IP拒否、IdPエラー、転送量のアラームとSNSトピック。サーバーを作り直しても監視が維持される

## 📑 目次

- [アーキテクチャ概要](#アーキテクチャ概要)
- [設計判断とベストプラクティス](#設計判断とベストプラクティス)
- [サーバーの起動モード](#サーバーの起動モード)
- [モニタリング](#モニタリング)
- [コスト最適化](#コスト最適化)
- [セキュリティ考慮事項](#セキュリティ考慮事項)
- [前提条件](#前提条件)
- [デプロイ手順](#デプロイ手順)
- [ユーザー管理（CloudShell）](#ユーザー管理cloudshell)
- [テスト戦略](#テスト戦略)
- [カスタマイズ](#カスタマイズ)
- [トラブルシューティング](#トラブルシューティング)
- [参考資料](#参考資料)

## 🏗️ アーキテクチャ概要

![Architecture Diagram](overview.drawio.svg)

### 主要コンポーネント

- **AWS Transfer Familyサーバー**: `EndpointType: PUBLIC`、プロトコルは `SFTP`、IDプロバイダーは `AWS_LAMBDA`、`SftpAuthenticationMethods: PUBLIC_KEY`。構造化ログをCloudWatch Logsへ出力
- **カスタムIdP Lambda**（`lambda/custom_idp/handler.py`、Python）: プロトコル、ユーザー、`enabled`、接続元IPを検証し、`Role`、`PublicKeys`、セッション`Policy`、`HomeDirectoryType: LOGICAL` を返す
- **DynamoDBユーザーテーブル**: PK `user`、SK `identity_provider_key`（AWS公式Custom IdP Solutionと同じ構成）。AWS管理キーで暗号化、ポイントインタイムリカバリ有効
- **S3バケット**: `s3://<bucket>/<username>/`。TLS必須、パブリックアクセスブロック、バージョニング有効
- **共有のTransferアクセスロール**: Transfer FamilyがAssumeRoleし、ユーザー別のセッションポリシーで絞り込む
- **サーバーcontroller Lambda**（手動、スケジュールのモード）: サーバーの作成と削除、サーバーメトリクスのアラームの作成と削除
- **EventBridge Scheduler**（スケジュールのモード）: スケジュールでcontrollerを呼び出して起動、停止する
- **アラームとSNSトピック**: ログのメトリクスフィルターとCloudWatchアラームが、暗号化したSNSトピックへ通知
- **管理者用マネージドポリシー**: DynamoDBの項目操作をユーザーテーブルのARNに限定。CloudShellを使う運用者に付与する
- **スクリプト**（`scripts/`）: `create` / `get` / `list` / `update-transfer-user-key` / `update-transfer-user-ip` / `set-transfer-user-status` / `delete`、`control-transfer-server.sh`（start / stop / status）、動作確認用の `e2e-test.sh`

### 認証フロー

```text
sftpクライアント ──TCP 22──> Transfer Family (PUBLIC)
                          │ Lambda呼び出し {username, protocol, serverId, sourceIp}
                          ▼
                    protocol == SFTP ?              No → {}
                    イベントにpasswordが無い ?       No → {}
                    username形式が正しい ?           No → {}
                    DynamoDB GetItem（強い整合性）   エラー → {}
                    ユーザー存在 / enabled == true ? No → {}
                    sourceIp ∈ ipv4_allow_list ?     No → {}（リストが空でも {}）
                    鍵 / Role / HomeDirectoryが妥当 ? No → {}
                          ▼
                    {Role, PublicKeys, Policy, HomeDirectoryType, HomeDirectoryDetails}
                          │
                    Transfer FamilyがPublicKeysでSSH署名を検証
```

空のレスポンス（`{}`）には `Role` が含まれないため、Transfer Familyは認証失敗として扱います。

### アーキテクチャの特性

| 特性 | 値 | 理由 |
|---------------|-------|-----------|
| 可用性 | リージョンのマネージドサービス（Transfer Family、Lambda、DynamoDB、S3） | パッチ適用が不要。PUBLICエンドポイントはサービス側でマルチAZ構成 |
| スケーラビリティ | DynamoDBオンデマンド、Lambdaの同時実行 | ユーザー数は少なく、IdPはログインごとに `GetItem` 1回 |
| セキュリティ | 鍵認証のみ、認証時IP検証、ユーザー別セッションポリシー、Fail Closed | [セキュリティ考慮事項](#セキュリティ考慮事項)を参照 |
| コスト | Transfer Familyサーバー1台の時間課金が大半 | 他は従量課金で、この規模ではほぼ0 |

## 設計判断とベストプラクティス

### 1. 接続元IP制限はネットワークではなく認証時に行う

**決定**: IdP Lambdaに渡される `sourceIp` を使い、ユーザーごとの `ipv4_allow_list` に含まれないIPからのログインを拒否します。

**根拠**:
- ✅ Security Groupを付けられないPUBLICエンドポイントで使える
- ✅ サーバー単位ではなくユーザー単位で許可IPを持てる
- ✅ 拒否はユーザー名とIP付きでログに残る

**トレードオフ**:
- ❌ TCP/22はインターネットから到達できます。許可されていないIPのクライアントもSSHハンドシェイクを開始でき、Transfer FamilyがIdPを呼び出した後に拒否されます。これは**ネットワークレベルのフィルタではなく**、スキャンや接続レベルのDoSは防げません
- ❌ ネットワークレベルの制限が必須の場合は、VPCホスト型エンドポイントとSecurity Groupを使います

### 2. データモデルはAWS公式Custom IdP Solutionに合わせ、Solution自体はデプロイしない

**決定**: Solutionの `users` テーブル構成（`user` / `identity_provider_key`、`config.{Role,HomeDirectory,PublicKeys}`、`ipv4_allow_list`、`server_id_allow_list`）とプロバイダー名 `publickeys` を採用し、CDKで小さなLambdaを実装します。

**根拠**:
- ✅ 公式SolutionはSAMテンプレートをCodePipeline/CodeBuildでデプロイする構成で、VPC利用オプションや、このユースケースで使わないLDAP/Okta/Cognito/Entraのモジュールを含む。サーバー、S3、IAMを管理するCDKスタックとはデプロイのライフサイクルが別になる
- ✅ テーブル構成を揃えているため、将来公式Solutionへ移行してもデータ変換が不要

**公式Solutionおよび要件書との差分**:

| 項目 | 本実装 | 公式Solution | 採用理由 |
|---|---|---|---|
| デプロイ | CDKスタック | SAM + CodePipeline | IaCのライフサイクルを1つにし、パイプライン用リソースを増やさない |
| プロバイダーテーブル | なし（`publickeys` 固定） | `identity_providers` テーブル | 鍵認証のみでプロバイダー切替が不要 |
| `enabled` 属性 | 追加（`BOOL`、未設定は無効扱い） | 定義なし | 要件: 削除せずにユーザーを無効化したい |
| ホームディレクトリ | `LOGICAL`、`/` → `/bucket/prefix` | configの `HomeDirectoryDetails` | バケット名とプレフィックス構造をクライアントに見せない |
| IP許可リスト属性 | `ipv4_allow_list`（IPv4とIPv6のCIDRを評価、スクリプトはIPv4を受け付ける） | `ipv4_allow_list`（IPv4） | サーバーはIPv4のみ。デュアルスタックは未有効化 |
| IP許可リストの必須 | 必須（空または未設定は拒否） | 任意 | 要件: IP許可リストの必須化 |
| ユーザー名 | 小文字 `[a-z0-9][a-z0-9_.-]{2,63}`、`@@` 不可 | 小文字、`user@@provider` 構文 | プロバイダーが1つのため |

### 3. 共有のアクセスロール1つとユーザー別セッションポリシー

**決定**: S3アクセス用のIAMロールを1つ作成し、Lambdaがユーザーの `HomeDirectory` からセッションポリシーを生成して絞り込みます。`Role` はユーザーごとに保存するため、後から専用ロールを割り当てられます。

**根拠**:
- ✅ CloudShellからユーザーごとのIAMロールを作る必要がない（管理者ポリシーに `iam:*` が不要）
- ✅ 有効な権限はロールとセッションポリシーの積集合。広いロールを登録しても自分のプレフィックスの外へ出られない
- ✅ LOGICALマッピング（`/` → `/bucket/prefix`）により、他ユーザーのプレフィックスはクライアントから見えない

**トレードオフ**:
- ❌ 共有ロールはバケット全体のオブジェクト権限を持つため、正しさはLambdaのセッションポリシーに依存します。機密性が高いデータは `--role` でユーザー専用ロールを指定すると多層防御になります

### 4. 鍵ローテーションは置換ではなく追加と削除の2段階

**決定**: 公開鍵はDynamoDBの文字列セットとして保存し、`update-transfer-user-key.sh` は `--add-key` と `--remove-fingerprint` を提供します。最後の1本は削除できません。

**根拠**:
- ✅ クライアントの切り替え中は新旧の鍵が併存する（検証済み。両方で接続でき、削除した鍵は直後に拒否された）
- ✅ セットの `ADD` / `DELETE` は原子的で、他の属性に影響しない

### 5. 起動モード: 「止める」はサーバーの削除

**決定**: `serverLifecycle.mode` で `always`、`scheduled`、`manual` を選びます（詳細は[サーバーの起動モード](#サーバーの起動モード)）。後ろの2つでは、Lambdaがサーバーを作成、削除します。

**根拠**:
- ✅ OFFLINE状態のサーバー（`StopServer`）にも課金が続く。公式ドキュメントは、課金を止めるにはサーバーを削除するよう案内している
- ✅ ユーザー、鍵、データはDynamoDBとS3にあるため、作り直しても再登録なしで残る（検証済み）

**トレードオフ**:
- ❌ 起動のたびにサーバーIDと既定のホスト名が変わり、新しい名前のDNSが引けるまで1分ほどかかる
- ❌ ホスト鍵のシークレットを設定しないと、ホスト鍵が変わる（後述）
- ❌ 起動してから `ONLINE` になるまで2から3分かかる

### 6. モニタリングもアーキテクチャの一部

**決定**: アラームは1つのSNSトピックに通知します（[モニタリング](#モニタリング)）。サーバーIDが必要なアラームは、オンデマンドのモードではcontroller Lambdaが作成します。

**根拠**:
- ✅ 起動のたびにサーバーIDが変わると、`AWS/Transfer` のメトリクスアラームが機能しなくなるため
- ✅ スケジュールされた起動または停止の失敗も、専用のアラームで検知できる

### 7. Well-Architected Framework との対応

| 柱 | 実装 |
|--------|---------------|
| **運用上の優秀性** | ユーザーデータ以外はIaC。構造化JSON認証ログ。認証失敗、IdPエラー、転送量のアラームとSNS通知。`scripts/e2e-test.sh` による動作確認。入力検証付きの管理スクリプト |
| **セキュリティ** | 鍵認証のみ、IP許可リスト、Fail Closed、enabledフラグ、セッションポリシー、TLS必須バケット、KMS暗号化ログ、最小権限Lambda（1テーブルへの`GetItem`のみ）、CDK Nag |
| **信頼性** | マネージドサービスのみ。参照は強い整合性。ユーザーテーブルのPITR。バケットのバージョニング |
| **パフォーマンス効率** | 認証ごとに`GetItem`1回。ARM64 Lambda。オンデマンドDynamoDB |
| **コスト最適化** | DynamoDBとLambdaは従量課金。共有ロール1つ。スケジュールまたは手動のモードで、停止中はサーバーの時間課金が発生しない |
| **持続可能性** | サーバーレスの従量課金コンポーネント。ARM64 Lambda。ログ保持期間で保存量を制限 |

## サーバーの起動モード

パラメータファイルの `serverLifecycle` で選びます（デプロイ時に `-c serverMode=always|scheduled|manual` で上書きできます）。

| モード | サーバー | 起動と停止 | 用途 |
|---|---|---|---|
| `always` | CloudFormationリソース | なし | 本番 |
| `scheduled` | controller Lambdaが作成、削除 | EventBridge Scheduler（`startExpression`、`stopExpression`、`timezone`）と手動 | 平日に使う開発環境 |
| `manual` | controller Lambdaが作成、削除 | `control-transfer-server.sh start|stop|status`（controller Lambdaを呼び出す） | たまにしか使わない環境 |

```typescript
serverLifecycle: {
  mode: 'scheduled',
  startExpression: 'cron(0 8 ? * MON-FRI *)',
  stopExpression: 'cron(0 20 ? * MON-FRI *)',
  timezone: 'Asia/Tokyo',
  hostKeySecretArn: 'arn:aws:secretsmanager:...',   // 任意。下記を参照
}
```

動作:

- controllerはタグ `sftp-custom-idp-stack` でサーバーを探すため、状態を持ちません。`start` は冪等です。呼び出しが重なって2台作られた場合は、どの呼び出しもサーバーIDが最小の1台を残し、他を削除します
- `start` は新しいサーバーIDの `BytesIn` / `BytesOut` アラームも作成し、`stop` で削除します。起動中のサーバーに `start` を呼ぶと、消えているアラームを復元します
- スタックを削除すると、controllerが作ったサーバーも削除されます（カスタムリソース）
- サーバーIDはデプロイ時に分からないため、IdPのLambda権限とアクセスロールの信頼ポリシーは、このアカウントのサーバー全体（`server/*`、`user/*`）を対象にします。ロールの信頼ポリシーでは `aws:SourceAccount` も必須です
- CloudShellからの操作: `./control-transfer-server.sh start --wait`、`stop`、`status`（`~/.sftp-user-admin.conf` に `SFTP_CONTROLLER_FUNCTION` を設定します。管理者ポリシーにcontrollerの呼び出し権限があります）

**ホスト鍵**: 設定しない場合、サーバーを作り直すたびにホスト鍵が変わり、クライアントにホスト鍵変更の警告が出ます。フィンガープリントを維持するには、OpenSSH形式のホスト秘密鍵（ed25519またはRSA）をSecrets Managerのシークレットにプレーンテキストで保存し、`hostKeySecretArn` に指定します。

```bash
ssh-keygen -t ed25519 -N '' -f sftp-host-key
aws secretsmanager create-secret --name sftp-host-key --secret-string file://sftp-host-key
```

検証では、ホスト鍵のシークレットを指定すると、作り直しの前後でフィンガープリントが同じでした。ホスト名も起動のたびに変わります。固定の名前が必要なクライアントには、カスタムホスト名（新しいエンドポイントへのRoute 53のエイリアスまたはCNAME）を使います。

## モニタリング

すべてのアラームはSNSトピック `<project>-<env>-sftp-alerts` に通知します（カスタマー管理KMSキーで暗号化し、キーポリシーとトピックポリシーでCloudWatchを許可）。通知先は `monitoring.alertEmails` で追加します（各アドレスでサブスクリプションの確認が必要です）。

| アラーム | 取得元 | 既定値 | 意味 |
|---|---|---|---|
| `...-AuthFailure` | Transferのロググループに対する `"AUTH_FAILURE"` のメトリクスフィルター | 5分に5回 | ブルートフォース、またはクライアントの設定ミス |
| `...-IpDenied` | IdPのロググループに対する `"ip_not_allowed"` のメトリクスフィルター | 5分に1回 | 登録済みユーザーが想定外のIPから接続（鍵の漏えいの可能性） |
| `...-IdpError` | `dynamodb_error` / `unexpected_error` のメトリクスフィルター | 5分に1回 | IdPがFail Closedになり、全ログインが拒否されている |
| `...-BytesIn` / `...-BytesOut` | サーバーの `AWS/Transfer` メトリクス | 5分に1024MB | 異常なアップロード量、ダウンロード量 |
| `...-ServerControllerError` | controllerのLambda `Errors`（オンデマンドのモード） | 1回 | スケジュールされた起動または停止の失敗 |

しきい値と期間はパラメータ（`monitoring`）です。`always` ではサーバーのアラームはCloudFormationリソースです。他のモードではcontrollerが管理し、サーバーがある間だけ存在します。ログのメトリクスフィルターは固定名のロググループに付くため、サーバーを作り直しても有効なままです。

検証では、3つのログ系アラームと、controllerが作成した `BytesIn` アラームが `ALARM` になり、SNSアクションが実行されたことをアラーム履歴で確認しました。

## 💰 コスト最適化

### 月額コスト見積もり（ap-northeast-1）

#### 開発環境（サーバー1台、ログイン数回、転送1GB未満）
```
Transfer Familyサーバー(SFTP):  $219.00  (730時間 × $0.30/時間)
Transfer Familyデータ転送:       ~$0.04  ($0.04/GB、1GB)
Lambda / DynamoDB(オンデマンド): $0.01未満
KMSキー(ログ、通知トピック):      $2.00  (各$1/キー/月)
アラームとカスタムメトリクス:    約$1.50  (アラーム6 × $0.10、メトリクス3 × $0.30)
S3 / CloudWatch Logs:           $0.10未満
-------------------------------------------
合計(開発、常時起動):           約$224/月  (サーバーがある間は約$0.30/時間)
```

サーバーの時間課金が大半を占めます。停止中（OFFLINE）のサーバーにも課金されるため、`scheduled` と `manual` のモードではサーバーを削除します。

```
scheduled、平日22日 × 12時間:  264時間 × $0.30 = 約$79/月  ($219の代わり)
manual、月20時間使用:           20時間 × $0.30 = 約$6/月
```

### コスト最適化戦略

1. **必要なときだけサーバーを起動する（`scheduled` / `manual`）**
   - 削減額: 平日12時間の稼働で約$140/月、たまにしか使わない場合は$219のほぼ全額
2. **全システムで1サーバーを共有する**
   - 削減額: 追加サーバー1台あたり約$219/月
   - ユーザーの分離はサーバーではなく、DynamoDBのレコード、ユーザー別プレフィックス、許可IPで行う
3. **使い捨て環境ではログ暗号化を無効にする（`enableLogEncryption: false`）**
   - 削減額: キー1つあたり$1/月
4. **`logRetentionDays` を調整する**
   - ログ量は少ないため、コストよりも監査で遡れる期間に影響する

## 🔒 セキュリティ考慮事項

### ネットワークセキュリティ

1. **PUBLICエンドポイントにはSecurity Groupがありません。** IP制限は認証時にLambdaが行います。守れない範囲は設計判断1を参照してください。
2. **SFTPのみ。** FTP/FTPSは有効化せず、Lambdaも `SFTP` 以外の `protocol` を拒否します。

### 実装済みのセキュリティベストプラクティス

- ✅ 秘密鍵はAWSもスクリプトも生成、保存、送信しません。登録するのは `.pub` の内容のみで、OpenSSH公開鍵でないファイルはスクリプトが拒否します
- ✅ 公開鍵とパスワードはログに出力しません（Lambdaログに鍵情報が無いことを確認済み）
- ✅ 未登録ユーザー、無効ユーザー、許可リストが空、レコード不正、DynamoDBエラー、想定外の例外はすべてFail Closed
- ✅ `enabled` は `true` の場合のみ有効
- ✅ スクリプトでCIDRを検証（`0.0.0.0/0` は拒否）。保存済みの不正なCIDRはLambdaで一致しない
- ✅ Lambdaロールはユーザーテーブルへの `dynamodb:GetItem` のみ。環境変数に認証情報を持たない
- ✅ Transferのロールは `transfer.amazonaws.com` のみを信頼し、`aws:SourceAccount` と `aws:SourceArn`（`user/<server-id>/*`）で制限
- ✅ DynamoDBはAWS管理キーで暗号化しPITR有効。S3はTLS必須、パブリックアクセスブロック、バージョニング
- ✅ CloudWatch Logsはカスタマー管理キーで暗号化（パラメータで切替）
- ✅ 管理操作はCloudTrailで追跡可能（`dynamodb:PutItem` / `UpdateItem` / `DeleteItem`）
- ✅ 管理者ポリシーはユーザーテーブルのARNに限定（オンデマンドのモードではcontrollerの呼び出しも許可）
- ✅ controllerが削除、参照できるのは自分のスタックのタグが付いたサーバーのみ。作成するアラームも自スタックのプレフィックスのものだけ
- ✅ 通知トピックはカスタマー管理キーで暗号化し、TLSを必須にしている

### CDK Nag コンプライアンス

`test/compliance/cdk-nag.test.ts` でスタックに `AwsSolutionsChecks` を適用します。抑制は `S1`（このデモ用バケットにアクセスログバケットを作らない）、`IAM4`（AWSLambdaBasicExecutionRole）、`IAM5`（セッションポリシーでユーザー別に絞るオブジェクト単位のワイルドカード、ログストリーム名、テーブルのインデックス、リソースで制限できないcontrollerのアクション: `CreateServer`、`ListServers`、Transfer Familyが要求するCloudWatch Logsのdelivery系アクション）で、すべて理由を付けています。テストは3つの起動モードすべてで実行します。

## 📋 前提条件

- AWSアカウントとAWS CLIプロファイル
- Node.js 20以上と、リポジトリの依存関係（`infrastructure/` で `npm ci`）
- AWS CDK 2.x（対象アカウントとリージョンでBootstrap済み）
- `scripts/e2e-test.sh` の実行には `sftp`、`ssh-keygen`、`jq`、`curl`
- ユーザー管理はCloudShellで行います（AWS CLI、`jq`、`ssh-keygen` を同梱）。Windows管理端末にはブラウザ以外は不要です

### 必要なIAM権限

デプロイするプリンシパルは、Transfer Familyサーバー、Lambda関数、DynamoDBテーブル、S3バケット、IAMロールとポリシー、KMSキー、CloudWatch Logsロググループを作成できる必要があります。

## 🚀 デプロイ手順

### 1. セットアップ

```bash
cd infrastructure
npm ci
```

### 2. 環境パラメータの設定

`parameters/dev-params.ts` を編集します（`securityPolicyName`、`logRetentionDays`、`enableLogEncryption`、`lambdaLogLevel`、`retainData`）。

### 3. デプロイ

```bash
export PROJECT=<project> ENV=dev
npm run stage:deploy:all -w workspaces/transfer-sftp-custom-idp
```

### 4. デプロイの確認

```bash
aws cloudformation describe-stacks --stack-name <stack> --query 'Stacks[0].Outputs'
```

出力: `ServerId` / `ServerEndpoint`（always）または `ControllerFunctionName`（他のモード）、`AlertTopicArn`、`UserTableName`、`BucketName`、`TransferAccessRoleArn`、`UserAdminPolicyArn`、`IdpFunctionName`、`TransferLogGroupName`。

### 5. 削除

```bash
npm run stage:destroy:all -w workspaces/transfer-sftp-custom-idp
```

## ユーザー管理（CloudShell）

`scripts/` をCloudShellへアップロード（Actions → Upload file、または `git clone`）し、次を実行します。

```bash
cat > ~/.sftp-user-admin.conf <<'CONF'
SFTP_USER_TABLE=<出力のUserTableName>
SFTP_ACCESS_ROLE_ARN=<出力のTransferAccessRoleArn>
SFTP_CONTROLLER_FUNCTION=<出力のControllerFunctionName。manual、scheduledのみ>
CONF
chmod +x scripts/*.sh
```

CloudShellを開くIAMプリンシパルに、出力の `UserAdminPolicyArn` のマネージドポリシーを付与します。

| 作業 | コマンド |
|---|---|
| ユーザー登録 | `./create-transfer-user.sh --user system01 --public-key ./system01.pub --allowed-ip 203.0.113.10/32 --allowed-ip 198.51.100.0/24 --home /<bucket>/system01` |
| ユーザー表示 | `./get-transfer-user.sh --user system01`（鍵はフィンガープリントで表示） |
| ユーザー一覧 | `./list-transfer-users.sh` |
| 鍵の追加（ローテーション手順1） | `./update-transfer-user-key.sh --user system01 --add-key ./new.pub` |
| 古い鍵の削除（手順3） | `./update-transfer-user-key.sh --user system01 --remove-fingerprint SHA256:...` |
| IP許可リストの置換 | `./update-transfer-user-ip.sh --user system01 --allowed-ip 203.0.113.20/32` |
| 無効化 / 有効化 | `./set-transfer-user-status.sh --user system01 --disable` |
| サーバーの起動、停止、状態確認（manual、scheduled） | `./control-transfer-server.sh start --wait` |
| 削除（確認あり） | `./delete-transfer-user.sh --user system01`（`--force` で確認を省略） |

鍵ペアは接続元システムで作成します: `ssh-keygen -t ed25519 -f transfer-user01`。AWS管理者へ渡すのは `transfer-user01.pub` だけです。

接続: `sftp -i transfer-user01 system01@<ServerEndpoint>`

詳細手順: [docs/user-management.md](docs/user-management.md)、[docs/key-rotation.md](docs/key-rotation.md)、[docs/deployment.md](docs/deployment.md)、[docs/architecture.md](docs/architecture.md)、[docs/test-plan.md](docs/test-plan.md)

## 🧪 テスト戦略

### テスト構成

```
test/
├── snapshot/      # テンプレート全体とリソース数
├── unit/          # Server / Lambda / IAM / DynamoDB / S3 のプロパティ
└── compliance/    # CDK Nag AwsSolutions
tests-python/      # IdP LambdaとcontrollerのLambdaのロジック（28件）
scripts/e2e-test.sh  # デプロイ済みスタックに対する実SFTP検証
```

```bash
npm test -w workspaces/transfer-sftp-custom-idp
python3 -m unittest discover -s tests-python   # boto3が必要
./scripts/e2e-test.sh --stack <stack> --profile <profile> --region <region>
```

### デプロイ検証の結果（ap-northeast-1）

実環境へのデプロイに対して `scripts/e2e-test.sh` の31項目がすべて成功しました（`manual` モードで `--recycle` を指定。最初の20項目は `always` モードでも成功しています）。確認内容は、正常ログイン、複数鍵、CIDR範囲内のIP、鍵ローテーション（削除後に旧鍵が拒否される）、未許可IP、未登録の秘密鍵、未登録ユーザー、無効ユーザー（再有効化を含む）、DynamoDB障害（存在しないテーブルをLambdaに指定）、不正なprotocol（`test-identity-provider`）、プレフィックスの分離、アップロード先が自分のプレフィックスであること、セッションポリシー単独の効果（広いロールをLambdaのセッションポリシーで絞り込み、自分のプレフィックスは許可、他のプレフィックスとバケット直下は拒否。ロール単独では他のプレフィックスを読める）、停止と起動の繰り返し（サーバーIDは変わるが、ユーザーとデータは同じで、ホスト鍵のシークレットがあればホスト鍵も同じ）です。`scheduled` モードでは、スケジュールの時刻にサーバーとアラームが作成され、停止の時刻に削除されることも確認しました。

## ⚙️ カスタマイズ

- **ユーザー専用ロール**: ロールを作成し（信頼先は `transfer.amazonaws.com`、条件 `aws:SourceArn` = `arn:aws:transfer:<region>:<account>:user/<server-id>/*`）、`--role` で指定します
- **セキュリティポリシー**: パラメータの `securityPolicyName`
- **通知先としきい値**: パラメータの `monitoring`
- **デュアルスタック**: 未有効化です。サーバーのアドレスタイプ変更とIPv6のCIDR登録が必要です（LambdaはすでにIPv6のCIDRを評価できます）
- **独自ドメイン**: `ServerEndpoint` に対するRoute 53レコードを作成します

## 🔧 トラブルシューティング

### 問題: ログインが拒否される

1. Lambdaログ（JSON、`reason` フィールド）で理由を確認します。

```bash
aws logs tail <IdpLogGroup> --since 15m --filter-pattern '"FAILURE"'
```

`reason` の値: `protocol_not_allowed`、`password_not_allowed`、`invalid_username`、`user_not_found`、`user_disabled`、`ip_allow_list_empty`、`ip_not_allowed`、`server_not_allowed`、`no_public_keys`、`invalid_role`、`invalid_home_directory`、`dynamodb_error`、`unexpected_error`

2. Transfer側のイベント（`AUTH_FAILURE`、`ERROR`）は `/aws/transfer/<project>-<env>-sftp` にあります。
3. クライアントなしで再現: `aws transfer test-identity-provider --server-id <id> --user-name <user> --server-protocol SFTP --source-ip <ip>`

### 問題: ログインできるがファイル操作が Permission denied になる

Transferのログに `Unable to AssumeRole for user` が出ます。ロールの信頼ポリシーの `aws:SourceArn` は、サーバーARNではなく**ユーザーARN**（`arn:aws:transfer:<region>:<account>:user/<server-id>/*`）にする必要があります。デプロイ検証で判明しました。

### 問題: manual、scheduledのモードで接続できない

`./control-transfer-server.sh status` を確認します。`ABSENT` はサーバーが削除されている状態です（起動するか、スケジュールを確認します）。`start` の後、`ONLINE` になるまで2から3分、新しいホスト名が引けるまで1分ほどかかります。ホスト鍵変更の警告が出る場合は、ホスト鍵のシークレットを設定していないサーバーが作り直されています。

### 問題: ログインできるが一覧が空、または file not found

`config.HomeDirectory` にバケット名が含まれているか（`/<bucket>/<prefix>`）を確認します。

## 📚 参考資料

- [Custom identity providers (Lambda)](https://docs.aws.amazon.com/transfer/latest/userguide/custom-lambda-idp.html)
- [Custom identity provider solution](https://docs.aws.amazon.com/transfer/latest/userguide/custom-idp-toolkit.html)
- [Logical directories](https://docs.aws.amazon.com/transfer/latest/userguide/logical-dir-mappings.html)
- [Transfer Family roles](https://docs.aws.amazon.com/transfer/latest/userguide/requirements-roles.html)
- [DynamoDB PutItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html)
