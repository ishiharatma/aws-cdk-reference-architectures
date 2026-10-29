import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { KubectlV36Layer } from '@aws-cdk/lambda-layer-kubectl-v36';
import { Construct } from 'constructs';

/** Inputs shared by both cluster stacks. */
export interface ClusterDefaultsProps {
  readonly clusterName: string;
  readonly vpc: ec2.IVpc;
  readonly kubernetesVersion: string;
  /** CIDRs allowed to reach the public API endpoint (the deploying machine). */
  readonly endpointAllowedCidrs: string[];
  readonly logRetentionDays: number;
}

/**
 * Settings that are identical for the managed node group and Auto Mode clusters, so the two stacks
 * show only what differs. Owns the resources these settings point to (KMS key, log group,
 * kubectl layer).
 */
export class ClusterDefaults extends Construct {
  /** Spread into `eks.Cluster` props. */
  public readonly clusterProps: eks.ClusterProps;
  /** Control plane log group; the cluster must depend on it so EKS does not create it first. */
  public readonly controlPlaneLogGroup: logs.ILogGroup;

  /** Creates the shared KMS key, control plane log group and kubectl layer. */
  constructor(scope: Construct, id: string, props: ClusterDefaultsProps) {
    super(scope, id);
    // EKS writes control plane logs to this fixed name; creating it first sets the retention
    // and lets the stack delete it (EKS itself would create it with no expiry).
    this.controlPlaneLogGroup = new logs.LogGroup(this, 'ControlPlaneLogGroup', {
      logGroupName: `/aws/eks/${props.clusterName}/cluster`,
      retention: props.logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.clusterProps = {
      clusterName: props.clusterName,
      version: eks.KubernetesVersion.of(props.kubernetesVersion),
      vpc: props.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      // Public endpoint for kubectl from the allowed CIDRs; nodes and the kubectl handler
      // (placed in the private subnets) use the private endpoint.
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE.onlyFrom(...props.endpointAllowedCidrs),
      secretsEncryptionKey: new kms.Key(this, 'SecretsKey', {
        description: `Envelope encryption of Kubernetes secrets in ${props.clusterName}`,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
        eks.ClusterLoggingTypes.SCHEDULER,
      ],
      // Required so CDK can apply manifests and Helm charts during deployment.
      kubectlProviderOptions: {
        kubectlLayer: new KubectlV36Layer(this, 'KubectlLayer'),
      },
    };
  }
}

/**
 * Grants cluster-admin to an IAM principal through an EKS access entry, so a human can run kubectl.
 * Skipped when no principal is given; the CloudFormation execution role is the cluster creator.
 */
export function grantAdmin(cluster: eks.Cluster, principalArn?: string): void {
  if (!principalArn) {
    return;
  }
  cluster.grantAccess('AdminAccess', principalArn, [
    eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
      accessScopeType: eks.AccessScopeType.CLUSTER,
    }),
  ]);
}
