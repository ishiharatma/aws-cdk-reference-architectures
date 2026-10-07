# テスト計画

自動テストは3種類あります。実環境の確認は `scripts/e2e-test.sh` で行います。

| 種別 | 場所 | 内容 |
|---|---|---|
| CDK | `test/unit`、`test/snapshot`、`test/compliance` | リソースのプロパティ、スナップショット、CDK Nag |
| Lambda | `tests-python` | 許可リスト、Fail Closedの各経路、ログに鍵が出ないこと、controllerの冪等性と重複排除、アラームの作成と削除 |
| 実環境 | `scripts/e2e-test.sh` | 実SFTP接続、Lambda差し替えによる障害再現、S3の配置確認 |

## ケース一覧

| # | ケース | 期待 | 確認方法 |
|---|---|---|---|
| 1 | 登録ユーザー、正しい秘密鍵、許可IP | 成功 | e2e / Lambda |
| 2 | 複数登録鍵のうち1つを使用 | 成功 | e2e |
| 2b | 削除した鍵を使用 | 失敗 | e2e |
| 3 | 許可CIDR内のIP | 成功 | e2e |
| 4 | 正しい秘密鍵、未許可IP | 失敗 | e2e（`test-identity-provider`で送信元IPを指定） / Lambda |
| 5 | 不正な秘密鍵 | 失敗 | e2e |
| 6 | 未登録ユーザー | 失敗 | e2e / Lambda |
| 7 | 無効ユーザー（再有効化後は成功） | 失敗 | e2e / Lambda |
| 8 | DynamoDB取得エラー | 失敗 | e2e（Lambdaの環境変数を存在しないテーブルに変更して復元） / Lambda |
| 9 | 不正なprotocol | 失敗 | e2e（`test-identity-provider`でFTP） / Lambda |
| 10 | 自分の領域のみアクセス可能 | 成功 | e2e（アップロード先が自分のプレフィックス） |
| 11 | 他ユーザー領域へのアクセス | 拒否 | e2e（論理ディレクトリに他領域が存在しない） |
| - | 既存ユーザーの再作成 | 拒否 | e2e（条件付き書き込み） |
| 12 | セッションポリシー単独の効果（ロールは広いまま） | 自分の領域のみ許可、他領域とバケット直下は拒否 | e2e（一時ロールとAssumeRole） |
| 13 | サーバーの停止と再起動 | サーバー削除、新しいサーバーID、ユーザーとデータは維持、ホスト鍵のシークレットがあればホスト鍵も同じ | e2e `--recycle` |
| 14 | アラーム | AuthFailure、IpDenied、IdpError、BytesInがALARMになりSNSが実行される | CloudWatchのアラーム履歴 |
| 15 | スケジュール起動 | 指定時刻にサーバーとサーバー系アラームが作成され、停止時刻に削除される | デプロイ検証（手動確認） |

SFTPの接続元IPは実際の接続元に固定されるため、ケース4の未許可IPは、未許可のCIDRだけを登録したユーザーと、`test-identity-provider` の `--source-ip` 指定の両方で確認しています。

## 実行

```bash
npm test -w workspaces/transfer-sftp-custom-idp
python3 -m unittest discover -s tests-python
./scripts/e2e-test.sh --stack <stack名> --profile <profile> --region <region>
```
