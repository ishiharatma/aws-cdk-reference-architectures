import type {
  BedrockAgentRuntimeClient,
  KnowledgeBaseRetrievalResult,
  RetrieveAndGenerateCommandOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { RetrieveAndGenerateCommand, RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';

export interface RagConfig {
  readonly knowledgeBaseId: string;
  /** ARN of the generation model or inference profile. */
  readonly modelArn: string;
  readonly numberOfResults: number;
  /** Metadata attribute the request may filter on. */
  readonly filterAttribute: string;
}

export interface AskRequest {
  readonly question: string;
  /** Value of the filter attribute; only chunks of documents with this value are retrieved. */
  readonly filter?: string;
  /** Session ID returned by an earlier answer, to continue a conversation. */
  readonly sessionId?: string;
  readonly maxResults?: number;
}

export interface Citation {
  readonly source: string;
  readonly text: string;
  readonly score?: number;
  readonly metadata: Record<string, unknown>;
}

export interface AskResponse {
  readonly answer: string;
  readonly sessionId?: string;
  readonly citations: Citation[];
}

/** A request the caller got wrong; the handler turns it into HTTP 400. */
export class BadRequest extends Error {}

const MAX_QUESTION_LENGTH = 1000;
const MAX_RESULTS = 10;
const FILTER_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Validates a JSON body. Everything that reaches Bedrock has been checked here. */
export const parseAsk = (body: string | null | undefined): AskRequest => {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    throw new BadRequest('the body must be JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new BadRequest('the body must be a JSON object');
  const { question, filter, sessionId, maxResults } = raw as Record<string, unknown>;
  if (typeof question !== 'string' || question.trim() === '') throw new BadRequest('"question" is required');
  if (question.length > MAX_QUESTION_LENGTH) throw new BadRequest(`"question" is limited to ${MAX_QUESTION_LENGTH} characters`);
  if (filter !== undefined && (typeof filter !== 'string' || !FILTER_PATTERN.test(filter))) throw new BadRequest('"filter" must be a short plain value');
  if (sessionId !== undefined && typeof sessionId !== 'string') throw new BadRequest('"sessionId" must be a string');
  if (maxResults !== undefined && (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > MAX_RESULTS)) {
    throw new BadRequest(`"maxResults" must be an integer from 1 to ${MAX_RESULTS}`);
  }
  return { question: question.trim(), filter: filter as string | undefined, sessionId: sessionId as string | undefined, maxResults: maxResults as number | undefined };
};

/** Retrieval options shared by `Retrieve` and `RetrieveAndGenerate`. */
export const vectorSearch = (config: RagConfig, req: AskRequest) => ({
  numberOfResults: req.maxResults ?? config.numberOfResults,
  ...(req.filter ? { filter: { equals: { key: config.filterAttribute, value: req.filter } } } : {}),
});

const sourceOf = (location?: { s3Location?: { uri?: string } }): string => location?.s3Location?.uri ?? 'unknown';

const toCitation = (r: KnowledgeBaseRetrievalResult): Citation => ({
  source: sourceOf(r.location),
  text: r.content?.text ?? '',
  score: r.score,
  metadata: (r.metadata ?? {}) as Record<string, unknown>,
});

/** Question answering and plain retrieval over a knowledge base. The client is injected so tests can fake it. */
export class Rag {
  constructor(private readonly client: Pick<BedrockAgentRuntimeClient, 'send'>, private readonly config: RagConfig) {}

  /** Retrieve the best chunks and let the model answer from them, with the chunks returned as citations. */
  async ask(req: AskRequest): Promise<AskResponse> {
    const out = (await this.client.send(new RetrieveAndGenerateCommand({
      sessionId: req.sessionId,
      input: { text: req.question },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: this.config.knowledgeBaseId,
          modelArn: this.config.modelArn,
          retrievalConfiguration: { vectorSearchConfiguration: vectorSearch(this.config, req) },
        },
      },
    }))) as RetrieveAndGenerateCommandOutput;
    const citations = (out.citations ?? []).flatMap((c) => c.retrievedReferences ?? []).map((r) => ({
      source: sourceOf(r.location),
      text: r.content?.text ?? '',
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
    return { answer: out.output?.text ?? '', sessionId: out.sessionId, citations };
  }

  /** Retrieval only: the chunks and their scores, without generation. Useful to tune chunking and filters. */
  async search(req: AskRequest): Promise<{ results: Citation[] }> {
    const out = await this.client.send(new RetrieveCommand({
      knowledgeBaseId: this.config.knowledgeBaseId,
      retrievalQuery: { text: req.question },
      retrievalConfiguration: { vectorSearchConfiguration: vectorSearch(this.config, req) },
    }));
    return { results: (out.retrievalResults ?? []).map(toCitation) };
  }
}
