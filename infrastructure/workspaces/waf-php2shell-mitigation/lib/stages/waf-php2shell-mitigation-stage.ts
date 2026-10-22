import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { CloudfrontWafStack } from 'lib/stacks/cloudfront-waf-stack';
import { WafPhp2ShellMitigationStack } from 'lib/stacks/waf-php2shell-mitigation-stack';

/** Properties for {@link WafPhp2ShellMitigationStage}. */
export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly params: EnvParams;
  readonly allowedIps?: string[];
  readonly allowedIpv6s?: string[];
}

/** Deploys the CloudFront WAF stack (us-east-1) and the main stack. */
export class WafPhp2ShellMitigationStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const wafStack = new CloudfrontWafStack(this, pascalCase(`${props.project}WafPhp2ShellMitigationWaf`), {
      stackName: `${props.project}-${props.environment}-waf-php2shell-mitigation-waf`,
      description: 'PHP2Shell WAF mitigation: CloudFront Web ACL (us-east-1)',
      project: props.project,
      environment: props.environment,
      waf: props.params.waf,
      isAutoDeleteObject: props.isAutoDeleteObject,
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
      env: { account: props.env?.account, region: 'us-east-1' },
      terminationProtection: props.terminationProtection,
      crossRegionReferences: true,
    });

    const mainStack = new WafPhp2ShellMitigationStack(this, pascalCase(`${props.project}WafPhp2ShellMitigation`), {
      stackName: `${props.project}-${props.environment}-waf-php2shell-mitigation`,
      description: 'PHP2Shell WAF mitigation: CloudFront + ALB (Web ACL) + Lambda container (PHP-FPM 8.4.27)',
      project: props.project,
      environment: props.environment,
      env: props.env,
      terminationProtection: props.terminationProtection,
      isAutoDeleteObject: props.isAutoDeleteObject,
      params: props.params,
      cloudFrontWebAclArn: wafStack.webAclArn,
      directAccessIps: props.params.verification.allowDirectAlbAccess ? props.allowedIps : undefined,
      crossRegionReferences: true,
    });
    mainStack.addStackDependency(wafStack);
  }
}
