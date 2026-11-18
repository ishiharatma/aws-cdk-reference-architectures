import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { esbuildBundling } from 'lib/constructs/esbuild-bundling';

/** Properties for {@link LambdaWebFunctionsExpressL2Stack}. */
export interface LambdaWebFunctionsExpressL2StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
  /** WAFv2 Web ACL (CLOUDFRONT scope, us-east-1) to associate with the distribution. */
  readonly webAclArn?: string;
}

/**
 * Same architecture as {@link LambdaWebFunctionsExpressStack}, built with the L2 constructs
 * added in aws-cdk-lib 2.276.0 (`lambda.WebFunction`, `lambda.NetworkConnector`).
 *
 *   Client -> CloudFront (+WAF) --SigV4/OAC--> WebFunction endpoint -> Express -> DynamoDB
 *
 * What the L2 takes over from the hand-written L1 wrapper:
 * - Function / revision / endpoint wiring and their dependencies.
 * - The versioned code bucket, its read policy for `lambda.amazonaws.com` and the copy of
 *   the bundled zip (`WebFunctionCode.fromAssetToManagedBucket`).
 * - Pinning the revision to the connector's `LatestVersionArn` (no property override).
 * - The single `AWS::Lambda::ResourcePolicy` (`endpoint.grants.invoke`).
 *
 * What it does not do, so it stays here:
 * - The `<group>.local` log group the service creates per Region (it would outlive the stack).
 * - A scoped execution role: the default role carries `AWSLambdaBasicExecutionRole`.
 *
 * Physical names use the `lwf2` infix so this stack deploys next to the L1 stack.
 */
export class LambdaWebFunctionsExpressL2Stack extends cdk.Stack {
  public readonly webFunction: lambda.IWebFunction;
  public readonly distribution: cloudfront.IDistribution;
  public readonly networkConnector?: lambda.INetworkConnector;

