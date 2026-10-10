// Operator-side check: creates a session in the self_hosted environment.
// When the session starts, Anthropic delivers `session.status_run_started` to the webhook and the
// launcher starts one MicroVM. Run it from the operator's machine only: it needs the organization API key,
// which must never be placed on AWS compute.
//
//   ANTHROPIC_API_KEY=sk-ant-... ANTHROPIC_ENVIRONMENT_ID=env_... AGENT_ID=agent_... \
//     node scripts/create-session.mjs ["first user message"]
import Anthropic from '@anthropic-ai/sdk';

const { ANTHROPIC_API_KEY, ANTHROPIC_ENVIRONMENT_ID, AGENT_ID } = process.env;
for (const [name, value] of Object.entries({ ANTHROPIC_API_KEY, ANTHROPIC_ENVIRONMENT_ID, AGENT_ID })) {
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const session = await client.beta.sessions.create({ agent: AGENT_ID, environment_id: ANTHROPIC_ENVIRONMENT_ID });
console.log(`created session ${session.id}`);

const message = process.argv[2];
if (message) {
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }],
  });
  console.log('sent the first user message');
}
