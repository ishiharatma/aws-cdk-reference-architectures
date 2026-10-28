import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** Properties for {@link TaskEventRecorder}. */
export interface TaskEventRecorderProps {
  readonly cluster: ecs.ICluster;
  /** Prefix of the log group names under `/aws/events/`. */
  readonly logGroupPrefix: string;
  readonly retentionDays: number;
}

/**
 * Records the cluster's ECS events in CloudWatch Logs so that Spot interruptions, AZ rebalancing
 * and capacity shortages can be counted after the fact:
 *
 * - `spot-interruptions`: task state changes with stop code `TerminationNotice` (the 2-minute warning)
 * - `task-stopped`: every stopped task with its stop code and reason (rebalancing, scale-in, deployments)
 * - `service-actions`: service events such as placement failures when Spot capacity is unavailable
 */
export class TaskEventRecorder extends Construct {
  public readonly spotInterruptionLogGroup: logs.ILogGroup;
  public readonly taskStoppedLogGroup: logs.ILogGroup;
  public readonly serviceActionLogGroup: logs.ILogGroup;

  /** Creates the three log groups and the EventBridge rules that feed them. */
  constructor(scope: Construct, id: string, props: TaskEventRecorderProps) {
    super(scope, id);

    const logGroup = (name: string, suffix: string) =>
      new logs.LogGroup(this, name, {
        // EventBridge can only write to log groups under /aws/events/.
        logGroupName: `/aws/events/${props.logGroupPrefix}/${suffix}`,
        retention: props.retentionDays,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    this.spotInterruptionLogGroup = logGroup('SpotInterruptionLogGroup', 'spot-interruptions');
    this.taskStoppedLogGroup = logGroup('TaskStoppedLogGroup', 'task-stopped');
    this.serviceActionLogGroup = logGroup('ServiceActionLogGroup', 'service-actions');

    new events.Rule(this, 'SpotInterruptionRule', {
      description: 'Fargate Spot interruption warnings (2 minutes before the task stops)',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: { clusterArn: [props.cluster.clusterArn], stopCode: ['TerminationNotice'] },
      },
      targets: [new targets.CloudWatchLogGroup(this.spotInterruptionLogGroup)],
    });

    new events.Rule(this, 'TaskStoppedRule', {
      description: 'Every stopped task of the cluster with its stop code and reason',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: { clusterArn: [props.cluster.clusterArn], lastStatus: ['STOPPED'] },
      },
      targets: [new targets.CloudWatchLogGroup(this.taskStoppedLogGroup)],
    });

    new events.Rule(this, 'ServiceActionRule', {
      description: 'ECS service actions such as task placement failures',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Service Action'],
        detail: { clusterArn: [props.cluster.clusterArn] },
      },
      targets: [new targets.CloudWatchLogGroup(this.serviceActionLogGroup)],
    });
  }
}