  /**
   * @param scope - Parent construct (the stage)
   * @param id - Construct ID
   * @param props - Stack properties
   */
  constructor(scope: Construct, id: string, props: LambdaWebFunctionsExpressL2StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-lwf2`;
    const functionName = `${namePrefix}-todos`;

    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${namePrefix}-todos`,
      partitionKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // ---- Optional VPC egress (NetworkConnector L2) -------------------------
    let networkConnector: lambda.NetworkConnector | undefined;
    if (params.vpcEgress.enabled) {
      const vpc = new ec2.Vpc(this, 'Vpc', {
        maxAzs: params.vpcEgress.maxAzs,
        natGateways: 0,
        subnetConfiguration: [{ name: 'web-function', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
        gatewayEndpoints: { DynamoDb: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } },
      });
      vpc.addFlowLog('FlowLog', { trafficType: ec2.FlowLogTrafficType.REJECT });
      const securityGroup = new ec2.SecurityGroup(this, 'ConnectorSecurityGroup', {
        vpc,
        description: 'Outbound HTTPS only for the Lambda Web Function (DynamoDB gateway endpoint)',
        allowAllOutbound: false,
      });
      securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to AWS APIs through VPC endpoints');

      // The operator role is created with AWSLambdaNetworkConnectorOperatorPolicy by default.
      networkConnector = new lambda.NetworkConnector(this, 'EgressConnector', {
        networkConnectorName: `${namePrefix}-egress`,
        configuration: lambda.NetworkConnectorConfiguration.vpcEgress({
          computeType: lambda.NetworkConnectorComputeType.WEB_FUNCTION,
          vpc,
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
          securityGroups: [securityGroup],
        }),
      });
    }

    // ---- Logs ----------------------------------------------------------------
    // Named log groups so retention/removal are managed here. The service also writes a
    // per-Region `<group>.local` copy, which the L2 does not create.
    const logGroupName = `/aws/lambda/web/${functionName}`;
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    const localLogGroup = new logs.LogGroup(this, 'LocalLogGroup', {
      logGroupName: `${logGroupName}.local`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    // ---- Execution role ------------------------------------------------------
    // The L2 default role attaches AWSLambdaBasicExecutionRole (logs on `*`); scope it instead.
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for Lambda Web Function ${functionName}`,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [
          `arn:${this.partition}:logs:*:${this.account}:log-group:${logGroupName}:*`,
          `arn:${this.partition}:logs:*:${this.account}:log-group:${logGroupName}.local:*`,
        ],
      }),
    );

    // ---- WebFunction (function + revision + endpoint) -------------------------
    // The code is staged as a CDK asset and copied into a versioned bucket the L2 creates.
    // Its copy function's log group is passed in so it does not outlive the stack.
    const sourceDir = path.join(__dirname, '..', '..', 'src');
    const codeCopyLogGroup = new logs.LogGroup(this, 'CodeCopyLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    const webFunction = new lambda.WebFunction(this, 'TodosWebFunction', {
      webFunctionName: functionName,
      code: lambda.WebFunctionCode.fromAssetToManagedBucket(sourceDir, {
        bundling: esbuildBundling(sourceDir, 'index.ts'),
        copyOptions: { logGroup: codeCopyLogGroup },
      }),
      runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
      role,
      logGroup,
      applicationLogLevel: lambda.ApplicationLogLevel.INFO,
      systemLogLevel: lambda.SystemLogLevel.INFO,
      timeout: cdk.Duration.seconds(params.webFunction.timeoutSeconds),
      maxConcurrencyPerEnvironment: params.webFunction.maxConcurrencyPerEnvironment,
      environment: {
        TABLE_NAME: todosTable.tableName,
        ENABLE_DEBUG_ROUTES: String(params.webFunction.enableDebugRoutes),
      },
      egressNetworkConnector: networkConnector,
      defaultEndpointAuth: lambda.WebFunctionAuthType.IAM_AUTH,
      defaultEndpoint: {
        endpointName: environment,
        maxEnvironments: params.webFunction.maxEnvironments,
        rateLimit: params.webFunction.rateLimit,
      },
    });
    webFunction.resourceRevision.node.addDependency(localLogGroup, role);
    todosTable.grants.readWriteData(webFunction);
    this.webFunction = webFunction;
    this.networkConnector = networkConnector;

    // ---- CloudFront with origin access control --------------------------------
    // `FunctionUrlOriginAccessControl` creates an OAC of origin type `lambda`, which is also the
    // type a Web Function endpoint needs. Web Function origins accept only `always-amz-auth`.
    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, 'WebFunctionOac', {
      originAccessControlName: `${namePrefix}-web-function-oac`,
      description: 'OAC for the Lambda Web Function endpoint (L2)',
      signing: cloudfront.Signing.SIGV4_ALWAYS_AMZ_AUTH,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${namePrefix} Todos API (Lambda Web Functions, L2)`,
      defaultBehavior: {
        origin: new origins.HttpOrigin(webFunction.endpoint.domainName, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          readTimeout: cdk.Duration.seconds(params.webFunction.timeoutSeconds),
          originAccessControlId: oac.originAccessControlId,
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

    // Only this distribution may invoke the endpoint. Rendered into the function's single
    // AWS::Lambda::ResourcePolicy by the L2.
    webFunction.endpoint.grants.invoke(
      new iam.ServicePrincipal('cloudfront.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceArn': distribution.distributionArn } },
      }),
    );

    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Public URL (CloudFront)',
    });
    new cdk.CfnOutput(this, 'EndpointDomainName', {
      value: webFunction.endpoint.domainName,
      description: 'Web Function endpoint domain (IamAuth; unsigned requests are rejected)',
    });
    new cdk.CfnOutput(this, 'WebFunctionName', { value: webFunction.webFunctionName });
    new cdk.CfnOutput(this, 'EndpointName', { value: environment });
    new cdk.CfnOutput(this, 'RevisionId', { value: webFunction.revisionId });
    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
    new cdk.CfnOutput(this, 'TodosTableName', { value: todosTable.tableName });
  }
}
