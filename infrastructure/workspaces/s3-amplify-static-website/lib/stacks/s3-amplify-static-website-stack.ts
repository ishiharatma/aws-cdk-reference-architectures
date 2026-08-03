import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // Amplify uses this role to fetch the zip from S3 when StartDeployment runs.
    const amplifyServiceRole = new iam.Role(this, 'AmplifyServiceRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
    });
    websiteAsset.grantRead(amplifyServiceRole);

    // Amplify Hosting App — platform WEB = managed CDN, no server-side compute.
    // No repository/accessToken: manual deployment mode (zip from S3).
    this.amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: `${props.project}-${props.environment}-website`,
      platform: 'WEB',
      iamServiceRole: amplifyServiceRole.roleArn,
    });

    // Branch — auto-build disabled because deployment is driven by the custom resource below.
    this.amplifyBranch = new amplify.CfnBranch(this, 'AmplifyBranch', {
      appId: this.amplifyApp.attrAppId,
      branchName,
      enableAutoBuild: false,
      enablePullRequestPreview: false,
    });

    // Custom resource: calls amplify:StartDeployment with the S3 zip URL.
    // Amplify downloads the zip using the iamServiceRole granted above, extracts it, and serves the
    // files via its managed CDN. Runs on both create and update so any source change triggers a
    // fresh deployment automatically (the asset key is content-addressed, so the sourceUrl changes
    // only when the website files actually change).
    const deployAction = {
      service: 'Amplify',
      action: 'startDeployment',
      parameters: {
        appId: this.amplifyApp.attrAppId,
        branchName,
        sourceUrl: `s3://${websiteAsset.s3BucketName}/${websiteAsset.s3ObjectKey}`,
        sourceUrlType: 'ZIP',
      },
      physicalResourceId: cr.PhysicalResourceId.of(
        `${props.project}-${props.environment}-amplify-deploy`,
      ),
    };

    const amplifyDeployment = new cr.AwsCustomResource(this, 'AmplifyDeployment', {
      onCreate: deployAction,
      onUpdate: deployAction,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['amplify:StartDeployment'],
          resources: ['*'],
        }),
      ]),
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
