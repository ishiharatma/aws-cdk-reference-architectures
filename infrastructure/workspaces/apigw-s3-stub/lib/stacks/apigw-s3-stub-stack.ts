import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

const STUB_DATA_DIR = path.join(__dirname, '../../src/stub-data');

export interface ApigwS3StubStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly envParams: EnvParams;
}

/**
 * apigw-s3-stub reference architecture
 *
 * A mock/stub HTTP API backed entirely by API Gateway's native AWS Service
 * integration to S3 -- no Lambda involved. Each method is wired directly to
 * `s3:GetObject`, so extending the API is just dropping a new JSON file into
 * the bucket; no redeploy is required.
 *
 * Endpoint shape (both levels support the pattern; add more methods/files
 * the same way):
 *   GET/POST    /{resource}          -> {resource}/{get|post}_result.json
 *   GET/PUT/DELETE /{resource}/{item} -> {resource}/{item}/{get|put|delete}_result.json
 *
 * Based on: https://zenn.dev/issy/articles/zenn-apigw-s3-stub-tried-it
 */
export class ApigwS3StubStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApigwS3StubStackProps) {
    super(scope, id, props);

    const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const rateLimit = props.envParams.throttle?.rateLimit ?? 10;
    const burstLimit = props.envParams.throttle?.burstLimit ?? 20;

