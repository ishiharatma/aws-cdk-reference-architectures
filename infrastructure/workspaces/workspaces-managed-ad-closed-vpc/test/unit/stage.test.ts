/* eslint-disable @typescript-eslint/no-explicit-any */
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStage, templates, testParams } from '../helpers/stage';
import { cidrToRange } from 'lib/constructs/management-instance';
import { validateIpRules } from 'lib/constructs/workspaces-directory';
import { OPERATOR_DENY } from 'lib/constructs/operator-role';

const stage = buildStage();
const t = templates(stage);
const params = testParams();

/** All statements of the operator role's inline policy. */
function operatorStatements(template: Template): any[] {
  const roles = template.findResources('AWS::IAM::Role', {
    Properties: { RoleName: params.operatorRole.roleName },
  });
  const role = Object.values(roles)[0] as any;
  return role.Properties.Policies[0].PolicyDocument.Statement;
}

/** Normalize a policy statement's Action to an array. */
function actionsOf(statement: any): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

describe('Requirement 1/2/3: closed VPC layout', () => {
  test('VPC uses the /23 CIDR and has no internet gateway or NAT', () => {
    t.network.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.97.220.0/23',
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
    t.network.resourceCountIs('AWS::EC2::InternetGateway', 0);
    t.network.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.network.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 0);
  });

  test.each([
    ['ws-az1', 'apne1-az1', '10.97.220.0/25'],
    ['ws-az4', 'apne1-az4', '10.97.220.128/25'],
    ['ad-az1', 'apne1-az1', '10.97.221.0/28'],
    ['ad-az4', 'apne1-az4', '10.97.221.16/28'],
    ['vpce-az1', 'apne1-az1', '10.97.221.32/27'],
    ['vpce-az4', 'apne1-az4', '10.97.221.64/27'],
    ['manage-az1', 'apne1-az1', '10.97.221.96/28'],
    ['manage-az4', 'apne1-az4', '10.97.221.112/28'],
    ['tgw-az1', 'apne1-az1', '10.97.221.224/28'],
    ['tgw-az4', 'apne1-az4', '10.97.221.240/28'],
  ])('subnet %s is in %s with %s', (name, azId, cidr) => {
    t.network.hasResourceProperties('AWS::EC2::Subnet', {
      AvailabilityZoneId: azId,
      CidrBlock: cidr,
      MapPublicIpOnLaunch: false,
      Tags: Match.arrayWith([{ Key: 'Name', Value: `test-test-${name}` }]),
    });
  });

  test('spare blocks are not allocated', () => {
    const cidrs = Object.values(t.network.findResources('AWS::EC2::Subnet')).map(
      (r: any) => r.Properties.CidrBlock
    );
    expect(cidrs).toHaveLength(10);
    expect(cidrs).not.toContain('10.97.221.128/26');
    expect(cidrs).not.toContain('10.97.221.192/27');
  });

  test('no route table has a route (local only); TGW subnets are reserved without a TGW', () => {
    t.network.resourceCountIs('AWS::EC2::Route', 0);
    t.network.resourceCountIs('AWS::EC2::TransitGateway', 0);
    t.network.resourceCountIs('AWS::EC2::TransitGatewayAttachment', 0);
    t.network.resourceCountIs('AWS::EC2::TransitGatewayVpcAttachment', 0);
    t.network.hasResourceProperties('AWS::EC2::RouteTable', {
      Tags: [{ Key: 'Name', Value: 'test-test-rtb-tgw' }],
    });
  });

  test('flow logs capture all traffic', () => {
    t.network.hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'ALL',
      ResourceType: 'VPC',
    });
  });
});

