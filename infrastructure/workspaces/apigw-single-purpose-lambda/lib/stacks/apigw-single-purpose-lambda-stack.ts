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

export class ApigwSinglePurposeLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;

    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${project}-${environment}-todos`,
      partitionKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    const commonProps: Omit<lambdaNodejs.NodejsFunctionProps, 'entry' | 'handler' | 'functionName'> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        TABLE_NAME: todosTable.tableName,
        ENVIRONMENT: environment,
      },
    };

    const listTodosHandler = new lambdaNodejs.NodejsFunction(this, 'ListTodosHandler', {
      ...commonProps,
      entry: 'src/handlers/list-todos.ts',
      handler: 'handler',
      functionName: `${project}-${environment}-list-todos`,
    });
    todosTable.grantReadData(listTodosHandler);

    const createTodoHandler = new lambdaNodejs.NodejsFunction(this, 'CreateTodoHandler', {
      ...commonProps,
      entry: 'src/handlers/create-todo.ts',
      handler: 'handler',
      functionName: `${project}-${environment}-create-todo`,
    });
    todosTable.grantWriteData(createTodoHandler);

    const getTodoHandler = new lambdaNodejs.NodejsFunction(this, 'GetTodoHandler', {
      ...commonProps,
      entry: 'src/handlers/get-todo.ts',
      handler: 'handler',
      functionName: `${project}-${environment}-get-todo`,
    });
    todosTable.grantReadData(getTodoHandler);

    const updateTodoHandler = new lambdaNodejs.NodejsFunction(this, 'UpdateTodoHandler', {
      ...commonProps,
      entry: 'src/handlers/update-todo.ts',
      handler: 'handler',
      functionName: `${project}-${environment}-update-todo`,
    });
    todosTable.grantReadWriteData(updateTodoHandler);

    const deleteTodoHandler = new lambdaNodejs.NodejsFunction(this, 'DeleteTodoHandler', {
      ...commonProps,
      entry: 'src/handlers/delete-todo.ts',
      handler: 'handler',
      functionName: `${project}-${environment}-delete-todo`,
    });
    todosTable.grantWriteData(deleteTodoHandler);

    const api = new apigateway.RestApi(this, 'TodosApi', {
      restApiName: `${project}-${environment}-todos-api`,
      description: 'Todos REST API (Single-Purpose Lambda pattern)',
      deployOptions: { stageName: environment },
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
