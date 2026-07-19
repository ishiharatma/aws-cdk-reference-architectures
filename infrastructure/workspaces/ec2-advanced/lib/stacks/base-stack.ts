import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { Environment } from "@common/parameters/environments";
import { VpcConfig } from '@common/types';

import { VpcConstruct } from '@common/constructs/vpc/vpc';

export interface StackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly config: VpcConfig;
}
export class BaseStack extends cdk.Stack {
  public readonly vpc: VpcConstruct;
  public readonly notificationTopic: sns.ITopic;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    // Create VPC
    this.vpc = new VpcConstruct(this, 'Vpc', {
      project: props.project,
      environment: props.environment,
      config: props.config,
      prefix: [props.project, props.environment].join('/'),
    });
    // Create SNS topic for notifications
    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      topicName: `${props.project}-${props.environment}-notifications`,
    });

  }
}

