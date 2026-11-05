import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { Environment } from '@common/parameters/environments';

/**
 *
 */
interface StackProps extends cdk.StackProps {
  readonly project: string;
  readonly environment: Environment;
  readonly httpApi: apigwv2.IHttpApi;
  readonly apiStageName: string;
}

/**
 * Browser-only access to MicroVM sessions, without a local relay.
 *
 * /__cp/* reaches the control plane on the distribution's own origin, so the session cookie it sets
 * belongs to this domain. Everything else goes through Lambda@Edge, which turns that cookie into the
 * endpoint and X-aws-proxy-auth header each MicroVM requires. Lambda@Edge lives in us-east-1;
 * EdgeFunction creates and references that support stack automatically.
 */
export class BrowserAccessStack extends cdk.Stack {
  /**
   *
   */
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const { project, environment, httpApi, apiStageName } = props;

    const apiOrigin = new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`, {
      originPath: `/${apiStageName}`,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const router = new cloudfront.experimental.EdgeFunction(this, 'MicrovmRouter', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'router.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'src', 'edge')),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
    });

    const stripPrefix = new cloudfront.Function(this, 'StripControlPlanePrefix', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'Removes /__cp before the request reaches the control plane API',
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; r.uri = r.uri.replace(/^\\/__cp/, '') || '/'; return r; }",
      ),
    });

    // CloudFront forwards Authorization on GET only when it is part of the cache key, which requires
    // a non-zero maximum TTL. Every response is no-store, so nothing is actually kept.
    const controlPlaneCache = new cloudfront.CachePolicy(this, 'ControlPlaneCachePolicy', {
      comment: 'Forwards Authorization to the control plane; responses are no-store',
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(1),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${project}-${environment} code-server browser access`,
      defaultBehavior: {
        // Only a placeholder: the origin-request function replaces it per request or redirects.
        origin: apiOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // AllViewer keeps the viewer's Host visible to the function and forwards the WebSocket headers.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        edgeLambdas: [
          { eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST, functionVersion: router.currentVersion },
          { eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE, functionVersion: router.currentVersion },
        ],
      },
      additionalBehaviors: {
        '/__cp/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: controlPlaneCache,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [{ eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: stripPrefix }],
        },
      },
    });

    new cdk.CfnOutput(this, 'PortalUrl', { value: `https://${distribution.distributionDomainName}/__cp/portal` });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
  }
}
