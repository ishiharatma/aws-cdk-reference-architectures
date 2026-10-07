# デプロイ手順

## 前提

- `infrastructure/` で `npm ci` 済み
- 対象アカウントとリージョンでCDK Bootstrap済み
- `parameters/<env>-params.ts` に環境パラメータを定義済み

## デプロイ

```bash
cd infrastructure
export PROJECT=<project> ENV=dev
npm run stage:deploy:all -w workspaces/transfer-sftp-custom-idp
```

スタックの出力 `ServerId`、`ServerEndpoint`（`always` のみ。他のモードは `ControllerFunctionName`）、`AlertTopicArn`、`UserTableName`、`BucketName`、`TransferAccessRoleArn`、`UserAdminPolicyArn` を控えます。

## 起動モードの指定

```bash
npm run stage:deploy:all -w workspaces/transfer-sftp-custom-idp -- -c serverMode=scheduled \
  -c "scheduleStart=cron(0 8 ? * MON-FRI *)" -c "scheduleStop=cron(0 20 ? * MON-FRI *)" -c scheduleTimezone=Asia/Tokyo
```

`manual` と `scheduled` はデプロイ直後にサーバーがありません。`./scripts/control-transfer-server.sh start --wait` で起動します。ホスト鍵を固定する場合は `-c hostKeySecretArn=<ARN>` を指定します。

## 通知先の設定

`parameters/<env>-params.ts` の `monitoring.alertEmails` にメールアドレスを設定してデプロイし、届いた確認メールでサブスクリプションを承認します。

## 管理者権限の付与

CloudShellを使うIAMプリンシパルに `UserAdminPolicyArn` のマネージドポリシーをアタッチします。このポリシーは、ユーザーテーブルに対する `GetItem` / `PutItem` / `UpdateItem` / `DeleteItem` / `Query` / `Scan` だけを許可します。

## 動作確認

`scripts/e2e-test.sh` は、手動、スケジュールのモードではサーバーを起動してから実行します（`--recycle` を付けると、停止と再起動の後にユーザー、データ、ホスト鍵も確認します）。管理スクリプトを使って一時ユーザー（`e2e-user01` から `e2e-user04`）を作成し、SFTPで正常系、異常系、権限分離を確認して削除します。

```bash
./scripts/e2e-test.sh --stack <stack名> --profile <profile> --region <region>
```

## 削除

```bash
npm run stage:destroy:all -w workspaces/transfer-sftp-custom-idp
```

`retainData: true` の環境ではテーブルとバケットは残ります。
