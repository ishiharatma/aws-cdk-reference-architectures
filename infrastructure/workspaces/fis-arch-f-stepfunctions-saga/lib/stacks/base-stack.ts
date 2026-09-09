import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface BaseStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
}

/**
 * Base infrastructure stack: DynamoDB table for order state.
 *
 * The table uses PAY_PER_REQUEST billing so it scales to zero cost between
 * chaos experiments. Every Saga step (forward or compensating) updates the
 * `status` field of the order item identified by `orderId`, so the table
 * itself is a durable, inspectable log of how far a Saga execution
 * progressed before FIS interrupted it.
 */
export class BaseStack extends cdk.Stack {
    public readonly table: dynamodb.Table;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        this.table = new dynamodb.Table(this, 'OrdersTable', {
            tableName: `${props.project}-${props.environment}-orders`,
            partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'TableName', {
            value: this.table.tableName,
            description: 'DynamoDB orders table name',
        });
        new cdk.CfnOutput(this, 'TableArn', {
            value: this.table.tableArn,
            description: 'DynamoDB orders table ARN',
        });
    }
}
