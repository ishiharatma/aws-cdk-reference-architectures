/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildStage, clientIp, adminPrincipalArn, testParams } from '../helpers/stage';
import { required } from '../helpers/stage';

/** Every `Custom::AWSCDK-EKS-KubernetesResource` manifest of a template, parsed. */
const manifests = (template: Template): any[] =>
  Object.values(template.findResources('Custom::AWSCDK-EKS-KubernetesResource')).flatMap((r: any) => {
    const raw = r.Properties.Manifest;
    // Manifests holding tokens are rendered as Fn::Join; join the literal parts for inspection.
    const text = typeof raw === 'string' ? raw : raw['Fn::Join'][1].map((p: any) => (typeof p === 'string' ? p : 'TOKEN')).join('');
    return JSON.parse(text);
  });

const byKind = (template: Template, kind: string): any => manifests(template).find((m) => m.kind === kind);

describe('Stage composition', () => {
  test('both cluster stacks are created by default and share the network stack VPC', () => {
    const stage = buildStage();
    expect(stage.managedNodeGroup).toBeDefined();
    expect(stage.autoMode).toBeDefined();
    // Cross-stack references are resolved (and stack dependencies added) at synthesis.
    Template.fromStack(required(stage.managedNodeGroup));
    Template.fromStack(required(stage.autoMode));
    expect(required(stage.managedNodeGroup).dependencies).toContain(stage.network);
    expect(required(stage.autoMode).dependencies).toContain(stage.network);
  });

  test('each cluster stack can be switched off', () => {
    const base = testParams();
    const onlyAuto = buildStage({ params: { managedNodeGroup: { ...base.managedNodeGroup, enabled: false } } });
    expect(onlyAuto.managedNodeGroup).toBeUndefined();
    expect(onlyAuto.autoMode).toBeDefined();
    const onlyMng = buildStage({ params: { autoMode: { ...base.autoMode, enabled: false } } });
    expect(onlyMng.autoMode).toBeUndefined();
  });
});

describe('NetworkStack', () => {
  const template = Template.fromStack(buildStage().network);

  test('three AZs with public and private subnets', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 6);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  test('subnets carry the ELB role tags used for ALB subnet discovery', () => {
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet')) as any[];
    const tagged = (key: string) =>
      subnets.filter((s) => s.Properties.Tags.some((t: any) => t.Key === key && t.Value === '1')).length;
    expect(tagged('kubernetes.io/role/elb')).toBe(3);
    expect(tagged('kubernetes.io/role/internal-elb')).toBe(3);
  });

  test('REJECT flow log', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', { TrafficType: 'REJECT' });
  });
});

