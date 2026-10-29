import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { NetworkStack } from 'lib/stacks/network-stack';
import { ManagedNodeGroupStack } from 'lib/stacks/managed-node-group-stack';
import { AutoModeStack } from 'lib/stacks/auto-mode-stack';

/** Properties for {@link EksManagedNodeGroupVsAutoModeStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  /** Client IPv4 addresses allowed to reach the ALBs and the public API endpoints. */
  readonly allowedIps: string[];
  /** IAM principal granted cluster-admin on both clusters (for kubectl). */
  readonly adminPrincipalArn?: string;
}

/** Shared VPC plus one stack per cluster; each cluster stack can be switched off in EnvParams. */
export class EksManagedNodeGroupVsAutoModeStage extends cdk.Stage {
  public readonly network: NetworkStack;
  public readonly managedNodeGroup?: ManagedNodeGroupStack;
  public readonly autoMode?: AutoModeStack;

  /** Creates the network stack and the enabled cluster stacks. */
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);
    const p = props.params;
    const prefix = `${props.project}-${props.environment}`;
    const common = {
      env: props.env,
      terminationProtection: props.terminationProtection,
    };

    this.network = new NetworkStack(this, pascalCase(`${props.project}EksNetwork`), {
      ...common,
      stackName: `${prefix}-eks-network`,
      description: 'VPC shared by the managed node group and Auto Mode EKS clusters',
      network: p.network,
      logRetentionDays: p.logRetentionDays,
    });

    const clusterCommon = {
      ...common,
      vpc: this.network.vpc,
      kubernetesVersion: p.kubernetesVersion,
      webApp: p.webApp,
      allowedIps: props.allowedIps,
      adminPrincipalArn: props.adminPrincipalArn,
      logRetentionDays: p.logRetentionDays,
    };

    if (p.managedNodeGroup.enabled) {
      this.managedNodeGroup = new ManagedNodeGroupStack(this, pascalCase(`${props.project}EksManagedNodeGroup`), {
        ...clusterCommon,
        stackName: `${prefix}-eks-mng`,
        description: 'EKS with a managed node group and the AWS Load Balancer Controller (Pod Identity)',
        clusterName: `${prefix}-eks-mng`,
        cluster: p.managedNodeGroup,
      });
    }

    if (p.autoMode.enabled) {
      this.autoMode = new AutoModeStack(this, pascalCase(`${props.project}EksAutoMode`), {
        ...clusterCommon,
        stackName: `${prefix}-eks-auto`,
        description: 'EKS Auto Mode serving the same application through its managed ALB controller',
        clusterName: `${prefix}-eks-auto`,
        cluster: p.autoMode,
      });
    }
  }
}
