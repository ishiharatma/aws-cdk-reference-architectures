import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as path from 'path';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as transfer from 'aws-cdk-lib/aws-transfer';
import { Environment } from "@common/parameters/environments";
import { EnvParams } from 'parameters/environments';
import { SftpMonitoring } from 'lib/constructs/sftp-monitoring';

export interface TransferSftpCustomIdpStackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly isAutoDeleteObject: boolean;
  readonly envParams: EnvParams;
}

/** Sort-key value of the user items. Matches the provider name used by the AWS custom IdP solution. */
export const IDENTITY_PROVIDER_KEY = 'publickeys';

export class TransferSftpCustomIdpStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props: TransferSftpCustomIdpStackProps) {
    super(scope, id, props);

    const { envParams } = props;
    const removalPolicy = envParams.retainData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const retention = envParams.logRetentionDays as logs.RetentionDays;

    // ---------------------------------------------------------------------------------------------
    // Log encryption key (CloudWatch Logs service principal only)
    // ---------------------------------------------------------------------------------------------
    let logKey: kms.Key | undefined;
    if (envParams.enableLogEncryption) {
      logKey = new kms.Key(this, 'LogKey', {
        enableKeyRotation: true,
        description: `${props.project}-${props.environment} SFTP log encryption key`,
        removalPolicy,
      });
      logKey.addToResourcePolicy(new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }));
    }

    // ---------------------------------------------------------------------------------------------
    // User table (schema follows the "users" table of the AWS Transfer Family custom IdP solution)
    //   PK user (lower-case name) / SK identity_provider_key
    //   config{Role,HomeDirectory,PublicKeys}, ipv4_allow_list, server_id_allow_list, enabled
    // ---------------------------------------------------------------------------------------------
    const userTable = new dynamodb.Table(this, 'UserTable', {
      partitionKey: { name: 'user', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'identity_provider_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: envParams.retainData,
      removalPolicy,
    });

    // ---------------------------------------------------------------------------------------------
    // SFTP data bucket: s3://<bucket>/<username>/
    // ---------------------------------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'SftpBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: props.isAutoDeleteObject,
    });

    // ---------------------------------------------------------------------------------------------
    // Custom IdP Lambda (read-only GetItem on the user table, no secrets in env vars)
    // ---------------------------------------------------------------------------------------------
    const idpLogGroup = new logs.LogGroup(this, 'IdpLogGroup', {
      retention,
      encryptionKey: logKey,
      removalPolicy,
    });
    const idpFunction = new lambda.Function(this, 'IdpFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/custom_idp'), { exclude: ['__pycache__', '*.pyc'] }),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup: idpLogGroup,
      environment: {
        USER_TABLE_NAME: userTable.tableName,
        IDENTITY_PROVIDER_KEY,
        LOG_LEVEL: envParams.lambdaLogLevel,
      },
    });
    idpFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [userTable.tableArn],
    }));

    // ---------------------------------------------------------------------------------------------
    // Transfer Family: logging role and structured log group
    // ---------------------------------------------------------------------------------------------
    const transferLogGroup = new logs.LogGroup(this, 'TransferLogGroup', {
      logGroupName: `/aws/transfer/${props.project}-${props.environment}-sftp`,
      retention,
      encryptionKey: logKey,
      removalPolicy,
    });
    const loggingRole = new iam.Role(this, 'TransferLoggingRole', {
      assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    loggingRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
      resources: [transferLogGroup.logGroupArn, `${transferLogGroup.logGroupArn}:*`],
    }));

    // ---------------------------------------------------------------------------------------------
    // Monitoring: SNS topic + alarms (auth failures, IP denials, IdP errors, data transfer volume)
    // ---------------------------------------------------------------------------------------------
    const alarmPrefix = `${props.project}-${props.environment}-sftp`;
    const monitoring = envParams.monitoring.enabled
      ? new SftpMonitoring(this, 'Monitoring', {
        alarmPrefix,
        params: envParams.monitoring,
        removalPolicy,
        transferLogGroup,
        idpLogGroup,
      })
      : undefined;

    // ---------------------------------------------------------------------------------------------
    // Transfer Family server: PUBLIC endpoint, SFTP, custom IdP, SSH public key only.
    // The endpoint has no Security Group: source IP control is done by the Lambda at authentication.
    //
    // Run mode: a stopped (OFFLINE) server is still billed, so "off" means deleted.
    //   always:            CloudFormation resource, always running
    //   manual/scheduled:  no CloudFormation resource; a controller Lambda creates and deletes the server
    // ---------------------------------------------------------------------------------------------
    const lifecycle = envParams.serverLifecycle;
    const onDemand = lifecycle.mode !== 'always';
    const serverArnPattern = `arn:${this.partition}:transfer:${this.region}:${this.account}:server/*`;
    let userArnPattern = `arn:${this.partition}:transfer:${this.region}:${this.account}:user/*`;
    let controller: lambda.Function | undefined;
    let controllerLogGroup: logs.LogGroup | undefined;

    if (!onDemand) {
      const server = new transfer.CfnServer(this, 'SftpServer', {
        endpointType: 'PUBLIC',
        protocols: ['SFTP'],
        domain: 'S3',
        identityProviderType: 'AWS_LAMBDA',
        identityProviderDetails: {
          function: idpFunction.functionArn,
          sftpAuthenticationMethods: 'PUBLIC_KEY',
        },
        securityPolicyName: envParams.securityPolicyName,
        loggingRole: loggingRole.roleArn,
        structuredLogDestinations: [transferLogGroup.logGroupArn],
      });
      server.node.addDependency(transferLogGroup);
      idpFunction.addPermission('AllowTransferInvoke', {
        principal: new iam.ServicePrincipal('transfer.amazonaws.com'),
        sourceArn: server.attrArn,
        sourceAccount: this.account,
      });
      userArnPattern = `arn:${this.partition}:transfer:${this.region}:${this.account}:user/${server.attrServerId}/*`;
      monitoring?.addServerAlarms(server.attrServerId);
      new cdk.CfnOutput(this, 'ServerId', { value: server.attrServerId });
      new cdk.CfnOutput(this, 'ServerEndpoint', {
        value: `${server.attrServerId}.server.transfer.${this.region}.amazonaws.com`,
      });
    } else {
      // The server ID is not known at deploy time, so the invoke permission covers servers of this account.
      idpFunction.addPermission('AllowTransferInvoke', {
        principal: new iam.ServicePrincipal('transfer.amazonaws.com'),
        sourceArn: serverArnPattern,
        sourceAccount: this.account,
      });

      controllerLogGroup = new logs.LogGroup(this, 'ControllerLogGroup', {
        retention,
        encryptionKey: logKey,
        removalPolicy,
      });
      controller = new lambda.Function(this, 'ServerController', {
        runtime: lambda.Runtime.PYTHON_3_14,
        architecture: lambda.Architecture.ARM_64,
        handler: 'handler.lambda_handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/server_controller'), { exclude: ['__pycache__', '*.pyc'] }),
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        logGroup: controllerLogGroup,
        environment: {
          STACK_TAG: this.stackName,
          IDP_FUNCTION_ARN: idpFunction.functionArn,
          LOGGING_ROLE_ARN: loggingRole.roleArn,
          LOG_GROUP_ARN: transferLogGroup.logGroupArn,
          SECURITY_POLICY_NAME: envParams.securityPolicyName,
          ...(lifecycle.hostKeySecretArn ? { HOST_KEY_SECRET_ARN: lifecycle.hostKeySecretArn } : {}),
          ...(monitoring ? {
            ALARM_PREFIX: alarmPrefix,
            ALARM_TOPIC_ARN: monitoring.topic.topicArn,
            ALARM_PERIOD_MINUTES: String(envParams.monitoring.periodMinutes),
            BYTES_IN_THRESHOLD: String(Math.round(envParams.monitoring.bytesInThresholdMb * 1024 * 1024)),
            BYTES_OUT_THRESHOLD: String(Math.round(envParams.monitoring.bytesOutThresholdMb * 1024 * 1024)),
          } : {}),
        },
      });
      const ownedServer = { 'aws:ResourceTag/sftp-custom-idp-stack': this.stackName };
      controller.addToRolePolicy(new iam.PolicyStatement({
        actions: ['transfer:CreateServer', 'transfer:ListServers'],
        resources: ['*'],
      }));
      // CreateServer with structured logging requires these permissions of the caller (not only of the logging role).
      // None of them supports resource-level restriction.
      controller.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'logs:CreateLogDelivery', 'logs:DeleteLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
          'logs:ListLogDeliveries', 'logs:DescribeLogGroups', 'logs:DescribeResourcePolicies', 'logs:PutResourcePolicy',
        ],
        resources: ['*'],
      }));
      controller.addToRolePolicy(new iam.PolicyStatement({
        actions: ['transfer:DeleteServer', 'transfer:DescribeServer'],
        resources: [serverArnPattern],
        conditions: { StringEquals: ownedServer },
      }));
      controller.addToRolePolicy(new iam.PolicyStatement({
        actions: ['transfer:TagResource', 'transfer:ListTagsForResource'],
        resources: [serverArnPattern],
      }));
      controller.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [loggingRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'transfer.amazonaws.com' } },
      }));
      if (monitoring) {
        // The controller owns the server metric alarms: it creates them after start and deletes them after stop.
        controller.addToRolePolicy(new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms'],
          resources: [`arn:${this.partition}:cloudwatch:${this.region}:${this.account}:alarm:${alarmPrefix}-*`],
        }));
      }
      if (lifecycle.hostKeySecretArn) {
        controller.addToRolePolicy(new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [lifecycle.hostKeySecretArn],
        }));
      }

      // Deleting the stack removes a server created by the controller.
      const cleanup = new cdk.CustomResource(this, 'ServerCleanup', {
        serviceToken: controller.functionArn,
        resourceType: 'Custom::SftpServerCleanup',
      });
      cleanup.node.addDependency(transferLogGroup, loggingRole, controllerLogGroup);

      if (lifecycle.mode === 'scheduled') {
        if (!lifecycle.startExpression || !lifecycle.stopExpression) {
          throw new Error('serverLifecycle.startExpression and stopExpression are required in scheduled mode');
        }
        const schedulerRole = new iam.Role(this, 'SchedulerRole', {
          assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
            conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
          }),
        });
        schedulerRole.addToPolicy(new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [controller.functionArn],
        }));
        for (const [name, action, expression] of [
          ['Start', 'start', lifecycle.startExpression],
          ['Stop', 'stop', lifecycle.stopExpression],
        ]) {
          new scheduler.CfnSchedule(this, `${name}Schedule`, {
            description: `${action} the SFTP server (${props.project}-${props.environment})`,
            scheduleExpression: expression,
            scheduleExpressionTimezone: lifecycle.timezone ?? 'UTC',
            flexibleTimeWindow: { mode: 'OFF' },
            target: {
              arn: controller.functionArn,
              roleArn: schedulerRole.roleArn,
              input: JSON.stringify({ action }),
              retryPolicy: { maximumRetryAttempts: 2 },
            },
          });
        }
      }
      monitoring?.addLambdaErrorAlarm('ControllerErrorAlarm', 'ServerControllerError',
        controller.metricErrors({ period: cdk.Duration.minutes(envParams.monitoring.periodMinutes), statistic: 'Sum' }),
        'Starting or stopping the on-demand SFTP server failed (the server may be missing or still running)');
      new cdk.CfnOutput(this, 'ControllerFunctionName', { value: controller.functionName });
    }

    // ---------------------------------------------------------------------------------------------
    // Shared access role that Transfer Family assumes for S3 access.
    // The Lambda narrows it per user with a session policy built from the user's HomeDirectory.
    // ---------------------------------------------------------------------------------------------
    const transferAccessRole = new iam.Role(this, 'TransferAccessRole', {
      assumedBy: new iam.ServicePrincipal('transfer.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          // Transfer Family passes the user ARN (user/<server-id>/<username>) when assuming a user role
          ArnLike: { 'aws:SourceArn': userArnPattern },
        },
      }),
      description: 'S3 access role assumed by AWS Transfer Family (narrowed per user by a session policy)',
    });
    transferAccessRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [bucket.bucketArn],
    }));
    transferAccessRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAttributes',
        's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion',
      ],
      resources: [bucket.arnForObjects('*')],
    }));

    // ---------------------------------------------------------------------------------------------
    // Admin policy for the CloudShell operator (least privilege, limited to the user table)
    // ---------------------------------------------------------------------------------------------
    const adminPolicy = new iam.ManagedPolicy(this, 'UserAdminPolicy', {
      description: 'Allows managing SFTP user records in the custom IdP DynamoDB table (CloudShell scripts)',
      statements: [
        new iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
            'dynamodb:Query', 'dynamodb:Scan',
          ],
          resources: [userTable.tableArn],
        }),
      ],
    });

    if (controller) {
      // Lets the CloudShell operator start / stop / check the server
      adminPolicy.addStatements(new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [controller.functionArn],
      }));
    }

    // ---------------------------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------------------------
    if (monitoring) {
      new cdk.CfnOutput(this, 'AlertTopicArn', { value: monitoring.topic.topicArn });
    }
    new cdk.CfnOutput(this, 'UserTableName', { value: userTable.tableName });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'TransferAccessRoleArn', { value: transferAccessRole.roleArn });
    new cdk.CfnOutput(this, 'UserAdminPolicyArn', { value: adminPolicy.managedPolicyArn });
    new cdk.CfnOutput(this, 'IdpFunctionName', { value: idpFunction.functionName });
    new cdk.CfnOutput(this, 'TransferLogGroupName', { value: transferLogGroup.logGroupName });
  }
}
