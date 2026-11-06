import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Test Environment Parameters
 *
 * Static values only (no env-var / network lookups) so snapshots stay deterministic.
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  microvm: {
    baseImageArn: 'arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1',
    baseImageVersion: '1',
    extensions: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'],
  },
  ec2: {},
  controlPlane: { requireMfa: true },
  operations: { alarmEmail: 'ops@example.com', monthlyBudgetUsd: 100 },
  codeCommit: {
    repositoryNames: ['existing-a', 'existing-b'],
    managedRepositoryNames: ['managed-a'],
  },
};

// Register in the params object
params[Environment.TEST] = testParams;
