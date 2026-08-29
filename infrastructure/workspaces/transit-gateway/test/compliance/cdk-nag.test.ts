import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { TransitGatewayStack } from 'lib/stacks/transit-gateway-stack';
import { EnvParams } from 'lib/types/transit-gateway-params';
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

const VPC_NAMES = ['VpcA', 'VpcB', 'VpcC'] as const;

describe('CDK Nag AwsSolutions Pack', () => {
    let stack: TransitGatewayStack;

    beforeAll(() => {
        const app = new cdk.App();
        stack = new TransitGatewayStack(app, 'TransitGateway', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            allowedIps: ['192.0.2.10'],
            allowedIpv6s: [],
        });

        applySuppressions(stack);
        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test('No unsuppressed Warnings', () => {
        const warnings = Annotations.fromStack(stack).findWarning(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (warnings.length > 0) {
            console.log(JSON.stringify(warnings, null, 2));
        }
        expect(warnings).toHaveLength(0);
    });

    test('No unsuppressed Errors', () => {
        const errors = Annotations.fromStack(stack).findError(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        if (errors.length > 0) {
            console.log(JSON.stringify(errors, null, 2));
        }
        expect(errors).toHaveLength(0);
    });
});

/**
 * Suppressions are scoped to the demonstration test instances and the cost-optimised
 * (flow-logs-off) VPCs. Nothing in the Transit Gateway wiring itself is suppressed.
 */
function applySuppressions(stack: TransitGatewayStack): void {
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

    for (const name of VPC_NAMES) {
        NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/${name}TestInstance/SecurityGroup/Resource`, [
            {
                id: 'CdkNagValidationFailure',
                reason: 'The TestInstance security group references the VPC CIDR via an intrinsic function (Fn::GetAtt), which cdk-nag cannot evaluate at synth time.',
            },
        ]);

        NagSuppressions.addResourceSuppressionsByPath(
            stack,
            `${pathPrefix}/${name}TestInstance/Resource/InstanceRole/Resource`,
            [
                {
                    id: 'AwsSolutions-IAM4',
                    reason: 'Test instances use the AWS managed policy AmazonSSMManagedInstanceCore for Session Manager access. Use a custom managed policy in production.',
                    appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
                },
            ],
        );

        NagSuppressions.addResourceSuppressionsByPath(stack, `${pathPrefix}/${name}TestInstance/Resource/Resource`, [
            {
                id: 'AwsSolutions-EC28',
                reason: 'Detailed monitoring is unnecessary for short-lived connectivity test instances.',
            },
            {
                id: 'AwsSolutions-EC29',
                reason: 'Termination protection is intentionally off so the demonstration stack can be torn down cleanly.',
            },
        ]);
    }
}
