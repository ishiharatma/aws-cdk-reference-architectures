import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
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
 * IAM User with Group Construct
 * @export
 * @class IamUserGroup
 * @extends {Construct}
 */
export class IamUserGroup extends Construct {
  constructor(scope: Construct, id: string, props: ConstructProps) {
    super(scope, id);

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

    // Create IAM User
    const user = new iam.User(this, 'User', {
      userName: username,
      password: userSecrets.secretValueFromJson('password'),
      passwordResetRequired: true,
    });
    // change password policy
    user.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('IAMUserChangePassword')
    );

    // Create Group
    const group = new iam.Group(this, 'IamGroup', {
    });
    // 
    group.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'));

    // Add user to Switch Role Group
    user.addToGroup(group);
  }
}