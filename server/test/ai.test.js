import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflareAI, CloudflareAIError, DEFAULT_EMBED_MODEL, DEFAULT_CHAT_MODEL } from '../src/lib/ai/cloudflare.js';

const vec = (seed) => Array.from({ length: 1024 }, (_, i) => (seed + i) / 10000);
const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeCF(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    return handler(url, body, calls.length);
  };
  return { fetchImpl, calls };
}

test('embed: correct endpoint/auth, batches in order, returns 1024-dim vectors', async () => {
  const cf = fakeCF((url, body) => ok({ shape: [body.text.length, 1024], data: body.text.map((t) => vec(Number(t.slice(1)))) }));
  const ai = createCloudflareAI({ accountId: 'acc123', apiToken: 'tok', fetchImpl: cf.fetchImpl, batchSize: 2 });
  const out = await ai.embed(['t0', 't1', 't2', 't3', 't4']);
  assert.equal(out.length, 5);
  assert.equal(out[3][0], vec(3)[0], 'order preserved across batches');
  assert.equal(cf.calls.length, 3);
  assert.equal(cf.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/${DEFAULT_EMBED_MODEL}`);
  assert.equal(cf.calls[0].headers.Authorization, 'Bearer tok');
  assert.equal(cf.calls[0].body.truncate_inputs, true);
  assert.deepEqual(await ai.embed([]), []);
});

test('embed: rejects wrong dimensions (would corrupt pgvector column)', async () => {
  const cf = fakeCF(() => ok({ shape: [1, 768], data: [Array(768).fill(0)] }));
  const ai = createCloudflareAI({ accountId: 'a', apiToken: 't', fetchImpl: cf.fetchImpl });
  await assert.rejects(ai.embed('x'), /1024-dim/);
});

test('chat: sends messages to Llama 3.3 and returns trimmed text', async () => {
  const cf = fakeCF(() => ok({ response: '  Usually 3–5 business days.  ', usage: { total_tokens: 20 } }));
  const ai = createCloudflareAI({ accountId: 'a', apiToken: 't', fetchImpl: cf.fetchImpl });
  const reply = await ai.chat([{ role: 'user', content: 'shipping?' }], { maxTokens: 50 });
  assert.equal(reply, 'Usually 3–5 business days.');
  assert.ok(cf.calls[0].url.endsWith(DEFAULT_CHAT_MODEL));
  assert.equal(cf.calls[0].body.max_tokens, 50);
  assert.equal(cf.calls[0].body.messages[0].content, 'shipping?');
});

test('retries 429/5xx then succeeds; auth errors fail fast with a hint', async () => {
  const sleeps = [];
  const cf = fakeCF((url, body, n) => (n <= 2 ? new Response('{}', { status: n === 1 ? 429 : 503 }) : ok({ response: 'hi' })));
  const ai = createCloudflareAI({ accountId: 'a', apiToken: 't', fetchImpl: cf.fetchImpl, sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal(await ai.chat([{ role: 'user', content: 'x' }]), 'hi');
  assert.equal(sleeps.length, 2);

  const denied = fakeCF(() => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 }));
  const ai2 = createCloudflareAI({ accountId: 'a', apiToken: 'bad', fetchImpl: denied.fetchImpl });
  await assert.rejects(ai2.chat([{ role: 'user', content: 'x' }]), (e) => e instanceof CloudflareAIError && /Workers AI.*permission/.test(e.message) && e.status === 403);
  assert.equal(denied.calls.length, 1, 'no retry on auth error');
});

test('requires credentials', () => {
  assert.throws(() => createCloudflareAI({ accountId: '', apiToken: 'x' }), /CLOUDFLARE_ACCOUNT_ID/);
});
