import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Environment } from '@common/parameters/environments';

export interface AwsEolMonitorDataStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
}

/**
 * Stateful stack: the DynamoDB table that stores the last-seen status of
 * every (serviceCode, version) pair from the upstream EOL dataset.
 *
 * The Fetch-Diff Lambda compares each run's dataset against this table to
 * decide what is "new" (never-seen version), "changed" (status transition,
 * e.g. STANDARD_SUPPORT -> DEPRECATED) or "newly upcoming" (just crossed the
 * upcomingThresholdDays window before standardSupportEnd) — items are added,
 * not removed, so history persists.
 */
export class AwsEolMonitorDataStack extends cdk.Stack {
  public readonly table: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: AwsEolMonitorDataStackProps) {
    super(scope, id, props);

    const removalPolicy = props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    const table = new dynamodb.TableV2(this, 'Resource', {
      tableName: `${props.project}-${props.environment}-eol-state`,
      partitionKey: { name: 'serviceCode', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'version', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    this.table = table;
  }
}
