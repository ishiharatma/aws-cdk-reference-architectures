import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as workspaces from 'aws-cdk-lib/aws-workspaces';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { WorkSpacesParams } from 'lib/types';

/** WorkSpaces IP access control groups accept at most 30 rules each. */
export const MAX_IP_RULES = 30;

/** Properties of {@link WorkSpacesDirectory}. */
export interface WorkSpacesDirectoryProps {
  readonly params: WorkSpacesParams;
  readonly vpc: ec2.IVpc;
  readonly directoryId: string;
  /** Two WorkSpaces subnets in supported AZ IDs. */
  readonly subnets: ec2.ISubnet[];
  /** Full DN of the OU new WorkSpaces computer accounts are created in. */
  readonly defaultOuDn: string;
  /** Management subnet CIDRs allowed to reach WorkSpaces on WinRM. */
  readonly managementCidrs: string[];
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * IP access control group + WorkSpaces directory registration with locked settings (R1).
 */
export class WorkSpacesDirectory extends Construct {
  public readonly ipGroup: workspaces.CfnWorkspaceIpGroup;
  public readonly additionalSecurityGroup: ec2.ISecurityGroup;
  public readonly registrationCode: string;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: WorkSpacesDirectoryProps) {
    super(scope, id);

    const { params } = props;
    const stack = cdk.Stack.of(this);

    validateIpRules(params.allowedSources.map((rule) => rule.cidr));

    // ------------------------------------------------------------------
    // IP access control group: only the standard PCs' global IPs
    // ------------------------------------------------------------------
    this.ipGroup = new workspaces.CfnWorkspaceIpGroup(this, 'IpGroup', {
      groupName: params.ipGroupName,
      groupDesc: 'Standard PC egress addresses allowed to stream WorkSpaces',
      userRules: params.allowedSources.map((rule) => ({
        ipRule: rule.cidr,
        ruleDesc: rule.description,
      })),
    });
    // The bundled cfn-lint region spec lists no AWS::WorkSpaces::WorkspaceIpGroup in
    // ap-northeast-1, but `aws cloudformation describe-type` there returns it as PUBLIC / LIVE.
    cdk.Validations.of(this.ipGroup).acknowledge({
      id: 'CloudFormation-Validate::F3006',
      reason:
        'False positive: the CloudFormation registry in ap-northeast-1 has AWS::WorkSpaces::WorkspaceIpGroup (LIVE); ' +
        'only the bundled cfn-lint region spec lacks it.',
    });

    // ------------------------------------------------------------------
    // Additional security group attached to every new WorkSpace:
    // WinRM from the management subnets (snapshot / log collection).
    // ------------------------------------------------------------------
    const additionalSecurityGroup = new ec2.SecurityGroup(this, 'WorkspacesSecurityGroup', {
      vpc: props.vpc,
      description: 'WorkSpaces: WinRM from management subnets',
      allowAllOutbound: false,
    });
    for (const cidr of props.managementCidrs) {
      additionalSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(5985),
        'WinRM from management'
      );
    }
    this.additionalSecurityGroup = additionalSecurityGroup;

