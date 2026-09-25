import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { SOURCE_BRANCH } from '../../app/lib/config';
import { repositoryName } from '../../app/lib/naming';

export interface RepositoryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

/**
 * The CodeCommit repository the pipeline builds from, seeded with `app/` as its initial commit.
 *
 * Why a separate stack: CDK Pipelines needs its source to exist before the pipeline does, and the
 * pipeline definition itself lives in that source. This stack is deployed once; after that the
 * repository is owned by developers (`git push`) and the pipeline is owned by the pipeline.
 *
 * `Code` is an initial-commit-only property: changing `app/` later and redeploying this stack does
 * NOT push new commits to an existing repository.
 */
export class RepositoryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RepositoryStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;

    const initialCode = new s3assets.Asset(this, 'InitialCode', {
      path: path.join(__dirname, '../../app'),
      // Git-style patterns match at any depth; dependencies and build output never belong in the repository.
      ignoreMode: cdk.IgnoreMode.GIT,
      exclude: ['node_modules', 'cdk.out', 'coverage'],
    });

    const repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: repositoryName(project, environment),
      description: `CDK Pipelines source for ${project}/${environment}: the pipeline definition and the app it deploys`,
      code: codecommit.Code.fromAsset(initialCode, SOURCE_BRANCH),
    });
    repository.applyRemovalPolicy(isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN);

    new cdk.CfnOutput(this, 'RepositoryName', { value: repository.repositoryName, description: 'CodeCommit repository name' });
    new cdk.CfnOutput(this, 'CloneUrlGrc', { value: repository.repositoryCloneUrlGrc, description: 'git clone URL (git-remote-codecommit)' });
    new cdk.CfnOutput(this, 'PipelineStackName', {
      value: `${project}-${environment}-cdkp-pipeline`,
      description: 'Stack that `cdk deploy` in app/ creates (deployed once by hand; afterwards it updates itself)',
    });
  }
}
