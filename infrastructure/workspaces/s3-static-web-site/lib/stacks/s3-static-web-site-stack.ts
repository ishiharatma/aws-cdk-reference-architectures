import * as cdk from 'aws-cdk-lib';
import { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments'
import { EnvParams } from 'parameters/environments';
import { createAccountRegionalBucket, createAccountRegionalBucketWebSite } from '@common/constructs/s3';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';

interface S3StaticWebSiteStackProps extends StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly envParams: EnvParams;
    /**
     * Path to the local directory containing the static website content to upload to the S3 bucket. If omitted, no content will be uploaded and the bucket will be empty.
     */
    readonly contentsPath?: string;

    /**
     * List of Ipv4 addresses to allow bucket access from. If omitted, no Ipv4 allowlist will be applied.
     * @example ['192.168.0.1']
     */
    readonly allowedIps?: string[];
    /**
     * List of Ipv6 addresses to allow bucket access from. If omitted, no Ipv6 allowlist will be applied.
     * @example ['2001:db8::1']
     */
    readonly allowedIpv6s?: string[];
}

export class S3StaticWebSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: S3StaticWebSiteStackProps) {
    super(scope, id, props);

    // Create Access Logging bucket for CloudFront distribution logs. CloudFront's log delivery
    // service (awslogsdelivery) requires ACLs to be enabled on the bucket, hence the
    // LOG_DELIVERY_WRITE access control and BUCKET_OWNER_PREFERRED ownership below.
    const accessLogBucket = createAccountRegionalBucket(
      {
        scope: this,
        id: 'AccessLogBucket',
        project: props.project,
        environment: props.environment,
        purpose: `access-logs-${id}`,
        removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        autoDeleteObjects: props.isAutoDeleteObject,
        accessControl: cdk.aws_s3.BucketAccessControl.LOG_DELIVERY_WRITE,
        objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      }
    );
    // Bucket for the static website content, with a bucket policy to allow CloudFront to read it.
    const websiteBucket = createAccountRegionalBucketWebSite(
      {
        scope: this,
        id: 'WebsiteBucket',
        project: props.project,
        environment: props.environment,
        autoDeleteObjects: props.isAutoDeleteObject,
        purpose: `website-${id}`,
        serverAccessLogsBucket: accessLogBucket,
        serverAccessLogsPrefix: 'website-bucket-logs/',
      }
    );

    if (props.allowedIps) {
      // Add a bucket policy to allow access from the specified IPv4 addresses
      websiteBucket.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [websiteBucket.arnForObjects('*')],
        conditions: {
          IpAddress: {
            'aws:SourceIp': props.allowedIps.map(ip => `${ip}/32`),
          },
        },
      }));
    }
    if (props.allowedIpv6s) {
      // Add a bucket policy to allow access from the specified IPv6 addresses
      websiteBucket.addToResourcePolicy(new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [websiteBucket.arnForObjects('*')],
        conditions: {
          IpAddress: {
            'aws:SourceIp': props.allowedIpv6s.map(ip => `${ip}/128`),
          },
        },
      }));
    }

    // Deploy the static website content to the S3 bucket if a contentsPath is provided
    if (props.contentsPath) {
      new s3Deployment.BucketDeployment(this, 'DeployWebsiteContents', {
        sources: [s3Deployment.Source.asset(props.contentsPath)],
        destinationBucket: websiteBucket,
      });
    } else {
      console.warn(`No contentsPath specified for ${props.project} ${props.environment} static website stack; the S3 bucket will be empty.`);
    }

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: websiteBucket.bucketName,
      description: 'The name of the S3 bucket hosting the static website content',
    });
    new cdk.CfnOutput(this, 'WebsiteBucketUrl', {
      value: websiteBucket.bucketWebsiteUrl,
      description: 'The URL of the S3 bucket hosting the static website content',
    });

  }
}
