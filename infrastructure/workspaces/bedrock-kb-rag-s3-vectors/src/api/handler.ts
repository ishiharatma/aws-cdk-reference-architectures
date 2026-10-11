import { BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { BadRequest, Rag, parseAsk } from './rag';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const rag = new Rag(new BedrockAgentRuntimeClient({}), {
  knowledgeBaseId: required('KNOWLEDGE_BASE_ID'),
  modelArn: required('MODEL_ARN'),
  numberOfResults: Number(process.env.NUMBER_OF_RESULTS ?? '4'),
  filterAttribute: process.env.FILTER_ATTRIBUTE ?? 'department',
});

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** `POST /ask` answers a question with citations; `POST /search` returns the retrieved chunks only. */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const req = parseAsk(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : event.body);
    return json(200, event.rawPath.endsWith('/search') ? await rag.search(req) : await rag.ask(req));
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { message: e.message });
    console.error(JSON.stringify({ message: 'request failed', error: String(e) }));
    return json(502, { message: 'the knowledge base could not answer the request' });
  }
};
