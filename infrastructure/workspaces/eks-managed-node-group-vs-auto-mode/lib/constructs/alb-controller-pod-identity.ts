import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** Properties for {@link AlbControllerPodIdentity}. */
export interface AlbControllerPodIdentityProps {
  readonly cluster: eks.ICluster;
  /** Helm chart version; the controller image tag is `v<chartVersion>`. */
  readonly chartVersion: string;
}

/**
 * AWS Load Balancer Controller installed with Helm, authenticated through EKS Pod Identity.
 *
 * The built-in `albController` option of `eks.Cluster` uses IRSA (an IAM OIDC provider plus a
 * role trust policy per service account). Pod Identity needs neither: the role trusts
 * `pods.eks.amazonaws.com` and a Pod Identity association binds it to the service account.
 */
export class AlbControllerPodIdentity extends Construct {
  public readonly serviceAccount: eks.ServiceAccount;
  public readonly chart: eks.HelmChart;

  /** Creates the service account, its role, the Pod Identity association and the Helm release. */
  constructor(scope: Construct, id: string, props: AlbControllerPodIdentityProps) {
    super(scope, id);
    const namespace = 'kube-system';

    this.serviceAccount = new eks.ServiceAccount(this, 'ServiceAccount', {
      cluster: props.cluster,
      name: 'aws-load-balancer-controller',
      namespace,
      identityType: eks.IdentityType.POD_IDENTITY,
    });

    // Upstream policy for the controller version, as shipped with aws-cdk-lib.
    const policyFile = path.join(__dirname, '..', '..', 'src', `alb-controller-iam-policy-v${props.chartVersion}.json`);
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8')) as { Statement: Record<string, unknown>[] };
    for (const statement of policy.Statement) {
      this.serviceAccount.addToPrincipalPolicy(iam.PolicyStatement.fromJson(statement));
    }

    this.chart = new eks.HelmChart(this, 'Chart', {
      cluster: props.cluster,
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      release: 'aws-load-balancer-controller',
      version: props.chartVersion,
      namespace,
      // Waits until the controller (and its admission webhook) is ready, so manifests that
      // depend on this chart are not rejected by an unreachable webhook.
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        clusterName: props.cluster.clusterName,
        region: cdk.Stack.of(this).region,
        vpcId: props.cluster.vpc.vpcId,
        serviceAccount: { create: false, name: this.serviceAccount.serviceAccountName },
      },
    });
    this.chart.node.addDependency(this.serviceAccount);
  }
}
