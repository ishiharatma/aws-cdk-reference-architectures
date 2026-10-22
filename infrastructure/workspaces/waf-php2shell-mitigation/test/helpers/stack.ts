import * as cdk from 'aws-cdk-lib';
import { Environment } from '@common/parameters/environments';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import { WafPhp2ShellMitigationStack } from 'lib/stacks/waf-php2shell-mitigation-stack';
import { EnvParams, params } from 'parameters/environments';
import '../parameters';

export const testEnv = { account: '123456789012', region: 'ap-northeast-1' };
export const projectName = 'test';
export const envName: Environment = Environment.TEST;
export const cloudFrontWebAclArn =
  'arn:aws:wafv2:us-east-1:123456789012:global/webacl/test/00000000-0000-0000-0000-000000000000';
export const verificationIp = '203.0.113.10';

/** Context answer for the CloudFront origin-facing prefix list lookup, so tests run offline. */
const prefixListContext = {
  'cc-api-provider:account=123456789012:expectedMatchCount=exactly-one:propertiesToReturn.0=PrefixListId:propertyMatch.PrefixListName=com.amazonaws.global.cloudfront.origin-facing:region=ap-northeast-1:typeName=AWS$:$:EC2$:$:PrefixList':
    [{ PrefixListId: 'pl-58a04531', Identifier: 'pl-58a04531' }],
};

/** Test-environment parameters with optional overrides. */
export function testParams(overrides: Partial<EnvParams> = {}): EnvParams {
  const base = params[envName];
  if (!base) {
    throw new Error(`No parameters found for environment: ${envName}`);
  }
  return { ...base, ...overrides };
}

/** App pre-loaded with the prefix list lookup answer. */
export function newApp(): cdk.App {
  return new cdk.App({ context: prefixListContext });
}

/** Builds the main stack (direct ALB access for the verification IP unless overridden). */
export function buildMainStack(
  app: cdk.App = newApp(),
  options: { overrides?: Partial<EnvParams>; directAccessIps?: string[] } = {},
): WafPhp2ShellMitigationStack {
  return new WafPhp2ShellMitigationStack(app, 'WafPhp2ShellMitigation', {
    project: projectName,
    environment: envName,
    isAutoDeleteObject: true,
    env: testEnv,
    params: testParams(options.overrides),
    cloudFrontWebAclArn,
    directAccessIps: 'directAccessIps' in options ? options.directAccessIps : [verificationIp],
  });
}

/** Builds the us-east-1 CloudFront WAF stack. */
export function buildWafStack(app: cdk.App = newApp(), overrides: Partial<EnvParams> = {}): CloudfrontWafStack {
  return new CloudfrontWafStack(app, 'CloudfrontWaf', {
    project: projectName,
    environment: envName,
    waf: testParams(overrides).waf,
    isAutoDeleteObject: true,
    allowedIps: [verificationIp],
    env: { account: testEnv.account, region: 'us-east-1' },
  });
}
