import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},
  anthropic: {
    // Issued in the Claude Console (Managed Agents > Environments > self_hosted).
    environmentId: process.env.ANTHROPIC_ENVIRONMENT_ID || 'env_REPLACE_ME',
  },
  microvm: {
    // AWS-managed al2023 base image (aws lambda-microvms list-managed-microvm-images, ap-northeast-1)
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
  },
  network: {
    egressMode: (process.env.EGRESS_MODE as 'internet' | 'firewall') || 'internet',
    ingressMode: (process.env.INGRESS_MODE as 'all' | 'none') || 'all',
    allowedDomains: [
      'api.anthropic.com',
      '.amazonaws.com',
    ],
  },
  operations: {
    alarmEmail: process.env.ALARM_EMAIL || undefined,
    staleThresholdMinutes: 240,
  },
};

params[Environment.DEVELOPMENT] = devParams;
