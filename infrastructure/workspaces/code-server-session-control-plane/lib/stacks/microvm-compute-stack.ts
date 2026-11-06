import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { claudeInvokePolicy, resolveBedrock } from 'lib/shared/claude-bedrock';
import { codeArtifactDomainName, PACKAGE_REPOSITORY, packageReadStatements } from 'lib/shared/code-artifact';
import { accessibleRepositoryNames, codeCommitPolicy } from 'lib/shared/code-commit';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

export const CODE_SERVER_PORT = 8080;

/** Fixed so this stack can grant invoke on a function that the control plane stack, which depends on it, creates. */
export const workspaceFunctionName = (namePrefix: string): string => `${namePrefix}-workspace-url`;

/**
 * The code-server MicroVM image and the roles around it. No compute runs until the control plane
 * calls RunMicrovm for a signed-in user.
 *
 * The user gets a terminal inside the MicroVM, so the execution role is effectively theirs. It holds
 * only Bedrock access and log writes, and no secret is shared between sessions.
 */
export class MicrovmComputeStack extends cdk.Stack {
  public readonly imageArn: string;
  public readonly executionRole: iam.IRole;
  public readonly logGroupName: string;
  public readonly egressConnectorArn: string;

  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-code-server-sessions`;
    const image = params.microvm;

    const extensions = image.extensions ?? [];
    const invalid = extensions.filter((extension) => !/^[\w-]+\.[\w-]+$/.test(extension));
    if (invalid.length > 0) throw new Error(`microvm.extensions must be publisher.name: ${invalid.join(', ')}`);

    const imageSource = path.join(__dirname, '..', '..', 'src', 'microvm-image');
    const imageAsset = new s3assets.Asset(this, 'MicrovmImageAsset', {
      path: imageSource,
      // The Dockerfile reads the list from the build context, so a changed list builds a new image.
      assetHashType: cdk.AssetHashType.OUTPUT,
      bundling: {
        image: cdk.DockerImage.fromRegistry('unused'),
        local: {
          tryBundle(outputDir: string): boolean {
            fs.cpSync(imageSource, outputDir, { recursive: true });
            fs.writeFileSync(path.join(outputDir, 'extensions.txt'), extensions.map((extension) => `${extension}\n`).join(''));
            return true;
          },
        },
      },
    });

    const servicePrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');

    const buildRole = new iam.Role(this, 'MicrovmImageBuildRole', {
      assumedBy: servicePrincipal,
      description: 'Assumed by Lambda MicroVMs while building the code-server image',
    });
    imageAsset.bucket.grantRead(buildRole);

    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      assumedBy: servicePrincipal,
      description: 'Assumed by running code-server MicroVMs; reachable from the user terminal',
    });

    const bedrock = resolveBedrock(params.bedrock);
    if (bedrock.enabled) executionRole.addToPolicy(claudeInvokePolicy(this, bedrock));
    const repositories = accessibleRepositoryNames(params.codeCommit);
    if (repositories.length > 0) executionRole.addToPolicy(codeCommitPolicy(this, repositories));
    // Only the token-checked function; the role itself cannot reach any saved workspace.
    executionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WorkspaceUrlOnly',
      actions: ['lambda:InvokeFunction'],
      resources: [this.formatArn({ service: 'lambda', resource: 'function', resourceName: workspaceFunctionName(namePrefix), arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
    }));
    const isPrivate = image.egress === 'private';
    if (isPrivate) packageReadStatements(this, namePrefix).forEach((statement) => executionRole.addToPolicy(statement));
    this.executionRole = executionRole;

    const imageLogGroup = new logs.LogGroup(this, 'MicrovmImageLogGroup', {
      logGroupName: `/lambda-microvms/${namePrefix}-image`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    imageLogGroup.grantWrite(buildRole);
    // Runtime logs of each MicroVM go to the same group (passed as logging at RunMicrovm).
    imageLogGroup.grantWrite(this.executionRole);
    this.logGroupName = imageLogGroup.logGroupName;

    // AWS-managed connector: outbound internet access without a VPC or NAT Gateway. Only the image build
    // uses it in private mode, where running MicroVMs are given the private connector instead.
    this.egressConnectorArn = `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

    const microvmImage = new lambda.CfnMicrovmImage(this, 'CodeServerImage', {
      name: `${namePrefix}-image`,
      description: 'code-server behind a small launcher/reverse proxy, packaged as a Lambda MicroVM image',
      baseImageArn: image.baseImageArn,
      baseImageVersion: image.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: { uri: imageAsset.s3ObjectUrl },
      cpuConfigurations: [{ architecture: image.architecture ?? 'ARM_64' }],
      egressNetworkConnectors: [this.egressConnectorArn],
      environmentVariables: [
        { key: 'SESSION_REGION', value: this.region },
        { key: 'WORKSPACE_FUNCTION_NAME', value: workspaceFunctionName(namePrefix) },
        ...(isPrivate
          ? [
              { key: 'BLOCK_FILE_TRANSFER', value: '1' },
              { key: 'PACKAGE_DOMAIN', value: codeArtifactDomainName(namePrefix) },
              { key: 'PACKAGE_REPOSITORY', value: PACKAGE_REPOSITORY },
            ]
          : []),
        ...(bedrock.enabled
          ? [
              { key: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
              { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
              { key: 'BEDROCK_SMOKE_CHECK', value: bedrock.smokeCheck ? '1' : '0' },
              { key: 'ANTHROPIC_MODEL', value: bedrock.modelId },
              { key: 'ANTHROPIC_SMALL_FAST_MODEL', value: bedrock.smallFastModelId },
            ]
          : []),
      ],
      hooks: {
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: 60,
          suspend: 'ENABLED',
          suspendTimeoutInSeconds: 60,
          resume: 'DISABLED',
          terminate: 'ENABLED',
          terminateTimeoutInSeconds: 60,
        },
        microvmImageHooks: {
          ready: 'ENABLED',
          readyTimeoutInSeconds: 60,
          validate: 'ENABLED',
          validateTimeoutInSeconds: 120,
        },
        port: CODE_SERVER_PORT,
      },
      logging: { cloudWatch: { logGroup: imageLogGroup.logGroupName } },
      resources: [{ minimumMemoryInMiB: image.minimumMemoryInMiB ?? 2048 }],
      additionalOsCapabilities: [],
    });
    this.imageArn = microvmImage.attrImageArn;

    new cdk.CfnOutput(this, 'MicrovmImageArn', { value: this.imageArn });
    new cdk.CfnOutput(this, 'LogGroupName', { value: this.logGroupName });
  }
}
