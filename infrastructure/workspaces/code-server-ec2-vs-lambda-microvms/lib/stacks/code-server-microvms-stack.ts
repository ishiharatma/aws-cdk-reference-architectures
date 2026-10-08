import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';
import { EnvParams } from 'parameters/environments';
import { claudeInvokePolicy, resolveBedrock } from 'lib/shared/claude-bedrock';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly params: EnvParams;
}

const HOOK_AND_PROXY_PORT = 8080;

/**
 * code-server on AWS Lambda MicroVMs.
 *
 * There is no always-on compute: the stack only builds the MicroVM image (code-server + a small
 * launcher) and the roles around it. A MicroVM is launched on demand with scripts/microvm-session.sh,
 * which reaches it through the platform's token-authenticated HTTPS endpoint. Compute is billed
 * only while RUNNING; an idle MicroVM is suspended automatically and resumes on the next request.
 */
export class CodeServerMicrovmsStack extends cdk.Stack {
  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, isAutoDeleteObject, params } = props;
    const removalPolicy = isAutoDeleteObject ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
    const namePrefix = `${project}-${environment}-code-server`;
    const image = params.microvm;

    const password = new secretsmanager.Secret(this, 'CodeServerPassword', {
      secretName: `${namePrefix}-microvms-password`,
      description: 'code-server login password (MicroVMs variant)',
      generateSecretString: { passwordLength: 24, excludePunctuation: true },
      removalPolicy,
    });

    const imageAsset = new s3assets.Asset(this, 'MicrovmImageAsset', {
      path: path.join(__dirname, '..', '..', 'src', 'microvm-image'),
    });

    const servicePrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');

    const buildRole = new iam.Role(this, 'MicrovmImageBuildRole', {
      assumedBy: servicePrincipal,
      description: 'Assumed by Lambda MicroVMs while building the code-server image',
    });
    imageAsset.bucket.grantRead(buildRole);

    // The password is read by the /run hook inside a running MicroVM, i.e. with this role.
    const executionRole = new iam.Role(this, 'MicrovmExecutionRole', {
      assumedBy: servicePrincipal,
      description: 'Assumed by running code-server MicroVMs to read the login password',
    });
    password.grantRead(executionRole);

    const bedrock = resolveBedrock(params.bedrock);
    if (bedrock.enabled) executionRole.addToPolicy(claudeInvokePolicy(this, bedrock));

    const imageLogGroup = new logs.LogGroup(this, 'MicrovmImageLogGroup', {
      logGroupName: `/lambda-microvms/${namePrefix}-image`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy,
    });
    imageLogGroup.grantWrite(buildRole);
    // Runtime logs of each MicroVM go to the same group (passed as --logging at run-microvm).
    imageLogGroup.grantWrite(executionRole);

    // AWS-managed connector: outbound internet access without a VPC or NAT Gateway.
    const internetEgressArn = `arn:${this.partition}:lambda:${this.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`;

    const microvmImage = new lambda.CfnMicrovmImage(this, 'CodeServerImage', {
      name: `${namePrefix}-image`,
      description: 'code-server behind a small launcher/reverse proxy, packaged as a Lambda MicroVM image',
      baseImageArn: image.baseImageArn,
      baseImageVersion: image.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      codeArtifact: { uri: imageAsset.s3ObjectUrl },
      cpuConfigurations: [{ architecture: image.architecture ?? 'ARM_64' }],
      egressNetworkConnectors: [internetEgressArn],
      environmentVariables: [
        { key: 'PASSWORD_SECRET_ARN', value: password.secretArn },
        ...(bedrock.enabled
          ? [
              { key: 'CLAUDE_CODE_USE_BEDROCK', value: '1' },
              { key: 'ANTHROPIC_MODEL', value: bedrock.modelId },
              { key: 'ANTHROPIC_SMALL_FAST_MODEL', value: bedrock.smallFastModelId },
            ]
          : []),
      ],
      hooks: {
        microvmHooks: {
          run: 'ENABLED',
          runTimeoutInSeconds: 60,
          suspend: 'DISABLED',
          resume: 'DISABLED',
          terminate: 'ENABLED',
          terminateTimeoutInSeconds: 15,
        },
        microvmImageHooks: {
          ready: 'ENABLED',
          readyTimeoutInSeconds: 60,
          validate: 'ENABLED',
          validateTimeoutInSeconds: 60,
        },
        port: HOOK_AND_PROXY_PORT,
      },
      logging: { cloudWatch: { logGroup: imageLogGroup.logGroupName } },
      resources: [{ minimumMemoryInMiB: image.minimumMemoryInMiB ?? 2048 }],
      additionalOsCapabilities: [],
    });

    new cdk.CfnOutput(this, 'MicrovmImageArn', { value: microvmImage.attrImageArn });
    new cdk.CfnOutput(this, 'MicrovmExecutionRoleArn', { value: executionRole.roleArn });
    new cdk.CfnOutput(this, 'LogGroupName', { value: imageLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'PasswordSecretName', { value: password.secretName });
    new cdk.CfnOutput(this, 'InternetEgressConnectorArn', { value: internetEgressArn });
  }
}
