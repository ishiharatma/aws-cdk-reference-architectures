// Resolves the OpenAI API key from Secrets Manager at container startup,
// using the credentials the platform injects for the MicroVM's execution
// role. Never bakes the key into the image itself -- only its ARN is
// baked in, via OPENAI_API_KEY_SECRET_ARN.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});

export async function resolveOpenAiApiKey() {
  const secretArn = process.env.OPENAI_API_KEY_SECRET_ARN;
  if (!secretArn) {
    console.error('[secret] OPENAI_API_KEY_SECRET_ARN is not set; codex app-server will fail to authenticate');
    return undefined;
  }
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    return response.SecretString;
  } catch (err) {
    console.error('[secret] failed to resolve OpenAI API key from Secrets Manager', err);
    return undefined;
  }
}
