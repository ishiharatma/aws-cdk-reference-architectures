import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { DirectoryParams, ManagementInstanceParams } from 'lib/types';

const SSM_SCRIPT_DIR = path.join(__dirname, '../../src/ssm');

/** Relative OU (to the delegated OU) the management instance joins into. */
export const MANAGEMENT_COMPUTER_OU = 'OU=Admin,OU=Computers';
/** Relative OU WorkSpaces computer accounts are created in. */
export const WORKSPACES_COMPUTER_OU = 'OU=WorkSpaces,OU=Computers';
/** AD groups that GPO-WS-LocalAdmin puts into the local Administrators group. */
export const LOCAL_ADMINISTRATOR_GROUPS = ['WS-Admins', 'WS-LocalAdmins'];

/** Properties of {@link ManagementInstance}. */
export interface ManagementInstanceProps {
  readonly namePrefix: string;
  readonly vpc: ec2.IVpc;
  readonly subnet: ec2.ISubnet;
  /** CIDRs of the management subnets (WinRM source for WorkSpaces). */
  readonly managementCidrs: string[];
  readonly vpcCidr: string;
  readonly params: ManagementInstanceParams;
  readonly directory: DirectoryParams;
  readonly dnsIpAddresses: string;
  readonly adminSecret: secretsmanager.ISecret;
}

/**
 * Windows Server 2025 management instance that builds the AD objects.
 *
 * A State Manager association runs the bootstrap document once the instance reports to SSM
 * (through the VPC endpoints). CloudFormation waits for the association to succeed
 * (`WaitForSuccessTimeoutSeconds`), so stacks that depend on the OU tree (the WorkSpaces
 * directory registration with `DefaultOu`) are created only after it exists.
 */
