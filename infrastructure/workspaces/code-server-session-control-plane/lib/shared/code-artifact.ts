import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export const PACKAGE_REPOSITORY = 'packages';

/** Fixed, because the image stack needs it before the network stack that creates the domain is known to it. */
export const codeArtifactDomainName = (namePrefix: string): string => namePrefix.toLowerCase();

/**
 * Install only. Nothing here allows publishing, which would be a way to send code out through the mirror.
 */
export function packageReadStatements(stack: cdk.Stack, namePrefix: string): iam.PolicyStatement[] {
  const domain = codeArtifactDomainName(namePrefix);
  return [
    new iam.PolicyStatement({
      sid: 'PackageMirrorRead',
      actions: ['codeartifact:GetAuthorizationToken', 'codeartifact:GetRepositoryEndpoint', 'codeartifact:ReadFromRepository'],
      resources: [
        stack.formatArn({ service: 'codeartifact', resource: 'domain', resourceName: domain }),
        stack.formatArn({ service: 'codeartifact', resource: 'repository', resourceName: `${domain}/${PACKAGE_REPOSITORY}` }),
      ],
    }),
    new iam.PolicyStatement({
      sid: 'PackageMirrorBearerToken',
      actions: ['sts:GetServiceBearerToken'],
      resources: ['*'],
      conditions: { StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' } },
    }),
  ];
}
