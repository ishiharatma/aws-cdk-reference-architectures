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

export class ApigwLambdaWebAdapterStack extends cdk.Stack {
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

    const webAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'LambdaWebAdapterLayer',
      `arn:aws:lambda:${cdk.Stack.of(this).region}:753240598075:layer:LambdaAdapterLayerArm64:24`,
    );

    const webAdapterHandler = new lambdaNodejs.NodejsFunction(this, 'WebAdapterHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'src/index.ts',
      handler: 'handler',
      functionName: `${project}-${environment}-lambda-web-adapter`,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      layers: [webAdapterLayer],
      environment: {
        TABLE_NAME: todosTable.tableName,
        ENVIRONMENT: environment,
        PORT: '8080',
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        READINESS_CHECK_PATH: '/health',
      },
    });
    todosTable.grantReadWriteData(webAdapterHandler);

    const api = new apigateway.LambdaRestApi(this, 'TodosApi', {
      handler: webAdapterHandler,
      proxy: true,
      restApiName: `${project}-${environment}-todos-api`,
      description: 'Todos REST API (Lambda Web Adapter pattern)',
      deployOptions: { stageName: environment },
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
