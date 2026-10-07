# アーキテクチャ

## 構成

- Transfer Familyサーバー: PUBLICエンドポイント、SFTP、IDプロバイダーはAWS_LAMBDA、認証方式はPUBLIC_KEYのみ
- カスタムIdP Lambda: `sourceIp` による接続元IP検証と公開鍵、Role、ホームディレクトリの返却
- DynamoDB: ユーザー情報（AWS公式Custom IdP Solutionの `users` テーブル構成）
- S3: ユーザーごとのプレフィックス（`s3://<bucket>/<username>/`）
- IAM: 共有のTransferアクセスロール、Lambdaセッションポリシーでユーザー別に絞り込み
- CloudWatch Logs: Transferの構造化ログとLambdaの認証ログ（KMSで暗号化）

構成図は `../overview.drawio.svg` を参照してください。

## 起動モード

`serverLifecycle.mode` で `always`（CloudFormationのサーバー）、`scheduled`、`manual` を選びます。後ろの2つはcontroller Lambdaがサーバーを作成、削除します（停止中のサーバーにも課金されるため、停止は削除です）。詳細はREADMEの「サーバーの起動モード」を参照してください。

## モニタリング

認証失敗、IP拒否、IdPエラー、転送量、controllerのエラーのアラームが、暗号化したSNSトピックに通知します。サーバーIDが必要なアラームは、オンデマンドのモードではcontrollerが起動、停止に合わせて作成、削除します。詳細はREADMEの「モニタリング」を参照してください。

## 重要な制約

PUBLICエンドポイントのTCP/22はインターネットから到達できます。本構成のIP制限は、Transfer Familyが渡す `sourceIp` を認証時に検証して拒否する方式で、Security Groupによるネットワークレベルの制限ではありません。接続自体は受け付けられ、認証の段階で拒否されます。

## DynamoDBスキーマ

テーブル: PK `user`（小文字のユーザー名）、SK `identity_provider_key`（固定値 `publickeys`）

| 属性 | 型 | 内容 |
|---|---|---|
| `enabled` | BOOL | `true` のときのみ有効。本実装での追加属性 |
| `ipv4_allow_list` | SS | 許可するCIDR。必須。空または未設定は拒否 |
| `server_id_allow_list` | SS | 任意。指定時はそのサーバーIDのみ許可 |
| `config.Role` | S | Transferが引き受けるIAMロールのARN |
| `config.HomeDirectory` | S | `/<bucket>/<prefix>` |
| `config.PublicKeys` | SS | OpenSSH形式の公開鍵（コメント無し）。複数登録可 |

```json
{
  "user": {"S": "system01"},
  "identity_provider_key": {"S": "publickeys"},
  "enabled": {"BOOL": true},
  "ipv4_allow_list": {"SS": ["203.0.113.10/32", "198.51.100.0/24"]},
  "config": {"M": {
    "Role": {"S": "arn:aws:iam::123456789012:role/TransferSftpAccessRole"},
    "HomeDirectory": {"S": "/example-sftp-bucket/system01"},
    "PublicKeys": {"SS": ["ssh-ed25519 AAAA..."]}
  }}
}
```

## 公式Custom IdP Solutionとの差分

[README.md](../README.md) の「Design Decisions」の表を参照してください。

## ログ

Lambdaは認証ごとにJSONを1行出力します。項目は `result`（SUCCESS/FAILURE）、`reason`、`username`、`sourceIp`、`serverId`、`protocol`、`ipAllowListCheck`、`publicKeyCount` です。公開鍵とパスワードは出力しません。Transfer側の `AUTH_FAILURE` などのイベントはTransferの構造化ログ用ロググループにあります。
