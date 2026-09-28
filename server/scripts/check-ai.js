/**
 * Verifies your Cloudflare Workers AI credentials end to end.
 *   npm run check:ai
 * Needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the environment (or server/.env).
 */
import { createCloudflareAI } from '../src/lib/ai/cloudflare.js';

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !apiToken) {
  console.error('✖ Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN first.');
  process.exit(1);
}

const ai = createCloudflareAI({
  accountId,
  apiToken,
  embedModel: process.env.CF_AI_EMBED_MODEL || undefined,
  chatModel: process.env.CF_AI_CHAT_MODEL || undefined,
});

try {
  const t0 = Date.now();
  const [vec] = await ai.embed('Where is my order?');
  console.log(`✔ Embeddings OK: ${ai.models.embed} → ${vec.length} dims (${Date.now() - t0} ms)`);

  const t1 = Date.now();
  const reply = await ai.chat(
    [
      { role: 'system', content: 'You are a concise support agent for an online store.' },
      { role: 'user', content: 'In one sentence: how long does standard shipping usually take?' },
    ],
    { maxTokens: 60 },
  );
  console.log(`✔ Chat OK: ${ai.models.chat} (${Date.now() - t1} ms)\n  → ${reply}`);
  console.log('\nCloudflare Workers AI is ready for ChatWithUss.');
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
