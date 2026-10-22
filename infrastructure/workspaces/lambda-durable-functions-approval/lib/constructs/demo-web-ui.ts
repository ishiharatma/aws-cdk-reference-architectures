import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import {
  IdentityPool,
  IdentityPoolProviderUrl,
  UserPoolAuthenticationProvider,
} from 'aws-cdk-lib/aws-cognito-identitypool';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as esbuild from 'esbuild';
import { Construct } from 'constructs';

/** Properties for {@link DemoWebUi}. */
export interface DemoWebUiProps {
  /** `<project>-<env>-ldf`, used for resource names. */
  readonly namePrefix: string;
  /** The IAM-authorized approval API the browser calls with SigV4. */
  readonly api: apigateway.IRestApi;
  /** Shown in the UI as the approval deadline. */
  readonly approvalTimeoutMinutes: number;
  /** Prefix of the Cognito managed login domain; unique per Region across all accounts. */
  readonly cognitoDomainPrefix: string;
  readonly removalPolicy: cdk.RemovalPolicy;
  readonly autoDeleteObjects: boolean;
}

const WEB_DIR = path.join(__dirname, '..', '..', 'web');

/**
 * Demo web UI for the approval API, without changing how the API is authorized.
 *
 *   Browser --managed login (code + PKCE)--> Cognito user pool  (groups: requesters / approvers)
 *           --ID token--> Cognito identity pool --(group role)--> temporary IAM credentials
 *           --SigV4--> API Gateway (IAM auth, CORS for this origin only)
 *   CloudFront (OAC) --> private S3 bucket: index.html, app.js, style.css, config.json
 *
 * The requester and approver roles carry different execute-api:Invoke permissions, so the
 * separation of duties is enforced by IAM before any handler runs.
 */
export class DemoWebUi extends Construct {
  /** `https://<distribution domain>`; the only origin allowed by CORS. */
  public readonly origin: string;
  public readonly userPool: cognito.IUserPool;
  public readonly requesterRole: iam.IRole;
  public readonly approverRole: iam.IRole;

  /** Creates the identity and hosting resources and publishes the SPA. */
  constructor(scope: Construct, id: string, props: DemoWebUiProps) {
    super(scope, id);
    const { namePrefix, api, removalPolicy } = props;
    const region = cdk.Stack.of(this).region;

    // ---- Hosting ---------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: props.autoDeleteObjects,
    });

    const cognitoDomain = `${props.cognitoDomainPrefix}.auth.${region}.amazoncognito.com`;
    const apiHost = `${api.restApiId}.execute-api.${region}.${cdk.Aws.URL_SUFFIX}`;
    const headersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `${namePrefix}-demo-web-headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            `connect-src 'self' https://${apiHost} https://cognito-identity.${region}.amazonaws.com https://${cognitoDomain}`,
            "img-src 'self' data:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            `form-action 'self' https://${cognitoDomain}`,
          ].join('; '),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${namePrefix} approval demo UI`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headersPolicy,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });
    this.origin = `https://${distribution.distributionDomainName}`;

    // ---- Identity --------------------------------------------------------------
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${namePrefix}-demo-users`,
      // Demo users are created by an administrator (scripts/create-demo-users.sh).
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    this.userPool = userPool;

    const domain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const client = userPool.addClient('WebClient', {
      userPoolClientName: `${namePrefix}-demo-web`,
      // A browser cannot keep a secret: public client + PKCE.
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${this.origin}/`],
        logoutUrls: [`${this.origin}/`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.hours(12),
    });

    // Managed login (v2) pages need a style; use the Cognito defaults.
    const branding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    const identityPool = new IdentityPool(this, 'IdentityPool', {
      identityPoolName: `${namePrefix}-demo-identities`,
      allowUnauthenticatedIdentities: false,
      authenticationProviders: {
        userPools: [
          new UserPoolAuthenticationProvider({ userPool: this.userPool, userPoolClient: client }),
        ],
      },
      // The role comes from the user's group (cognito:preferred_role). A user in no group gets
      // no credentials at all (ambiguous role resolution = Deny).
      roleMappings: [
        {
          mappingKey: 'userpool',
          providerUrl: IdentityPoolProviderUrl.userPool(this.userPool, client),
          useToken: true,
        },
      ],
    });

    const groupRole = (roleId: string, description: string): iam.Role =>
      new iam.Role(this, roleId, {
        description,
        assumedBy: new iam.WebIdentityPrincipal('cognito-identity.amazonaws.com', {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.identityPoolId },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        }),
        maxSessionDuration: cdk.Duration.hours(1),
      });
    const stage = api.deploymentStage.stageName;

    const requesterRole = groupRole(
      'RequesterRole',
      'Demo UI requesters: submit and read requests'
    );
    requesterRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [
          api.arnForExecuteApi('POST', '/requests', stage),
          api.arnForExecuteApi('GET', '/requests/*', stage),
        ],
      })
    );

    const approverRole = groupRole(
      'ApproverRole',
      'Demo UI approvers: list, read and decide requests'
    );
    approverRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        resources: [
          api.arnForExecuteApi('GET', '/requests', stage),
          api.arnForExecuteApi('GET', '/requests/*', stage),
          api.arnForExecuteApi('POST', '/requests/*/decision', stage),
        ],
      })
    );

    this.requesterRole = requesterRole;
    this.approverRole = approverRole;

    // Lower precedence wins when a user is in both groups.
    new cognito.UserPoolGroup(this, 'ApproversGroup', {
      userPool: this.userPool,
      groupName: 'approvers',
      role: this.approverRole,
      precedence: 1,
    });
    new cognito.UserPoolGroup(this, 'RequestersGroup', {
      userPool: this.userPool,
      groupName: 'requesters',
      role: this.requesterRole,
      precedence: 2,
    });

    // ---- Publish the SPA ---------------------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      destinationBucket: bucket,
      sources: [
        webAsset(),
        s3deploy.Source.jsonData('config.json', {
          region,
          apiUrl: api.deploymentStage.urlForPath('/'),
          userPoolId: this.userPool.userPoolId,
          userPoolClientId: client.userPoolClientId,
          identityPoolId: identityPool.identityPoolId,
          cognitoDomain,
          approvalTimeoutMinutes: props.approvalTimeoutMinutes,
        }),
      ],
      distribution,
      distributionPaths: ['/*'],
      memoryLimit: 256,
    });

    new cdk.CfnOutput(this, 'DemoWebUrl', { value: this.origin, description: 'Demo UI URL' });
    new cdk.CfnOutput(this, 'DemoUserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Pass to scripts/create-demo-users.sh',
    });
  }
}

/** Bundle web/src with the local esbuild (no Docker), then add the static files. */
function webAsset(): s3deploy.ISource {
  return s3deploy.Source.asset(WEB_DIR, {
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:24-slim'),
      command: ['sh', '-c', 'echo "local esbuild bundling is required" && exit 1'],
      local: {
        tryBundle(outputDir: string): boolean {
          esbuild.buildSync({
            entryPoints: [path.join(WEB_DIR, 'src', 'main.ts')],
            bundle: true,
            minify: true,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            outfile: path.join(outputDir, 'app.js'),
            logLevel: 'warning',
          });
          fs.cpSync(path.join(WEB_DIR, 'public'), outputDir, { recursive: true });
          return true;
        },
      },
    },
  });
}
