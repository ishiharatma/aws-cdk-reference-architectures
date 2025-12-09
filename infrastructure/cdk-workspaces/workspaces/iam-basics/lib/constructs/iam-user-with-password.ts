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
 * IAM User with Password Construct
 * @export
 * @class IAMUserWithPassword
 * @extends {Construct}
 */
export class IAMUserWithPassword extends Construct {

  constructor(scope: Construct, id: string, props: ConstructProps) {
    super(scope, id);

    // ==================================================
    // Create IAM User with password
    const userWithPassword = new iam.User(this, 'PasswordUser', {
      password: cdk.SecretValue.unsafePlainText('InitialPassword123!'),
      passwordResetRequired: true,
    });
    // output the user name
    new cdk.CfnOutput(this, 'PasswordUserName', {
      value: userWithPassword.userName,
      description: 'The user name of the IAM User with Password',
    });

    // ==================================================
    // Create IAM User with Secrets Manager
    const userNameWithSecretsManager = 'SecretsPasswordUser';
    // Create the user secret
    const userWithSecretsManagerSecret = new secretsmanager.Secret(this, `PasswordSecrets`, {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: userNameWithSecretsManager }),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });
    // Output the secret ARN
    new cdk.CfnOutput(this, 'SecretsPasswordUserSecretArn', {
      value: userWithSecretsManagerSecret.secretArn,
      description: 'The ARN of the Secrets Manager secret for SecretsPasswordUser',
    });

    // Create the user
    const userWithSecretsManager = new iam.User(this, 'SecretsPasswordUser', {
      userName: userNameWithSecretsManager,
      password: userWithSecretsManagerSecret.secretValueFromJson('password'),
      passwordResetRequired: true,
    });
    // change password policy
    userWithSecretsManager.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('IAMUserChangePassword')
    );
    // Attach ReadOnlyAccess managed policy to the user
    userWithSecretsManager.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')
    );
    // Add inline policy to the user
    userWithSecretsManager.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListAllMyBuckets'],
        resources: ['arn:aws:s3:::*'],
      })
    );
    // output the user name
    new cdk.CfnOutput(this, 'SecretsPasswordUserName', {
      value: userWithSecretsManager.userName,
      description: 'The user name of the IAM User with Secrets Manager password',
    });
    // grant read access to the secret only to the user itself
    userWithSecretsManagerSecret.grantRead(userWithSecretsManager);

  }
}