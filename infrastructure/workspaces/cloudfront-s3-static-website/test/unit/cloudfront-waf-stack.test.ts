import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import * as path from 'path';
import { loadCdkContext } from '@common/test-helpers/test-context';

const defaultEnv = {
    account: '123456789012',
    region: 'us-east-1',
};

const projectName = 'TestProject';
const envName: Environment = Environment.TEST;
const cdkJsonPath = path.resolve(__dirname, '../../cdk.json');
const baseContext = loadCdkContext(cdkJsonPath);

function synth(overrides: Partial<ConstructorParameters<typeof CloudfrontWafStack>[2]> = {}) {
    const app = new cdk.App({ context: baseContext });
    const stack = new CloudfrontWafStack(app, 'Waf', {
        project: projectName,
        environment: envName,
        env: defaultEnv,
        isAutoDeleteObject: true,
        terminationProtection: false,
        enableWaf: true,
        ...overrides,
    });
    return { stack, template: Template.fromStack(stack) };
}

describe('CloudfrontWafStack Fine-grained Assertions', () => {
    describe('Web ACL', () => {
        test('should create a CLOUDFRONT-scoped Web ACL with a default block action', () => {
            const { template } = synth();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Scope: 'CLOUDFRONT',
                DefaultAction: { Block: {} },
                VisibilityConfig: Match.objectLike({
                    MetricName: `${projectName}-${envName}-WafAcl`,
                }),
            });
        });

        test('should include the AWS managed Common and KnownBadInputs rule groups, evaluated only', () => {
            const { template } = synth();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.arrayWith([
                    Match.objectLike({
                        Name: 'CoreRuleSet',
                        OverrideAction: { None: {} },
                        Statement: Match.objectLike({
                            ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' },
                        }),
                    }),
                    Match.objectLike({
                        Name: 'KnownBadInputsRuleSet',
                        OverrideAction: { None: {} },
                        Statement: Match.objectLike({
                            ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesKnownBadInputsRuleSet' },
                        }),
                    }),
                ]),
            });
        });

        test('should not create a before-rules allow list when allowedIpsBeforeRules is omitted', () => {
            const { template } = synth();
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.not(Match.arrayWith([Match.objectLike({ Name: 'AllowSpecificIPsBeforeRules' })])),
            });
            // Only the two after-rules defaults (IPv4 + IPv6 full range) exist; no *BeforeRules IPSet.
            template.resourceCountIs('AWS::WAFv2::IPSet', 2);
            Object.values(template.findResources('AWS::WAFv2::IPSet')).forEach((resource) => {
                expect((resource as { Properties: { Name: string } }).Properties.Name).not.toContain('BeforeRules');
            });
        });

        test('should create a before-rules allow list at priority 1 when allowedIpsBeforeRules is provided', () => {
            const { template } = synth({ allowedIpsBeforeRules: ['203.0.113.10'] });

            template.hasResourceProperties('AWS::WAFv2::IPSet', {
                Name: `${projectName}-${envName}-AllowedIpsSetBeforeRules`,
                Addresses: ['203.0.113.10/32'],
                IPAddressVersion: 'IPV4',
                Scope: 'CLOUDFRONT',
            });
            template.hasResourceProperties('AWS::WAFv2::WebACL', {
                Rules: Match.arrayWith([
                    Match.objectLike({ Name: 'AllowSpecificIPsBeforeRules', Priority: 1, Action: { Allow: {} } }),
                ]),
            });
        });

        test('should default the after-rules allow list to the full IPv4 range split into two /1 CIDRs', () => {
            // Regression test: WAF rejects a /0 CIDR, and appending /32 to these (already full)
            // CIDR ranges would produce an invalid address like "0.0.0.0/1/32".
            const { template } = synth();
            template.hasResourceProperties('AWS::WAFv2::IPSet', {
                Name: `${projectName}-${envName}-AllowedIpsSetAfterRules`,
                Addresses: ['0.0.0.0/1', '128.0.0.0/1'],
            });
        });

        test('should narrow the after-rules allow list to /32 host addresses when allowedIpsAfterRules is provided', () => {
            const { template } = synth({ allowedIpsAfterRules: ['198.51.100.20', '198.51.100.21'] });
            template.hasResourceProperties('AWS::WAFv2::IPSet', {
                Name: `${projectName}-${envName}-AllowedIpsSetAfterRules`,
                Addresses: ['198.51.100.20/32', '198.51.100.21/32'],
            });
        });
    });

    describe('WAF log delivery', () => {
        test('should name the log bucket with the mandatory aws-waf-logs- prefix', () => {
            const { template } = synth();
            // The account-regional namespace only takes a prefix; S3 appends the account id and
            // region. The mandatory `aws-waf-logs-` prefix must survive into that prefix.
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketNamePrefix: `aws-waf-logs-${projectName.toLowerCase()}-${envName}`,
                BucketNamespace: 'account-regional',
            });
        });

        test('should block all public access and enforce SSL on the log bucket', () => {
            const { template } = synth();
            template.hasResourceProperties('AWS::S3::Bucket', {
                PublicAccessBlockConfiguration: {
                    BlockPublicAcls: true,
                    BlockPublicPolicy: true,
                    IgnorePublicAcls: true,
                    RestrictPublicBuckets: true,
                },
            });
            template.hasResourceProperties('AWS::S3::BucketPolicy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Effect: 'Deny',
                            Principal: { AWS: '*' },
                            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
                        }),
                    ]),
                }),
            });
        });

        test('should grant delivery.logs.amazonaws.com scoped write and ACL-check access to the log bucket', () => {
            const { template } = synth();
            template.hasResourceProperties('AWS::S3::BucketPolicy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'AWSLogDeliveryWrite',
                            Effect: 'Allow',
                            Principal: { Service: 'delivery.logs.amazonaws.com' },
                            Action: 's3:PutObject',
                            Condition: Match.objectLike({
                                StringEquals: Match.objectLike({
                                    's3:x-amz-acl': 'bucket-owner-full-control',
                                    'aws:SourceAccount': defaultEnv.account,
                                }),
                            }),
                        }),
                        Match.objectLike({
                            Sid: 'AWSLogDeliveryAclCheck',
                            Effect: 'Allow',
                            Principal: { Service: 'delivery.logs.amazonaws.com' },
                            Action: 's3:GetBucketAcl',
                        }),
                    ]),
                }),
            });
        });

        test('should scope the logging configuration to the Web ACL and redact auth headers/cookies', () => {
            const { template } = synth();
            template.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
                RedactedFields: [{ SingleHeader: { Name: 'authorization' } }, { SingleHeader: { Name: 'cookie' } }],
            });
        });

        test('should create the logging configuration after the bucket policy is in place', () => {
            const { template } = synth();
            const resources = template.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[] }>;

            const loggingConfig = Object.values(resources).find(
                (r) => r.Type === 'AWS::WAFv2::LoggingConfiguration',
            );
            const bucketPolicyEntry = Object.entries(resources).find(([, r]) => r.Type === 'AWS::S3::BucketPolicy');

            expect(loggingConfig).toBeDefined();
            expect(bucketPolicyEntry).toBeDefined();
            const [bucketPolicyLogicalId] = bucketPolicyEntry as [string, { Type: string }];
            expect(loggingConfig?.DependsOn).toEqual(expect.arrayContaining([bucketPolicyLogicalId]));
        });

        test('should output the WAF log bucket name', () => {
            const { template } = synth();
            template.hasOutput('WafLogBucketName', {});
        });
    });
});
