import { Environment, EnvironmentConfig } from '@common/parameters/environments';

/** Network shared by both clusters. */
export interface NetworkParams {
  readonly vpcCidr: string;
  readonly maxAzs: number;
  /** NAT gateways for node egress (image pulls, EKS API). 1 for dev, one per AZ for production. */
  readonly natGateways: number;
}

/** The managed node group of the L-1 cluster. */
export interface NodeGroupParams {
  readonly instanceTypes: string[];
  readonly minSize: number;
  readonly desiredSize: number;
  readonly maxSize: number;
  readonly diskSizeGiB: number;
}

/** L-1: managed node group + self-installed AWS Load Balancer Controller (Helm, Pod Identity). */
export interface ManagedNodeGroupClusterParams {
  readonly enabled: boolean;
  readonly nodeGroup: NodeGroupParams;
  /** Helm chart version of the AWS Load Balancer Controller; the IAM policy in `src/` must match it. */
  readonly albControllerChartVersion: string;
}

/** L-2: EKS Auto Mode. Nodes, the load balancer controller and Pod Identity run as managed capabilities. */
export interface AutoModeClusterParams {
  readonly enabled: boolean;
  /** Built-in node pools. `general-purpose` runs the application, `system` runs cluster add-ons. */
  readonly nodePools: string[];
}

/** The web application deployed identically to both clusters. */
export interface WebAppParams {
  /** Container image with Python 3; `src/app.py` is passed as the command. */
  readonly image: string;
  readonly replicas: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly memoryLimit: string;
  /** Seconds the pod keeps serving after SIGTERM while it reports unhealthy. */
  readonly drainSeconds: number;
  /** Must exceed `drainSeconds` so the kubelet does not SIGKILL a draining pod. */
  readonly terminationGracePeriodSeconds: number;
  /** ALB target group deregistration delay. */
  readonly deregistrationDelaySeconds: number;
}

/**
 * Environment parameters type
 */
export interface EnvParams extends EnvironmentConfig {
  readonly network: NetworkParams;
  /** Kubernetes version of both clusters. Must match the kubectl layer (`KubectlV36Layer`). */
  readonly kubernetesVersion: string;
  readonly managedNodeGroup: ManagedNodeGroupClusterParams;
  readonly autoMode: AutoModeClusterParams;
  readonly webApp: WebAppParams;
  /** Retention of the control plane logs and the VPC flow logs. */
  readonly logRetentionDays: number;
}

// Object to store parameters for each environment
export const params: Partial<Record<Environment, EnvParams>> = {};