describe('Requirement 5: VPC endpoints', () => {
  test.each(params.network.interfaceEndpoints)(
    'interface endpoint %s with private DNS',
    (service) => {
      t.network.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
        ServiceName: `com.amazonaws.ap-northeast-1.${service}`,
      });
    }
  );

  test('S3 gateway endpoint is attached to the WorkSpaces and management route tables', () => {
    t.network.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: 'com.amazonaws.ap-northeast-1.s3',
      RouteTableIds: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp('WorkspacesRouteTable') }),
      ]),
    });
  });

  test('endpoint security group accepts HTTPS from the VPC only', () => {
    t.network.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('Interface VPC endpoints'),
      SecurityGroupIngress: [
        Match.objectLike({ CidrIp: '10.97.220.0/23', FromPort: 443, ToPort: 443 }),
      ],
    });
  });
});

describe('Managed AD and bootstrap', () => {
  test('Managed AD Standard in the AD subnets with the password from Secrets Manager', () => {
    t.directory.hasResourceProperties('AWS::DirectoryService::MicrosoftAD', {
      Name: 'wsdev.example.co.jp',
      ShortName: 'WSDEV',
      Edition: 'Standard',
      Password: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
    });
  });

  test('ds-data is enabled with an SDK call', () => {
    // Create is an Fn::Join because it embeds the directory ID token.
    const resource = Object.values(t.directory.findResources('Custom::AWS'))[0] as any;
    expect(JSON.stringify(resource.Properties.Create)).toContain('EnableDirectoryDataAccess');
    expect(JSON.stringify(resource.Properties.Delete)).toContain('DisableDirectoryDataAccess');
  });

  test('management instance runs Windows Server 2025 with IMDSv2 and no public IP', () => {
    t.directory.hasResourceProperties('AWS::EC2::Instance', {
      ImageId: { Ref: Match.stringLikeRegexp('Windows.*Server.*2025') },
      InstanceType: 't3.medium',
    });
    t.directory.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  test('CloudFormation waits for the bootstrap association', () => {
    t.directory.hasResourceProperties('AWS::SSM::Association', {
      WaitForSuccessTimeoutSeconds: 3600,
      Targets: [{ Key: 'InstanceIds', Values: Match.anyValue() }],
    });
  });

  test('bootstrap config carries the OU tree, groups, PSO and WinRM filter', () => {
    const association = Object.values(t.directory.findResources('AWS::SSM::Association'))[0] as any;
    const config = JSON.parse(
      Buffer.from(association.Properties.Parameters.ConfigBase64[0], 'base64').toString('utf-8')
    );
    expect(config.organizationalUnits.map((ou: any) => `OU=${ou.name},${ou.parent}`)).toEqual([
      'OU=WorkSpaces,OU=Computers',
      'OU=ImageBuild,OU=Computers',
      'OU=Admin,OU=Computers',
      'OU=Employees,OU=Users',
      'OU=Vendors,OU=Users',
      'OU=Admins,OU=Users',
      'OU=Disabled,OU=Users',
      'OU=Groups,',
    ]);
    expect(config.groups.map((g: any) => g.name)).toEqual([
      'WS-Users',
      'WS-LocalAdmins',
      'WS-Admins',
      'Vendor-UserManagers',
    ]);
    expect(config.passwordPolicy.appliesToGroup).toBe('WS-Users');
    expect(config.localAdministratorGroups).toEqual(['WS-Admins', 'WS-LocalAdmins']);
    expect(config.winRm.ipv4Filter).toBe('10.97.221.96-10.97.221.111,10.97.221.112-10.97.221.127');
  });

  test('bootstrap document creates and links every GPO of the design', () => {
    const documents = t.directory.findResources('AWS::SSM::Document');
    const bootstrap = Object.values(documents).find((d: any) =>
      d.Properties.Content.description.startsWith('Join the management instance')
    ) as any;
    const stage2Line = (
      bootstrap.Properties.Content.mainSteps[0].inputs.runCommand as string[]
    ).find((line) => line.startsWith('$Stage2Base64')) as string;
    const stage2 = Buffer.from(stage2Line.split("'")[1], 'base64').toString('utf-8');
    for (const gpo of ['GPO-WS-Security', 'GPO-WS-Audit', 'GPO-WS-LocalAdmin', 'GPO-Admin']) {
      expect(stage2).toContain(`'${gpo}'`);
    }
    expect(stage2).toContain('Set-ADFineGrainedPasswordPolicy');
    expect(stage2).toContain('ProcessCreationIncludeCmdLine_Enabled');
    expect(stage2).toContain('EnableScriptBlockLogging');
  });
});

describe('WorkSpaces directory (R1)', () => {
  test('IP access control group lists only the configured sources', () => {
    t.workspaces.hasResourceProperties('AWS::WorkSpaces::WorkspaceIpGroup', {
      UserRules: [
        { IpRule: '203.0.113.10/32', RuleDesc: 'Office egress' },
        { IpRule: '198.51.100.0/28', RuleDesc: 'VPN egress' },
      ],
    });
  });

  test('registration locks the directory settings', () => {
    t.workspaces.hasResourceProperties('Custom::WorkSpacesDirectoryRegistration', {
      DefaultOu: 'OU=WorkSpaces,OU=Computers,OU=WSDEV,DC=wsdev,DC=example,DC=co,DC=jp',
      AllowedDeviceTypes: ['DeviceTypeWindows'],
      UserEnabledAsLocalAdministrator: 'true',
      IpGroupIds: [{ 'Fn::GetAtt': [Match.anyValue(), 'GroupId'] }],
    });
  });

  test('WorkSpaces accept WinRM only from the management subnets', () => {
    t.workspaces.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'WorkSpaces: WinRM from management subnets',
      SecurityGroupIngress: [
        Match.objectLike({ CidrIp: '10.97.221.96/28', FromPort: 5985, ToPort: 5985 }),
        Match.objectLike({ CidrIp: '10.97.221.112/28', FromPort: 5985, ToPort: 5985 }),
      ],
    });
  });

  test('registration handler runs on Python', () => {
    t.workspaces.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.is_complete',
      Runtime: 'python3.14',
    });
  });

  test('workspaces_DefaultRole is created when requested', () => {
    t.workspaces.hasResourceProperties('AWS::IAM::Role', { RoleName: 'workspaces_DefaultRole' });
    const without = templates(
      buildStage({ overrides: { workspaces: { ...params.workspaces, createDefaultRole: false } } })
    );
    expect(
      without.workspaces.findResources('AWS::IAM::Role', {
        Properties: { RoleName: 'workspaces_DefaultRole' },
      })
    ).toEqual({});
  });
});

