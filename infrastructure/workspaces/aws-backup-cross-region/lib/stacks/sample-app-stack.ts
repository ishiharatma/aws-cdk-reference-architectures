import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { createAccountRegionalBucket } from '@common/constructs/s3';
import { EnvParams } from 'parameters/environments';

/** Props for {@link SampleAppStack}. */
export interface SampleAppStackProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly params: EnvParams;
    readonly isAutoDeleteObject: boolean;
}

/**
 * Stands in for an unrelated team's application stack.
 *
 * AWS Backup can protect an entire CloudFormation stack as a single
 * `AWS::CloudFormation::Stack` recovery point (recreatable from its template + parameters),
 * independent of backing up the individual resources inside it. Tagging this stack with the
 * same key/value as the VPC/EC2/RDS/S3 workload in `AwsBackupCrrTokyoStack` lets the
 * tag-based Backup Selection there pick it up too — one Backup Plan spanning two otherwise
 * unrelated stacks, with no per-stack selection required.
 */
export class SampleAppStack extends cdk.Stack {
    public readonly bucket: s3.Bucket;

    constructor(scope: Construct, id: string, props: SampleAppStackProps) {
        super(scope, id, props);

        const { backupTagKey = 'Backup', backupTagValue = 'true' } = props.params.awsBackupCrr;

        this.bucket = createAccountRegionalBucket({
            scope: this,
            id: 'SampleAppBucket',
            project: props.project,
            environment: props.environment,
            purpose: 'sample-app',
            autoDeleteObjects: props.isAutoDeleteObject,
        });

        new ssm.StringParameter(this, 'SampleAppConfig', {
            parameterName: `/${props.project}/${props.environment}/sample-app/config`,
            stringValue: 'sample-value',
            description: 'Placeholder configuration value for the sample application stack',
        });

        // Applying tags at the Stack level (rather than per-resource) also tags the
        // CloudFormation stack resource itself, which is what makes it discoverable by the
        // tag-based Backup Selection as an AWS::CloudFormation::Stack recovery point.
        cdk.Tags.of(this).add(backupTagKey, backupTagValue);
    }
}
