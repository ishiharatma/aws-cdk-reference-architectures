import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  spokeACidr: '10.1.0.0/24',
  spokeBCidr: '10.2.0.0/24',
  inspectionCidr: '10.100.0.0/24',
  homeNet: '10.0.0.0/8',
  allowedDomains: ['.amazonaws.com'],
  eastWestAllowedTcpPorts: [8080],
  blockEastWestIcmp: true,
  logRetentionDays: 7,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
