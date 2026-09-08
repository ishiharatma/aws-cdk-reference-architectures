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
 * Single-Purpose Function pattern (a.k.a. "one Lambda per route").
 *
 * Every API Gateway method is backed by its own Lambda function with its own
 * IAM role, log group, and least-privilege DynamoDB grant (read-only for GET,
 * write-only for POST/DELETE). API Gateway does the routing; each function does
 * exactly one thing.
 */
export class ApigwSinglePurposeLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${project}-${environment}-todos`,
      partitionKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });

    const commonProps: Omit<lambdaNodejs.NodejsFunctionProps, 'entry' | 'handler' | 'functionName' | 'logGroup'> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: todosTable.tableName,
        ENVIRONMENT: environment,
      },
    };

    /** Create one single-purpose function with its own dedicated log group. */
    const makeHandler = (idPrefix: string, entryFile: string, name: string): lambdaNodejs.NodejsFunction =>
      new lambdaNodejs.NodejsFunction(this, `${idPrefix}Handler`, {
        ...commonProps,
        entry: `src/handlers/${entryFile}.ts`,
        handler: 'handler',
        functionName: `${project}-${environment}-${name}`,
        logGroup: new logs.LogGroup(this, `${idPrefix}LogGroup`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy,
        }),
      });

    const listTodosHandler = makeHandler('ListTodos', 'list-todos', 'list-todos');
    todosTable.grantReadData(listTodosHandler);

    const createTodoHandler = makeHandler('CreateTodo', 'create-todo', 'create-todo');
    todosTable.grantWriteData(createTodoHandler);

    const getTodoHandler = makeHandler('GetTodo', 'get-todo', 'get-todo');
    todosTable.grantReadData(getTodoHandler);

    const updateTodoHandler = makeHandler('UpdateTodo', 'update-todo', 'update-todo');
    todosTable.grantReadWriteData(updateTodoHandler);

    const deleteTodoHandler = makeHandler('DeleteTodo', 'delete-todo', 'delete-todo');
    todosTable.grantWriteData(deleteTodoHandler);

    const accessLogGroup = new logs.LogGroup(this, 'TodosApiAccessLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const api = new apigateway.RestApi(this, 'TodosApi', {
      restApiName: `${project}-${environment}-todos-api`,
      description: 'Todos REST API (Single-Purpose Lambda pattern)',
      cloudWatchRole: true,
      deployOptions: {
        stageName: environment,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    const todosResource = api.root.addResource('todos');
    todosResource.addMethod('GET', new apigateway.LambdaIntegration(listTodosHandler));
    todosResource.addMethod('POST', new apigateway.LambdaIntegration(createTodoHandler));

    const todoResource = todosResource.addResource('{todoId}');
    todoResource.addMethod('GET', new apigateway.LambdaIntegration(getTodoHandler));
    todoResource.addMethod('PUT', new apigateway.LambdaIntegration(updateTodoHandler));
    todoResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteTodoHandler));

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
