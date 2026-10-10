import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/** Static values only so snapshots stay deterministic. */
export const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  anthropic: { environmentId: 'env_test' },
  microvm: {
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
  },
  network: {
    egressMode: 'internet',
    ingressMode: 'all',
    allowedDomains: ['api.anthropic.com', '.amazonaws.com'],
  },
  operations: { alarmEmail: 'ops@example.com', staleThresholdMinutes: 240, monthlyBudgetUsd: 100 },
};

params[Environment.TEST] = testParams;
