// ECS サービス定義（jsonnet 版）。サブネット/SGはSSM経由でDeployステージに渡す想定。

local env = std.native('env');
local must_env = std.native('must_env');

local project = must_env('PROJECT');
local envName = must_env('ENV');
local containerName = '%s-%s-api' % [project, envName];
local targetGroupArn = env('TARGET_GROUP_ARN', '');

{
  desiredCount: std.parseInt(env('DESIRED_COUNT', '1')),
  launchType: 'FARGATE',
  platformVersion: 'LATEST',
  networkConfiguration: {
    awsvpcConfiguration: {
      subnets: std.split(must_env('SUBNET_IDS'), ','),
      securityGroups: std.split(must_env('SECURITY_GROUP_IDS'), ','),
      assignPublicIp: env('ASSIGN_PUBLIC_IP', 'DISABLED'),
    },
  },
  loadBalancers: if targetGroupArn != '' then [
    {
      targetGroupArn: targetGroupArn,
      containerName: containerName,
      containerPort: 8080,
    },
  ] else [],
  deploymentConfiguration: {
    maximumPercent: 200,
    minimumHealthyPercent: 100,
  },
  enableExecuteCommand: env('ENABLE_ECS_EXEC', 'false') == 'true',
}
