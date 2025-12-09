import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { C_RESOURCE} from "@common/types";
import { Environment } from '@common/parameters/environments';

/**
 * 
 * @export
 * @interface ConstructProps
 * @extends {cdk.StackProps}
 * @property {string} project - Project name
 * @property {Environment} environment - Deployment environment
 */
export interface ConstructProps extends cdk.StackProps {
    readonly project: string;
    readonly environment: Environment;
}

/**
 * Switch Role User Construct
 * @export
 * @class SwitchRoleUser
 * @extends {Construct}
 */
export class SwitchRoleUser extends Construct {

  constructor(scope: Construct, id: string, props: ConstructProps) {
    super(scope, id);

    const accountId = cdk.Stack.of(this).account;

    const username = 'SwitchRoleUser';
    // Create the user secret
    const userSecrets = new secretsmanager.Secret(this, `PasswordSecrets`, {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: username }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    // Output the secret ARN
    new cdk.CfnOutput(this, 'SecretsPasswordUserSecretArn', {
      value: userSecrets.secretArn,
      description: 'The ARN of the Secrets Manager secret for SecretsPasswordUser',
    });

    // Create IAM User for Switch Role
    const user = new iam.User(this, 'User', {
      userName: username,
      password: userSecrets.secretValueFromJson('password'),
      passwordResetRequired: true,
    });
    // change password policy
    user.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('IAMUserChangePassword')
    );

    // Create Swith Role
    // Switch Role can assume ReadOnlyAccess role with MFA
    const readOnlyRole = new iam.Role(this, 'ReadOnlyRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.AccountPrincipal(accountId),
        {
          // MFA requirement
          Bool: { 'aws:MultiFactorAuthPresent': 'true' },
        }
      ),
      maxSessionDuration: cdk.Duration.hours(4),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
      ],
    });

    // Create Switch Role Policy
    const assumeSwitchRoleReadOnlyPolicy = new iam.Policy(this, 'AssumeRoleReadOnlyPolicy', {
      statements: [
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [readOnlyRole.roleArn],
        }),
      ],
    });
    // Create Switch Role Group and attach policy
    const switchRoleGroup = new iam.Group(this, 'IamGroup', {
    });
    assumeSwitchRoleReadOnlyPolicy.attachToGroup(switchRoleGroup);
    // Add user to Switch Role Group
    user.addToGroup(switchRoleGroup);
  }
}