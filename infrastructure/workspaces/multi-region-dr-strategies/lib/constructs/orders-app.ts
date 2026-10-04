import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Strategy } from 'lib/types';

/**
 * Tiny orders API shared by all four strategies, so only the DR design differs.
 *   GET  /            -> which strategy, which region, which table
 *   GET  /health      -> 200, or 503 while FAIL=true (how the drill takes a region "down")
 *   POST /orders      -> writes an item {id, ts}
 *   GET  /orders/{id} -> reads it back
 */
const HANDLER_CODE = `
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const ddb = new DynamoDBClient({});
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
exports.handler = async (event) => {
  const path = event.rawPath || '/';
  const method = event.requestContext.http.method;
  const base = { strategy: process.env.STRATEGY, region: process.env.AWS_REGION };
  if (path === '/health') return process.env.FAIL === 'true' ? json(503, { ...base, healthy: false }) : json(200, { ...base, healthy: true });
  if (method === 'POST' && path === '/orders') {
    const id = JSON.parse(event.body || '{}').id || crypto.randomUUID();
    const ts = Date.now();
    await ddb.send(new PutItemCommand({ TableName: process.env.TABLE_NAME, Item: { id: { S: id }, ts: { N: String(ts) } } }));
    return json(200, { ...base, id, ts });
  }
  if (method === 'GET' && path.startsWith('/orders/')) {
    const id = decodeURIComponent(path.slice('/orders/'.length));
    const res = await ddb.send(new GetItemCommand({ TableName: process.env.TABLE_NAME, Key: { id: { S: id } } }));
    return res.Item ? json(200, { ...base, id, ts: Number(res.Item.ts.N) }) : json(404, { ...base, id, found: false });
  }
  return json(200, { ...base, table: process.env.TABLE_NAME });
};
`;

export interface OrdersAppProps {
  readonly strategy: Strategy;
  readonly functionName: string;
  readonly tableName: string;
  /** Region of the table the function reads and writes. */
  readonly tableRegion: string;
  /** Warm standby: set to 0 to scale the function to zero. Leave undefined for a normally serving function. */
  readonly reservedConcurrentExecutions?: number;
  readonly removalPolicy: cdk.RemovalPolicy;
}

/** Orders API on a Lambda function URL, with least-privilege access to a single table. */
export class OrdersApp extends Construct {
  public readonly function: lambda.Function;
  public readonly url: lambda.FunctionUrl;
  /** Host name of the function URL, without scheme or path. */
  public readonly host: string;

  constructor(scope: Construct, id: string, props: OrdersAppProps) {
    super(scope, id);

    this.function = new lambda.Function(this, 'Function', {
      functionName: props.functionName,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromInline(HANDLER_CODE),
      environment: { STRATEGY: props.strategy, TABLE_NAME: props.tableName, FAIL: 'false' },
      timeout: cdk.Duration.seconds(5),
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,
      logGroup: new logs.LogGroup(this, 'LogGroup', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: props.removalPolicy }),
    });

    const stack = cdk.Stack.of(this);
    this.function.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
      resources: [`arn:${stack.partition}:dynamodb:${props.tableRegion}:${stack.account}:table/${props.tableName}`],
    }));

    // Route 53 health checkers cannot sign requests, so the URL is public. It serves a fixed API only.
    this.url = this.function.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    this.host = cdk.Fn.parseDomainName(this.url.url);
  }
}
