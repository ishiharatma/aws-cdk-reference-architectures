import * as cdk from 'aws-cdk-lib';

/**
 * One subnet pinned to an Availability Zone ID.
 *
 * AZ IDs (e.g. `apne1-az1`) are used instead of AZ names because WorkSpaces Personal only
 * supports specific AZ IDs per Region, and AZ names map to different physical zones in
 * every account.
 */
export interface SubnetSpec {
  /** Short name used in resource names and tags (e.g. `ws-az1`). */
  readonly name: string;
  /** Availability Zone ID (e.g. `apne1-az1`). */
  readonly availabilityZoneId: string;
  /** IPv4 CIDR block of the subnet. */
  readonly cidr: string;
}

/**
 * Network layout of the closed VPC (no internet gateway, no NAT).
 */
export interface NetworkParams {
  /** VPC CIDR (/23 in the reference layout). */
  readonly vpcCidr: string;
  /** Subnets for WorkSpaces ENIs (two supported AZ IDs). */
  readonly workspacesSubnets: SubnetSpec[];
  /** Subnets for the AWS Managed Microsoft AD domain controllers. */
  readonly directorySubnets: SubnetSpec[];
  /** Subnets for interface VPC endpoints. */
  readonly endpointSubnets: SubnetSpec[];
  /** Subnets for the management instance(s). */
  readonly managementSubnets: SubnetSpec[];
  /**
   * Subnets reserved for a future Transit Gateway attachment.
   * They are created with a local-only route table; no Transit Gateway is created.
   */
  readonly transitGatewaySubnets: SubnetSpec[];
  /**
   * Interface endpoint service short names (e.g. `ssm`, `logs`).
   * An S3 gateway endpoint is always created as it has no hourly cost.
   */
  readonly interfaceEndpoints: string[];
  /** Retention of the VPC flow log group. */
  readonly flowLogRetention: cdk.aws_logs.RetentionDays;
}

/** Organizational unit to create under the delegated OU (`OU=<NetBIOS>,<domain DN>`). */
export interface OrganizationalUnitSpec {
  /** OU name. */
  readonly name: string;
  /**
   * Parent path relative to the delegated OU, as RDN list from the closest parent outward
   * (e.g. `OU=Computers`). Empty string means directly under the delegated OU.
   */
  readonly parent: string;
  /** Description written to the OU. */
  readonly description: string;
}

/** Security group (AD group) to create. */
export interface AdGroupSpec {
  /** sAMAccountName / CN of the group. */
  readonly name: string;
  /** Parent OU relative to the delegated OU (e.g. `OU=Groups`). */
  readonly parent: string;
  /** Description written to the group. */
  readonly description: string;
}

/**
 * Settings for the fine-grained password policy (PSO) that AWS Managed Microsoft AD
 * pre-creates. The default domain policy cannot be edited in Managed AD, so the PSO is
 * edited and applied to a group instead.
 */
export interface PasswordPolicyParams {
  /** Name of the pre-created PSO to edit (e.g. `CustomerPSO-01`). */
  readonly psoName: string;
  /** Group the PSO is applied to. */
  readonly appliesToGroup: string;
  readonly minPasswordLength: number;
  readonly passwordHistoryCount: number;
  readonly maxPasswordAgeDays: number;
  readonly lockoutThreshold: number;
  readonly lockoutDurationMinutes: number;
  readonly lockoutObservationWindowMinutes: number;
}

/**
 * Values used by the GPOs created by the bootstrap script.
 */
export interface GroupPolicyParams {
  /** Windows idle lock (seconds) for WorkSpaces and the management instance. */
  readonly inactivityTimeoutSeconds: number;
  /** Maximum size of the Security event log in KB. */
  readonly securityLogMaxSizeKb: number;
}

/**
 * AWS Managed Microsoft AD and the objects created inside it.
 */
export interface DirectoryParams {
  /** Fully qualified domain name (e.g. `wsdev.example.co.jp`). */
  readonly domainName: string;
  /** NetBIOS name; also the name of the delegated OU Managed AD creates. */
  readonly netBiosName: string;
  /** Managed AD edition. */
  readonly edition: 'Standard' | 'Enterprise';
  /** OUs created by the bootstrap script, in creation order (parents first). */
  readonly organizationalUnits: OrganizationalUnitSpec[];
  /** Security groups created by the bootstrap script. */
  readonly groups: AdGroupSpec[];
  /** Fine-grained password policy. */
  readonly passwordPolicy: PasswordPolicyParams;
  /** GPO settings. */
  readonly groupPolicy: GroupPolicyParams;
}

/**
 * Management instance that joins the domain and builds OUs / groups / GPOs.
 */
export interface ManagementInstanceParams {
  /** EC2 instance type (Windows Server 2025). */
  readonly instanceType: string;
  /** Index into `network.managementSubnets` to place the instance in. */
  readonly subnetIndex: number;
  /** Seconds CloudFormation waits for the bootstrap association to succeed. */
  readonly bootstrapTimeoutSeconds: number;
}

/** One rule of the WorkSpaces IP access control group. */
export interface IpRuleSpec {
  /** Source CIDR (IPv4 only). */
  readonly cidr: string;
  /** Description of the rule. */
  readonly description: string;
}

/**
 * WorkSpaces directory registration settings.
 */
export interface WorkSpacesParams {
  /** Name of the IP access control group. */
  readonly ipGroupName: string;
  /** Global IPs of the standard PCs (max 30 rules). */
  readonly allowedSources: IpRuleSpec[];
  /** Whether users are local administrators of new WorkSpaces (PoC: true, production: false). */
  readonly userEnabledAsLocalAdministrator: boolean;
  /**
   * Create `workspaces_DefaultRole`. Set to false when the account already has it
   * (it is an account-wide, fixed-name role).
   */
  readonly createDefaultRole: boolean;
}

/**
 * IAM role handed to the vendor / operators.
 */
export interface OperatorRoleParams {
  /** Role name. */
  readonly roleName: string;
  /**
   * Principals allowed to assume the role. Empty = the deploying account root
   * (delegated to IAM policies in that account).
   */
  readonly trustedPrincipalArns: string[];
  /** Require MFA in the trust policy. */
  readonly requireMfa: boolean;
  /** Maximum session duration in hours. */
  readonly maxSessionHours: number;
}

/**
 * Monthly usage report.
 */
export interface UsageReportParams {
  /** EventBridge Scheduler expression. */
  readonly scheduleExpression: string;
  /** Time zone of the schedule and of timestamps in the report. */
  readonly timeZone: cdk.TimeZone;
  /** WorkSpaces whose last connection is older than this are flagged as inactive. */
  readonly inactiveThresholdDays: number;
  /** Email addresses subscribed to the report topic. */
  readonly notificationEmails: string[];
  /** Days CSV reports are kept in S3. */
  readonly reportRetentionDays: number;
}
