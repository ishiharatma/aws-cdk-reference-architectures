import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagPackSuppression, NagSuppressions } from 'cdk-nag';
import { buildStage } from '../helpers/stage';
import { required } from '../helpers/stage';

const kubectlProviderSuppressions: NagPackSuppression[] = [
  {
    id: 'AwsSolutions-L1',
    reason: 'The runtime of the CDK-provided kubectl handler is chosen by aws-cdk-lib.',
  },
];

const iam4 = (roles: string): NagPackSuppression => ({
  id: 'AwsSolutions-IAM4',
  reason:
    `EKS requires AWS managed policies on ${roles}. The CDK kubectl handler, which runs in the private ` +
    'subnets, uses the Lambda basic/VPC access and ECR read-only managed policies.',
});

const providerIam5: NagPackSuppression = {
  id: 'AwsSolutions-IAM5',
  reason: 'The CDK provider framework invokes the versions of its own kubectl handler (`<handler-arn>:*`).',
};

describe('CDK Nag AwsSolutions Pack', () => {
  const app = new cdk.App();
  const stage = buildStage({ app });
  const mng = required(stage.managedNodeGroup);
  const auto = required(stage.autoMode);

  NagSuppressions.addStackSuppressions(
    mng,
    [
      ...kubectlProviderSuppressions,
      iam4(
        'the cluster role (AmazonEKSClusterPolicy) and the node role (AmazonEKSWorkerNodePolicy, ' +
          'AmazonEKS_CNI_Policy, AmazonEC2ContainerRegistryReadOnly)',
      ),
      providerIam5,
    ],
    true,
  );
  NagSuppressions.addResourceSuppressions(
    mng.albController.serviceAccount.role,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Upstream AWS Load Balancer Controller v3.2.2 policy: the controller creates ALBs, target groups and ' +
          'security groups whose ARNs are unknown in advance; mutating actions are scoped by the ' +
          'elbv2.k8s.aws/cluster tag conditions of that policy.',
      },
    ],
    true,
  );
  NagSuppressions.addStackSuppressions(
    auto,
    [
      ...kubectlProviderSuppressions,
      iam4(
        'the Auto Mode cluster role (AmazonEKSClusterPolicy, AmazonEKSComputePolicy, AmazonEKSBlockStoragePolicy, ' +
          'AmazonEKSLoadBalancingPolicy, AmazonEKSNetworkingPolicy) and the node pool role ' +
          '(AmazonEKSWorkerNodePolicy, AmazonEC2ContainerRegistryReadOnly)',
      ),
      providerIam5,
    ],
    true,
  );

  // Aspects added to the App do not reach stacks inside a Stage; attach the pack to the Stage.
  cdk.Aspects.of(stage).add(new AwsSolutionsChecks({ verbose: true, logIgnores: true }));
  const stacks = [stage.network, mng, auto];

  test.each(stacks.map((s) => [s.node.id, s] as const))('%s has no unsuppressed findings', (_id, stack) => {
    const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    const findings = [...warnings, ...errors];
    if (findings.length > 0) {
      console.log(JSON.stringify(findings.map((f) => ({ id: f.id, entry: f.entry.data })), null, 2));
    }
    expect(findings).toHaveLength(0);
  });

  test('the pack actually inspected the stage', () => {
    // Guards against the suite passing vacuously: with logIgnores, suppressed findings are recorded as info.
    const suppressed = Annotations.fromStack(mng).findInfo('*', Match.stringLikeRegexp('AwsSolutions-IAM5.*'));
    expect(suppressed.length).toBeGreaterThan(0);
  });
});
