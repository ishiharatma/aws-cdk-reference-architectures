// ecspresso 設定ファイル（jsonnet 版）。
// ecspresso v2.4+ の jsonnet native function（std.native('env') / std.native('must_env')）で、
// CodeBuild が渡す環境変数を参照する。
//
// cluster / service は SSM Parameter Store 由来の値を CodeBuild 側で
// `aws ssm get-parameter` により ECS_CLUSTER_NAME / ECS_SERVICE_NAME 環境変数へ
// 解決してから ecspresso を実行する想定（buildspec-deploy.yml 参照）。
//
// 本サンプルには ECS クラスタ/サービスの実体が存在しないため、
// このファイルは `ecspresso render` によるローカルレンダリング確認にのみ使用し、
// `ecspresso verify` / `ecspresso deploy`（AWSリソースへアクセスするコマンド）は実行しない。

local env = std.native('env');
local must_env = std.native('must_env');

{
  region: env('AWS_REGION', 'ap-northeast-1'),
  cluster: must_env('ECS_CLUSTER_NAME'),
  service: must_env('ECS_SERVICE_NAME'),
  task_definition: 'ecs-task-def.jsonnet',
  service_definition: 'ecs-service-def.jsonnet',
  timeout: '10m',
}
