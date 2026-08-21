import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { Environment } from '@common/parameters/environments';
import { EcrCrrTokyoStack } from 'lib/stacks/ecr-crr-tokyo-stack';
import { EcrCrrOsakaStack } from 'lib/stacks/ecr-crr-osaka-stack';
import { params } from 'parameters/environments';
import '../parameters';

const tokyoEnv = { account: '123456789012', region: 'ap-northeast-1' };
const osakaEnv = { account: '123456789012', region: 'ap-northeast-3' };

const projectName = 'example';
const envName: Environment = Environment.TEST;
if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];

describe('CDK Nag AwsSolutions Pack', () => {
    let app: cdk.App;
    let tokyoStack: EcrCrrTokyoStack;
    let osakaStack: EcrCrrOsakaStack;

    beforeAll(() => {
        app = new cdk.App();

        osakaStack = new EcrCrrOsakaStack(app, `${projectName}-${envName}-osaka`, {
            project: projectName,
            environment: envName,
            env: osakaEnv,
            params: envParams,
        });

        tokyoStack = new EcrCrrTokyoStack(app, `${projectName}-${envName}-tokyo`, {
            project: projectName,
            environment: envName,
            env: tokyoEnv,
            params: envParams,
        });

        applySuppressions(tokyoStack);
        applySuppressions(osakaStack);

        cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
    });

    test.each([
        ['Tokyo', () => tokyoStack],
        ['Osaka', () => osakaStack],
    ])('%s stack: no unsuppressed Warnings', (_name, getStack) => {
        const warnings = Annotations.fromStack(getStack()).findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*'));
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

    test.each([
        ['Tokyo', () => tokyoStack],
        ['Osaka', () => osakaStack],
    ])('%s stack: no unsuppressed Errors', (_name, getStack) => {
        const errors = Annotations.fromStack(getStack()).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
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

/**
 * Apply CDK Nag suppressions to a stack.
 *
 * Best Practices:
 * 1. Apply suppressions to specific resource paths whenever possible (addResourceSuppressionsByPath)
 * 2. Minimize stack-wide suppressions (addStackSuppressions)
 * 3. Use appliesTo when there are multiple specific issues with the same resource
 * 4. Provide clear and specific reasons
 */
function applySuppressions(stack: cdk.Stack): void {
    NagSuppressions.addStackSuppressions(
        stack,
        [
            {
                id: 'AwsSolutions-ECR1',
                reason:
                    'This is a reference architecture demonstrating cross-region replication; image scan-on-push ' +
                    'settings are intentionally asymmetric between source and destination to illustrate independent ' +
                    'per-region configuration and are not a security requirement of this pattern.',
            },
        ],
        true,
    );
}
