import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import { CloudfrontS3StaticWebsiteStack } from 'lib/stacks/cloudfront-s3-static-website-stack';
import { params } from 'parameters/environments';
import 'test/parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};
const wafEnv = {
    account: '123456789012',
    region: 'us-east-1',
};

const projectName = 'example';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

const fakeWebAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/example-test-WafAcl/11111111-1111-1111-1111-111111111111';

function nagTestSuite(
    suiteName: string,
    buildStack: (app: cdk.App) => cdk.Stack,
    suppressFn: (stack: cdk.Stack) => void,
) {
    describe(`CDK Nag AwsSolutions Pack – ${suiteName}`, () => {
        let app: cdk.App;
        let stack: cdk.Stack;

        beforeAll(() => {
            app = new cdk.App();
            stack = buildStack(app);

            // Apply suppressions (must be applied before adding Aspects)
            suppressFn(stack);

            // Run CDK Nag
            cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
        });

        test('No unsuppressed Warnings', () => {
            const warnings = Annotations.fromStack(stack).findWarning(
                '*',
                Match.stringLikeRegexp('AwsSolutions-.*'),
            );
            if (warnings.length > 0) {
                console.log('\n=== CDK Nag Warnings ===');
                warnings.forEach((warning, index) => {
                    console.log(`\nWarning ${index + 1}:`);
                    console.log(`  Path: ${warning.id}`);
                    console.log(`  Entry:`, JSON.stringify(warning.entry, null, 2));
                });
                console.log('======================\n');
            }
            expect(warnings).toHaveLength(0);
        });

        test('No unsuppressed Errors', () => {
            const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
            if (errors.length > 0) {
                console.log('\n=== CDK Nag Errors ===');
                errors.forEach((error, index) => {
                    console.log(`\nError ${index + 1}:`);
                    console.log(`  Path: ${error.id}`);
                    console.log(`  Entry:`, JSON.stringify(error.entry, null, 2));
                });
                console.log('======================\n');
            }
            expect(errors).toHaveLength(0);
        });
    });
}

// ============================================================================
// Stack 1: WAFv2 Web ACL + WAF log delivery bucket
// ============================================================================
nagTestSuite(
    'CloudfrontWafStack',
    (app) =>
        new CloudfrontWafStack(app, `${projectName}-${envName}-waf`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: wafEnv,
            allowedIpsAfterRules: ['192.0.2.10'],
        }),
    (stack) => {
        NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/WafLogBucket/Resource`, [
            {
                id: 'AwsSolutions-S1',
                reason:
                    'This bucket is itself the destination for AWS WAF access logs; enabling server access ' +
                    'logging on it would only generate logs about logs, with no additional observability value.',
            },
        ]);
    },
);

// ============================================================================
// Stack 2: CloudFront distribution + website content bucket
// ============================================================================
nagTestSuite(
    'CloudfrontS3StaticWebsiteStack',
    (app) =>
        new CloudfrontS3StaticWebsiteStack(app, `${projectName}-${envName}-main`, {
            project: projectName,
            environment: envName,
            isAutoDeleteObject: false,
            terminationProtection: false,
            env: defaultEnv,
            envParams,
            webAclArn: fakeWebAclArn,
        }),
    (stack) => {
        NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/AccessLogBucket/Resource`, [
            {
                id: 'AwsSolutions-S1',
                reason:
                    'This bucket is itself the destination for S3 server access logs and CloudFront access ' +
                    'logs; enabling server access logging on it would only generate logs about logs, with no ' +
                    'additional observability value.',
            },
        ]);
        NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/WebsiteDistribution/Resource`, [
            {
                id: 'AwsSolutions-CFR1',
                reason: 'Geo restriction is not required for this reference architecture; the site is public.',
            },
            {
                id: 'AwsSolutions-CFR4',
                reason:
                    'No custom domain/ACM certificate is configured for this reference architecture, so the ' +
                    'distribution uses the default CloudFront certificate, which is pinned to TLSv1 regardless ' +
                    'of MinimumProtocolVersion. Attach a custom domain with an ACM certificate to enforce ' +
                    'TLSv1.2+ in a production deployment.',
            },
        ]);
    },
);
