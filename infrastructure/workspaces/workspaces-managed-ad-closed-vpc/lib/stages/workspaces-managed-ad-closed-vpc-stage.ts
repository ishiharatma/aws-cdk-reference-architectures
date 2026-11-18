import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { NetworkStack } from 'lib/stacks/network-stack';
import { DirectoryStack } from 'lib/stacks/directory-stack';
import { WorkSpacesStack } from 'lib/stacks/workspaces-stack';
import { UsageReportStack } from 'lib/stacks/usage-report-stack';

/** Properties of {@link Stage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
}

/**
 * Network -> Directory (Managed AD + bootstrap) -> WorkSpaces (registration + operator role),
 * plus the independent usage report stack.
 */
export class WorkspacesManagedAdClosedVpcStage extends cdk.Stage {
  public readonly network: NetworkStack;
  public readonly directory: DirectoryStack;
  public readonly workspaces: WorkSpacesStack;
  public readonly usageReport: UsageReportStack;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const { params } = props;
    const namePrefix = `${props.project}-${props.environment}`;
    const removalPolicy = props.isAutoDeleteObject
      ? cdk.RemovalPolicy.DESTROY
      : cdk.RemovalPolicy.RETAIN;
    const common = {
      env: props.env,
      terminationProtection: props.terminationProtection,
      namePrefix,
      removalPolicy,
    };

    this.network = new NetworkStack(this, 'Network', {
      ...common,
      stackName: `${namePrefix}-ws-network`,
      description: 'WorkSpaces closed VPC (no IGW / NAT) with VPC endpoints',
      network: params.network,
    });

    this.directory = new DirectoryStack(this, 'Directory', {
      ...common,
      stackName: `${namePrefix}-ws-directory`,
      description: 'AWS Managed Microsoft AD and the management instance that builds OUs / GPOs',
      network: this.network.network,
      vpcCidr: params.network.vpcCidr,
      directory: params.directory,
      managementInstance: params.managementInstance,
    });

    this.workspaces = new WorkSpacesStack(this, 'WorkSpaces', {
      ...common,
      stackName: `${namePrefix}-ws-workspaces`,
      description: 'WorkSpaces directory registration with IP access control and the operator role',
      network: this.network.network,
      directoryId: this.directory.managedAd.directoryId,
      directoryArn: this.directory.managedAd.directoryArn,
      delegatedOuDn: this.directory.managedAd.delegatedOuDn,
      workspaces: params.workspaces,
      operatorRole: params.operatorRole,
    });
    // The default OU must exist before registration: it is created by the bootstrap
    // association, which the Directory stack waits for.
    this.workspaces.addStackDependency(this.directory);

    this.usageReport = new UsageReportStack(this, 'UsageReport', {
      ...common,
      stackName: `${namePrefix}-ws-usage-report`,
      description: 'Monthly WorkSpaces usage report (Scheduler -> Lambda -> S3 / SNS)',
      usageReport: params.usageReport,
      autoDeleteObjects: props.isAutoDeleteObject,
    });
  }
}
