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
 * Base infrastructure stack: DynamoDB table.
 *
 * The table uses PAY_PER_REQUEST billing so it scales to zero cost between
 * chaos experiments. FIS scenarios B-1 and B-2 inject DynamoDB-level faults.
 */
export class BaseStack extends cdk.Stack {
    public readonly table: dynamodb.Table;

    constructor(scope: Construct, id: string, props: BaseStackProps) {
        super(scope, id, props);

        this.table = new dynamodb.Table(this, 'ItemsTable', {
            tableName: `${props.project}-${props.environment}-items`,
            partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: props.isAutoDeleteObject
                ? cdk.RemovalPolicy.DESTROY
                : cdk.RemovalPolicy.RETAIN,
            pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
        });

        // --- Outputs ---

        new cdk.CfnOutput(this, 'TableName', {
            value: this.table.tableName,
            description: 'DynamoDB items table name',
        });
        new cdk.CfnOutput(this, 'TableArn', {
            value: this.table.tableArn,
            description: 'DynamoDB items table ARN',
        });
    }
}
