# ユーザー管理

Windows管理端末からは、ブラウザでAWSマネジメントコンソールを開き、CloudShellからスクリプトを実行します。管理端末にAWS CLIやPythonは不要です。

## 準備（初回のみ）

1. CloudShellで `scripts/` を配置する（Actions → Upload file、または `git clone`）
2. 設定ファイルを作る

```bash
cat > ~/.sftp-user-admin.conf <<'CONF'
SFTP_USER_TABLE=<UserTableName>
SFTP_ACCESS_ROLE_ARN=<TransferAccessRoleArn>
CONF
chmod +x scripts/*.sh
```

`--table` オプションまたは環境変数 `SFTP_USER_TABLE` でも指定できます。

## 公開鍵の受け取り

秘密鍵はAWS側で作成も保管もしません。接続元システムで生成し、`.pub` ファイルだけを受け取ります。

```powershell
ssh-keygen -t ed25519 -f transfer-user01
```

## 登録

```bash
./create-transfer-user.sh --user system01 --public-key ./system01.pub \
  --allowed-ip 203.0.113.10/32 --allowed-ip 198.51.100.0/24 \
  --home /<bucket>/system01
```

- 事前検証: ユーザー名、公開鍵形式、CIDR、ロールARN、ホームディレクトリ
- DynamoDBの条件付き書き込み（`attribute_not_exists`）で、既存ユーザーを上書きしない
- `--role` を省略すると `SFTP_ACCESS_ROLE_ARN` を使う

## 参照

```bash
./get-transfer-user.sh --user system01
./list-transfer-users.sh
```

公開鍵はフィンガープリントで表示します。

## IP許可リストの変更

```bash
./update-transfer-user-ip.sh --user system01 --allowed-ip 203.0.113.20/32 --allowed-ip 198.51.100.0/24
```

指定したCIDRで許可リスト全体を置き換えます。公開鍵、ロール、ホームディレクトリは変更しません。

## 無効化と有効化

```bash
./set-transfer-user-status.sh --user system01 --disable
./set-transfer-user-status.sh --user system01 --enable
```

## 削除

```bash
./delete-transfer-user.sh --user system01
```

存在確認と現在の設定表示のあと、ユーザー名の入力による確認があります。`--force` を指定すると確認を省略します。S3上のデータは削除されません。

## 操作の追跡

すべての変更はDynamoDB APIとしてCloudTrailに記録されます。
