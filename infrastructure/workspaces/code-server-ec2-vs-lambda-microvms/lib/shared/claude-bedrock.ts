import * as iam from 'aws-cdk-lib/aws-iam';
import { Stack } from 'aws-cdk-lib';
import { BedrockParams } from 'parameters/environments';

export const defaultBedrock: Required<BedrockParams> = {
  enabled: true,
  modelId: 'jp.anthropic.claude-sonnet-4-6',
  smallFastModelId: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
};

export const resolveBedrock = (p?: BedrockParams): Required<BedrockParams> => ({ ...defaultBedrock, ...p });

/**
 * Invoke permission for the configured models. Cross-region inference profiles (jp./global./apac.)
 * fan out to foundation models in other Regions, so the foundation-model ARN uses a wildcard Region.
 */
export function claudeInvokePolicy(stack: Stack, cfg: Required<BedrockParams>): iam.PolicyStatement {
  const ids = [cfg.modelId, cfg.smallFastModelId];
  const foundationModels = ids.map((id) => `arn:${stack.partition}:bedrock:*::foundation-model/${id.replace(/^(jp|apac|global|us|eu)\./, '')}`);
  const profiles = ids.map((id) => `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:inference-profile/${id}`);
  return new iam.PolicyStatement({
    sid: 'ClaudeCodeBedrockInvoke',
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: [...foundationModels, ...profiles],
  });
}

/** ~/.claude/settings.json content: makes the CLI and the VS Code extension use Bedrock. */
export function claudeSettings(cfg: Required<BedrockParams>, region: string): string {
  return JSON.stringify({
    env: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: region,
      ANTHROPIC_MODEL: cfg.modelId,
      ANTHROPIC_SMALL_FAST_MODEL: cfg.smallFastModelId,
    },
  }, null, 2);
}
