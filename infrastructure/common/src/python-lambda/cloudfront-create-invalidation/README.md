# cloudfront-create-invalidation

## Description
CodePipeline から呼び出されて実行されます。指定された CloudFront のキャッシュ無効化を実行します。実行に必要な情報は Lambda 関数の環境変数ではなく、CodePipeline からパラメータで渡されます。

## Environment or Paramater

Lambda の環境変数ではなく、パイプラインからパラメータとして与えられます。

- PIPELINE_NAME
    - 実行されたパイプラインの名称です。
- DISTRIBUTION_ID
    - CloudFront のディストリビューションIDです。
- TOPIC_ARN
    - 通知先の SNS トピック ARN を指定します。環境変数が存在しない場合は SNS トピックへ送信しません。
- LOG_LEVEL
    - ログレベルを指定します。デフォルトは 'INFO'です。

## Test Parameter
テスト用のパラメータを記載

## Note
注意点など
