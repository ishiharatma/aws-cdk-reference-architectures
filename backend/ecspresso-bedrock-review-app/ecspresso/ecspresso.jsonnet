// ecspresso config file (jsonnet version).
// Uses ecspresso v2.4+'s jsonnet native functions (std.native('env') /
// std.native('must_env')) to read the environment variables CodeBuild passes in.
//
// cluster / service are values originating from SSM Parameter Store, which
// the CodeBuild side resolves into the ECS_CLUSTER_NAME / ECS_SERVICE_NAME
// environment variables via `aws ssm get-parameter` before running ecspresso
// (see buildspec-deploy.yml).
//
// This sample has no real ECS cluster/service, so this file is only used to
// confirm local rendering via `ecspresso render`; `ecspresso verify` /
// `ecspresso deploy` (commands that call AWS APIs) are never run.

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
