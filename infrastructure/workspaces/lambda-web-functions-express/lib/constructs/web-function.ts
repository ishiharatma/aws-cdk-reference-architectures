import * as path from 'path';
import { execFileSync } from 'child_process';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/** Endpoint authentication type. `ApplicationManaged` is public; `IamAuth` requires SigV4. */
export type WebFunctionAuthType = 'ApplicationManaged' | 'IamAuth';

/** Properties for {@link WebFunction}. */
export interface WebFunctionProps {
  /** Web Function name. Must be unique across ALL Regions of the account (max 64 chars). */
  readonly functionName: string;
  /** Directory containing the application source; `entry` is resolved relative to it. */
  readonly sourceDir: string;
  /** Entry file (TypeScript) bundled by esbuild into `index.js` at the zip root. */
  readonly entry: string;
  /** Endpoint name (letters, digits, `-`, `_`). */
  readonly endpointName: string;
  readonly authType: WebFunctionAuthType;
  readonly timeoutSeconds: number;
  readonly maxConcurrencyPerEnvironment: number;
  readonly maxEnvironments?: number;
  readonly rateLimit?: number;
  readonly environmentVariables?: Record<string, string>;
  /**
   * Version-qualified ARN of an `AWS::Lambda::NetworkConnector` (VPC egress). Only valid with a
   * `HomeRegion` endpoint.
   */
  readonly egressNetworkConnectorArn?: string;
  readonly logRetention: logs.RetentionDays;
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly autoDeleteObjects: boolean;
}

/** Node.js runtime supported by Lambda Web Functions at GA (arm64 only). */
export const WEB_FUNCTION_RUNTIME = 'nodejs24.x';

const CODE_KEY_PREFIX = 'code/';

/**
 * AWS Lambda Web Function (function + immutable revision + HTTPS endpoint).
 *
 * aws-cdk-lib has no L2 for Web Functions; this wraps the generated L1s
 * (`CfnWebFunction*`, available from aws-cdk-lib 2.273.0).
 *
 * Gotchas encoded here:
 * - Revision and endpoint reference the function by its *bare name*, which creates
 *   no CloudFormation dependency, so `addDependency` is mandatory.
 * - Code is pulled from a versioned S3 bucket that grants `lambda.amazonaws.com`
 *   read access; the key changes with every code change (asset hash), so a new
 *   revision is created only when the code or revision config changes.
 */
export class WebFunction extends Construct {
  public readonly functionName: string;
  public readonly functionArn: string;
  public readonly endpointArn: string;
  public readonly domainName: string;
  public readonly revisionId: string;
  public readonly role: iam.IRole;
  public readonly codeBucket: s3.IBucket;
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: WebFunctionProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    this.functionName = props.functionName;
    const functionArnPattern = `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:web-function/${props.functionName}`;

