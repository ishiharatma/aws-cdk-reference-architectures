import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

/**
 * S3 key prefix under which AWS FIS writes active Lambda fault configurations
 * and the AWS FIS Lambda extension reads them. Shared by AppStack (extension
 * env var + read grant) and FisStack (write grant).
 */
export const FIS_CONFIG_PREFIX = 'FisConfigs';

/**
 * Public SSM parameter that resolves to the AWS FIS Lambda extension layer ARN
 * for the current Region (x86_64 build — matches the default Lambda architecture).
 */
export const FIS_EXTENSION_LAYER_SSM_PARAM =
    '/aws/service/fis/lambda-extension/AWS-FIS-extension-x86_64/1.x.x';

export interface AppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly table: dynamodb.ITable;
}

/**
 * Application stack: Lambda + API Gateway HTTP API + CloudFront.
 *
 * CloudFront sits in front of the API Gateway endpoint, providing caching,
 * WAF attachment point, and a stable domain. All API requests pass through
 * CloudFront → API Gateway → Lambda → DynamoDB.
 *
 * The Lambda function carries the AWS FIS Lambda extension layer so that the
 * FisStack can inject invocation faults (error / added latency / overridden
 * HTTP response) without any change to the function code. FIS and the extension
 * exchange the active fault configuration through `fisConfigBucket`.
 */
export class AppStack extends cdk.Stack {
    public readonly apiFunction: lambda.Function;
    public readonly httpApi: apigwv2.HttpApi;
    public readonly distribution: cloudfront.Distribution;
    /** S3 bucket used to distribute AWS FIS Lambda fault configurations. */
    public readonly fisConfigBucket: s3.IBucket;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- FIS Lambda extension: config-distribution bucket ---
        // AWS FIS writes the active fault config here; the extension polls it.
        // One bucket per Region is sufficient; it holds only tiny JSON objects.
        this.fisConfigBucket = new s3.Bucket(this, 'FisConfigBucket', {
            bucketName: `${props.project}-${props.environment}-b-fis-config-${this.account}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: props.isAutoDeleteObject,
            lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
        });

        // --- Lambda function ---

        const fnLogGroup = new logs.LogGroup(this, 'ApiFunctionLogGroup', {
            logGroupName: `/aws/lambda/${props.project}-${props.environment}-api-handler`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        const fisExtensionLayerArn = ssm.StringParameter.valueForStringParameter(
            this,
            FIS_EXTENSION_LAYER_SSM_PARAM,
        );
        const fisConfigLocation = `arn:aws:s3:::${this.fisConfigBucket.bucketName}/${FIS_CONFIG_PREFIX}/`;

        this.apiFunction = new lambda.Function(this, 'ApiFunction', {
            functionName: `${props.project}-${props.environment}-api-handler`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/api-handler')),
            layers: [
                lambda.LayerVersion.fromLayerVersionArn(
                    this,
                    'FisExtensionLayer',
                    fisExtensionLayerArn,
                ),
            ],
            environment: {
                TABLE_NAME: props.table.tableName,
                // AWS FIS Lambda extension wiring (see aws:lambda:invocation-* actions).
                AWS_LAMBDA_EXEC_WRAPPER: '/opt/aws-fis/bootstrap',
                AWS_FIS_CONFIGURATION_LOCATION: fisConfigLocation,
                // Give the extension time to fetch fault config before deciding
                // whether to block execution (recommended when preventExecution=true).
                AWS_FIS_POLL_MAX_WAIT_MILLISECONDS: '2000',
            },
            timeout: cdk.Duration.seconds(29),
            memorySize: 256,
            logGroup: fnLogGroup,
        });

        props.table.grantReadWriteData(this.apiFunction);

        // The extension (running in the function's execution role) reads fault
        // configs from the shared bucket.
        this.apiFunction.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AllowListingFisConfigLocation',
                actions: ['s3:ListBucket'],
                resources: [this.fisConfigBucket.bucketArn],
                conditions: { StringLike: { 's3:prefix': [`${FIS_CONFIG_PREFIX}/*`] } },
            }),
        );
        this.apiFunction.addToRolePolicy(
            new iam.PolicyStatement({
                sid: 'AllowReadingFisConfig',
                actions: ['s3:GetObject'],
                resources: [`${this.fisConfigBucket.bucketArn}/${FIS_CONFIG_PREFIX}/*`],
            }),
        );

        // --- API Gateway HTTP API ---

        const apiLogGroup = new logs.LogGroup(this, 'ApiGwLogGroup', {
            logGroupName: `/aws/apigateway/${props.project}-${props.environment}-http-api`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        const integration = new apigwv2Integrations.HttpLambdaIntegration(
            'LambdaIntegration',
            this.apiFunction,
        );

        this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
            apiName: `${props.project}-${props.environment}-http-api`,
            description: `FIS chaos B — API Gateway HTTP API for ${props.project} ${props.environment}`,
            defaultIntegration: integration,
            disableExecuteApiEndpoint: false,
        });

        // Enable access logging
        const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
        if (defaultStage) {
            defaultStage.accessLogSettings = {
                destinationArn: apiLogGroup.logGroupArn,
                format: JSON.stringify({
                    requestId: '$context.requestId',
                    ip: '$context.identity.sourceIp',
                    requestTime: '$context.requestTime',
                    httpMethod: '$context.httpMethod',
                    routeKey: '$context.routeKey',
                    status: '$context.status',
                    integrationLatency: '$context.integrationLatency',
                    responseLength: '$context.responseLength',
                }),
            };
        }

        // --- CloudFront Distribution ---

        const apiEndpoint = `${this.httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;

        this.distribution = new cloudfront.Distribution(this, 'Distribution', {
            comment: `${props.project}-${props.environment} API CloudFront distribution`,
            defaultBehavior: {
                origin: new origins.HttpOrigin(apiEndpoint, {
                    originPath: '',
                    protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            },
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
            httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
            enableIpv6: true,
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'ApiFunctionArn', {
            value: this.apiFunction.functionArn,
            description: 'Lambda function ARN',
        });
        new cdk.CfnOutput(this, 'HttpApiEndpoint', {
            value: this.httpApi.url ?? '',
            description: 'API Gateway HTTP API endpoint URL',
        });
        new cdk.CfnOutput(this, 'CloudFrontDomain', {
            value: this.distribution.distributionDomainName,
            description: 'CloudFront distribution domain name',
        });
        new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
            value: this.distribution.distributionId,
            description: 'CloudFront distribution ID',
        });
        new cdk.CfnOutput(this, 'FisConfigBucketName', {
            value: this.fisConfigBucket.bucketName,
            description: 'S3 bucket distributing AWS FIS Lambda fault configurations',
        });
    }
}
