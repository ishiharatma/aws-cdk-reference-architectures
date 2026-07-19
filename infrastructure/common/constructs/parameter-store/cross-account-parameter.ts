/* eslint-disable cdk/require-passing-this */
import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CrossAccountParameterProps {
  /**
   * Parameter name (will be prefixed with /)
   * Example: 'myproject/test/vpc-c/id'
   */
  readonly parameterName: string;

  /**
   * Parameter value
   */
  readonly value: string;

  /**
   * Parameter description
   */
  readonly description: string;

  /**
   * AWS Account IDs that should have read access to this parameter
   */
  readonly readerAccountIds: string[];

  /**
   * Optional: Parameter tier (defaults to STANDARD)
   */
  readonly tier?: ssm.ParameterTier;

  /**
   * Optional: Create an IAM role for cross-account Custom Resource access
   * If true, creates a role named {project}-{environment}-{ParameterName}-ReadRole
   * that can be assumed by reader accounts for Custom Resource access
   */
  readonly createReadRole?: boolean;

  /**
   * Optional: Custom role name for the parameter read role
   * Only used if createReadRole is true
   */
  readonly readRoleName?: string;
}

export interface CrossAccountParameterLookupProps {
  /**
   * Parameter name (with / prefix)
   */
  readonly parameterName: string;

  /**
   * AWS Account ID where the parameter is stored
   */
  readonly accountId: string;

  /**
   * Region where the parameter is stored
   */
  readonly region: string;
}

export interface CrossAccountParameterCustomResourceProps {
  /**
   * Parameter name (with / prefix)
   */
  readonly parameterName: string;

  /**
   * AWS Account ID where the parameter is stored
   */
  readonly accountId: string;

  /**
   * Region where the parameter is stored
   */
  readonly region: string;

  /**
   * IAM Role ARN in the target account that allows reading the parameter
   * This role will be assumed by the Custom Resource
   */
  readonly assumedRoleArn: string;
}

/**
 * Construct for creating SSM Parameters with cross-account read access
 * 
 * This construct simplifies the creation of SSM Parameters that need to be
 * shared across AWS accounts. It automatically sets up the necessary IAM
 * permissions for cross-account access.
 * 
 * @example
 * ```typescript
 * // Writer - Account A
 * const param = new CrossAccountParameter(this, 'VpcCIdParam', {
 *   parameterName: 'myproject/test/vpc-c/id',
 *   value: vpc.vpcId,
 *   description: 'VPC C ID for cross-account peering',
 *   readerAccountIds: ['987654321098'], // Account B
 * });
 * 
 * // Reader - Account B
 * const vpcId = CrossAccountParameter.fromArn(this, 'VpcCIdLookup', {
 *   parameterName: 'myproject/test/vpc-c/id',
 *   accountId: '123456789012', // Account A
 *   region: 'ap-northeast-1',
 * });
 * // Use: vpcId.stringValue
 * ```
 */
export class CrossAccountParameter extends Construct {
  public readonly parameter: ssm.IStringParameter;
  public readonly parameterArn: string;
  public readonly parameterName: string;
  public readonly readRole?: iam.Role;

  constructor(scope: Construct, id: string, props: CrossAccountParameterProps) {
    super(scope, id);

    // Ensure parameter name starts with /
    const paramName = props.parameterName.startsWith('/') 
      ? props.parameterName 
      : `/${props.parameterName}`;

    // Create SSM Parameter
    this.parameter = new ssm.StringParameter(this, 'Parameter', {
      parameterName: paramName,
      stringValue: props.value,
      description: props.description,
      tier: props.tier || ssm.ParameterTier.STANDARD,
    });

    this.parameterArn = this.parameter.parameterArn;
    this.parameterName = this.parameter.parameterName;

    // Grant read access to specified accounts
    props.readerAccountIds.forEach((accountId) => {
      this.parameter.grantRead(new iam.AccountPrincipal(accountId));
    });

    // Optionally create IAM role for Custom Resource access
    if (props.createReadRole) {
      const roleName = props.readRoleName || `${paramName.replace(/\//g, '-').substring(1)}-ReadRole`;
      
      this.readRole = new iam.Role(this, 'ReadRole', {
        assumedBy: new iam.CompositePrincipal(
          ...props.readerAccountIds.map(accountId => new iam.AccountPrincipal(accountId))
        ),
        roleName: roleName,
        description: `Role to allow cross-account access to parameter ${paramName}`,
      });

      // Grant read access to this parameter
      this.parameter.grantRead(this.readRole);

      // Output role ARN
      new cdk.CfnOutput(scope, `${id}ReadRoleArn`, {
        value: this.readRole.roleArn,
        description: `IAM Role ARN for reading parameter ${paramName}`,
        exportName: `${roleName}-Arn`,
      });
    }
  }