    // ------------------------------------------------------------------
    // workspaces_DefaultRole (account-wide, fixed name, required before registration)
    // ------------------------------------------------------------------
    let defaultRole: iam.Role | undefined;
    if (params.createDefaultRole) {
      defaultRole = new iam.Role(this, 'WorkspacesDefaultRole', {
        roleName: 'workspaces_DefaultRole',
        assumedBy: new iam.ServicePrincipal('workspaces.amazonaws.com'),
        description: 'Service role WorkSpaces uses to manage ENIs and directory integration',
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonWorkSpacesServiceAccess'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonWorkSpacesSelfServiceAccess'),
        ],
      });
    }

    // ------------------------------------------------------------------
    // Registration custom resource (Python)
    // ------------------------------------------------------------------
    const handlerLogGroup = new logs.LogGroup(this, 'HandlerLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: props.removalPolicy,
    });
    const handlerProps: Omit<lambda.FunctionProps, 'handler'> = {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../src/lambda/directory_registration'), {
        exclude: ['test_*.py', '__pycache__'],
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: handlerLogGroup,
    };
    const onEventHandler = new lambda.Function(this, 'OnEventHandler', {
      ...handlerProps,
      handler: 'index.on_event',
      description: 'Registers / deregisters the WorkSpaces directory',
    });
    const isCompleteHandler = new lambda.Function(this, 'IsCompleteHandler', {
      ...handlerProps,
      handler: 'index.is_complete',
      description: 'Waits for REGISTERED and applies the locked directory settings',
    });

    const registrationPolicy = new iam.PolicyStatement({
      actions: [
        'workspaces:RegisterWorkspaceDirectory',
        'workspaces:DeregisterWorkspaceDirectory',
        'workspaces:DescribeWorkspaceDirectories',
        'workspaces:ModifyWorkspaceCreationProperties',
        'workspaces:ModifyWorkspaceAccessProperties',
        'workspaces:ModifyClientProperties',
        'workspaces:ModifySelfservicePermissions',
        'workspaces:AssociateIpGroups',
        'workspaces:DisassociateIpGroups',
        'workspaces:CreateTags',
      ],
      resources: ['*'],
    });
    // Calls WorkSpaces makes with the caller's permissions while (de)registering a directory.
    const directoryIntegrationPolicy = new iam.PolicyStatement({
      actions: [
        'ds:DescribeDirectories',
        'ds:AuthorizeApplication',
        'ds:UnauthorizeApplication',
        'ec2:DescribeSubnets',
        'ec2:DescribeVpcs',
        'ec2:DescribeSecurityGroups',
        'ec2:DescribeNetworkInterfaces',
        'ec2:CreateSecurityGroup',
        'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress',
        'ec2:RevokeSecurityGroupIngress',
        'ec2:RevokeSecurityGroupEgress',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    });
    const getDefaultRolePolicy = new iam.PolicyStatement({
      actions: ['iam:GetRole'],
      resources: [
        stack.formatArn({
          service: 'iam',
          region: '',
          resource: 'role',
          resourceName: 'workspaces_DefaultRole',
        }),
      ],
    });
    for (const fn of [onEventHandler, isCompleteHandler]) {
      fn.addToRolePolicy(registrationPolicy);
      fn.addToRolePolicy(directoryIntegrationPolicy);
      fn.addToRolePolicy(getDefaultRolePolicy);
    }

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler,
      isCompleteHandler,
      queryInterval: cdk.Duration.seconds(30),
      totalTimeout: cdk.Duration.minutes(30),
      logGroup: handlerLogGroup,
    });

    const registration = new cdk.CustomResource(this, 'Registration', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::WorkSpacesDirectoryRegistration',
      properties: {
        DirectoryId: props.directoryId,
        SubnetIds: props.subnets.map((subnet) => subnet.subnetId),
        DefaultOu: props.defaultOuDn,
        CustomSecurityGroupId: this.additionalSecurityGroup.securityGroupId,
        UserEnabledAsLocalAdministrator: String(params.userEnabledAsLocalAdministrator),
        AllowedDeviceTypes: ['DeviceTypeWindows'],
        IpGroupIds: [this.ipGroup.attrGroupId],
      },
    });
    if (defaultRole) {
      registration.node.addDependency(defaultRole);
    }

    this.registrationCode = registration.getAttString('RegistrationCode');
  }
}

/** IPv4 CIDRs only, at most {@link MAX_IP_RULES}, no "allow everyone". */
export function validateIpRules(cidrs: string[]): void {
  if (cidrs.length === 0) {
    throw new Error('workspaces.allowedSources must contain at least one CIDR');
  }
  if (cidrs.length > MAX_IP_RULES) {
    throw new Error(
      `An IP access control group accepts at most ${MAX_IP_RULES} rules (got ${cidrs.length})`
    );
  }
  for (const cidr of cidrs) {
    if (!/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(cidr)) {
      throw new Error(`Not an IPv4 CIDR: ${cidr} (IP access control groups support IPv4 only)`);
    }
    if (cidr.endsWith('/0')) {
      throw new Error(`${cidr} would allow every source and defeat the IP restriction`);
    }
  }
}
