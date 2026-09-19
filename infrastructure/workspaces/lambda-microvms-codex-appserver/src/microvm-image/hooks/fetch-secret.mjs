// Resolves the OpenAI API key from Secrets Manager at MicroVM startup, using
// the credentials the platform injects for the MicroVM's execution role
// (RunMicrovmRequest.executionRoleArn). Invoked by hooks/run.sh; never bakes
// the key into the image.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secretArn = process.argv[2];
if (!secretArn) {
  process.exit(0);
}

const client = new SecretsManagerClient({});
const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
process.stdout.write(response.SecretString ?? '');
