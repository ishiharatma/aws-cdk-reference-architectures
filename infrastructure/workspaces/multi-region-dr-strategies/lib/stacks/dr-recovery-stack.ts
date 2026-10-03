import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { OrdersApp } from 'lib/constructs/orders-app';
import { orderTableName } from 'lib/types';

export interface DrRecoveryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
}

/**
 * Pilot light recovery: the compute that is NOT deployed in normal operation.
 *
 * The data layer (the global table replica) is already live in the DR region. Recovery means deploying
 * this stack; the drill script times that deployment, which is the pilot light's recovery time.
 * It is only synthesized with `-c includeRecoveryStack=true`.
 */
export class DrRecoveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DrRecoveryStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;
    const prefix = `${project}-${environment}-dr`;

    const app = new OrdersApp(this, 'PilotLight', {
      strategy: 'pl',
      functionName: `${prefix}-pl`,
      tableName: orderTableName(prefix, 'pl'),
      tableRegion: this.region,
      removalPolicy: isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });
    new cdk.CfnOutput(this, 'PilotLightUrl', { value: app.url.url });
  }
}
