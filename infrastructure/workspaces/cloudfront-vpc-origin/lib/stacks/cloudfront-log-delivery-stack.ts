import * as cdk from 'aws-cdk-lib/core';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface CloudfrontLogDeliveryStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    /** ARN of the CloudFront distribution that runs the CloudFront Function calling cf.logCustomData() */
    readonly distributionArn: string;
}

/**
 * Delivers a CloudFront Function's cf.logCustomData() output (viewer-request-log-data) to
 * CloudWatch Logs via CloudFront standard logging (v2).
 *
 * All three resources here — the log group, the delivery source, the delivery destination and
 * the delivery pairing them — must live in the SAME region:
 * - PutDeliverySource for a CloudFront distribution only works from us-east-1, regardless of the
 *   distribution's actual region.
 * - PutDeliveryDestination requires the caller's region to match the destination resource ARN's
 *   region.
 * - CloudWatch Logs delivery destinations don't support cross-region delivery at all
 *   ("Cross-region Delivery Destination is not supported").
 *
 * The only region that satisfies all three constraints is us-east-1, so the log group lives here
 * too (not in the main stack), and this whole stack must be deployed with env.region = 'us-east-1'.
 */
export class CloudfrontLogDeliveryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CloudfrontLogDeliveryStackProps) {
    super(scope, id, props);

    const denyAccessLogGroup = new logs.LogGroup(this, 'DenyAccessLogGroup', {
      logGroupName: `/aws/cloudfront/${props.project}-${props.environment}-deny-access`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    const deliverySourceName = `${props.project}-${props.environment}-cf-delivery-source`;

    const logDeliverySource = new logs.CfnDeliverySource(this, 'CloudFrontLogDeliverySource', {
      name: deliverySourceName,
      logType: 'ACCESS_LOGS',
      resourceArn: props.distributionArn,
    });

    const logDeliveryDestination = new logs.CfnDeliveryDestination(this, 'CloudFrontLogDeliveryDestination', {
      name: `${props.project}-${props.environment}-cf-delivery-destination`,
      destinationResourceArn: denyAccessLogGroup.logGroupArn,
    });

    const logDelivery = new logs.CfnDelivery(this, 'CloudFrontLogDelivery', {
      deliverySourceName: deliverySourceName,
      deliveryDestinationArn: logDeliveryDestination.attrArn,
      recordFields: ['date', 'time', 'c-ip', 'cs-method', 'cs-uri-stem', 'sc-status', 'cache-behavior-path-pattern', 'viewer-request-log-data'],
    });
    logDelivery.node.addDependency(logDeliverySource, logDeliveryDestination);
  }
}
