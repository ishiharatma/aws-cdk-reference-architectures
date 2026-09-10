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

const projectName = 'fis-chaos';
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
        dbSecurityGroup: baseStack.dbSecurityGroup,
        auroraCluster: baseStack.auroraCluster,
        auroraSecret: baseStack.auroraSecret,
        cloudfrontManagedPrefixList: envParams.cloudfrontManagedPrefixList,
    });

    const fisStack = new FisStack(app, `${appId}Fis`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        terminationProtection: false,
        ecsCluster: appStack.ecsCluster,
        ecsService: appStack.ecsService,
        alb: appStack.alb,
        auroraCluster: baseStack.auroraCluster,
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

    // CloudFront: default *.cloudfront.net certificate, no WAF, no access logging,
    // no geo restriction — all intentionally absent for a chaos engineering demo.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/Distribution/Resource`, [
        {
            id: 'AwsSolutions-CFR4',
            reason:
                'Distribution uses the default CloudFront certificate (no custom domain). ' +
                'TLSv1 is enforced by CloudFront regardless of minimumProtocolVersion in that case.',
        },
        {
            id: 'AwsSolutions-CFR2',
            reason: 'WAF integration is out of scope for this ECS chaos reference pattern.',
        },
        {
            id: 'AwsSolutions-CFR3',
            reason:
                'CloudFront access logging is not enabled. Adding a log bucket with ACL mode ' +
                'is out of scope for this reference pattern which focuses on FIS chaos scenarios.',
        },
        {
            id: 'AwsSolutions-CFR1',
            reason:
                'Geo restriction is intentionally absent. This is a public demo for FIS chaos ' +
                'engineering — geographic access restrictions are out of scope.',
        },
    ]);

    // ECS task execution role uses AmazonECSTaskExecutionRolePolicy (accepted managed policy
    // for ECS Fargate task execution — pulling images from ECR, writing to CloudWatch Logs).
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'AmazonECSTaskExecutionRolePolicy is the required managed policy for ECS Fargate ' +
                    'task execution (ECR pull, CloudWatch Logs write). AmazonSSMManagedInstanceCore is ' +
                    'the managed policy the AWS FIS user guide mandates on the ECS task SSM ' +
                    'managed-instance role (needed for aws:ecs:task-* fault injection). Both are ' +
                    'accepted baselines.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
                ],
            },
        ],
        true,
    );

    // Task role: ssm:CreateActivation / ssm:AddTagsToResource on '*' are required by the AWS
    // FIS SSM sidecar to self-register the task as a managed instance. Secret.grantRead()
    // generates wildcard sub-resource ARNs on the Aurora secret.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'ssm:CreateActivation / ssm:AddTagsToResource require resource "*" (the FIS ' +
                    'sidecar self-registers the task as an SSM managed instance). ' +
                    'Secret.grantRead() generates wildcard sub-resource ARNs on the Aurora secret. ' +
                    'Both are intentional for this chaos engineering reference pattern.',
            },
        ],
        true,
    );

    // S3 buckets: ALB log bucket and error page bucket have no server access logging.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-S1',
                reason:
                    'Server access logging is not enabled on the ALB log bucket and error page bucket. ' +
                    'These are internal operational buckets for a chaos engineering demo, not production stores.',
            },
        ],
        true,
    );

    // CDK-managed BucketDeployment Lambda (for error page S3 deployment).
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-L1',
                reason:
                    'CDK-managed BucketDeployment Lambda uses a CDK-controlled runtime. ' +
                    'The runtime is managed by CDK internals and not under direct author control.',
            },
            {
                id: 'AwsSolutions-IAM4',
                reason:
                    'CDK-managed BucketDeployment Lambda ServiceRole uses AWSLambdaBasicExecutionRole, ' +
                    'which is the accepted baseline for CDK internal custom resource Lambdas.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
        ],
        true,
    );

    // ECS task definition: DB_HOST, DB_PORT, DB_NAME are non-secret configuration values.
    // The actual database credentials are injected at runtime via Secrets Manager (auroraSecret).
    // Using plaintext environment variables for host/port/database name is acceptable here.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-ECS2',
                reason:
                    'ECS task definition uses plaintext environment variables (DB_HOST, DB_PORT, DB_NAME) ' +
                    'for non-sensitive database connection configuration. Actual credentials are injected ' +
                    'at runtime via Secrets Manager through the auroraSecret grantRead() pattern.',
            },
        ],
        true,
    );
}

function suppressFisStack(stack: FisStack): void {
    // FIS log delivery requires broad CloudWatch Logs management permissions.
    // ECS/ALB monitoring actions (DescribeServices, DescribeClusters, etc.) cannot be scoped to a resource.
    // SNS alarm topic: internal operational topic, only publisher is CloudWatch alarm action.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'FIS experiment logging to CloudWatch requires log delivery management actions ' +
                    '(CreateLogDelivery, ListLogDeliveries, etc.) which do not support resource-level ' +
                    'restrictions. ECS and ALB monitoring actions also require wildcard resources.',
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
