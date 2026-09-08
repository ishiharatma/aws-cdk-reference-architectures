import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';

interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * Lambda Web Adapter pattern.
 *
 * A single Lambda function runs a standard Express.js HTTP server. The AWS
 * Lambda Web Adapter layer bridges the API Gateway proxy event to a real HTTP
 * request against the server listening on `PORT`, so the same image runs
 * unchanged on Lambda, Fargate, or a local `node` process.
 */
export class ApigwLambdaWebAdapterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    // Pattern infix so the three companion workspaces can be deployed side by side
    // under the same project/env without physical-name collisions.
    const namePrefix = `${project}-${environment}-lwa`;

    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${namePrefix}-todos`,
      partitionKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    // AWS Lambda Web Adapter layer (public, published by AWS).
    // https://github.com/awslabs/aws-lambda-web-adapter
    const webAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'LambdaWebAdapterLayer',
      `arn:aws:lambda:${cdk.Stack.of(this).region}:753240598075:layer:LambdaAdapterLayerArm64:24`,
    );

    const handlerLogGroup = new logs.LogGroup(this, 'WebAdapterHandlerLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const webAdapterHandler = new lambdaNodejs.NodejsFunction(this, 'WebAdapterHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/index.ts',
      // With the managed runtime + Lambda Web Adapter, the function Handler must
      // be an executable bootstrap script (not `index.handler`). `run.sh` is
      // written next to the bundled `index.js` by the afterBundling hook below.
      handler: 'run.sh',
      functionName: `${namePrefix}-fn`,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: handlerLogGroup,
      layers: [webAdapterLayer],
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string): string[] => [
            `printf '#!/bin/sh\\nexec node index.js\\n' > "${outputDir}/run.sh"`,
            `chmod +x "${outputDir}/run.sh"`,
          ],
        },
      },
      environment: {
        TABLE_NAME: todosTable.tableName,
        ENVIRONMENT: environment,
        // Consumed by the Lambda Web Adapter layer.
        PORT: '8080',
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        READINESS_CHECK_PATH: '/health',
      },
    });
    todosTable.grantReadWriteData(webAdapterHandler);

    const accessLogGroup = new logs.LogGroup(this, 'TodosApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const api = new apigateway.LambdaRestApi(this, 'TodosApi', {
      handler: webAdapterHandler,
      proxy: true,
      restApiName: `${namePrefix}-todos-api`,
      description: 'Todos REST API (Lambda Web Adapter pattern)',
      cloudWatchRole: true,
      deployOptions: {
        stageName: environment,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });
    new cdk.CfnOutput(this, 'TodosTableName', {
      value: todosTable.tableName,
      description: 'DynamoDB table name',
    });
  }
}
