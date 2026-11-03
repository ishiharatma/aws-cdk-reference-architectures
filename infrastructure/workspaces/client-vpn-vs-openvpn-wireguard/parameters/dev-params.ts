import { params, EnvParams } from 'parameters/environments';
import { Environment } from '@common/parameters/environments';

/**
 * Development Environment Parameters
 */
const devParams: EnvParams = {
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1',
  tags: {},

  targetNetwork: {
    vpcCidr: '10.110.0.0/16',
    maxAzs: 2,
    targetInstanceType: 't4g.nano',
  },

  clientVpn: {
    clientCidr: '10.120.0.0/22',
    subnetAssociations: 2,
    splitTunnel: true,
    transportProtocol: 'udp',
    port: 443,
    sessionTimeoutHours: 8,
    // client2 is the "offboarded user": the handler rejects it although its certificate is valid.
    deniedCommonNames: ['client2.vpn.internal'],
    loginBanner: 'Authorized use only. Connections are logged.',
  },

  openVpn: {
    instanceType: 't4g.micro',
    port: 1194,
    tunnelCidr: '10.121.0.0/24',
  },

  wireGuard: {
    instanceType: 't4g.nano',
    port: 51820,
    tunnelCidr: '10.122.0.0/24',
    mtu: 1420,
  },

  clientSimulator: {
    enabled: true,
    vpcCidr: '10.200.0.0/16',
    instanceType: 't4g.micro',
  },

  vpnIngressCidrs: ['0.0.0.0/0'],
  logRetentionDays: 7,
};

// Register in the params object
params[Environment.DEVELOPMENT] = devParams;
