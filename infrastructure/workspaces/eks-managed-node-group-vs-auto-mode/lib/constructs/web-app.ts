import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks-v2';
import { Construct } from 'constructs';
import { WebAppParams } from 'parameters/environments';

/** Properties for {@link WebApp}. */
export interface WebAppProps {
  readonly cluster: eks.ICluster;
  /** Reported by the application so responses show which cluster answered. */
  readonly clusterMode: string;
  readonly ingressClassName: string;
  /** Load balancer settings that the controller reads from the Ingress. */
  readonly ingressAnnotations: Record<string, string>;
  readonly params: WebAppParams;
}

const NAMESPACE = 'web';
const NAME = 'web';
const PORT = 8080;

/**
 * The same workload for both clusters: Deployment spread across AZs, ClusterIP Service and an
 * Ingress that the cluster's load balancer controller turns into an internet-facing ALB.
 */
export class WebApp extends Construct {
  /** Namespace, Deployment and Service. */
  public readonly workload: eks.KubernetesManifest;
  public readonly ingress: eks.KubernetesManifest;
  /** ALB DNS name, read from the Ingress status once the controller has created the ALB. */
  public readonly albHostname: string;

  /** Applies the workload and Ingress manifests and reads back the ALB hostname. */
  constructor(scope: Construct, id: string, props: WebAppProps) {
    super(scope, id);
    const p = props.params;
    const labels = { 'app.kubernetes.io/name': NAME };
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app.py'), 'utf8');

    const fieldEnv = (name: string, fieldPath: string) => ({ name, valueFrom: { fieldRef: { fieldPath } } });

    this.workload = new eks.KubernetesManifest(this, 'Workload', {
      cluster: props.cluster,
      manifest: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE } },
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: NAME, namespace: NAMESPACE, labels },
        spec: {
          replicas: p.replicas,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              terminationGracePeriodSeconds: p.terminationGracePeriodSeconds,
              // One pod per AZ before any AZ gets a second one.
              topologySpreadConstraints: [{
                maxSkew: 1,
                topologyKey: 'topology.kubernetes.io/zone',
                whenUnsatisfiable: 'DoNotSchedule',
                labelSelector: { matchLabels: labels },
              }],
              securityContext: { runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [{
                name: NAME,
                image: p.image,
                command: ['python', '-c', source],
                ports: [{ containerPort: PORT }],
                env: [
                  { name: 'PORT', value: String(PORT) },
                  { name: 'DRAIN_SECONDS', value: String(p.drainSeconds) },
                  { name: 'CLUSTER_MODE', value: props.clusterMode },
                  fieldEnv('POD_NAME', 'metadata.name'),
                  fieldEnv('NODE_NAME', 'spec.nodeName'),
                  // Populated only if the API server copies node topology labels onto pods.
                  fieldEnv('ZONE', "metadata.labels['topology.kubernetes.io/zone']"),
                ],
                resources: {
                  requests: { cpu: p.cpuRequest, memory: p.memoryRequest },
                  limits: { memory: p.memoryLimit },
                },
                readinessProbe: { httpGet: { path: '/health', port: PORT }, periodSeconds: 5 },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
              }],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: NAME, namespace: NAMESPACE, labels },
        spec: { type: 'ClusterIP', selector: labels, ports: [{ port: 80, targetPort: PORT, protocol: 'TCP' }] },
      },
      ],
    });

    this.ingress = new eks.KubernetesManifest(this, 'Ingress', {
      cluster: props.cluster,
      manifest: [{
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: NAME,
        namespace: NAMESPACE,
        annotations: {
          'alb.ingress.kubernetes.io/healthcheck-path': '/health',
          'alb.ingress.kubernetes.io/target-group-attributes':
            `deregistration_delay.timeout_seconds=${p.deregistrationDelaySeconds}`,
          ...props.ingressAnnotations,
        },
      },
      spec: {
        ingressClassName: props.ingressClassName,
        rules: [{
          http: {
            paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: NAME, port: { number: 80 } } } }],
          },
        }],
      },
      }],
    });
    this.ingress.node.addDependency(this.workload);

    const hostname = new eks.KubernetesObjectValue(this, 'AlbHostname', {
      cluster: props.cluster,
      objectType: 'ingress',
      objectName: NAME,
      objectNamespace: NAMESPACE,
      jsonPath: '.status.loadBalancer.ingress[0].hostname',
      timeout: cdk.Duration.minutes(10),
    });
    hostname.node.addDependency(this.ingress);
    this.albHostname = hostname.value;
  }
}
