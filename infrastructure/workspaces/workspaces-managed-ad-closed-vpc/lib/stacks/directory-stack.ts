import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ClosedVpc } from 'lib/constructs/closed-vpc';
import { ManagedAd } from 'lib/constructs/managed-ad';
import { ManagementInstance } from 'lib/constructs/management-instance';
import { DirectoryParams, ManagementInstanceParams } from 'lib/types';

/** Properties of {@link DirectoryStack}. */
export interface DirectoryStackProps extends cdk.StackProps {
  readonly namePrefix: string;
  readonly network: ClosedVpc;
  readonly vpcCidr: string;
  readonly directory: DirectoryParams;
  readonly managementInstance: ManagementInstanceParams;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/**
 * AWS Managed Microsoft AD + the management instance that builds the OU tree, groups,
 * PSO and GPOs. The stack completes only after the bootstrap association has succeeded.
 */
export class DirectoryStack extends cdk.Stack {
  public readonly managedAd: ManagedAd;
  public readonly managementInstance: ManagementInstance;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: DirectoryStackProps) {
    super(scope, id, props);

    const { network, managementInstance } = props;
    const managementSubnet = network.management.subnets[managementInstance.subnetIndex];
    if (!managementSubnet) {
      throw new Error(
        `managementInstance.subnetIndex ${managementInstance.subnetIndex} is out of range`
      );
    }

    this.managedAd = new ManagedAd(this, 'ManagedAd', {
      namePrefix: props.namePrefix,
      directory: props.directory,
      vpc: network.vpc,
      subnets: network.directory.subnets,
      removalPolicy: props.removalPolicy,
    });

    this.managementInstance = new ManagementInstance(this, 'ManagementInstance', {
      namePrefix: props.namePrefix,
      vpc: network.vpc,
      subnet: managementSubnet,
      managementCidrs: network.management.cidrs,
      vpcCidr: props.vpcCidr,
      params: managementInstance,
      directory: props.directory,
      dnsIpAddresses: this.managedAd.dnsIpAddresses,
      adminSecret: this.managedAd.adminSecret,
    });

    new cdk.CfnOutput(this, 'DirectoryId', { value: this.managedAd.directoryId });
    new cdk.CfnOutput(this, 'AdminSecretArn', { value: this.managedAd.adminSecret.secretArn });
    new cdk.CfnOutput(this, 'ManagementInstanceId', {
      value: this.managementInstance.instance.instanceId,
    });
    new cdk.CfnOutput(this, 'InstallDcvAdmxDocumentName', {
      value: this.managementInstance.installDcvAdmxDocument.ref,
      description: 'Run after the first WorkSpace is AVAILABLE (parameter: WorkSpaceComputerName)',
    });
  }
}
