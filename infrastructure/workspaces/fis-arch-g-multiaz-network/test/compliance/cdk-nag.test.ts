import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { params } from 'parameters/environments';
import '../parameters';

import { BaseStack } from 'lib/stacks/base-stack';
import { AppStack } from 'lib/stacks/app-stack';
import { FisStack } from 'lib/stacks/fis-stack';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'fis-chaos-g';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName]!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStacks(appId: string) {
    const app = new cdk.App();

    const baseStack = new BaseStack(app, `${appId}Base`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        vpcConfig: envParams.vpcConfig,
    });

    const appStack = new AppStack(app, `${appId}App`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        vpc: baseStack.vpc,
        auroraCluster: baseStack.auroraCluster,
        auroraSecret: baseStack.auroraSecret,
    });

    const fisStack = new FisStack(app, `${appId}Fis`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        terminationProtection: false,
        targetGroup: appStack.targetGroup,
        auroraCluster: baseStack.auroraCluster,
        azSubnetArns: baseStack.azSubnetArns,
        alarmEmail: envParams.alarmEmail,
    });

    return { app, baseStack, appStack, fisStack };
}

// ---------------------------------------------------------------------------
// Suppression helpers
// ---------------------------------------------------------------------------

function suppressBaseStack(stack: BaseStack): void {
    const p = `/${stack.stackName}`;

    // Aurora deletion protection is intentionally disabled — chaos demo cluster
    // that is destroyed with the stack and never holds production data.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/Aurora/Resource`, [
        {
            id: 'AwsSolutions-RDS10',
            reason:
                'Deletion protection is intentionally disabled for this chaos demo cluster. ' +
                'The cluster is destroyed with the stack and never holds production data.',
        },
    ]);

    // AuroraSecret: automatic rotation is out of scope for a short-lived chaos demo.
    // The secret is destroyed with the stack; production deployments should enable rotation.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/AuroraSecret/Resource`, [
        {
            id: 'AwsSolutions-SMG4',
            reason:
                'Automatic secret rotation is not configured. This is a chaos engineering demo ' +
                'where the cluster and secret are destroyed after the experiment window. ' +
                'Rotation is out of scope for this short-lived reference pattern.',
        },
    ]);

    // DbSecurityGroup: AwsSolutions-EC23 cannot be validated because vpc.vpcCidrBlock
    // resolves to an intrinsic function (Fn::GetAtt on VPC CidrBlock) at synthesis time.
    // The ingress source is restricted to the VPC CIDR — not 0.0.0.0/0.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/DbSecurityGroup/Resource`, [
        {
            id: 'CdkNagValidationFailure',
            reason:
                'AwsSolutions-EC23 cannot be validated: vpc.vpcCidrBlock resolves to an ' +
                'intrinsic function at synthesis time. The actual ingress source is the VPC CIDR ' +
                '(not 0.0.0.0/0); cdk-nag cannot evaluate intrinsic values at synth time.',
        },
    ]);

    // Stack-wide suppressions:
    // VPC7: VPC Flow Logs are out of scope for this chaos engineering demo.
    // RDS6: IAM database authentication is not enabled (Secrets Manager credentials used).
    // IAM4/IAM5: CDK-managed LogRetention Lambda (created by cloudwatchLogsRetention on Aurora)
    //   uses AWSLambdaBasicExecutionRole and requires wildcard log management permissions.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-VPC7',
                reason:
                    'VPC Flow Logs are not enabled. Network traffic analysis is out of scope ' +
                    'for this chaos engineering reference pattern.',
            },
            {
                id: 'AwsSolutions-RDS6',
                reason:
                    'IAM database authentication is not enabled. Credentials are managed via ' +
                    'Secrets Manager. IAM auth is out of scope for this chaos engineering reference pattern.',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'CDK-managed LogRetention Lambda (for Aurora CloudWatch log retention) ' +
                    'uses AWSLambdaBasicExecutionRole, which is the accepted baseline for internal CDK custom resources.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'CDK-managed LogRetention Lambda service role requires wildcard permissions ' +
                    'for log group management (CreateLogGroup, PutRetentionPolicy). These are ' +
                    'CDK-generated internal resources not under direct author control.',
            },
        ],
        true,
    );
}

function suppressAppStack(stack: AppStack): void {
    const p = `/${stack.stackName}`;

    // InstanceSecurityGroup: AwsSolutions-EC23 cannot be validated because
    // vpc.vpcCidrBlock resolves to an intrinsic function at synthesis time.
    // The ingress source is restricted to the VPC CIDR — not 0.0.0.0/0.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/InstanceSecurityGroup/Resource`, [
        {
            id: 'CdkNagValidationFailure',
            reason:
                'AwsSolutions-EC23 cannot be validated: vpc.vpcCidrBlock resolves to an ' +
                'intrinsic function at synthesis time. The actual ingress source is the VPC CIDR ' +
                '(not 0.0.0.0/0) — traffic through the NLB is source-NAT\'d to a VPC-CIDR address ' +
                'because the target group sets preserveClientIp: false.',
        },
    ]);

    // EC2 instance role: AmazonSSMManagedInstanceCore grants operational SSM access
    // (Session Manager) for troubleshooting during experiments; it is not required by
    // any of the G-1..G-4 FIS actions themselves.
    // AwsSolutions-IAM5: grantRead on the Aurora secret generates wildcard sub-resource arns.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'AmazonSSMManagedInstanceCore grants Session Manager access for operational ' +
                    'troubleshooting during chaos experiments. It is not required by any FIS action ' +
                    'used in this workspace.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
                ],
            },
        ],
        true,
    );

    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'Wildcard permissions are generated by Secret.grantRead() for sub-resource ARNs. ' +
                    'The secret ARN itself is scoped to the Aurora secret.',
            },
        ],
        true,
    );

    // ASG: no scaling notifications (AwsSolutions-AS3) — out of scope for chaos demo.
    // Cooldown period (AwsSolutions-AS1) uses CDK defaults, which is acceptable here.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-AS3',
                reason:
                    'ASG scaling notifications are not configured. ' +
                    'This is a chaos engineering demo — SNS scaling notifications are out of scope.',
            },
        ],
        true,
    );

    // NLB: access logging (AwsSolutions-ELB2 equivalent for v2 load balancers is not
    // separately flagged by the AwsSolutions pack for `network` type load balancers in
    // the same way as ALB; this suppression is a defensive no-op if the rule does apply).
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-ELB2',
                reason:
                    'NLB access logging is not enabled. This is an internet-facing demo ' +
                    'load balancer for a chaos engineering reference pattern; logging is out of scope.',
            },
        ],
        true,
    );
}

