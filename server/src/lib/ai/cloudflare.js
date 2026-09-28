/**
 * Cloudflare Workers AI client (REST).
 *   POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}
 *
 * - embed(): BGE-M3 → 1024-dim vectors (matches knowledge_chunks.embedding vector(1024)),
 *   multilingual, 60k-token context. Batched, order-preserving.
 * - chat(): instruction model (default Llama 3.3 70B FP8 fast) → plain text answer.
 * Retries 429/5xx/network with exponential backoff.
 */

export const EMBED_DIMENSIONS = 1024;
export const DEFAULT_EMBED_MODEL = '@cf/baai/bge-m3';
export const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class CloudflareAIError extends Error {
  constructor(message, { status = 0, errors = null, retryable = false } = {}) {
    super(message);
    this.name = 'CloudflareAIError';
    this.status = status;
    this.errors = errors;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createCloudflareAI({
  accountId,
  apiToken,
  embedModel = DEFAULT_EMBED_MODEL,
  chatModel = DEFAULT_CHAT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  maxAttempts = 4,
  batchSize = 32,
  sleepImpl = sleep,
}) {
  if (!accountId || !apiToken) throw new Error('Cloudflare AI needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/`;

  async function run(model, input) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(base + model, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw new CloudflareAIError(`Workers AI unreachable: ${err.message}`, { retryable: true });
        await sleepImpl(backoff(attempt));
        continue;
      }

      const body = await res.json().catch(() => null);

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) {
          throw new CloudflareAIError(`Workers AI ${res.status} after ${attempt} attempts`, { status: res.status, errors: body?.errors, retryable: true });
        }
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleepImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }

      if (!res.ok || !body || body.success === false) {
        const msg = body?.errors?.map((e) => e?.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
        const hint = res.status === 401 || res.status === 403 ? ' (check CLOUDFLARE_API_TOKEN has the "Workers AI" permission and CLOUDFLARE_ACCOUNT_ID is right)' : '';
        throw new CloudflareAIError(`Workers AI error: ${msg}${hint}`, { status: res.status, errors: body?.errors });
      }
      return body.result;
    }
  }

  /** @param {string|string[]} input  → number[][] (one 1024-dim vector per input, same order) */
  async function embed(input) {
    const texts = (Array.isArray(input) ? input : [input]).map((t) => String(t ?? ''));
    if (!texts.length) return [];
    const vectors = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const result = await run(embedModel, { text: batch, truncate_inputs: true });
      const data = result?.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new CloudflareAIError(`Embedding count mismatch: sent ${batch.length}, got ${Array.isArray(data) ? data.length : 'none'}`);
      }
      for (const v of data) {
        if (!Array.isArray(v) || v.length !== EMBED_DIMENSIONS) {
          throw new CloudflareAIError(`Expected ${EMBED_DIMENSIONS}-dim embeddings from ${embedModel}, got ${Array.isArray(v) ? v.length : typeof v}`);
        }
        vectors.push(v);
      }
    }
    return vectors;
  }

  /**
   * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
   * @returns {Promise<string>}
   */
  async function chat(messages, { maxTokens = 512, temperature = 0.2 } = {}) {
    if (!Array.isArray(messages) || !messages.length) throw new CloudflareAIError('chat() needs at least one message');
    const result = await run(chatModel, { messages, max_tokens: maxTokens, temperature });
    const out = result?.response;
    if (typeof out === 'string') return out.trim();
    if (out && typeof out === 'object') return JSON.stringify(out);
    throw new CloudflareAIError('Workers AI returned no response text');
  }

  return { embed, chat, models: { embed: embedModel, chat: chatModel } };
}

function backoff(attempt) {
  return Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}
