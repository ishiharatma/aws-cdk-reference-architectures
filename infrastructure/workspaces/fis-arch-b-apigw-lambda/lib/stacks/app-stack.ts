import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

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
 */
export class AppStack extends cdk.Stack {
    public readonly apiFunction: lambda.Function;
    public readonly httpApi: apigwv2.HttpApi;
    public readonly distribution: cloudfront.Distribution;

    constructor(scope: Construct, id: string, props: AppStackProps) {
        super(scope, id, props);

        // --- Lambda function ---

        const fnLogGroup = new logs.LogGroup(this, 'ApiFunctionLogGroup', {
            logGroupName: `/aws/lambda/${props.project}-${props.environment}-api-handler`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
        });

        this.apiFunction = new lambda.Function(this, 'ApiFunction', {
            functionName: `${props.project}-${props.environment}-api-handler`,
            runtime: lambda.Runtime.PYTHON_3_13,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/api-handler')),
            environment: {
                TABLE_NAME: props.table.tableName,
            },
            timeout: cdk.Duration.seconds(29),
            memorySize: 256,
            logGroup: fnLogGroup,
        });

        props.table.grantReadWriteData(this.apiFunction);

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
    }
}
