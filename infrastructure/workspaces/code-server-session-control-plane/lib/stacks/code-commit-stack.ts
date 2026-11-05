import * as cdk from 'aws-cdk-lib';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import { Construct } from 'constructs';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly repositoryNames: string[];
  readonly isAutoDeleteObject: boolean;
}

/**
 * Repositories owned by this application. Deleting the stack deletes them and their contents when
 * isAutoDeleteObject is set, so use `codeCommit.repositoryNames` for anything that must outlive it.
 */
export class CodeCommitStack extends cdk.Stack {
  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    props.repositoryNames.forEach((repositoryName, index) => {
      const repository = new codecommit.Repository(this, `Repository${index}`, {
        repositoryName,
        description: 'Reachable from code-server sessions',
      });
      repository.applyRemovalPolicy(props.isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN);
      new cdk.CfnOutput(this, `CloneUrl${index}`, { value: repository.repositoryCloneUrlHttp });
    });
  }
}
