import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { pascalCase } from "change-case-commonjs";
import { Environment } from "@common/parameters/environments";
import { EnvParams } from "parameters/environments";

import { CloudfrontVpcOriginStack } from 'lib/stacks/cloudfront-vpc-origin-stack';
import { CloudfrontLogDeliveryStack } from 'lib/stacks/cloudfront-log-delivery-stack';
import { CloudfrontMonitoringStack } from 'lib/stacks/cloudfront-monitoring-stack';

export interface StageProps extends cdk.StageProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly terminationProtection: boolean;
    readonly params: EnvParams;
    readonly allowedIps: string[];
}

export class CloudfrontVpcOriginStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    const mainStack = new CloudfrontVpcOriginStack(this, pascalCase(`${props.project}Main`), {
      project: props.project,
      description: `${pascalCase(props.project)} Cloudfront VPC Origin Stack for ${props.environment}`,
      environment: props.environment,
      vpcConfig: props.params.vpcConfig,
      cloudfrontManagedPrefixList: props.params.cloudfrontManagedPrefixList,
      publicAlbFailover: props.params.publicAlbFailover,
      useWAF: true, // WAF is not used in this stack; if needed, it can be added later
      allowedIpsAfterRules: props.allowedIps,
      //allowedIpsBeforeRules: props.allowedIps,
      env: props.env,
      terminationProtection: props.terminationProtection, // Enabling deletion protection
      isAutoDeleteObject: props.isAutoDeleteObject,
      crossRegionReferences: true,
    });

    // CloudFront standard logging (v2) delivery (log group + source + destination + pairing) must
    // all live in us-east-1: PutDeliverySource for CloudFront only works there, and CloudWatch Logs
    // delivery destinations don't support cross-region delivery at all. So this is a single stack,
    // separate from the main stack purely because of that region requirement.
    if (mainStack.hasDenyAccessFunction) {
      const logDeliveryStack = new CloudfrontLogDeliveryStack(this, pascalCase(`${props.project}LogDelivery`), {
        project: props.project,
        description: `${pascalCase(props.project)} CloudFront Log Delivery Stack for ${props.environment}`,
        environment: props.environment,
        distributionArn: mainStack.distribution.distributionArn,
        env: { account: props.params.accountId, region: 'us-east-1' },
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject: props.isAutoDeleteObject,
        crossRegionReferences: true,
      });
      logDeliveryStack.addDependency(mainStack);
    }

    // CloudFront's request/error metrics (namespace AWS/CloudFront) are only published to us-east-1
    // regardless of the distribution's own region, and a CloudWatch Alarm can only evaluate a metric
    // in its own region — so this, too, is a separate stack forced into us-east-1. Always created
    // (unlike the log delivery stack above) so the 5xx error rate alarm exists regardless of whether
    // the viewer IP allow-list feature is in use.
    const monitoringStack = new CloudfrontMonitoringStack(this, pascalCase(`${props.project}Monitoring`), {
      project: props.project,
      description: `${pascalCase(props.project)} CloudFront Monitoring Stack for ${props.environment}`,
      environment: props.environment,
      distributionId: mainStack.distribution.distributionId,
      alarmEmail: props.params.alarmEmail,
      env: { account: props.params.accountId, region: 'us-east-1' },
      terminationProtection: props.terminationProtection,
      crossRegionReferences: true,
    });
    monitoringStack.addDependency(mainStack);

  }
}
