import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct } from 'constructs';
import { AutoModeClusterParams, WebAppParams } from 'parameters/environments';
import { ClusterDefaults, grantAdmin } from 'lib/constructs/cluster-defaults';
import { WebApp } from 'lib/constructs/web-app';

/** Properties for {@link AutoModeStack}. */
export interface AutoModeStackProps extends cdk.StackProps {
  readonly clusterName: string;
  readonly vpc: ec2.IVpc;
  readonly kubernetesVersion: string;
  readonly cluster: AutoModeClusterParams;
  readonly webApp: WebAppParams;
  readonly allowedIps: string[];
  readonly adminPrincipalArn?: string;
  readonly logRetentionDays: number;
}

/** Name of both the IngressClass and its IngressClassParams. */
const INGRESS_CLASS = 'auto-alb';

/**
 * L-2: the same application on EKS Auto Mode. Nodes, the load balancer controller and Pod Identity
 * are managed capabilities of the cluster; the stack only selects the built-in node pools and
 * declares an IngressClass for the managed ALB controller.
 */
export class AutoModeStack extends cdk.Stack {
  public readonly cluster: eks.ICluster;
  public readonly webApp: WebApp;

  /** Creates the Auto Mode cluster, the IngressClass and the web application. */
  constructor(scope: Construct, id: string, props: AutoModeStackProps) {
    super(scope, id, props);
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
      defaultCapacityType: eks.DefaultCapacityType.AUTOMODE,
      compute: { nodePools: props.cluster.nodePools },
    });
    this.cluster = cluster;
    cluster.node.addDependency(defaults.controlPlaneLogGroup);
    grantAdmin(cluster, props.adminPrincipalArn);

    // Auto Mode reads load balancer settings from IngressClassParams (eks.amazonaws.com/v1),
    // not from annotations on the IngressClass.
    const ingressClass = new eks.KubernetesManifest(this, 'IngressClass', {
      cluster: this.cluster,
      manifest: [
        {
          apiVersion: 'eks.amazonaws.com/v1',
          kind: 'IngressClassParams',
          metadata: { name: INGRESS_CLASS },
          spec: { scheme: 'internet-facing', targetType: 'ip', inboundCIDRs: allowedCidrs },
        },
        {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'IngressClass',
          metadata: { name: INGRESS_CLASS },
          spec: {
            controller: 'eks.amazonaws.com/alb',
            parameters: { apiGroup: 'eks.amazonaws.com', kind: 'IngressClassParams', name: INGRESS_CLASS },
          },
        },
      ],
    });

    this.webApp = new WebApp(this, 'WebApp', {
      cluster: this.cluster,
      clusterMode: 'auto-mode',
      ingressClassName: INGRESS_CLASS,
      // Scheme, target type and source CIDRs come from the IngressClassParams above.
      ingressAnnotations: {},
      params: props.webApp,
    });
    this.webApp.node.addDependency(ingressClass);

    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${this.webApp.albHostname}` });
    new cdk.CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
  }
}
