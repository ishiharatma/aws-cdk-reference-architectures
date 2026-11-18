import * as logs from 'aws-cdk-lib/aws-logs';
import { DirectoryParams, NetworkParams } from 'lib/types';

/**
 * Network layout shared by every environment of this reference.
 *
 * 10.97.220.0/23 is split so that WorkSpaces get the largest blocks (/25 each) and the
 * remaining /24 holds AD, endpoints, management and the Transit Gateway attachment.
 * WorkSpaces Personal in Tokyo supports only apne1-az1 and apne1-az4, so every tier uses
 * those two AZ IDs. 10.97.221.128/26 and 10.97.221.192/27 are left unallocated as spare.
 */
export const referenceNetwork: NetworkParams = {
  vpcCidr: '10.97.220.0/23',
  workspacesSubnets: [
    { name: 'ws-az1', availabilityZoneId: 'apne1-az1', cidr: '10.97.220.0/25' },
    { name: 'ws-az4', availabilityZoneId: 'apne1-az4', cidr: '10.97.220.128/25' },
  ],
  directorySubnets: [
    { name: 'ad-az1', availabilityZoneId: 'apne1-az1', cidr: '10.97.221.0/28' },
    { name: 'ad-az4', availabilityZoneId: 'apne1-az4', cidr: '10.97.221.16/28' },
  ],
  endpointSubnets: [
    { name: 'vpce-az1', availabilityZoneId: 'apne1-az1', cidr: '10.97.221.32/27' },
    { name: 'vpce-az4', availabilityZoneId: 'apne1-az4', cidr: '10.97.221.64/27' },
  ],
  managementSubnets: [
    { name: 'manage-az1', availabilityZoneId: 'apne1-az1', cidr: '10.97.221.96/28' },
    { name: 'manage-az4', availabilityZoneId: 'apne1-az4', cidr: '10.97.221.112/28' },
  ],
  transitGatewaySubnets: [
    { name: 'tgw-az1', availabilityZoneId: 'apne1-az1', cidr: '10.97.221.224/28' },
    { name: 'tgw-az4', availabilityZoneId: 'apne1-az4', cidr: '10.97.221.240/28' },
  ],
  // Endpoints the management instance needs to be operated by SSM without internet access
  // (Run Command / Session Manager / Fleet Manager RDP), to read the AD admin secret and to
  // ship logs. WorkSpaces streaming and Managed AD need no endpoint: both are reached through
  // AWS-managed network interfaces. Add development endpoints (e.g. `codecommit`,
  // `codeartifact.api`, `codeartifact.repositories`, `ecr.api`, `ecr.dkr`, `sts`) here when
  // developers need them from WorkSpaces.
  interfaceEndpoints: ['ssm', 'ssmmessages', 'ec2messages', 'secretsmanager', 'logs'],
  flowLogRetention: logs.RetentionDays.THREE_MONTHS,
};

/**
 * AD design shared by every environment: OU tree, security groups, PSO and GPO values.
 *
 * `OU=WSDEV`, `OU=Computers,OU=WSDEV` and `OU=Users,OU=WSDEV` are created by Managed AD
 * itself; everything below is created by the bootstrap script on the management instance.
 */
export const referenceDirectory: DirectoryParams = {
  domainName: 'wsdev.example.co.jp',
  netBiosName: 'WSDEV',
  edition: 'Standard',
  organizationalUnits: [
    { name: 'WorkSpaces', parent: 'OU=Computers', description: 'Computer accounts of WorkSpaces' },
    {
      name: 'ImageBuild',
      parent: 'OU=Computers',
      description: 'WorkSpaces used to build custom images',
    },
    {
      name: 'Admin',
      parent: 'OU=Computers',
      description: 'Management instances (GPO editing, log collection)',
    },
    { name: 'Employees', parent: 'OU=Users', description: 'In-house developers' },
    { name: 'Vendors', parent: 'OU=Users', description: 'Vendor staff' },
    { name: 'Admins', parent: 'OU=Users', description: 'Team administrator accounts (adm-<name>)' },
    { name: 'Disabled', parent: 'OU=Users', description: 'Accounts disabled for inactivity' },
    { name: 'Groups', parent: '', description: 'Security groups of the WorkSpaces environment' },
  ],
  groups: [
    { name: 'WS-Users', parent: 'OU=Groups', description: 'All WorkSpaces users' },
    {
      name: 'WS-LocalAdmins',
      parent: 'OU=Groups',
      description: 'Users temporarily granted local administrator',
    },
    { name: 'WS-Admins', parent: 'OU=Groups', description: 'Team administrator accounts' },
    {
      name: 'Vendor-UserManagers',
      parent: 'OU=Groups',
      description: 'Vendor staff who manage users',
    },
  ],
  // Placeholder values: align with the security department's standard before production.
  passwordPolicy: {
    psoName: 'CustomerPSO-01',
    appliesToGroup: 'WS-Users',
    minPasswordLength: 14,
    passwordHistoryCount: 24,
    maxPasswordAgeDays: 90,
    lockoutThreshold: 5,
    lockoutDurationMinutes: 30,
    lockoutObservationWindowMinutes: 30,
  },
  groupPolicy: {
    inactivityTimeoutSeconds: 900,
    // Event 4688 for every process fills the default 20 MB log in days; 1 GB is the starting
    // point for keeping the ~2-week PoC period. Adjust after observing the real volume.
    securityLogMaxSizeKb: 1048576,
  },
};
