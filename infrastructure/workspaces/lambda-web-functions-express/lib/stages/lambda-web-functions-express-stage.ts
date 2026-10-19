import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { LambdaWebFunctionsExpressStack } from 'lib/stacks/lambda-web-functions-express-stack';
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

/** Deploys the WAF stack (us-east-1) and the main stack. */
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
  }
}
