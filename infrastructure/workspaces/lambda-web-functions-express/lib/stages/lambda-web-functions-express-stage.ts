import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { LambdaWebFunctionsExpressStack } from 'lib/stacks/lambda-web-functions-express-stack';
import { LambdaWebFunctionsExpressL2Stack } from 'lib/stacks/lambda-web-functions-express-l2-stack';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';

/** Properties for {@link LambdaWebFunctionsExpressStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  readonly allowedIps?: string[];
  readonly allowedIpv6s?: string[];
}

/**
 * Deploys the WAF stack (us-east-1), the main stack built from L1 constructs and, side by side,
 * the same architecture built from the aws-cdk-lib 2.276.0 L2 constructs. Both distributions
 * share the Web ACL.
 */
export class LambdaWebFunctionsExpressStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    // CLOUDFRONT-scoped Web ACLs exist only in us-east-1.
    const wafStack = new CloudfrontWafStack(this, pascalCase(`${props.project}LambdaWebFunctionsExpressWaf`), {
      stackName: `${props.project}-${props.environment}-lambda-web-functions-express-waf`,
      description: 'Lambda Web Functions pattern: CloudFront WAF (us-east-1)',
      project: props.project,
      environment: props.environment,
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
      rateLimitPerIp: props.params.wafRateLimitPerIp,
      env: { account: props.env?.account, region: 'us-east-1' },
      terminationProtection: props.terminationProtection,
      crossRegionReferences: true,
    });

    const mainStack = new LambdaWebFunctionsExpressStack(
      this,
      pascalCase(`${props.project}LambdaWebFunctionsExpress`),
      {
        stackName: `${props.project}-${props.environment}-lambda-web-functions-express`,
        description: 'Lambda Web Functions pattern: CloudFront (OAC) + Web Function (Express.js) + DynamoDB',
        project: props.project,
        environment: props.environment,
        env: props.env,
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject: props.isAutoDeleteObject,
        params: props.params,
        webAclArn: wafStack.webAclArn,
        crossRegionReferences: true,
      },
    );
    mainStack.addStackDependency(wafStack);

    const l2Stack = new LambdaWebFunctionsExpressL2Stack(
      this,
      pascalCase(`${props.project}LambdaWebFunctionsExpressL2`),
      {
        stackName: `${props.project}-${props.environment}-lambda-web-functions-express-l2`,
        description: 'Lambda Web Functions pattern (L2 constructs): CloudFront (OAC) + WebFunction (Express.js) + DynamoDB',
        project: props.project,
        environment: props.environment,
        env: props.env,
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject: props.isAutoDeleteObject,
        params: props.params,
        webAclArn: wafStack.webAclArn,
        crossRegionReferences: true,
      },
    );
    l2Stack.addStackDependency(wafStack);
  }
}
