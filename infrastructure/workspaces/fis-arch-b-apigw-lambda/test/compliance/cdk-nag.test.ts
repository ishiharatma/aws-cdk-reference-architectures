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

const projectName = 'fis-chaos-b';
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
    });

    const appStack = new AppStack(app, `${appId}App`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        table: baseStack.table,
    });

    const fisStack = new FisStack(app, `${appId}Fis`, {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        terminationProtection: false,
        apiFunction: appStack.apiFunction,
        fisConfigBucket: appStack.fisConfigBucket,
        alarmEmail: envParams.alarmEmail,
    });

    return { app, baseStack, appStack, fisStack };
}

// ---------------------------------------------------------------------------
// Suppression helper
// ---------------------------------------------------------------------------

function suppressBaseStack(stack: BaseStack): void {
    // PITR is intentionally disabled — this is a chaos-engineering demo table
    // that costs zero at rest. Point-in-time recovery adds cost with no benefit here.
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `/${stack.stackName}/ItemsTable/Resource`,
        [
            {
                id: 'AwsSolutions-DDB3',
                reason:
                    'PITR is intentionally disabled for this PAY_PER_REQUEST chaos demo table. ' +
                    'The table is destroyed with the stack and never holds production data.',
            },
        ],
    );
}

function suppressAppStack(stack: AppStack): void {
    const p = `/${stack.stackName}`;

    // The FIS Lambda-extension config bucket holds only transient FIS-written JSON
    // (1-day lifecycle expiry) and is not a data store — server access logging adds
    // a second bucket for no operational benefit in this reference pattern.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/FisConfigBucket/Resource`, [
        {
            id: 'AwsSolutions-S1',
            reason:
                'Transient FIS fault-config distribution bucket (1-day object expiry, tiny JSON ' +
                'only). Access logging would require a second bucket for no benefit here.',
        },
    ]);

    // CloudFront uses the default *.cloudfront.net certificate (no custom domain).
    // AWS forces TLSv1 availability regardless of minimumProtocolVersion in this case.
    // WAF is out of scope for this serverless reference pattern.
    // Access logging is not enabled on the distribution level (access logs would require
    // a separate S3 bucket with ACL mode, which is out of scope here).
    // Geo restriction is intentionally absent — this is a public chaos engineering demo API.
    NagSuppressions.addResourceSuppressionsByPath(stack, `${p}/Distribution/Resource`, [
        {
            id: 'AwsSolutions-CFR4',
            reason:
                'Distribution uses the default CloudFront certificate (no custom domain). ' +
                'TLSv1 is enforced by CloudFront regardless of minimumProtocolVersion in that case.',
        },
        {
            id: 'AwsSolutions-CFR2',
            reason: 'WAF integration is out of scope for this basic serverless chaos reference pattern.',
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
                'Geo restriction is intentionally absent. This is a public demo API for FIS chaos ' +
                'engineering — geographic access restrictions are out of scope.',
        },
    ]);

    // API Gateway HTTP API — authorizer is intentionally absent (public demo API).
    // Access logging IS enabled via CfnStage.accessLogSettings, but cdk-nag inspects
    // the L1 resource and may not recognise the escape-hatch approach.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-APIG4',
                reason:
                    'No authorizer is configured by design. This is a public demo API ' +
                    'used to drive FIS chaos experiments — authentication is out of scope.',
            },
            {
                id: 'AwsSolutions-APIG1',
                reason:
                    'Access logging is enabled via CfnStage.accessLogSettings (escape-hatch). ' +
                    'cdk-nag may not recognise this approach on the HTTP API default stage.',
            },
        ],
        true,
    );

    // Lambda function: AWSLambdaBasicExecutionRole is an accepted baseline for sample functions.
    // AwsSolutions-L1 fires because cdk-nag may lag behind AWS runtime releases and not yet
    // recognise Python 3.13 as the latest runtime. Python 3.13 is the most recent Lambda Python
    // runtime at the time this workspace was authored.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWSLambdaBasicExecutionRole is an accepted baseline for Lambda functions in this sample.',
                appliesTo: [
                    'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
                ],
            },
            {
                id: 'AwsSolutions-L1',
                reason:
                    'Python 3.13 is the latest available Lambda Python runtime. cdk-nag may not yet ' +
                    'recognise it as the latest due to release lag in the rule definitions.',
            },
        ],
        true,
    );

    // table.grantReadWriteData() generates a wildcard on index resources (table/*).
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'Wildcard permissions are generated by table.grantReadWriteData() ' +
                    'for index sub-resources (table/*). The table ARN itself is scoped.',
            },
        ],
        true,
    );
}

function suppressFisStack(stack: FisStack): void {
    // FIS log delivery requires a broad set of CloudWatch Logs management permissions;
    // there is no resource-scoped alternative for log delivery API actions.
    // The SNS alarm topic is an internal operational topic used only by CloudWatch alarm actions
    // (no external publishers). Enforcing SSL for publishers is out of scope here.
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason:
                    'FIS experiment logging to CloudWatch requires log delivery management actions ' +
                    '(CreateLogDelivery, ListLogDeliveries, etc.) which do not support resource-level ' +
                    'restrictions — wildcard is the only valid resource for these actions.',
            },
            {
                id: 'AwsSolutions-SNS3',
                reason:
                    'The FIS alarm topic is an internal operational topic whose only publisher is ' +
                    'the CloudWatch alarm action. No external publishers exist. ' +
                    'Enforcing SSL for publishers via an aws:SecureTransport policy is out of scope ' +
                    'for this chaos engineering reference pattern.',
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
