import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { WebFunction } from 'lib/constructs/web-function';
import { WebFunctionVpcEgress } from 'lib/constructs/web-function-vpc-egress';

/** Properties for {@link LambdaWebFunctionsExpressStack}. */
export interface LambdaWebFunctionsExpressStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  /** WAFv2 Web ACL (CLOUDFRONT scope, us-east-1) to associate with the distribution. */
  readonly webAclArn?: string;
}

/**
 * Lambda Web Functions pattern.
 *
 * The same Express.js Todos API as `apigw-lambda-web-adapter`, but the server runs
 * as a Lambda Web Function: no API Gateway, no adapter layer, no handler. Lambda
 * provides the HTTPS endpoint, which is `IamAuth` and reachable only through
 * CloudFront signing with origin access control (OAC). WAF sits on CloudFront.
 *
 *   Client -> CloudFront (+WAF) --SigV4/OAC--> Web Function endpoint -> Express -> DynamoDB
 */
export class LambdaWebFunctionsExpressStack extends cdk.Stack {
  public readonly webFunction: WebFunction;
  public readonly distribution: cloudfront.IDistribution;

  constructor(scope: Construct, id: string, props: LambdaWebFunctionsExpressStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    // `lwf` infix lets this deploy side by side with the three apigw-* companion workspaces.
    const namePrefix = `${project}-${environment}-lwf`;

    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${namePrefix}-todos`,
      partitionKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // Optional: send the revision's outbound traffic through an isolated VPC.
    const vpcEgress = params.vpcEgress.enabled
      ? new WebFunctionVpcEgress(this, 'VpcEgress', { namePrefix, maxAzs: params.vpcEgress.maxAzs })
      : undefined;

    this.webFunction = new WebFunction(this, 'TodosWebFunction', {
      functionName: `${namePrefix}-todos`,
      sourceDir: path.join(__dirname, '..', '..', 'src'),
      entry: 'index.ts',
      endpointName: environment,
      authType: 'IamAuth',
      timeoutSeconds: params.webFunction.timeoutSeconds,
      maxConcurrencyPerEnvironment: params.webFunction.maxConcurrencyPerEnvironment,
      maxEnvironments: params.webFunction.maxEnvironments,
      rateLimit: params.webFunction.rateLimit,
      environmentVariables: {
        TABLE_NAME: todosTable.tableName,
        ENABLE_DEBUG_ROUTES: String(params.webFunction.enableDebugRoutes),
      },
      egressNetworkConnectorArn: vpcEgress?.connectorVersionArn,
      logRetention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
      autoDeleteObjects: isAutoDeleteObject,
    });
    todosTable.grants.readWriteData(this.webFunction.role);

    // ---- CloudFront with origin access control ------------------------------
    // Web Function origins accept only signing behavior `always-amz-auth`: CloudFront signs every
    // origin request but leaves the viewer's Authorization header untouched for the app.
    const oac = new cloudfront.CfnOriginAccessControl(this, 'WebFunctionOac', {
      originAccessControlConfig: {
        name: `${namePrefix}-web-function-oac`,
        description: 'OAC for the Lambda Web Function endpoint',
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always-amz-auth',
        signingProtocol: 'sigv4', // HomeRegion endpoint; a MultiRegion (global) endpoint needs sigv4a
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${namePrefix} Todos API (Lambda Web Functions)`,
      defaultBehavior: {
        origin: new origins.HttpOrigin(this.webFunction.domainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          readTimeout: cdk.Duration.seconds(params.webFunction.timeoutSeconds),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // The endpoint routes on its own Host header; forwarding the viewer Host returns 404.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      webAclId: props.webAclArn,
    });
    this.distribution = distribution;
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.0.OriginAccessControlId', oac.attrId);

    // Only this distribution may invoke the endpoint (resource-based policy on the Web Function).
    new lambda.CfnResourcePolicy(this, 'WebFunctionResourcePolicy', {
      resourceArn: this.webFunction.functionArn,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOAC',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 'lambda:InvokeWebFunctionEndpoint',
            Resource: this.webFunction.endpointArn,
            Condition: {
              StringEquals: { 'aws:SourceArn': this.distribution.distributionArn },
            },
          },
        ],
      },
    });

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Public URL (CloudFront)',
    });
    new cdk.CfnOutput(this, 'EndpointDomainName', {
      value: this.webFunction.domainName,
      description: 'Web Function endpoint domain (IamAuth; unsigned requests are rejected)',
    });
    new cdk.CfnOutput(this, 'WebFunctionName', { value: this.webFunction.functionName });
    new cdk.CfnOutput(this, 'EndpointName', { value: environment });
    new cdk.CfnOutput(this, 'RevisionId', { value: this.webFunction.revisionId });
    new cdk.CfnOutput(this, 'LogGroupName', { value: this.webFunction.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'TodosTableName', { value: todosTable.tableName });
  }
}
