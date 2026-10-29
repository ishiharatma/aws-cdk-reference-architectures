import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct } from 'constructs';
import { ManagedNodeGroupClusterParams, WebAppParams } from 'parameters/environments';
import { ClusterDefaults, grantAdmin } from 'lib/constructs/cluster-defaults';
import { AlbControllerPodIdentity } from 'lib/constructs/alb-controller-pod-identity';
import { WebApp } from 'lib/constructs/web-app';

/** Properties for {@link ManagedNodeGroupStack}. */
export interface ManagedNodeGroupStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly vpc: ec2.IVpc;
  readonly kubernetesVersion: string;
  readonly cluster: ManagedNodeGroupClusterParams;
  readonly webApp: WebAppParams;
  readonly allowedIps: string[];
  readonly adminPrincipalArn?: string;
  readonly logRetentionDays: number;
}

/**
 * L-1: EKS with a managed node group. The node group, the Pod Identity Agent add-on and the
 * AWS Load Balancer Controller are all owned (versioned, scaled, upgraded) by this stack.
 */
export class ManagedNodeGroupStack extends cdk.Stack {
  public readonly cluster: eks.ICluster;
  public readonly nodeGroup: eks.INodegroup;
  public readonly albController: AlbControllerPodIdentity;
  public readonly webApp: WebApp;

  /** Creates the cluster, node group, controller and the web application. */
  constructor(scope: Construct, id: string, props: ManagedNodeGroupStackProps) {
    super(scope, id, props);
    const ng = props.cluster.nodeGroup;
    const allowedCidrs = props.allowedIps.map((ip) => `${ip}/32`);

    const defaults = new ClusterDefaults(this, 'Defaults', {
      clusterName: props.clusterName,
      vpc: props.vpc,
      kubernetesVersion: props.kubernetesVersion,
      endpointAllowedCidrs: allowedCidrs,
      logRetentionDays: props.logRetentionDays,
    });
    const cluster = new eks.Cluster(this, 'Cluster', {
      ...defaults.clusterProps,
      defaultCapacityType: eks.DefaultCapacityType.NODEGROUP,
      // The node group is declared below so its sizing and AMI are explicit.
      defaultCapacity: 0,
    });
    this.cluster = cluster;
    cluster.node.addDependency(defaults.controlPlaneLogGroup);
    grantAdmin(cluster, props.adminPrincipalArn);

    const nodeGroup = cluster.addNodegroupCapacity('Workers', {
      nodegroupName: `${props.clusterName}-workers`,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      instanceTypes: ng.instanceTypes.map((t) => new ec2.InstanceType(t)),
      minSize: ng.minSize,
      desiredSize: ng.desiredSize,
      maxSize: ng.maxSize,
      diskSize: ng.diskSizeGiB,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
    this.nodeGroup = nodeGroup;

    this.albController = new AlbControllerPodIdentity(this, 'AlbController', {
      cluster,
      chartVersion: props.cluster.albControllerChartVersion,
    });
    // The agent add-on and the controller pods need nodes to become ready.
    cluster.eksPodIdentityAgent?.node.addDependency(nodeGroup);
    this.albController.node.addDependency(nodeGroup);

    this.webApp = new WebApp(this, 'WebApp', {
      cluster,
      clusterMode: 'managed-node-group',
      // IngressClass installed by the Helm chart.
      ingressClassName: 'alb',
      // With the self-managed controller, the ALB is configured per Ingress through annotations.
      ingressAnnotations: {
        'alb.ingress.kubernetes.io/scheme': 'internet-facing',
        'alb.ingress.kubernetes.io/target-type': 'ip',
        'alb.ingress.kubernetes.io/inbound-cidrs': allowedCidrs.join(','),
      },
      params: props.webApp,
    });
    // Keeps the controller (and its webhook) alive until the Ingress and its ALB are deleted.
    this.webApp.node.addDependency(this.albController);

    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${this.webApp.albHostname}` });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new cdk.CfnOutput(this, 'NodeGroupName', { value: nodeGroup.nodegroupName });
  }
}