    // ---- Code bucket ------------------------------------------------------
    const codeBucket = new s3.Bucket(this, 'CodeBucket', {
      versioned: true, // required by AWS::Lambda::WebFunctionRevision
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
    });
    // The Web Functions service reads the zip with its own principal. The source ARN is the
    // revision (under the function), so the condition must end with `/*`.
    this.codeBucket = codeBucket;
    const codeReadPolicy = codeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowLambdaWebFunctionsRead',
        principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [this.codeBucket.arnForObjects('*')],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `${functionArnPattern}/*` },
        },
      }),
    );

    const codeDeployment = new s3deploy.BucketDeployment(this, 'CodeDeployment', {
      destinationBucket: this.codeBucket,
      destinationKeyPrefix: CODE_KEY_PREFIX,
      extract: false, // keep the zip as-is; its key is the asset hash
      prune: false, // older revisions may still reference older zips
      sources: [
        s3deploy.Source.asset(props.sourceDir, {
          bundling: {
            image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24-alpine'),
            command: ['sh', '-c', 'echo "Docker bundling is not supported; install esbuild locally" && exit 1'],
            local: {
              tryBundle(outputDir: string): boolean {
                execFileSync(
                  'npx',
                  [
                    'esbuild',
                    path.join(props.sourceDir, props.entry),
                    '--bundle',
                    '--platform=node',
                    '--target=node24',
                    '--format=cjs',
                    `--outfile=${path.join(outputDir, 'index.js')}`,
                    '--log-level=warning',
                  ],
                  { stdio: 'inherit' },
                );
                return true;
              },
            },
          },
        }),
      ],
    });
    // `objectKeys` are relative to `destinationKeyPrefix`; the prefix must be added back,
    // otherwise CreateWebFunctionRevision fails with "The specified S3 object does not exist".
    const codeKey = cdk.Fn.join('', [CODE_KEY_PREFIX, cdk.Fn.select(0, codeDeployment.objectKeys)]);
    const codeVersionId = cdk.Fn.select(0, codeDeployment.objectVersionIds);

    // ---- Logs ---------------------------------------------------------------
    // Default log group for Web Functions is /aws/lambda/web/{name} (not /aws/lambda/{name}).
    // Pre-create it so retention and removal are managed by this stack.
    const logGroupName = `/aws/lambda/web/${props.functionName}`;
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });
    this.logGroup = logGroup;
    // The service also writes each Region's own copy to `<group>.local` and creates it on
    // first use without a retention policy, which then outlives the stack. Own it here.
    const localLogGroup = new logs.LogGroup(this, 'LocalLogGroup', {
      logGroupName: `${logGroupName}.local`,
      retention: props.logRetention,
      removalPolicy: props.removalPolicy,
    });

    // ---- Execution role -----------------------------------------------------
    const role = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Execution role for Lambda Web Function ${props.functionName}`,
    });
    this.role = role;
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        // Covers the log group and the `.local` companion group the service writes per Region.
        resources: [
          `arn:${stack.partition}:logs:*:${stack.account}:log-group:${logGroupName}:*`,
          `arn:${stack.partition}:logs:*:${stack.account}:log-group:${logGroupName}.local:*`,
        ],
      }),
    );

    // ---- Web Function / Revision / Endpoint --------------------------------
    const webFunction = new lambda.CfnWebFunction(this, 'Function', {
      functionName: props.functionName,
    });

    const environmentVariables =
      props.environmentVariables && Object.keys(props.environmentVariables).length > 0
        ? props.environmentVariables
        : undefined;

    const revision = new lambda.CfnWebFunctionRevision(this, 'Revision', {
      functionName: props.functionName, // bare name, never the ARN
      description: `Code ${codeKey}`,
      buildConfig: {
        codeConfig: { s3Object: { bucket: this.codeBucket.bucketName, key: codeKey, versionId: codeVersionId } },
        runtimeConfig: { runtime: WEB_FUNCTION_RUNTIME },
      },
      serviceConfig: {
        executionRoleArn: this.role.roleArn,
        timeoutSeconds: props.timeoutSeconds,
        maxConcurrencyPerEnvironment: props.maxConcurrencyPerEnvironment,
        environmentVariables,
        telemetryConfig: {
          loggingConfig: { logGroup: logGroupName, applicationLogLevel: 'INFO', systemLogLevel: 'INFO' },
        },
      },
    });
    if (props.egressNetworkConnectorArn) {
      // The CloudFormation schema has ServiceConfig.EgressNetworkConnectorArn, but the L1 generated in
      // aws-cdk-lib 2.273.0 does not expose it yet, so set it as a raw property override.
      revision.addPropertyOverride('ServiceConfig.EgressNetworkConnectorArn', props.egressNetworkConnectorArn);
      // The bundled cfn-lint lists only `Arn` and `State` as NetworkConnector GetAtt attributes;
      // `LatestVersionArn` resolves at deploy time and is the value a revision requires.
      cdk.Validations.of(revision).acknowledge({
        id: 'CloudFormation-Validate::E9004',
        reason: 'NetworkConnector LatestVersionArn is a valid attribute missing from the bundled cfn-lint schema',
      });
    }
    revision.addResourceDependency(webFunction);
    revision.node.addDependency(codeDeployment, logGroup, localLogGroup, role);
    if (codeReadPolicy.policyDependable) {
      revision.node.addDependency(codeReadPolicy.policyDependable);
    }

    const endpoint = new lambda.CfnWebFunctionEndpoint(this, 'Endpoint', {
      functionName: props.functionName,
      endpointName: props.endpointName,
      endpointType: 'HomeRegion',
      authType: props.authType,
      revisionWeights: [{ revisionId: revision.attrRevisionId, weight: 100 }],
      scalingConfig: props.maxEnvironments !== undefined ? { maxEnvironments: props.maxEnvironments } : undefined,
      throttleConfig: props.rateLimit !== undefined ? { rateLimit: props.rateLimit } : undefined,
    });
    endpoint.addResourceDependency(webFunction);
    endpoint.addResourceDependency(revision);

    // The cfn-lint schema bundled with aws-cdk-lib 2.273.0 predates these resource types
    // ("F3006 Unknown resource type"); CloudFormation itself accepts them.
    cdk.Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::F3006',
      reason: 'AWS::Lambda::WebFunction* are valid CloudFormation types missing from the bundled cfn-lint schema',
    });

    this.functionArn = webFunction.attrFunctionArn;
    this.endpointArn = endpoint.attrEndpointArn;
    this.domainName = endpoint.attrDomainName;
    this.revisionId = revision.attrRevisionId;
  }
}
