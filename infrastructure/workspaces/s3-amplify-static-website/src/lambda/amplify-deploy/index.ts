import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AmplifyClient, StartDeploymentCommand } from '@aws-sdk/client-amplify';

const s3 = new S3Client({});
const amplify = new AmplifyClient({});

interface ResourceProperties {
  readonly AppId: string;
  readonly BranchName: string;
  readonly BucketName: string;
  readonly ObjectKey: string;
}

interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: ResourceProperties;
}

interface OnEventResponse {
  readonly PhysicalResourceId: string;
  readonly Data?: Record<string, string>;
}

/**
 * Amplify's StartDeployment API, when given an s3:// sourceUrl, requires a bucket
 * policy granting amplify.amazonaws.com access (see AWS's "Creating a bucket policy
 * to deploy a static website from S3" guide) — but the zip here lives in the shared
 * CDK bootstrap bucket, which this stack doesn't own and can't attach a policy to
 * (`Bucket.fromBucketAttributes` returns an imported bucket; `addToResourcePolicy`
 * on it is a silent no-op). A presigned HTTPS URL sidesteps that entirely: Amplify
 * just performs a plain HTTP GET, so only this function's own IAM role needs
 * s3:GetObject on the asset (granted via `websiteAsset.grantRead` in the stack).
 */
export async function handler(event: OnEventRequest): Promise<OnEventResponse> {
  const props = event.ResourceProperties;
  const physicalResourceId = `${props.AppId}-${props.BranchName}-amplify-deploy`;

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? physicalResourceId };
  }

  const sourceUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: props.BucketName, Key: props.ObjectKey }),
    { expiresIn: 900 },
  );

  const result = await amplify.send(
    new StartDeploymentCommand({
      appId: props.AppId,
      branchName: props.BranchName,
      sourceUrl,
      sourceUrlType: 'ZIP',
    }),
  );

  return {
    PhysicalResourceId: physicalResourceId,
    Data: { JobId: result.jobSummary?.jobId ?? '' },
  };
}