    // -----------------------------------------------------------------------
    // S3 bucket holding the canned JSON responses
    // -----------------------------------------------------------------------
    const stubBucket = new s3.Bucket(this, 'StubBucket', {
      removalPolicy,
      autoDeleteObjects: props.isAutoDeleteObject,
      enforceSSL: true,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
    stubBucket.addLifecycleRule({
      id: 'AbortIncompleteMultipartUploadsAfter7Days',
      enabled: true,
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
    });

    // Seed a couple of example resources so the API is usable right after
    // deployment. `src/stub-data/` is laid out with the exact same key
    // structure as the bucket (see addStubMethod below), so it's uploaded
    // as-is. `prune: false` means additional stub files dropped into the
    // bucket by hand (via console/CLI) are left alone on redeploy.
    new s3deploy.BucketDeployment(this, 'DeployStubData', {
      destinationBucket: stubBucket,
      prune: false,
      sources: [s3deploy.Source.asset(STUB_DATA_DIR)],
    });

    // -----------------------------------------------------------------------
    // IAM role assumed by API Gateway to read the stub files from S3
    // -----------------------------------------------------------------------
    const apiGatewayS3Role = new iam.Role(this, 'ApiGatewayS3Role', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    apiGatewayS3Role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [stubBucket.arnForObjects('*')],
    }));
    // Without s3:ListBucket, S3 can't tell the caller "this object doesn't
    // exist" from "you can't see this bucket at all", so GetObject on a
    // missing key returns 403 AccessDenied instead of 404 NoSuchKey -- see
    // https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-troubleshooting.html
    apiGatewayS3Role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [stubBucket.bucketArn],
    }));

    // -----------------------------------------------------------------------
    // REST API: every method is an AWS Service (non-proxy) integration to
    // S3 GetObject. `integrationHttpMethod` is always GET regardless of the
    // HTTP verb the caller used, since the backend call is always "read this
    // JSON file"; the verb only selects *which* file (via the path override).
    // -----------------------------------------------------------------------
    const apiAccessLogGroup = new logs.LogGroup(this, 'ApiAccessLogGroup', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, 'ApigwS3StubApi', {
      restApiName: `${props.project}-${props.environment}-apigw-s3-stub-api`,
      description: 'Mock/stub HTTP API returning canned JSON responses read directly from S3',
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      cloudWatchRole: false,
      deployOptions: {
        stageName: props.environment,
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        throttlingRateLimit: rateLimit,
        throttlingBurstLimit: burstLimit,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const requestValidator = api.addRequestValidator('ApigwS3StubRequestValidator', {
      validateRequestParameters: true,
      validateRequestBody: true,
    });

    /**
     * Wires one HTTP method on `resource` to `s3:GetObject` on `stubBucket`,
     * mapping the given path parameters through to the S3 object key.
     *
     * `s3KeyTemplate` uses the same `{name}` placeholders as `pathParams`
     * (e.g. `{resource}/{item}/get_result.json`); API Gateway substitutes
     * them from the matching `integration.request.path.*` parameters at
     * request time.
     */
    const addStubMethod = (
      resource: apigateway.IResource,
      httpMethod: string,
      s3KeyTemplate: string,
      pathParams: string[],
    ): void => {
      const integrationRequestParameters: Record<string, string> = {};
      const methodRequestParameters: Record<string, boolean> = {};
      pathParams.forEach((param) => {
        integrationRequestParameters[`integration.request.path.${param}`] = `method.request.path.${param}`;
        methodRequestParameters[`method.request.path.${param}`] = true;
      });

      const notFoundMessage = JSON.stringify({ message: 'No stub file found for this path/method' });
      const forbiddenMessage = JSON.stringify({ message: 'S3 denied access to this stub file' });

      // S3's response status only ever matches one of the non-default
      // entries below (200 has no selectionPattern and is the catch-all);
      // without an explicit 403 entry, an AccessDenied response would fall
      // through to the 200 branch and leak the raw S3 XML error body with
      // a 200 status instead of surfacing as an error.
      const integration = new apigateway.AwsIntegration({
        service: 's3',
        integrationHttpMethod: 'GET',
        path: `${stubBucket.bucketName}/${s3KeyTemplate}`,
        options: {
          credentialsRole: apiGatewayS3Role,
          requestParameters: integrationRequestParameters,
          integrationResponses: [
            { statusCode: '200' },
            {
              statusCode: '403',
              selectionPattern: '403',
              responseTemplates: { 'application/json': forbiddenMessage },
            },
            {
              statusCode: '404',
              selectionPattern: '404',
              responseTemplates: { 'application/json': notFoundMessage },
            },
          ],
        },
      });

      resource.addMethod(httpMethod, integration, {
        apiKeyRequired: true,
        requestParameters: methodRequestParameters,
        requestValidator,
        methodResponses: [{ statusCode: '200' }, { statusCode: '403' }, { statusCode: '404' }],
      });
    };

    const resource = api.root.addResource('{resource}');
    const item = resource.addResource('{item}');

    addStubMethod(resource, 'GET', '{resource}/get_result.json', ['resource']);
    addStubMethod(resource, 'POST', '{resource}/post_result.json', ['resource']);
    addStubMethod(item, 'GET', '{resource}/{item}/get_result.json', ['resource', 'item']);
    addStubMethod(item, 'PUT', '{resource}/{item}/put_result.json', ['resource', 'item']);
    addStubMethod(item, 'DELETE', '{resource}/{item}/delete_result.json', ['resource', 'item']);

    // -----------------------------------------------------------------------
    // API key + usage plan: cheap request throttling/auditing for a stub
    // endpoint that has no real backend authorization to delegate to.
    // -----------------------------------------------------------------------
    const apiKey = api.addApiKey('StubApiKey', {
      apiKeyName: `${props.project}-${props.environment}-apigw-s3-stub-key`,
    });
    const usagePlan = api.addUsagePlan('StubUsagePlan', {
      name: `${props.project}-${props.environment}-apigw-s3-stub-plan`,
      throttle: { rateLimit, burstLimit },
    });
    usagePlan.addApiStage({ stage: api.deploymentStage });
    usagePlan.addApiKey(apiKey);

    // -----------------------------------------------------------------------
    // Stack Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'Base URL of the stub API, e.g. curl "$ApiUrl users"',
    });
    new cdk.CfnOutput(this, 'StubBucketName', {
      value: stubBucket.bucketName,
      description: 'S3 bucket holding the stub JSON files -- add "<resource>/<method>_result.json" to extend the API',
    });
    new cdk.CfnOutput(this, 'ApiKeyId', {
      value: apiKey.keyId,
      description: 'API key ID; fetch the value with `aws apigateway get-api-key --api-key <id> --include-value`',
    });
  }
}
