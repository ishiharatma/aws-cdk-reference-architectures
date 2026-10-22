import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { Php2ShellWebAcl } from 'lib/constructs/php2shell-web-acl';

/** Properties for {@link WafPhp2ShellMitigationStack}. */
export interface WafPhp2ShellMitigationStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  /** ARN of the CLOUDFRONT-scoped Web ACL from the us-east-1 stack. */
  readonly cloudFrontWebAclArn: string;
  /**
   * IPv4 addresses that may reach the ALB directly (bypassing CloudFront). Used only to
   * compare the ALB's fixed 8 KB inspection limit with CloudFront's; omit to close the ALB.
   */
  readonly directAccessIps?: string[];
}

const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

/**
 * CloudFront (WAF, up to 64 KB body inspection) -> ALB (WAF, 8 KB fixed) -> Lambda
 * container image running PHP-FPM 8.4.27 + nginx behind the Lambda Web Adapter.
 */
export class WafPhp2ShellMitigationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WafPhp2ShellMitigationStackProps) {
    super(scope, id, props);
    const { params } = props;
    const namePrefix = `${props.project}-${props.environment}-php2shell`;
    const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // ---------------------------------------------------------------- Network
    // Public subnets only: the ALB is internet-facing and the Lambda target needs no VPC.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'ALB: HTTP from CloudFront origin-facing IPs and the verification client only',
      allowAllOutbound: false,
    });
    const cloudFrontPrefixList = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(cloudFrontPrefixList.prefixListId),
      ec2.Port.tcp(80),
      'CloudFront origin-facing',
    );
    for (const ip of props.directAccessIps ?? []) {
      albSecurityGroup.addIngressRule(ec2.Peer.ipv4(`${ip}/32`), ec2.Port.tcp(80), 'Verification client (direct)');
    }

    // ---------------------------------------------------------------- Origin
    const logGroup = new logs.LogGroup(this, 'OriginLogGroup', {
      logGroupName: `/aws/lambda/${namePrefix}-origin`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const originFunction = new lambda.DockerImageFunction(this, 'PhpOrigin', {
      functionName: `${namePrefix}-origin`,
      description: 'PHP-FPM 8.4.27 + nginx echo origin behind the Lambda Web Adapter',
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../../src/php-app'), {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: params.origin.memorySize,
      timeout: cdk.Duration.seconds(params.origin.timeoutSeconds),
      logGroup,
    });

    // ---------------------------------------------------------------- ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    });

    // Shared secret CloudFront adds to every origin request; the listener only forwards
    // requests that carry it (or come from the allow-listed verification client).
    const originVerifySecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: `${ORIGIN_VERIFY_HEADER} header value shared by CloudFront and the ALB listener`,
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
      removalPolicy,
    });
    const originVerifyValue = originVerifySecret.secretValue.unsafeUnwrap();

    const listener = alb.addListener('Http', {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Direct access denied',
      }),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'OriginTargetGroup', {
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new elbv2Targets.LambdaTarget(originFunction)],
    });

    listener.addAction('FromCloudFront', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originVerifyValue])],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
    if (props.directAccessIps?.length) {
      listener.addAction('DirectVerificationClient', {
        priority: 20,
        conditions: [elbv2.ListenerCondition.sourceIps(props.directAccessIps.map((ip) => `${ip}/32`))],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });
    }

    // Regional Web ACL: same rules, but the ALB body inspection limit is fixed at 8 KB.
    // No IP allowlist here: behind CloudFront the source IP is an edge address.
    const albAcl = new Php2ShellWebAcl(this, 'AlbWebAcl', {
      namePrefix,
      label: 'alb',
      scope: 'REGIONAL',
      acl: params.waf.alb,
      removalPolicy,
    });
    new wafv2.CfnWebACLAssociation(this, 'AlbWebAclAssociation', {
      resourceArn: alb.loadBalancerArn,
      webAclArn: albAcl.webAcl.attrArn,
    });

    // ---------------------------------------------------------------- CloudFront
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${namePrefix} PHP2Shell WAF verification`,
      webAclId: props.cloudFrontWebAclArn,
      defaultBehavior: {
        origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: { [ORIGIN_VERIFY_HEADER]: originVerifyValue },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'AlbUrl', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'AlbWebAclName', { value: albAcl.webAclName });
    new cdk.CfnOutput(this, 'AlbWafLogGroup', { value: albAcl.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'OriginFunctionName', { value: originFunction.functionName });
  }
}
