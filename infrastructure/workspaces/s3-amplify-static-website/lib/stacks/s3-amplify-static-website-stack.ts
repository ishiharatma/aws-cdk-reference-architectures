import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

export interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly branchName?: string;
}

export class S3AmplifyStaticWebsiteStack extends cdk.Stack {
  public readonly amplifyApp: amplify.CfnApp;
  public readonly amplifyBranch: amplify.CfnBranch;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const branchName = props.branchName ?? 'main';

    // CDK creates a content-addressed zip of the directory and uploads it to the CDK bootstrap
    // bucket. The zip key is a SHA-256 hash of the contents, so any change to the source files
    // produces a new key and triggers onUpdate below — keeping Amplify in sync automatically.
    const websiteAsset = new s3_assets.Asset(this, 'WebsiteAsset', {
      path: path.join(__dirname, '../../../../../frontend/static-web'),
    });

    // Amplify Hosting App — platform WEB = managed CDN, no server-side compute.
    // No repository/accessToken: manual deployment mode (zip from S3). No
    // iamServiceRole either: the deploy custom resource below fetches the zip via a
    // presigned URL rather than having Amplify assume a role to read it, so there's
    // no AWS service this app needs to access on its own behalf.
    this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: `${props.project}-${props.environment}-website`,
      platform: 'WEB',
    });

    // Branch — auto-build disabled because deployment is driven by the custom resource below.
    this.amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
      appId: this.amplifyApp.attrAppId,
      branchName,
      enableAutoBuild: false,
      enablePullRequestPreview: false,
    });

    // Custom resource: calls amplify:StartDeployment with a presigned URL to the zip.
    //
    // Amplify's StartDeployment API, when given an s3:// sourceUrl directly, requires
    // a bucket policy granting amplify.amazonaws.com read access to the object (see
    // AWS's "Creating a bucket policy to deploy a static website from S3" guide). The
    // zip here lives in the shared CDK bootstrap bucket, which this stack doesn't own
    // and can't attach a resource policy to — `websiteAsset.bucket` is an imported
    // `IBucket` (`Bucket.fromBucketAttributes`), so `addToResourcePolicy` on it is a
    // silent no-op. A presigned HTTPS URL sidesteps this: Amplify just performs a
    // plain HTTP GET, so only this Lambda's own IAM role needs s3:GetObject on the
    // asset (an ordinary identity-based grant, no bucket policy required).
    //
    // Runs on both create and update so any source change triggers a fresh deployment
    // automatically (the asset key is content-addressed, so the object changes only
    // when the website files actually change).
    const deployHandler = new lambdaNodejs.NodejsFunction(this, 'AmplifyDeployHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      entry: path.join(__dirname, '../../src/lambda/amplify-deploy/index.ts'),
      timeout: cdk.Duration.seconds(60),
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });
    websiteAsset.grantRead(deployHandler);
    deployHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['amplify:StartDeployment'],
        resources: ['*'],
      }),
    );

    const deployProvider = new cr.Provider(this, 'AmplifyDeployProvider', {
      onEventHandler: deployHandler,
    });

    const amplifyDeployment = new cdk.CustomResource(this, 'AmplifyDeployment', {
      serviceToken: deployProvider.serviceToken,
      properties: {
        AppId: this.amplifyApp.attrAppId,
        BranchName: branchName,
        BucketName: websiteAsset.s3BucketName,
        ObjectKey: websiteAsset.s3ObjectKey,
      },
    });
    amplifyDeployment.node.addDependency(this.amplifyBranch);

    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value: this.amplifyApp.attrAppId,
      description: 'Amplify App ID',
    });
    new cdk.CfnOutput(this, 'AmplifyAppUrl', {
      value: `https://${branchName}.${this.amplifyApp.attrDefaultDomain}`,
      description: 'Website URL served by Amplify Hosting',
    });
    new cdk.CfnOutput(this, 'AmplifyConsoleUrl', {
      value: `https://${cdk.Stack.of(this).region}.console.aws.amazon.com/amplify/apps/${this.amplifyApp.attrAppId}`,
      description: 'AWS Console URL for the Amplify app',
    });
  }
}
