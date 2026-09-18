// ECS service definition (jsonnet version). Subnets/security groups are
// expected to be passed into the Deploy stage via SSM.
//
// [About desiredCount when Application Auto Scaling is in use]
// Whenever the service definition contains a desiredCount key, ecspresso
// passes that value straight through to UpdateService on every deploy. So
// if desiredCount is a fixed number, it silently overwrites whatever count
// Auto Scaling has scaled to (e.g. 3 or 5) on every deploy run (verified
// against ecspresso's own source, ecspresso.go / deploy.go's
// calcDesiredCount(): only when the service definition has no desiredCount
// key at all does ecspresso omit the UpdateService DesiredCount parameter,
// leaving the current AWS-side value -- i.e. whatever Auto Scaling set --
// unchanged). The `ignore:` setting (ecspresso.jsonnet) only covers tags,
// not desiredCount, so omitting the key is the only workaround.
//
// This sample's default (AUTO_SCALING_ENABLED unset = false) keeps the
// simple behavior of writing DESIRED_COUNT (default 1) on every deploy.
// When pointing this at a service that has Application Auto Scaling
// configured, pass AUTO_SCALING_ENABLED=true: the desiredCount field is
// then omitted entirely, and ecspresso deploy stops touching desiredCount.

local env = std.native('env');
local must_env = std.native('must_env');

local project = must_env('PROJECT');
local envName = must_env('ENV');
local containerName = '%s-%s-api' % [project, envName];
local targetGroupArn = env('TARGET_GROUP_ARN', '');
local autoScalingEnabled = env('AUTO_SCALING_ENABLED', 'false') == 'true';

{
  [if !autoScalingEnabled then 'desiredCount']: std.parseInt(env('DESIRED_COUNT', '1')),
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
