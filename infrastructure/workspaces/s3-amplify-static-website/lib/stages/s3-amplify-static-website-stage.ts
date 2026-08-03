import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pascalCase } from 'change-case-commonjs';
import { Environment } from '@common/parameters/environments';
import { S3AmplifyStaticWebsiteStack } from 'lib/stacks/s3-amplify-static-website-stack';

export interface StageProps extends cdk.StageProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly terminationProtection: boolean;
  readonly branchName?: string;
}

export class S3AmplifyStaticWebsiteStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: StageProps) {
    super(scope, id, props);

    new S3AmplifyStaticWebsiteStack(
      this,
      `${pascalCase(props.project)}S3AmplifyStaticWebsite`,
      {
        description: 'S3 + Amplify Static Website Hosting Stack',
        project: props.project,
        environment: props.environment,
        env: props.env,
        terminationProtection: props.terminationProtection,
        isAutoDeleteObject: props.isAutoDeleteObject,
        branchName: props.branchName,
      },
    );
  }
}
