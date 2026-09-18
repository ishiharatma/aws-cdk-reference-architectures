import { params } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'lib/types';

/**
 * Development environment parameters.
 */
const devParams: EnvParams = {
  accountId: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  branchName: 'develop',
  requireManualApproval: false,

  // Bedrock モデルはここを書き換えるだけで切り替わる（コード変更不要）。
  // CodeBuild の BEDROCK_MODEL_ID 環境変数として渡される。
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  riskThreshold: 'high',

  ecsTaskCpu: 256,
  ecsTaskMemory: 512,
  // サンプルなので固定値 1。対象サービスに Application Auto Scaling を
  // 設定する場合は autoScalingEnabled: true にすること（この ecsDesiredCount
  // は無視され、Auto Scaling がスケールした値を deploy が上書きしなくなる。
  // 詳細は lib/types/index.ts の autoScalingEnabled のコメント参照）。
  ecsDesiredCount: 1,
  enableEcsExec: false,
  autoScalingEnabled: false,

  // Trivy スキャン結果（ASFF変換済み）を Security Hub に実送信するかどうか。
  // false（既定）ではログ出力のみで、Security Hub へは送信しない。
  securityHubImportEnabled: process.env.SECURITYHUB_IMPORT_ENABLED === 'true',
};

params[Environment.DEVELOPMENT] = devParams;
