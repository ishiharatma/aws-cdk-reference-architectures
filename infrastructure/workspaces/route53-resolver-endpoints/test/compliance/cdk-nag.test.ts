import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { Route53ResolverEndpointsStack } from 'lib/stacks/route53-resolver-endpoints-stack';
import { EnvParams } from 'lib/types/route53-resolver-endpoints-params';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = { account: '123456789012', region: 'us-east-1' };
const projectName = 'TestProject';
const envName: Environment = Environment.TEST;
const loaded = params[envName];
if (!loaded) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams: EnvParams = loaded;

describe('CDK Nag AwsSolutions Pack', () => {
    let stack: Route53ResolverEndpointsStack;

    beforeAll(() => {
        const app = new cdk.App();
        stack = new Route53ResolverEndpointsStack(app, 'Route53ResolverEndpoints', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });

        applySuppressions(stack);
        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
        if (warnings.length > 0) {
            console.log(JSON.stringify(warnings, null, 2));
        }
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
        if (errors.length > 0) {
            console.log(JSON.stringify(errors, null, 2));
        }
        expect(errors).toHaveLength(0);
    });
});

/**
 * Suppressions are scoped to demonstration test/BIND9 instances, the cost-optimised
 * (flow-logs-off) VPCs, and the CDK-generated VPC peering DNS-resolution custom resource.
 */
function applySuppressions(stack: Route53ResolverEndpointsStack): void {
    const pathPrefix = `/${stack.stackName}`;

    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-VPC7',
                reason: 'VPC Flow Logs are disabled for cost in this demonstration workspace. Enable in production (enableFlowLogsToCloudWatch).',
            },
        ],
        true,
    );

    // EC2 instances (BIND9 on-premises server + verification test instance).
    for (const instanceId of ['OnPremDnsServer', 'VerifyTestInstance']) {
        NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/${instanceId}/SecurityGroup/Resource`, [
            {
                id: 'CdkNagValidationFailure',
                reason: 'The security group references the VPC CIDR via an intrinsic function (Fn::GetAtt), which cdk-nag cannot evaluate at synth time.',
            },
        ]);
        NagSuppressions.addResourceSuppressionsByPath(
            stack,
            `${pathPrefix}/${instanceId}/Resource/InstanceRole/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM4',
                    reason: 'Demonstration instances use the AWS managed policy AmazonSSMManagedInstanceCore for Session Manager access. Use a custom managed policy in production.',
                    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
                },
            ],
        );
        NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/${instanceId}/Resource/Resource`, [
            {
                id: 'AwsSolutions-EC28',
                reason: 'Detailed monitoring is unnecessary for short-lived demonstration instances.',
            },
            {
                id: 'AwsSolutions-EC29',
                reason: 'Termination protection is intentionally off so the demonstration stack can be torn down cleanly.',
            },
        ]);
    }

    // Additional security groups whose ingress CIDR is an intrinsic reference to a VPC CIDR.
    for (const path of [
        'OnPremDnsServerSecurityGroup/Resource',
        'InboundEndpoint/SecurityGroup/Resource',
        'OutboundEndpoint/SecurityGroup/Resource',
        'VerifySsmEndpointsSecurityGroup/Resource',
        'OnPremSsmEndpointsSecurityGroup/Resource',
    ]) {
        NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/${path}`, [
            {
                id: 'CdkNagValidationFailure',
                reason: 'Security group ingress references a VPC CIDR via an intrinsic function (Fn::GetAtt), which cdk-nag cannot evaluate at synth time.',
            },
        ]);
    }

    // VPC peering: DNS-resolution custom resource (AWS-generated provider framework).
    for (const path of ['VerifyToOnPremPeering/LocalVpcPeeringSecurityGroup/Resource', 'VerifyToOnPremPeering/PeerVpcPeeringSecurityGroup/Resource']) {
        NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/${path}`, [
            {
                id: 'CdkNagValidationFailure',
                reason: 'Security group ingress references a peer VPC CIDR via an intrinsic function (Fn::GetAtt), which cdk-nag cannot evaluate at synth time.',
            },
        ]);
    }
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
        [
            {
                id: 'AwsSolutions-IAM4',
                reason: 'AWS Custom Resource framework uses the AWS managed policy AWSLambdaBasicExecutionRole for Lambda execution. This is CDK-generated infrastructure.',
                appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
            },
        ],
    );
    NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/AWS679f53fac002430cb0da5b7982bd2287/Resource`, [
        {
            id: 'AwsSolutions-L1',
            reason: 'AWS Custom Resource framework controls the Lambda runtime version. This is CDK-generated infrastructure updated by CDK.',
        },
    ]);
    NagSuppressions.addResourceSuppressionsByPath(
        stack,
        `${pathPrefix}/VerifyToOnPremPeering/EnableVpcPeeringDnsResolution/CustomResourcePolicy/Resource`,
        [
            {
                id: 'AwsSolutions-IAM5',
                reason: 'The custom resource requires wildcard permissions to modify VPC peering connection options; this is inherent to the DNS-resolution-over-peering feature.',
                appliesTo: ['Resource::*'],
            },
        ],
    );
}
