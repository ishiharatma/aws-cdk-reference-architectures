import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as pipelines from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import { AppStage } from './app-stage';
import { ENABLE_SECURITY_CHECK, SOURCE_BRANCH } from './config';
import { repositoryName, resourcePrefix } from './naming';

export interface PipelineStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: string;
  /** true for dev/test: artifact bucket and logs are destroyed with the stack. */
  readonly isAutoDeleteObject: boolean;
}

/**
 * Self-mutating CDK Pipeline.
 *
 *   Source (CodeCommit) -> Build (synth) -> UpdatePipeline (self-mutation) -> Assets
 *     -> Dev  (deploy + smoke test)
 *     -> Prod (manual approval -> deploy + smoke test)
 *
 * The pipeline definition lives in the same repository it builds from. When a commit changes this
 * file, the `UpdatePipeline` stage runs `cdk deploy` on this stack and the pipeline restarts itself
 * with the new definition -- no one runs `cdk deploy` on the pipeline again after the first time.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject } = props;
    const prefix = resourcePrefix(project, environment);
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

    // The repository is created by the workspace root stack; only its (deterministic) name is shared.
    const repository = codecommit.Repository.fromRepositoryName(this, 'Repository', repositoryName(project, environment));
    const source = pipelines.CodePipelineSource.codeCommit(repository, SOURCE_BRANCH);

    // ---------------------------------------------------------------------------------------------
    // Underlying CodePipeline: single account, so no cross-account KMS key is needed (saves $1/month
    // and a key policy to maintain). `restartExecutionOnUpdate` is what lets a self-mutation restart the run.
    // ---------------------------------------------------------------------------------------------
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy,
      autoDeleteObjects: isAutoDeleteObject,
    });
    const codePipeline = new codepipeline.Pipeline(this, 'CodePipeline', {
      pipelineName: `${prefix}-pipeline`,
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: true,
    });

    const buildLogGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      codePipeline,
      selfMutation: true,
      dockerEnabledForSynth: false,
      dockerEnabledForSelfMutation: false,
      synth: new pipelines.ShellStep('Synth', {
        input: source,
        commands: [
          'npm ci',
          'npm run build', // type-check
          'npm test', // unit tests + CDK Nag gate the pipeline before anything is deployed
          // The values are baked into the pipeline at first deploy, so self-mutation keeps them.
          `npx cdk synth -c project=${project} -c env=${environment}`,
        ],
        primaryOutputDirectory: 'cdk.out',
      }),
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: codebuild.ComputeType.SMALL,
        },
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: { install: { 'runtime-versions': { nodejs: '22' } } },
        }),
        logging: { cloudWatch: { logGroup: buildLogGroup } },
      },
    });

    // ---------------------------------------------------------------------------------------------
    // Stages
    // ---------------------------------------------------------------------------------------------
    const smokeTest = (stage: AppStage, stageName: string) =>
      new pipelines.CodeBuildStep(`SmokeTest${stageName}`, {
        // Resolved from the deployed stack's CloudFormation output at run time.
        envFromCfnOutputs: { FUNCTION_NAME: stage.functionNameOutput },
        commands: [
          'aws lambda invoke --function-name "$FUNCTION_NAME" --cli-binary-format raw-in-base64-out /tmp/response.json',
          'cat /tmp/response.json',
          `grep -q '"stage":"${stageName}"' /tmp/response.json`,
        ],
        // Least privilege: this step may invoke only that stage's function.
        rolePolicyStatements: [
          new iam.PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [`arn:${cdk.Aws.PARTITION}:lambda:${this.region}:${this.account}:function:${stage.functionName}`],
          }),
        ],
      });

    const dev = new AppStage(this, 'Dev', { project, environment, stageName: 'Dev', env: props.env });
    pipeline.addStage(dev, {
      // Flipping ENABLE_SECURITY_CHECK in lib/config.ts changes the pipeline's own structure, which
      // is what the check script uses to prove self-mutation.
      pre: ENABLE_SECURITY_CHECK
        ? [new pipelines.ShellStep('SecurityCheck', { commands: ['echo "extra pre-deployment security check"'] })]
        : [],
      post: [smokeTest(dev, 'Dev')],
    });

    const prod = new AppStage(this, 'Prod', { project, environment, stageName: 'Prod', env: props.env });
    pipeline.addStage(prod, {
      pre: [new pipelines.ManualApprovalStep('PromoteToProd', { comment: 'Dev is deployed and smoke-tested. Approve to deploy to Prod.' })],
      post: [smokeTest(prod, 'Prod')],
    });

    new cdk.CfnOutput(this, 'PipelineName', { value: codePipeline.pipelineName });
    new cdk.CfnOutput(this, 'RepositoryName', { value: repositoryName(project, environment) });
  }
}