  /**
   * Import a cross-account parameter by ARN (Static Reference - Not for CloudFormation Deployment)
   * 
   * ⚠️ WARNING: This method creates a static reference and DOES NOT work at CloudFormation
   * deployment time for cross-account access. Use fromCustomResource() instead for
   * actual cross-account parameter reading during deployment.
   * 
   * This method is only useful for:
   * - Documentation/reference purposes
   * - Local development/testing
   * - Cases where the parameter is in the same account
   * 
   * @deprecated Use fromCustomResource() for cross-account access at deployment time
   * @param scope Construct scope
   * @param id Construct ID
   * @param props Lookup properties
   * @returns IStringParameter (static reference only)
   */
  public static fromArn(
    scope: Construct,
    id: string,
    props: CrossAccountParameterLookupProps
  ): ssm.IStringParameter {
    // Ensure parameter name starts with /
    const paramName = props.parameterName.startsWith('/')
      ? props.parameterName
      : `/${props.parameterName}`;

    // Construct ARN for cross-account parameter
    const parameterArn = `arn:aws:ssm:${props.region}:${props.accountId}:parameter${paramName}`;

    return ssm.StringParameter.fromStringParameterArn(scope, id, parameterArn);
  }

  /**
   * Read a cross-account parameter using Custom Resource (Recommended for CloudFormation)
   * 
   * This method uses AWS Custom Resource to read a parameter from another account
   * at deployment time. This is the CORRECT way to access cross-account parameters
   * in CloudFormation stacks.
   * 
   * Prerequisites:
   * - The target account must have created an IAM role that allows sts:AssumeRole
   *   from your account
   * - That role must have ssm:GetParameter permission for the specific parameter
   * 
   * @param scope Construct scope
   * @param id Construct ID
   * @param props Custom Resource lookup properties
   * @returns The parameter value as a string (not IStringParameter)
   * 
   * @example
   * ```typescript
   * // In target account (where parameter is stored), create read role:
   * const param = new CrossAccountParameter(this, 'VpcId', {
   *   parameterName: 'myproject/dev/vpc-c/id',
   *   value: vpc.vpcId,
   *   description: 'VPC C ID',
   *   readerAccountIds: ['123456789012'],
   *   createReadRole: true,  // Creates IAM role automatically
   *   readRoleName: 'myproject-dev-VpcCId-ReadRole',
   * });
   * 
   * // In reader account, read the parameter:
   * const vpcCId = CrossAccountParameter.fromCustomResource(this, 'VpcCIdLookup', {
   *   parameterName: 'myproject/dev/vpc-c/id',
   *   accountId: '987654321098',
   *   region: 'ap-northeast-1',
   *   assumedRoleArn: 'arn:aws:iam::987654321098:role/myproject-dev-VpcCId-ReadRole',
   * });
   * 
   * // Use directly (returns string value)
   * new ec2.CfnVPCPeeringConnection(this, 'Peering', {
   *   vpcId: localVpc.vpcId,
   *   peerVpcId: vpcCId,
   *   peerOwnerId: '987654321098',
   * });
   * ```
   */
  public static fromCustomResource(
    scope: Construct,
    id: string,
    props: CrossAccountParameterCustomResourceProps
  ): string {
    // Ensure parameter name starts with /
    const paramName = props.parameterName.startsWith('/')
      ? props.parameterName
      : `/${props.parameterName}`;

    // Create Custom Resource to read parameter from other account
    const getParameter = new cr.AwsCustomResource(scope, id, {
      onUpdate: {
        service: 'SSM',
        action: 'getParameter',
        parameters: {
          Name: paramName,
        },
        region: props.region,
        physicalResourceId: cr.PhysicalResourceId.of(`${id}-${paramName}`),
        assumedRoleArn: props.assumedRoleArn,
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [props.assumedRoleArn],
        }),
      ]),
    });

    return getParameter.getResponseField('Parameter.Value');
  }

  /**
   * Helper method to create a set of related parameters with a common prefix
   * 
   * This is useful when you need to share multiple related values across accounts,
   * such as VPC ID, CIDR block, and other network information.
   * 
   * @param scope Construct scope
   * @param id Construct ID
   * @param props Group creation properties
   * @returns Record of CrossAccountParameter instances keyed by parameter name
   * 
   * @example
   * ```typescript
   * // Create multiple related parameters
   * const params = CrossAccountParameter.createGroup(this, 'VpcCParams', {
   *   prefix: 'myproject/test/vpc-c',
   *   parameters: {
   *     'id': { 
   *       value: vpc.vpcId, 
   *       description: 'VPC C ID' 
   *     },
   *     'cidr': { 
   *       value: vpc.vpcCidrBlock, 
   *       description: 'VPC C CIDR block' 
   *     },
   *   },
   *   readerAccountIds: ['987654321098'],
   * });
   * 
   * // Access individual parameters
   * console.log(params['id'].parameterName);  // /myproject/test/vpc-c/id
   * console.log(params['cidr'].parameterName); // /myproject/test/vpc-c/cidr
   * ```
   */
  public static createGroup(
    scope: Construct,
    id: string,
    props: {
      prefix: string;
      parameters: Record<string, { value: string; description: string; tier?: ssm.ParameterTier }>;
      readerAccountIds: string[];
    }
  ): Record<string, CrossAccountParameter> {
    const result: Record<string, CrossAccountParameter> = {};
    const prefix = props.prefix.endsWith('/') ? props.prefix.slice(0, -1) : props.prefix;

    Object.entries(props.parameters).forEach(([key, config]) => {
      result[key] = new CrossAccountParameter(scope, `${id}-${key}`, {
        parameterName: `${prefix}/${key}`,
        value: config.value,
        description: config.description,
        readerAccountIds: props.readerAccountIds,
        tier: config.tier,
      });
    });

    return result;
  }

  /**
   * Helper method to lookup multiple related parameters from a different account
   * 
   * @param scope Construct scope
   * @param id Construct ID
   * @param props Group lookup properties
   * @returns Record of IStringParameter instances keyed by parameter name
   * 
   * @example
   * ```typescript
   * // Lookup multiple related parameters
   * const params = CrossAccountParameter.lookupGroup(this, 'VpcCParams', {
   *   prefix: 'myproject/test/vpc-c',
   *   parameterNames: ['id', 'cidr'],
   *   accountId: '123456789012',
   *   region: 'ap-northeast-1',
   * });
   * 
   * // Use the parameter values
   * const vpcId = params['id'].stringValue;
   * const cidr = params['cidr'].stringValue;
   * ```
   */
  public static lookupGroup(
    scope: Construct,
    id: string,
    props: {
      prefix: string;
      parameterNames: string[];
      accountId: string;
      region: string;
    }
  ): Record<string, ssm.IStringParameter> {
    const result: Record<string, ssm.IStringParameter> = {};
    const prefix = props.prefix.endsWith('/') ? props.prefix.slice(0, -1) : props.prefix;

    props.parameterNames.forEach((key) => {
      result[key] = CrossAccountParameter.fromArn(scope, `${id}-${key}`, {
        parameterName: `${prefix}/${key}`,
        accountId: props.accountId,
        region: props.region,
      });
    });

    return result;
  }
}