export class ManagementInstance extends Construct {
  public readonly instance: ec2.IInstance;
  public readonly bootstrapDocument: ssm.CfnDocument;
  public readonly installDcvAdmxDocument: ssm.CfnDocument;
  public readonly association: ssm.CfnAssociation;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: ManagementInstanceProps) {
    super(scope, id);

    const { directory } = props;

    const securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: 'Management instance: no inbound, outbound to the VPC only',
      allowAllOutbound: false,
    });
    // AD (DNS/Kerberos/LDAP/SMB/ADWS/RPC), VPC endpoints (443) and WinRM to WorkSpaces (5985)
    // are all inside the VPC; there is no route to anywhere else.
    securityGroup.addEgressRule(
      ec2.Peer.ipv4(props.vpcCidr),
      ec2.Port.allTraffic(),
      'Inside the VPC'
    );
    // S3 gateway endpoint (SSM agent updates / Run Command output) has public S3 addresses.
    // The VPC has no internet gateway or NAT, so HTTPS to any address can only reach S3
    // through the gateway endpoint route; this avoids a synth-time prefix list lookup.
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'S3 gateway endpoint (no other route exists)'
    );

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Management instance: SSM managed node + read the AD admin secret',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    props.adminSecret.grantRead(role);

    const instance = new ec2.Instance(this, 'Instance', {
      vpc: props.vpc,
      vpcSubnets: { subnets: [props.subnet] },
      instanceType: new ec2.InstanceType(props.params.instanceType),
      machineImage: ec2.MachineImage.latestWindows(
        ec2.WindowsVersion.WINDOWS_SERVER_2025_ENGLISH_FULL_BASE
      ),
      securityGroup,
      role,
      requireImdsv2: true,
      associatePublicIpAddress: false,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(50, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    cdk.Tags.of(instance).add('Name', `${props.namePrefix}-management`);
    this.instance = instance;

    // ------------------------------------------------------------------
    // Bootstrap document (domain join + OU / group / PSO / GPO creation)
    // ------------------------------------------------------------------
    const config = {
      domainName: directory.domainName,
      netBiosName: directory.netBiosName,
      managementComputerOu: MANAGEMENT_COMPUTER_OU,
      organizationalUnits: directory.organizationalUnits,
      groups: directory.groups,
      passwordPolicy: directory.passwordPolicy,
      groupPolicy: directory.groupPolicy,
      gpoTargets: { workspacesOu: WORKSPACES_COMPUTER_OU, adminOu: MANAGEMENT_COMPUTER_OU },
      localAdministratorGroups: LOCAL_ADMINISTRATOR_GROUPS,
      winRm: {
        ipv4Filter: props.managementCidrs.map(cidrToRange).join(','),
        remoteAddresses: props.managementCidrs,
      },
    };
    const configBase64 = Buffer.from(JSON.stringify(config), 'utf-8').toString('base64');
    const stage2Base64 = Buffer.from(readScript('Build-AdObjects.ps1'), 'utf-8').toString('base64');

    this.bootstrapDocument = new ssm.CfnDocument(this, 'BootstrapDocument', {
      documentType: 'Command',
      documentFormat: 'JSON',
      content: {
        schemaVersion: '2.2',
        description:
          'Join the management instance to Managed AD and build OUs, groups, PSO and GPOs',
        parameters: {
          ConfigBase64: { type: 'String', description: 'Base64 JSON of the AD design' },
          DnsIpAddresses: {
            type: 'String',
            description: 'Domain controller IPs (comma-separated)',
          },
          AdminSecretArn: {
            type: 'String',
            description: 'Secrets Manager ARN of the AD admin password',
          },
          Region: { type: 'String', description: 'Region of the secret' },
        },
        mainSteps: [
          {
            action: 'aws:runPowerShellScript',
            name: 'Bootstrap',
            inputs: {
              timeoutSeconds: '3600',
              runCommand: scriptLines([
                "$ConfigBase64 = '{{ ConfigBase64 }}'",
                "$DnsIpAddresses = '{{ DnsIpAddresses }}'",
                "$AdminSecretArn = '{{ AdminSecretArn }}'",
                "$Region = '{{ Region }}'",
                `$NetBiosName = '${directory.netBiosName}'`,
                `$Stage2Base64 = '${stage2Base64}'`,
                readScript('common.ps1'),
                readScript('bootstrap-management-instance.ps1'),
              ]),
            },
          },
        ],
      },
    });

    this.association = new ssm.CfnAssociation(this, 'BootstrapAssociation', {
      name: this.bootstrapDocument.ref,
      associationName: `${props.namePrefix}-ad-bootstrap`,
      targets: [{ key: 'InstanceIds', values: [this.instance.instanceId] }],
      parameters: {
        ConfigBase64: [configBase64],
        DnsIpAddresses: [props.dnsIpAddresses],
        AdminSecretArn: [props.adminSecret.secretArn],
        Region: [cdk.Stack.of(this).region],
      },
      waitForSuccessTimeoutSeconds: props.params.bootstrapTimeoutSeconds,
    });

    // ------------------------------------------------------------------
    // DCV ADMX installer (run manually once the first WorkSpace exists)
    // ------------------------------------------------------------------
    this.installDcvAdmxDocument = new ssm.CfnDocument(this, 'InstallDcvAdmxDocument', {
      documentType: 'Command',
      documentFormat: 'JSON',
      content: {
        schemaVersion: '2.2',
        description:
          'Copy wsp.admx / wsp.adml from a WorkSpace into the Group Policy Central Store',
        parameters: {
          WorkSpaceComputerName: {
            type: 'String',
            description: 'Computer name of a running WorkSpace (e.g. WSAMZN-XXXXXXXX)',
            allowedPattern: '^[A-Za-z0-9-]{1,15}$',
          },
        },
        mainSteps: [
          {
            action: 'aws:runPowerShellScript',
            name: 'InstallDcvAdmx',
            inputs: {
              timeoutSeconds: '600',
              runCommand: scriptLines([
                "$WorkSpaceComputerName = '{{ WorkSpaceComputerName }}'",
                `$DomainName = '${directory.domainName}'`,
                `$AdminSecretArn = '${props.adminSecret.secretArn}'`,
                `$Region = '${cdk.Stack.of(this).region}'`,
                `$NetBiosName = '${directory.netBiosName}'`,
                readScript('common.ps1'),
                readScript('install-dcv-admx.ps1'),
              ]),
            },
          },
        ],
      },
    });
  }
}

/** Read a PowerShell script shipped under src/ssm. */
function readScript(name: string): string {
  return fs.readFileSync(path.join(SSM_SCRIPT_DIR, name), 'utf-8');
}

/** Join script parts and split them into the line array SSM `runCommand` expects. */
function scriptLines(parts: string[]): string[] {
  return parts.join('\n').replace(/\r\n/g, '\n').split('\n');
}

/** `10.97.221.96/28` -> `10.97.221.96-10.97.221.111` (WinRM IPv4Filter syntax). */
export function cidrToRange(cidr: string): string {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((o) => Number.isNaN(o) || o < 0 || o > 255) ||
    !(prefix >= 0 && prefix <= 32)
  ) {
    throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  }
  const base = octets.reduce((acc, o) => acc * 256 + o, 0);
  const size = 2 ** (32 - prefix);
  const start = base - (base % size);
  const end = start + size - 1;
  const toText = (value: number) =>
    [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
  return `${toText(start)}-${toText(end)}`;
}
