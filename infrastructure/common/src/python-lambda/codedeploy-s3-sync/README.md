# codedeploy-s3-sync

## Description
CodePipeline から呼び出されて実行されます。CodeDeployでS3にデプロイされた場合、リポジトリから削除されたファイルはS3上から削除されない仕様となっています。そのため、アーティファクトのファイルとS3のファイルを比較して差分を削除します。実行に必要な情報は Lambda 関数の環境変数ではなく、CodePipeline からパラメータで渡されます。

## Environment or Paramater
- dest_bucket
    - デプロイ先のS3バケット名を指定します。
- LOG_LEVEL
    - ログレベルを指定します。デフォルトは 'INFO'です。

## Test Parameter
テスト用のパラメータを記載

## Note
注意点など
