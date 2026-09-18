// ECS サービス定義（jsonnet 版）。サブネット/SGはSSM経由でDeployステージに渡す想定。
//
// 【Application Auto Scaling を使う場合の desiredCount の扱いについて】
// ecspresso は service definition に desiredCount キーが存在する場合、
// deploy のたびに UpdateService へその値をそのまま渡す。そのため
// desiredCount を固定値で書いてしまうと、Auto Scaling が現在3や5に
// スケールしていても、deploy 実行のたびにその固定値へ強制的に戻ってしまう
// （ecspresso 本体のソース ecspresso.go / deploy.go の calcDesiredCount()
//  を確認済み: service definition に desiredCount キー自体が無い場合のみ
//  UpdateService の DesiredCount パラメータを省略し、AWS 側の現在値
//  ＝ Auto Scaling が設定した値を変更しない）。
// `ignore:` 設定（ecspresso.jsonnet）は tags のみが対象で、desiredCount を
// 無視する機能は無いため、この省略が唯一の回避策になる。
//
// このサンプルの既定（AUTO_SCALING_ENABLED 未設定 = false）では
// DESIRED_COUNT（既定 1）を毎回書き込む単純な構成のままにしている。
// Application Auto Scaling を設定したサービスに向ける場合は
// AUTO_SCALING_ENABLED=true を渡すこと。desiredCount フィールド自体が
// 出力されなくなり、ecspresso deploy は desiredCount を変更しなくなる。

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
