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
 * Lambdalith ("Lambda monolith") pattern.
 *
 * A single Lambda function serves every route. Routing is done inside the
 * function by the Hono web framework via its `hono/aws-lambda` adapter, so
 * API Gateway is a thin `{proxy+}` pass-through and the whole API is one
 * deployable unit.
 */
export class ApigwLambdalithStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    // Pattern infix so the three companion workspaces can be deployed side by side
    // under the same project/env without physical-name collisions.
    const namePrefix = `${project}-${environment}-lith`;

    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${namePrefix}-todos`,
      partitionKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const handlerLogGroup = new logs.LogGroup(this, 'LambdalithHandlerLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const lambdalithHandler = new lambdaNodejs.NodejsFunction(this, 'LambdalithHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/lambda.ts',
      handler: 'handler',
      functionName: `${namePrefix}-fn`,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: handlerLogGroup,
      environment: {
        TABLE_NAME: todosTable.tableName,
        ENVIRONMENT: environment,
      },
    });
    todosTable.grantReadWriteData(lambdalithHandler);

    const accessLogGroup = new logs.LogGroup(this, 'TodosApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const api = new apigateway.LambdaRestApi(this, 'TodosApi', {
      handler: lambdalithHandler,
      proxy: true,
      restApiName: `${namePrefix}-todos-api`,
      description: 'Todos REST API (Lambdalith pattern with Hono)',
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
