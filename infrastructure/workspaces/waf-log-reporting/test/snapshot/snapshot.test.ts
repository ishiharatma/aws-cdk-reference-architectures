/* eslint-disable @typescript-eslint/no-explicit-any */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Environment } from '@common/parameters/environments';
import { WafLogReportingSampleWafStack } from 'lib/stacks/waf-log-reporting-sample-waf-stack';
import { WafLogReportingCwLogsReportStack } from 'lib/stacks/waf-log-reporting-cwlogs-report-stack';
import { WafLogReportingAthenaReportStack } from 'lib/stacks/waf-log-reporting-athena-report-stack';
import { params } from 'parameters/environments';
import '../parameters';

const defaultEnv = {
    account: '123456789012',
    region: 'ap-northeast-1',
};

const projectName = 'WafLogReportingTest';
const envName: Environment = Environment.TEST;

if (!params[envName]) {
    throw new Error(`No parameters found for environment: ${envName}`);
}
const envParams = params[envName];
const SAMPLE_LOG_GROUP_NAME = `aws-waf-logs-${projectName}-${envName}`;

/**
 * AWS CDK Snapshot Test Suite
 *
 * Purpose of this test suite:
 * 1. Detect unintended changes in the entire CloudFormation template
 * 2. Ensure safety during refactoring
 * 3. Track changes in the number of resources
 *
 * Note: Detailed configuration value verification is done with unit tests (test/unit/)
 */
describe('Stack Snapshot Tests', () => {
    function assertSnapshots(template: Template) {
        test('Complete CloudFormation template snapshot', () => {
            expect(template.toJSON()).toMatchSnapshot();
        });

        test('Resource types and counts', () => {
            const templateJson = template.toJSON();
            const resourceCounts: Record<string, number> = {};
            Object.values(templateJson.Resources || {}).forEach((resource: any) => {
                const type = resource.Type;
                resourceCounts[type] = (resourceCounts[type] || 0) + 1;
            });
            expect(resourceCounts).toMatchSnapshot();
        });
    }

    describe('WafLogReportingSampleWafStack', () => {
        const app = new cdk.App();
        const stack = new WafLogReportingSampleWafStack(app, 'SampleWaf', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
        });
        assertSnapshots(Template.fromStack(stack));
    });

    describe('WafLogReportingCwLogsReportStack', () => {
        const app = new cdk.App();
        const stack = new WafLogReportingCwLogsReportStack(app, 'CwLogsReport', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        assertSnapshots(Template.fromStack(stack));
    });

    describe('WafLogReportingAthenaReportStack', () => {
        const app = new cdk.App();
        const stack = new WafLogReportingAthenaReportStack(app, 'AthenaReport', {
            project: projectName,
            environment: envName,
            env: defaultEnv,
            isAutoDeleteObject: true,
            terminationProtection: false,
            params: envParams,
            sampleLogGroupName: SAMPLE_LOG_GROUP_NAME,
        });
        assertSnapshots(Template.fromStack(stack));
    });
});
