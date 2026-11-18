import * as cdk from 'aws-cdk-lib';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { referenceDirectory, referenceNetwork } from 'parameters/reference-design';

/**
 * Test Environment Parameters
 *
 * Static values only (no env-var / network lookups) so snapshots stay deterministic.
 */
const testParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},
  network: referenceNetwork,
  directory: referenceDirectory,
  managementInstance: {
    instanceType: 't3.medium',
    subnetIndex: 0,
    bootstrapTimeoutSeconds: 3600,
  },
  workspaces: {
    ipGroupName: 'test-standard-pc',
    allowedSources: [
      { cidr: '203.0.113.10/32', description: 'Office egress' },
      { cidr: '198.51.100.0/28', description: 'VPN egress' },
    ],
    userEnabledAsLocalAdministrator: true,
    createDefaultRole: true,
  },
  operatorRole: {
    roleName: 'test-workspaces-operator',
    trustedPrincipalArns: [],
    requireMfa: true,
    maxSessionHours: 1,
  },
  usageReport: {
    scheduleExpression: 'cron(0 9 1 * ? *)',
    timeZone: cdk.TimeZone.ASIA_TOKYO,
    inactiveThresholdDays: 30,
    notificationEmails: ['ops@example.com'],
    reportRetentionDays: 400,
  },
};

params[Environment.TEST] = testParams;
