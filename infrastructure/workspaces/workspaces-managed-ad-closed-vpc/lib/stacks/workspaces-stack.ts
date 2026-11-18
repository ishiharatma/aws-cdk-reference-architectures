import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ClosedVpc } from 'lib/constructs/closed-vpc';
import { WORKSPACES_COMPUTER_OU } from 'lib/constructs/management-instance';
import { OperatorRole } from 'lib/constructs/operator-role';
import { WorkSpacesDirectory } from 'lib/constructs/workspaces-directory';
import { OperatorRoleParams, WorkSpacesParams } from 'lib/types';

/** Properties of {@link WorkSpacesStack}. */
export interface WorkSpacesStackProps extends cdk.StackProps {
  readonly namePrefix: string;
  readonly network: ClosedVpc;
  readonly directoryId: string;
  readonly directoryArn: string;
  /** `OU=<NetBIOS>,DC=...` */
  readonly delegatedOuDn: string;
  readonly workspaces: WorkSpacesParams;
  readonly operatorRole: OperatorRoleParams;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * WorkSpaces directory registration (IP restriction, locked settings) and the operator role.
 * No WorkSpace is created here: the vendor launches them with the operator role.
 */
export class WorkSpacesStack extends cdk.Stack {
  public readonly directory: WorkSpacesDirectory;
  public readonly operatorRole: OperatorRole;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: WorkSpacesStackProps) {
    super(scope, id, props);

    this.directory = new WorkSpacesDirectory(this, 'WorkSpacesDirectory', {
      params: props.workspaces,
      vpc: props.network.vpc,
      directoryId: props.directoryId,
      subnets: props.network.workspaces.subnets,
      defaultOuDn: `${WORKSPACES_COMPUTER_OU},${props.delegatedOuDn}`,
      managementCidrs: props.network.management.cidrs,
      removalPolicy: props.removalPolicy,
    });

    this.operatorRole = new OperatorRole(this, 'OperatorRole', {
      params: props.operatorRole,
      directoryArn: props.directoryArn,
    });

    new cdk.CfnOutput(this, 'RegistrationCode', {
      value: this.directory.registrationCode,
      description: 'Enter this code in the WorkSpaces client on the standard PCs',
    });
    new cdk.CfnOutput(this, 'IpGroupId', { value: this.directory.ipGroup.attrGroupId });
    new cdk.CfnOutput(this, 'OperatorRoleArn', { value: this.operatorRole.role.roleArn });
  }
}
