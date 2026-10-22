import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { WafParams } from 'parameters/environments';
import { Php2ShellWebAcl } from 'lib/constructs/php2shell-web-acl';

/** Properties for {@link CloudfrontWafStack}. */
export interface CloudfrontWafStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly waf: WafParams;
  readonly isAutoDeleteObject: boolean;
  /** IPv4 addresses allowed through CloudFront. Omit to allow everyone. */
  readonly allowedIps?: string[];
  readonly allowedIpv6s?: string[];
}

/**
 * CLOUDFRONT-scoped Web ACL with the PHP2Shell rules. Such Web ACLs (and their
 * CloudWatch Logs destination) can only live in us-east-1, hence a separate stack.
 */
export class CloudfrontWafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: CloudfrontWafStackProps) {
    super(scope, id, props);

    const acl = new Php2ShellWebAcl(this, 'WebAcl', {
      namePrefix: `${props.project}-${props.environment}-php2shell`,
      label: 'cloudfront',
      scope: 'CLOUDFRONT',
      acl: props.waf.cloudFront,
      rateLimitPostsPerIp: props.waf.cloudFront.rateLimitPostsPerIp,
      bodyInspectionLimit: props.waf.cloudFront.bodyInspectionLimit,
      allowedIps: props.allowedIps,
      allowedIpv6s: props.allowedIpv6s,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    this.webAclArn = acl.webAcl.attrArn;

    new cdk.CfnOutput(this, 'CloudFrontWebAclName', { value: acl.webAclName });
    new cdk.CfnOutput(this, 'CloudFrontWafLogGroup', { value: acl.logGroup.logGroupName });
  }
}