function suppressFisStack(stack: FisStack): void {
    // FIS log delivery requires broad CloudWatch Logs management permissions
    // (no resource-level restrictions for log delivery API actions).
    // ec2:DescribeInstances and the aws:network:disrupt-connectivity NACL management
    // actions (CreateNetworkAcl, ReplaceNetworkAclAssociation, etc.) cannot be scoped
    // to a resource because the NACLs they create/replace do not exist at policy-authoring
    // time. SNS alarm topic: internal operational topic, only publisher is CloudWatch alarm action.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'FIS experiment logging to CloudWatch requires log delivery management actions ' +
                    '(CreateLogDelivery, ListLogDeliveries, etc.) which do not support resource-level ' +
                    'restrictions. ec2:DescribeInstances/DescribeSubnets/DescribeNetworkAcls and the ' +
                    'aws:network:disrupt-connectivity NACL management actions (CreateNetworkAcl, ' +
                    'CreateNetworkAclEntry, ReplaceNetworkAclAssociation, DeleteNetworkAcl, ' +
                    'DeleteNetworkAclEntry) also require wildcard resources because the temporary ' +
                    'NACLs the action creates do not exist when this policy is authored.',
            },
            {
                id: 'AwsSolutions-SNS3',
                reason:
                    'The FIS alarm topic is an internal operational topic whose only publisher is ' +
                    'the CloudWatch alarm action. No external publishers exist. ' +
                    'Enforcing SSL via aws:SecureTransport is out of scope for this chaos reference pattern.',
            },
        ],
        true,
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CDK Nag AwsSolutions — BaseStack', () => {
    let baseStack: BaseStack;

    beforeAll(() => {
        const { app, baseStack: bs } = makeStacks('NagBase');
        baseStack = bs;
        suppressBaseStack(baseStack);
        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(baseStack).findWarning(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (warnings.length > 0) {
            console.log('\n=== CDK Nag Warnings (BaseStack) ===');
            warnings.forEach((w, i) =>
                console.log(`Warning ${i + 1}: ${w.id}\n${JSON.stringify(w.entry, null, 2)}`),
            );
        }
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(baseStack).findError(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (errors.length > 0) {
            console.log('\n=== CDK Nag Errors (BaseStack) ===');
            errors.forEach((e, i) =>
                console.log(`Error ${i + 1}: ${e.id}\n${JSON.stringify(e.entry, null, 2)}`),
            );
        }
        expect(errors).toHaveLength(0);
    });
});

describe('CDK Nag AwsSolutions — AppStack', () => {
    let appStack: AppStack;

    beforeAll(() => {
        const { app, appStack: as } = makeStacks('NagApp');
        appStack = as;
        suppressAppStack(appStack);
        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(appStack).findWarning(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (warnings.length > 0) {
            console.log('\n=== CDK Nag Warnings (AppStack) ===');
            warnings.forEach((w, i) =>
                console.log(`Warning ${i + 1}: ${w.id}\n${JSON.stringify(w.entry, null, 2)}`),
            );
        }
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(appStack).findError(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (errors.length > 0) {
            console.log('\n=== CDK Nag Errors (AppStack) ===');
            errors.forEach((e, i) =>
                console.log(`Error ${i + 1}: ${e.id}\n${JSON.stringify(e.entry, null, 2)}`),
            );
        }
        expect(errors).toHaveLength(0);
    });
});

describe('CDK Nag AwsSolutions — FisStack', () => {
    let fisStack: FisStack;

    beforeAll(() => {
        const { app, fisStack: fs } = makeStacks('NagFis');
        fisStack = fs;
        suppressFisStack(fisStack);
        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(fisStack).findWarning(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (warnings.length > 0) {
            console.log('\n=== CDK Nag Warnings (FisStack) ===');
            warnings.forEach((w, i) =>
                console.log(`Warning ${i + 1}: ${w.id}\n${JSON.stringify(w.entry, null, 2)}`),
            );
        }
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(fisStack).findError(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (errors.length > 0) {
            console.log('\n=== CDK Nag Errors (FisStack) ===');
            errors.forEach((e, i) =>
                console.log(`Error ${i + 1}: ${e.id}\n${JSON.stringify(e.entry, null, 2)}`),
            );
        }
        expect(errors).toHaveLength(0);
    });
});
