import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { OperatorRoleParams } from 'lib/types';

/** Properties of {@link OperatorRole}. */
export interface OperatorRoleProps {
  readonly params: OperatorRoleParams;
  /** ARN of the Managed AD directory (ds-data / password reset scope). */
  readonly directoryArn: string;
}

/**
 * Actions the operator role is allowed to perform.
 * Keys are used as Sids so the policy reads like the requirement table.
 */
export const OPERATOR_ALLOW = {
  // V2: the vendor launches and maintains WorkSpaces
  WorkSpacesLifecycle: [
    'workspaces:CreateWorkspaces',
    'workspaces:RebootWorkspaces',
    'workspaces:RebuildWorkspaces',
    'workspaces:TerminateWorkspaces',
    'workspaces:StopWorkspaces',
    'workspaces:StartWorkspaces',
    'workspaces:CreateTags',
  ],
  // V3: license-included applications (Visual Studio 2022, Office LTSC 2024)
  LicenseIncludedApplications: [
    'workspaces:AssociateWorkspaceApplication',
    'workspaces:DisassociateWorkspaceApplication',
    'workspaces:DeployWorkspaceApplications',
  ],
  // V8: custom images and bundles (reviewed by the team)
  ImagesAndBundles: [
    'workspaces:CreateWorkspaceImage',
    'workspaces:CreateWorkspaceBundle',
    'workspaces:UpdateWorkspaceBundle',
  ],
  // Read-only views needed by the console and by the actions above
  ReadOnly: [
    'workspaces:Describe*',
    'workspaces:List*',
    'ds:DescribeDirectories',
    'ec2:DescribeSubnets',
    'ec2:DescribeVpcs',
    'ec2:DescribeSecurityGroups',
    'ec2:DescribeAvailabilityZones',
  ],
} as const;

/** ds-data user management (No.23): create, reset password, disable. Scoped to the directory. */
export const OPERATOR_DIRECTORY_DATA_ACTIONS = [
  'ds:AccessDSData',
  'ds-data:CreateUser',
  'ds-data:DescribeUser',
  'ds-data:ListUsers',
  'ds-data:SearchUsers',
  'ds-data:DisableUser',
  'ds-data:ListGroupsForMember',
  // Password reset is a Directory Service (not ds-data) API
  'ds:ResetUserPassword',
];