describe.each([
  ['ManagedNodeGroup', 'test-test-eks-mng'],
  ['AutoMode', 'test-test-eks-auto'],
])('%s cluster (common settings)', (name, clusterName) => {
  const stage = buildStage();
  const stack = name === 'ManagedNodeGroup' ? required(stage.managedNodeGroup) : required(stage.autoMode);
  const template = Template.fromStack(stack);

  test('Kubernetes version, private subnets and public endpoint restricted to the client', () => {
    template.hasResourceProperties('AWS::EKS::Cluster', {
      Name: clusterName,
      Version: '1.36',
      ResourcesVpcConfig: Match.objectLike({
        EndpointPublicAccess: true,
        EndpointPrivateAccess: true,
        PublicAccessCidrs: [`${clientIp}/32`],
      }),
    });
  });

  test('secrets envelope encryption with a rotated KMS key', () => {
    template.hasResourceProperties('AWS::EKS::Cluster', {
      EncryptionConfig: [Match.objectLike({ Resources: ['secrets'] })],
    });
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  test('all control plane log types go to a pre-created log group with retention', () => {
    template.hasResourceProperties('AWS::EKS::Cluster', {
      Logging: {
        ClusterLogging: {
          EnabledTypes: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'].map((Type) => ({ Type })),
        },
      },
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/eks/${clusterName}/cluster`,
      RetentionInDays: 7,
    });
    const cluster = Object.values(template.findResources('AWS::EKS::Cluster'))[0] as any;
    const logGroupId = Object.keys(template.findResources('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: `/aws/eks/${clusterName}/cluster` },
    }))[0];
    expect(cluster.DependsOn).toContain(logGroupId);
  });

  test('cluster-admin access entry for the given principal (besides the kubectl handler entry)', () => {
    template.resourceCountIs('AWS::EKS::AccessEntry', 2);
    template.hasResourceProperties('AWS::EKS::AccessEntry', {
      PrincipalArn: adminPrincipalArn,
      AccessPolicies: [Match.objectLike({ AccessScope: { Type: 'cluster' } })],
    });
  });

  test('no access entry when no admin principal is given', () => {
    const noAdmin = buildStage({ adminPrincipalArn: undefined });
    const s = name === 'ManagedNodeGroup' ? required(noAdmin.managedNodeGroup) : required(noAdmin.autoMode);
    const entries = Template.fromStack(s).findResources('AWS::EKS::AccessEntry');
    expect(Object.values(entries).map((e: any) => e.Properties.PrincipalArn)).not.toContain(adminPrincipalArn);
  });

  test('kubectl handler runs in the VPC (private endpoint)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: 'onEvent handler for EKS kubectl resource provider',
      VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
    });
  });

  test('same workload: Deployment spread over AZs with drain-friendly settings', () => {
    const p = testParams().webApp;
    const deployment = byKind(template, 'Deployment');
    expect(deployment.spec.replicas).toBe(p.replicas);
    const pod = deployment.spec.template.spec;
    expect(pod.terminationGracePeriodSeconds).toBe(p.terminationGracePeriodSeconds);
    expect(pod.terminationGracePeriodSeconds).toBeGreaterThan(p.drainSeconds);
    expect(pod.topologySpreadConstraints[0]).toMatchObject({
      topologyKey: 'topology.kubernetes.io/zone',
      whenUnsatisfiable: 'DoNotSchedule',
    });
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.containers[0].readinessProbe.httpGet.path).toBe('/health');
    expect(pod.containers[0].securityContext.readOnlyRootFilesystem).toBe(true);
  });

  test('Ingress health check and deregistration delay', () => {
    const ingress = byKind(template, 'Ingress');
    expect(ingress.metadata.annotations).toMatchObject({
      'alb.ingress.kubernetes.io/healthcheck-path': '/health',
      'alb.ingress.kubernetes.io/target-group-attributes': 'deregistration_delay.timeout_seconds=15',
    });
  });

  test('ALB hostname is read back from the Ingress status', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-KubernetesObjectValue', {
      ObjectType: 'ingress',
      ObjectName: 'web',
      ObjectNamespace: 'web',
      JsonPath: '.status.loadBalancer.ingress[0].hostname',
    });
    template.hasOutput('AlbUrl', {});
  });
});

describe('ManagedNodeGroupStack', () => {
  const stack = required(buildStage().managedNodeGroup);
  const template = Template.fromStack(stack);

  test('no default capacity; one explicit AL2023 node group in the private subnets', () => {
    template.resourceCountIs('AWS::EKS::Nodegroup', 1);
    template.hasResourceProperties('AWS::EKS::Nodegroup', {
      AmiType: 'AL2023_x86_64_STANDARD',
      InstanceTypes: ['t3.medium'],
      ScalingConfig: { MinSize: 2, DesiredSize: 2, MaxSize: 4 },
      DiskSize: 20,
    });
    template.hasResourceProperties('AWS::EKS::Cluster', { ComputeConfig: { Enabled: false } });
  });

  test('ALB controller uses Pod Identity, not IRSA', () => {
    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      Namespace: 'kube-system',
      ServiceAccount: 'aws-load-balancer-controller',
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Principal: { Service: 'pods.eks.amazonaws.com' },
        })]),
      },
    });
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  test('Pod Identity Agent add-on waits for the node group', () => {
    const addon = Object.values(template.findResources('AWS::EKS::Addon', {
      Properties: { AddonName: 'eks-pod-identity-agent' },
    }))[0] as any;
    const nodeGroupId = Object.keys(template.findResources('AWS::EKS::Nodegroup'))[0];
    expect(addon.DependsOn).toContain(nodeGroupId);
  });

  test('controller Helm release waits for readiness and reuses the Pod Identity service account', () => {
    template.hasResourceProperties('Custom::AWSCDK-EKS-HelmChart', {
      Chart: 'aws-load-balancer-controller',
      Version: '3.2.2',
      Namespace: 'kube-system',
      Wait: true,
      Values: Match.anyValue(),
    });
    const chart = Object.values(template.findResources('Custom::AWSCDK-EKS-HelmChart'))[0] as any;
    expect(JSON.stringify(chart.Properties.Values)).toContain('\\"create\\":false');
  });

  test('controller policy matches the upstream v3.2.2 policy', () => {
    const upstream = require('../../src/alb-controller-iam-policy-v3.2.2.json');
    const policy = Object.values(template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: Match.stringLikeRegexp('^AlbControllerServiceAccountRole') }] },
    }))[0] as any;
    expect(policy.Properties.PolicyDocument.Statement).toHaveLength(upstream.Statement.length);
    expect(JSON.stringify(policy)).toContain('elasticloadbalancing:CreateLoadBalancer');
  });

  test('the workload and Ingress depend on the controller (webhook ready, ALB removed before it)', () => {
    const chartId = Object.keys(template.findResources('Custom::AWSCDK-EKS-HelmChart'))[0];
    const k8s = template.findResources('Custom::AWSCDK-EKS-KubernetesResource');
    const webApp = Object.entries(k8s).filter(([id]) => id.startsWith('WebApp'));
    expect(webApp).toHaveLength(2);
    for (const [, r] of webApp as [string, any][]) {
      expect(r.DependsOn).toContain(chartId);
    }
  });

  test('ALB configured through Ingress annotations', () => {
    const ingress = byKind(template, 'Ingress');
    expect(ingress.spec.ingressClassName).toBe('alb');
    expect(ingress.metadata.annotations).toMatchObject({
      'alb.ingress.kubernetes.io/scheme': 'internet-facing',
      'alb.ingress.kubernetes.io/target-type': 'ip',
      'alb.ingress.kubernetes.io/inbound-cidrs': `${clientIp}/32`,
    });
  });
});

describe('AutoModeStack', () => {
  const stack = required(buildStage().autoMode);
  const template = Template.fromStack(stack);

  test('Auto Mode compute, block storage and load balancing are enabled together', () => {
    template.hasResourceProperties('AWS::EKS::Cluster', {
      ComputeConfig: Match.objectLike({ Enabled: true, NodePools: ['system', 'general-purpose'] }),
      StorageConfig: { BlockStorage: { Enabled: true } },
      KubernetesNetworkConfig: Match.objectLike({ ElasticLoadBalancing: { Enabled: true } }),
    });
  });

  test('no node group, Helm chart, Pod Identity association or add-on is managed by the stack', () => {
    template.resourceCountIs('AWS::EKS::Nodegroup', 0);
    template.resourceCountIs('Custom::AWSCDK-EKS-HelmChart', 0);
    template.resourceCountIs('AWS::EKS::PodIdentityAssociation', 0);
    template.resourceCountIs('AWS::EKS::Addon', 0);
  });

  test('IngressClass points to the Auto Mode ALB controller with IngressClassParams', () => {
    const params = byKind(template, 'IngressClassParams');
    expect(params.apiVersion).toBe('eks.amazonaws.com/v1');
    expect(params.spec).toEqual({ scheme: 'internet-facing', targetType: 'ip', inboundCIDRs: [`${clientIp}/32`] });
    const ingressClass = byKind(template, 'IngressClass');
    expect(ingressClass.spec.controller).toBe('eks.amazonaws.com/alb');
    expect(byKind(template, 'Ingress').spec.ingressClassName).toBe(ingressClass.metadata.name);
  });

  test('Ingress carries no scheme/target-type annotations (they live in IngressClassParams)', () => {
    const annotations = byKind(template, 'Ingress').metadata.annotations;
    expect(annotations['alb.ingress.kubernetes.io/scheme']).toBeUndefined();
    expect(annotations['alb.ingress.kubernetes.io/inbound-cidrs']).toBeUndefined();
  });
});
