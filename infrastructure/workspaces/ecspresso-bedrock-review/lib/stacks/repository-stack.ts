import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as s3_assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { SharedParams, EnvParams } from 'lib/types';

/** RepositoryStack properties. */
export interface RepositoryStackProps extends cdk.StackProps {
  readonly project: string;
  readonly sharedParams: SharedParams;
  readonly envParams: EnvParams;
}

/**
 * Repository Stack
 *
 * Creates a CodeCommit repository and seeds the envParams.branchName
 * branch (default: develop) with the contents of
 * backend/ecspresso-bedrock-review-app. This is a single-account sample,
 * so it carries no cross-account read wiring.
 */
export class RepositoryStack extends cdk.Stack {
  public readonly repository: codecommit.IRepository;

  constructor(scope: Construct, id: string, props: RepositoryStackProps) {
    super(scope, id, props);

    const seedAsset = new s3_assets.Asset(this, 'SeedAsset', {
      path: path.join(__dirname, '../../../../../backend/ecspresso-bedrock-review-app'),
      exclude: ['node_modules', 'coverage', '.git', '*.log', 'cdk.out'],
    });

    const repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: props.sharedParams.repositoryName,
      description: `${props.project} sample app for the ECS Fargate + ecspresso + Bedrock agentic review CI/CD demo`,
      code: codecommit.Code.fromAsset(seedAsset, props.envParams.branchName),
    });
    this.repository = repository;
  }
}