/** Actions the operator role must never perform, even if another policy allows them. */
export const OPERATOR_DENY = {
  // R1: changing the IP access control group would allow non-standard PCs
  IpAccessControlGroups: [
    'workspaces:CreateIpGroup',
    'workspaces:DeleteIpGroup',
    'workspaces:UpdateRulesOfIpGroup',
    'workspaces:AuthorizeIpRules',
    'workspaces:RevokeIpRules',
    'workspaces:AssociateIpGroups',
    'workspaces:DisassociateIpGroups',
  ],
  // (De)registering the directory drops the IP group association and the settings below
  DirectoryRegistration: [
    'workspaces:RegisterWorkspaceDirectory',
    'workspaces:DeregisterWorkspaceDirectory',
  ],
  // Allowed client types (Windows only)
  AccessProperties: ['workspaces:ModifyWorkspaceAccessProperties'],
  // Default OU (GPO scope) and local administrator setting
  CreationProperties: ['workspaces:ModifyWorkspaceCreationProperties'],
  // Saved credentials / reconnect
  ClientProperties: ['workspaces:ModifyClientProperties'],
  // Self-service (bundle change etc.)
  SelfservicePermissions: ['workspaces:ModifySelfservicePermissions'],
  // R2: routes, NACLs, security groups, VPC endpoints, peering
  NetworkPath: [
    'ec2:CreateRoute',
    'ec2:ReplaceRoute',
    'ec2:DeleteRoute',
    'ec2:CreateRouteTable',
    'ec2:DeleteRouteTable',
    'ec2:AssociateRouteTable',
    'ec2:DisassociateRouteTable',
    'ec2:ReplaceRouteTableAssociation',
    'ec2:CreateNetworkAcl',
    'ec2:CreateNetworkAclEntry',
    'ec2:DeleteNetworkAcl',
    'ec2:DeleteNetworkAclEntry',
    'ec2:ReplaceNetworkAclAssociation',
    'ec2:ReplaceNetworkAclEntry',
    'ec2:CreateSecurityGroup',
    'ec2:DeleteSecurityGroup',
    'ec2:AuthorizeSecurityGroupIngress',
    'ec2:AuthorizeSecurityGroupEgress',
    'ec2:RevokeSecurityGroupIngress',
    'ec2:RevokeSecurityGroupEgress',
    'ec2:ModifySecurityGroupRules',
    'ec2:UpdateSecurityGroupRuleDescriptionsIngress',
    'ec2:UpdateSecurityGroupRuleDescriptionsEgress',
    'ec2:ModifyNetworkInterfaceAttribute',
    'ec2:CreateVpcEndpoint',
    'ec2:ModifyVpcEndpoint',
    'ec2:DeleteVpcEndpoints',
    'ec2:ModifyVpcEndpointServicePermissions',
    'ec2:CreateVpcPeeringConnection',
    'ec2:AcceptVpcPeeringConnection',
    'ec2:ModifyVpcPeeringConnectionOptions',
    'ec2:DeleteVpcPeeringConnection',
  ],
  // Directory configuration (security settings, log forwarding, trusts, sharing, ...).
  // ds:ResetUserPassword stays allowed: none of these patterns match it.
  DirectorySettings: [
    'ds:Update*',
    'ds:Enable*',
    'ds:Disable*',
    'ds:Create*',
    'ds:Delete*',
    'ds:Add*',
    'ds:Remove*',
    'ds:Register*',
    'ds:Deregister*',
    'ds:Share*',
    'ds:Unshare*',
    'ds:Accept*',
    'ds:Reject*',
    'ds:Start*',
    'ds:Cancel*',
    'ds:Restore*',
    'ds:Verify*',
    'ds:AuthorizeApplication',
    'ds:UnauthorizeApplication',
    'ds:ResetDirectory*',
  ],
} as const;

/**
 * IAM role for the vendor / operators (requirement 4).
 *
 * Allows WorkSpaces lifecycle, license-included apps, images/bundles and ds-data user
 * management; explicitly denies everything that would weaken R1 (IP restriction), R2 (network
 * path) or the directory settings. The explicit Deny wins over any Allow attached later.
 */
export class OperatorRole extends Construct {
  public readonly role: iam.IRole;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: OperatorRoleProps) {
    super(scope, id);

    const { params } = props;
    const principals: iam.IPrincipal[] =
      params.trustedPrincipalArns.length > 0
        ? params.trustedPrincipalArns.map((arn) => new iam.ArnPrincipal(arn))
        : [new iam.AccountRootPrincipal()];
    let assumedBy: iam.IPrincipal = new iam.CompositePrincipal(...principals);
    if (params.requireMfa) {
      assumedBy = new iam.PrincipalWithConditions(assumedBy, {
        Bool: { 'aws:MultiFactorAuthPresent': 'true' },
      });
    }

    const statements: iam.PolicyStatement[] = [];
    for (const [sid, actions] of Object.entries(OPERATOR_ALLOW)) {
      statements.push(
        new iam.PolicyStatement({ sid: `Allow${sid}`, actions: [...actions], resources: ['*'] })
      );
    }
    statements.push(
      new iam.PolicyStatement({
        sid: 'AllowDirectoryDataUserManagement',
        actions: OPERATOR_DIRECTORY_DATA_ACTIONS,
        resources: [props.directoryArn],
      })
    );
    for (const [sid, actions] of Object.entries(OPERATOR_DENY)) {
      statements.push(
        new iam.PolicyStatement({
          sid: `Deny${sid}`,
          effect: iam.Effect.DENY,
          actions: [...actions],
          resources: ['*'],
        })
      );
    }

    this.role = new iam.Role(this, 'Role', {
      roleName: params.roleName,
      assumedBy,
      description:
        'WorkSpaces operator: lifecycle / apps / images / ds-data users; no network or directory settings',
      maxSessionDuration: cdk.Duration.hours(params.maxSessionHours),
      inlinePolicies: {
        WorkSpacesOperator: new iam.PolicyDocument({ statements }),
      },
    });
  }
}