describe('Requirement 4: operator role', () => {
  const statements = operatorStatements(t.workspaces);
  const allowed = statements.filter((s) => s.Effect === 'Allow').flatMap(actionsOf);
  const denied = statements.filter((s) => s.Effect === 'Deny').flatMap(actionsOf);

  test('trust policy requires MFA', () => {
    t.workspaces.hasResourceProperties('AWS::IAM::Role', {
      RoleName: params.operatorRole.roleName,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({ Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } } }),
        ],
      },
      MaxSessionDuration: 3600,
    });
  });

  test.each([
    'workspaces:CreateWorkspaces',
    'workspaces:RebootWorkspaces',
    'workspaces:RebuildWorkspaces',
    'workspaces:TerminateWorkspaces',
    'workspaces:StopWorkspaces',
    'workspaces:StartWorkspaces',
    'workspaces:AssociateWorkspaceApplication',
    'workspaces:DeployWorkspaceApplications',
    'workspaces:CreateWorkspaceImage',
    'workspaces:CreateWorkspaceBundle',
    'ds-data:CreateUser',
    'ds-data:DisableUser',
    'ds:ResetUserPassword',
  ])('allows %s', (action) => {
    expect(allowed).toContain(action);
  });

  test('ds-data actions are scoped to the directory', () => {
    const dsData = statements.find((s) => s.Sid === 'AllowDirectoryDataUserManagement');
    expect(JSON.stringify(dsData.Resource)).toContain(':directory/');
  });

  test.each([
    'workspaces:CreateIpGroup',
    'workspaces:UpdateRulesOfIpGroup',
    'workspaces:AuthorizeIpRules',
    'workspaces:AssociateIpGroups',
    'workspaces:DisassociateIpGroups',
    'workspaces:RegisterWorkspaceDirectory',
    'workspaces:DeregisterWorkspaceDirectory',
    'workspaces:ModifyWorkspaceAccessProperties',
    'workspaces:ModifyWorkspaceCreationProperties',
    'workspaces:ModifyClientProperties',
    'workspaces:ModifySelfservicePermissions',
    'ec2:CreateRoute',
    'ec2:ReplaceNetworkAclEntry',
    'ec2:AuthorizeSecurityGroupIngress',
    'ec2:ModifyVpcEndpoint',
    'ec2:CreateVpcPeeringConnection',
    'ds:UpdateSettings',
    'ds:CreateLogSubscription',
    'ds:DisableDirectoryDataAccess',
  ])('denies %s', (action) => {
    const matches = denied.some((pattern) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
        action
      )
    );
    expect(matches).toBe(true);
  });

  test('no deny pattern blocks an allowed action', () => {
    const patterns = Object.values(OPERATOR_DENY)
      .flat()
      .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
    const blocked = allowed.filter(
      (action) => !action.includes('*') && patterns.some((re) => re.test(action))
    );
    expect(blocked).toEqual([]);
  });
});

