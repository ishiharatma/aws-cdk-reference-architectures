import * as cdk from 'aws-cdk-lib';
import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';
import { referenceDirectory, referenceNetwork } from 'parameters/reference-design';

/**
 * Development Environment Parameters
 *
 * Replace `workspaces.allowedSources` with the fixed global IPs of the standard PCs and
 * `usageReport.notificationEmails` with a real address before deploying.
 */
const devParams: EnvParams = {
  region: 'ap-northeast-1',
  tags: {},

  network: referenceNetwork,
  directory: referenceDirectory,

  managementInstance: {
    instanceType: 't3.medium',
    subnetIndex: 0,
    // Domain join + reboot + OU/group/GPO creation usually takes 10-20 minutes.
    bootstrapTimeoutSeconds: 3600,
  },

  workspaces: {
    ipGroupName: 'wsdev-standard-pc',
    allowedSources: [{ cidr: '203.0.113.10/32', description: 'Standard PC egress (replace)' }],
    // PoC: enabled. Production: disabled (local admin is granted through WS-LocalAdmins GPO).
    userEnabledAsLocalAdministrator: true,
    createDefaultRole: true,
  },

  operatorRole: {
    roleName: 'wsdev-workspaces-operator',
    trustedPrincipalArns: [],
    requireMfa: true,
    maxSessionHours: 1,
  },

  usageReport: {
    // 09:00 JST on the 1st of every month
    scheduleExpression: 'cron(0 9 1 * ? *)',
    timeZone: cdk.TimeZone.ASIA_TOKYO,
    inactiveThresholdDays: 30,
    notificationEmails: ['change-me@example.com'],
    reportRetentionDays: 400,
  },
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
