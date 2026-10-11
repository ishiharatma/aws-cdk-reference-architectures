/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequest, Rag, RagConfig, parseAsk, vectorSearch } from '../../src/api/rag';

const config: RagConfig = { knowledgeBaseId: 'KB1', modelArn: 'arn:model', numberOfResults: 4, filterAttribute: 'department' };

const fakeClient = (answer: any) => {
  const calls: { name: string; input: any }[] = [];
  const client = { send: jest.fn(async (command: any) => { calls.push({ name: command.constructor.name, input: command.input }); return answer; }) } as any;
  return { client, calls };
};

describe('parseAsk', () => {
  test('accepts a question with the optional fields', () => {
    expect(parseAsk(JSON.stringify({ question: '  When does the rotation change? ', filter: 'infrastructure', sessionId: 's1', maxResults: 3 })))
      .toEqual({ question: 'When does the rotation change?', filter: 'infrastructure', sessionId: 's1', maxResults: 3 });
  });

  test.each([
    ['not JSON', 'nope'],
    ['an empty body', undefined],
    ['an array', '[]'],
    ['no question', '{}'],
    ['a blank question', '{"question":"  "}'],
    ['a question over 1000 characters', JSON.stringify({ question: 'x'.repeat(1001) })],
    ['a filter with a quote', JSON.stringify({ question: 'q', filter: 'a"b' })],
    ['a filter that is not a string', JSON.stringify({ question: 'q', filter: 5 })],
    ['a maxResults of 0', JSON.stringify({ question: 'q', maxResults: 0 })],
    ['a maxResults over 10', JSON.stringify({ question: 'q', maxResults: 11 })],
    ['a fractional maxResults', JSON.stringify({ question: 'q', maxResults: 1.5 })],
    ['a sessionId that is not a string', JSON.stringify({ question: 'q', sessionId: 1 })],
  ])('rejects %s', (_name, body) => {
    expect(() => parseAsk(body as any)).toThrow(BadRequest);
  });
});

describe('vectorSearch', () => {
  test('uses the configured result count and adds an equality filter only when asked', () => {
    expect(vectorSearch(config, { question: 'q' })).toEqual({ numberOfResults: 4 });
    expect(vectorSearch(config, { question: 'q', filter: 'finance', maxResults: 2 })).toEqual({
      numberOfResults: 2,
      filter: { equals: { key: 'department', value: 'finance' } },
    });
  });
});

describe('Rag.ask', () => {
  const answer = {
    output: { text: 'Every Monday at 10:00 JST.' },
    sessionId: 'sess-1',
    citations: [{ retrievedReferences: [{ content: { text: 'chunk' }, location: { s3Location: { uri: 's3://b/oncall.md' } }, metadata: { department: 'infrastructure' } }] }],
  };

  test('asks the knowledge base with the model, the filter and the session, and returns the answer with citations', async () => {
    const { client, calls } = fakeClient(answer);
    const result = await new Rag(client, config).ask({ question: 'q', filter: 'infrastructure', sessionId: 'sess-0' });
    expect(result).toEqual({
      answer: 'Every Monday at 10:00 JST.',
      sessionId: 'sess-1',
      citations: [{ source: 's3://b/oncall.md', text: 'chunk', metadata: { department: 'infrastructure' } }],
    });
    expect(calls[0].name).toBe('RetrieveAndGenerateCommand');
    expect(calls[0].input.sessionId).toBe('sess-0');
    expect(calls[0].input.retrieveAndGenerateConfiguration.knowledgeBaseConfiguration).toMatchObject({
      knowledgeBaseId: 'KB1',
      modelArn: 'arn:model',
      retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 4, filter: { equals: { key: 'department', value: 'infrastructure' } } } },
    });
  });

  test('an answer without citations or text still has a defined shape', async () => {
    const { client } = fakeClient({});
    expect(await new Rag(client, config).ask({ question: 'q' })).toEqual({ answer: '', sessionId: undefined, citations: [] });
  });
});

describe('Rag.search', () => {
  test('returns the retrieved chunks with their scores and sources', async () => {
    const { client, calls } = fakeClient({ retrievalResults: [{ content: { text: 'c1' }, score: 0.81, location: { s3Location: { uri: 's3://b/a.md' } }, metadata: { doc: 'a' } }, { content: { text: 'c2' } }] });
    const result = await new Rag(client, config).search({ question: 'q', maxResults: 2 });
    expect(result.results).toEqual([
      { source: 's3://b/a.md', text: 'c1', score: 0.81, metadata: { doc: 'a' } },
      { source: 'unknown', text: 'c2', score: undefined, metadata: {} },
    ]);
    expect(calls[0].name).toBe('RetrieveCommand');
    expect(calls[0].input.retrievalConfiguration.vectorSearchConfiguration.numberOfResults).toBe(2);
  });
});
