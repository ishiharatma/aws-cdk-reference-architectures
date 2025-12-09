import { Environment } from '@common/parameters/environments';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SwitchRoleUser } from 'lib/constructs/iam-user-with-switch-role';
import { IAMUserWithPassword } from 'lib/constructs/iam-user-with-password';
import { IamUserGroup } from 'lib/constructs/iam-user-with-group';

export interface StackProps extends cdk.StackProps {
  project: string;
  environment: Environment;
  isAutoDeleteObject: boolean;
}

export class IamBasicsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Create IAM User CDKDefaultUser
    new iam.User(this, 'CDKDefaultUser', {});

    // Create IAM User with Password
    new IAMUserWithPassword(this, 'UserWithPassword', {
      project: props.project,
      environment: props.environment,
    });
    // Create IAM User with Group
    new IamUserGroup(this, 'UserGroup', {
      project: props.project,
      environment: props.environment,
    });

    // Create IAM User for Switch Role
    new SwitchRoleUser(this, 'SwitchRoleUser', {
      project: props.project,
      environment: props.environment,
    });


  }
}
