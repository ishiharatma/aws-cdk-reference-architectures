import * as cdk from 'aws-cdk-lib';
import { StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments'
import { EnvParams } from 'parameters/environments';
import { createAccountRegionalBucket } from '@common/constructs/s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3Deployment from 'aws-cdk-lib/aws-s3-deployment';

interface CloudfrontS3StaticWebsiteStackProps extends StackProps {
    readonly project: string;
    readonly environment: Environment;
    readonly isAutoDeleteObject: boolean;
    readonly envParams: EnvParams;
    /**
     * ARN of the WAFv2 Web ACL (scope CLOUDFRONT) to associate with the distribution, created by
     * `CloudfrontWafStack` in us-east-1 — see that stack for why it can't live here. Omit to
     * deploy the distribution without a Web ACL.
     */
    readonly webAclArn?: string;
    /**
     * Path to the local directory containing the static website content to upload to the S3 bucket. If omitted, no content will be uploaded and the bucket will be empty.
     */
    readonly contentsPath?: string;
    /**
     * Two-letter, uppercase ISO 3166-1-alpha-2 country codes to allow via the CloudFront
     * distribution's geo restriction (allowlist). Omit or pass an empty array to allow all
     * countries (no geo restriction).
     * @example ['JP']
     */
    readonly geoRestrictionCountries?: string[];
}
export class CloudfrontS3StaticWebsiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CloudfrontS3StaticWebsiteStackProps) {
    super(scope, id, props);

    // Create Access Logging bucket for CloudFront distribution logs. The "aws-logs-" prefix is mandatory: AWS refuses to create the logging configuration below against a bucket whose name doesn't start with it.
    const accessLogBucket = createAccountRegionalBucket(
      {
        scope: this,
        id: 'AccessLogBucket',
        project: props.project,
        environment: props.environment,
        purpose: 'access-logs',
        removalPolicy: props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
        autoDeleteObjects: props.isAutoDeleteObject,
        accessControl: cdk.aws_s3.BucketAccessControl.LOG_DELIVERY_WRITE,
        objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      }
    );
    // Bucket for the static website content, with a bucket policy to allow CloudFront to read it.
    const websiteBucket = createAccountRegionalBucket(
      {
        scope: this,
        id: 'WebsiteBucket',
        project: props.project,
        environment: props.environment,
        autoDeleteObjects: props.isAutoDeleteObject,
        purpose: 'static-website-content',
        serverAccessLogsBucket: accessLogBucket,
        serverAccessLogsPrefix: 'website-bucket-logs/',
      }
    );
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
      responseHeadersPolicyName: `${props.project}-${props.environment}-ResponseHeadersPolicy`,
      comment: `Response headers policy for ${props.project} ${props.environment} static website`,
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: ['*'],
        originOverride: true,
      },
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self';",
          override: true,
        },
        contentTypeOptions: {
          override: true,
        },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'server',
            value: '', // Hide server information for security reasons
            override: true,
          },
        ],
      },
    });
    // CloudFront distribution for the static website, with the S3 bucket as the origin and optional WAFv2 Web ACL.
    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      comment: `${props.project} CloudFront Distribution for ${props.environment} static website`,
      // see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PriceClass.html
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
      webAclId: props.webAclArn,
      defaultRootObject: 'index.html',
      enableLogging: true,
      logBucket: accessLogBucket,
      logFilePrefix: 'cloudfront-logs/',
      geoRestriction: props.geoRestrictionCountries?.length
        ? cloudfront.GeoRestriction.allowlist(...props.geoRestrictionCountries)
        : undefined,
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        responseHeadersPolicy,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        // 5xx are real origin/edge failures (not SPA routing), so keep the original status code
        // and just replace the body with a friendly page instead of leaking origin error details.
        ...[500, 502, 503, 504].map((httpStatus) => ({
          httpStatus,
          responseHttpStatus: httpStatus,
          responsePagePath: '/error.html',
          ttl: cdk.Duration.minutes(1),
        })),
      ],
    });

    if (props.contentsPath) {
      new s3Deployment.BucketDeployment(this, 'DeployWebsiteContents', {
        sources: [s3Deployment.Source.asset(props.contentsPath)],
        destinationBucket: websiteBucket,
        distribution: distribution,
        distributionPaths: ['/*'],
      });
    } else {
      console.warn(`No contentsPath specified for ${props.project} ${props.environment} static website stack; the S3 bucket will be empty.`);
    }

    // Output the S3 bucket name and CloudFront distribution domain name.
    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: websiteBucket.bucketName,
      description: 'The name of the S3 bucket for the static website content.',
    });
    new cdk.CfnOutput(this, 'WebsiteDistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'The domain name of the CloudFront distribution for the static website.',
    });
    // CloudFront URL (https://<distributionDomainName>/)
    new cdk.CfnOutput(this, 'WebsiteDistributionUrl', {
      value: `https://${distribution.distributionDomainName}/`,
      description: 'The URL of the CloudFront distribution for the static website.',
    });
  }
}
