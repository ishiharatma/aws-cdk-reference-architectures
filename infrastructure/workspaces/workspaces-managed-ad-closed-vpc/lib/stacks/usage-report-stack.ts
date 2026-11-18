import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { UsageReport } from 'lib/constructs/usage-report';
import { UsageReportParams } from 'lib/types';

/** Properties of {@link UsageReportStack}. */
export interface UsageReportStackProps extends cdk.StackProps {
  readonly namePrefix: string;
  readonly usageReport: UsageReportParams;
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly autoDeleteObjects: boolean;
}

/**
 * Monthly WorkSpaces usage report. Independent of the other stacks: it reads every WorkSpace
 * in the Region, so it keeps working if directories are added later.
 */
export class UsageReportStack extends cdk.Stack {
  public readonly report: UsageReport;

  /**

   * Define the resources.

   *
   * @param scope - Parent construct
   * @param id - Construct ID
   * @param props - Construct properties
   */
  constructor(scope: Construct, id: string, props: UsageReportStackProps) {
    super(scope, id, props);

    this.report = new UsageReport(this, 'UsageReport', {
      namePrefix: props.namePrefix,
      params: props.usageReport,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
    });

    new cdk.CfnOutput(this, 'ReportBucketName', { value: this.report.bucket.bucketName });
    new cdk.CfnOutput(this, 'ReportFunctionName', { value: this.report.function.functionName });
  }
}