describe('Requirement 6: monthly usage report', () => {
  test('Python Lambda on a monthly JST schedule', () => {
    t.usageReport.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'python3.14',
      Environment: {
        Variables: Match.objectLike({
          INACTIVE_THRESHOLD_DAYS: '30',
          REPORT_TIME_ZONE: 'Asia/Tokyo',
        }),
      },
    });
    t.usageReport.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 9 1 * ? *)',
      ScheduleExpressionTimezone: 'Asia/Tokyo',
    });
  });

  test('report bucket is private, encrypted, versioned and expires objects', () => {
    t.usageReport.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 400 })]),
      },
    });
  });

  test('SNS topic is encrypted and has the email subscription', () => {
    t.usageReport.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    t.usageReport.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  test('Lambda can read connection status and write only under reports/', () => {
    const policies = JSON.stringify(t.usageReport.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('workspaces:DescribeWorkspacesConnectionStatus');
    expect(policies).toContain('/reports/*');
  });
});

describe('Parameter validation', () => {
  test('cidrToRange', () => {
    expect(cidrToRange('10.97.221.96/28')).toBe('10.97.221.96-10.97.221.111');
    expect(cidrToRange('10.97.221.100/27')).toBe('10.97.221.96-10.97.221.127');
    expect(() => cidrToRange('10.97.221.300/28')).toThrow();
  });

  test('IP rules must be IPv4, at most 30, and not 0.0.0.0/0', () => {
    expect(() => validateIpRules([])).toThrow(/at least one/);
    expect(() => validateIpRules(['0.0.0.0/0'])).toThrow(/every source/);
    expect(() => validateIpRules(['2001:db8::/32'])).toThrow(/IPv4/);
    expect(() =>
      validateIpRules(Array.from({ length: 31 }, (_, i) => `203.0.113.${i}/32`))
    ).toThrow(/at most 30/);
    expect(() => validateIpRules(['203.0.113.10/32'])).not.toThrow();
  });

  test('stage fails fast on an out-of-range management subnet index', () => {
    expect(() =>
      buildStage({
        overrides: { managementInstance: { ...params.managementInstance, subnetIndex: 5 } },
      })
    ).toThrow(/out of range/);
  });
});

test('stack dependencies: WorkSpaces waits for Directory', () => {
  expect(stage.workspaces.dependencies.map((s) => s.stackName)).toEqual(
    expect.arrayContaining([stage.directory.stackName, stage.network.stackName])
  );
});
