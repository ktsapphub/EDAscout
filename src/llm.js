// Vendor-neutral model adapter. Every AI call in EDAScout goes through chat().
// Routes (cheapest first) live in D1 `model_routes`; Workers AI needs no key, any OpenAI-compatible
// provider (Gemini, OpenAI, xAI Grok, Groq, OmniRoute, Cloudflare AI Gateway, Anthropic compat) works by URL + key.

const routeCache = new Map();

async function getRoute(env, task) {
  if (routeCache.has(task)) return routeCache.get(task);
  const row = await env.DB.prepare('SELECT chain, max_tokens, daily_cap_calls FROM model_routes WHERE task = ?').bind(task).first();
  const route = row
    ? { chain: JSON.parse(row.chain), maxTokens: row.max_tokens, dailyCap: row.daily_cap_calls }
    : { chain: [{ provider: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct-fast' }], maxTokens: 400, dailyCap: 30 };
  routeCache.set(task, route);
  return route;
}

export function clearRouteCache() { routeCache.clear(); }

/** Budget guard shared by a run: { used, max }. */
export function budget(env) { return { used: 0, max: Number(env.MAX_LLM_CALLS_PER_RUN || 40) }; }

/**
 * chat(env, task, messages, { json, maxTokens, budget })
 * Returns { text, data, provider, model } or null when every option failed / budget is spent.
 * Escalates at most once: the first usable model, then the next usable one.
 */
export async function chat(env, task, messages, opts = {}) {
  const route = await getRoute(env, task);
  if (opts.budget && opts.budget.used >= opts.budget.max) return null;
  const usedToday = await env.DB.prepare("SELECT COUNT(*) n FROM llm_calls WHERE task = ? AND at >= date('now')").bind(task).first('n');
  if (usedToday >= route.dailyCap) return null;

  const usable = route.chain.filter(s => s.provider === 'workers-ai' ? !!env.AI : !!(s.key ? env[s.key] : true) && !!(s.base_url || env.AI_BASE_URL));
  const tries = usable.slice(0, 2);
  const maxTokens = opts.maxTokens || route.maxTokens;
  for (const step of tries) {
    if (opts.budget) opts.budget.used++;
    const t0 = Date.now();
    let text = '', usage = {}, error = null;
    try {
      ({ text, usage } = step.provider === 'workers-ai'
        ? await runWorkersAI(env, step.model, messages, maxTokens, opts.json)
        : await runOpenAICompat(env, step, messages, maxTokens, opts.json));
      const data = opts.json ? parseJson(text) : null;
      if (opts.json && data === null) throw new Error('invalid JSON');
      await log(env, task, step, usage, Date.now() - t0, 1, null);
      return { text, data, provider: step.provider, model: step.model };
    } catch (e) {
      error = String(e.message || e).slice(0, 300);
      await log(env, task, step, usage, Date.now() - t0, 0, error);
    }
  }
  return null;
}

async function runWorkersAI(env, model, messages, maxTokens, wantJson) {
  const input = { messages, max_tokens: maxTokens, temperature: 0.2 };
  if (wantJson) input.response_format = { type: 'json_object' };
  let out;
  try { out = await env.AI.run(model, input); }
  catch (e) {
    if (!wantJson) throw e;
    delete input.response_format;           // some models reject JSON mode; fall back to plain text + our parser
    out = await env.AI.run(model, input);
  }
  const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out;
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  return { text, usage: out?.usage || {} };
}

async function runOpenAICompat(env, step, messages, maxTokens, wantJson) {
  const base = (step.base_url || env.AI_BASE_URL).replace(/\/$/, '');
  const body = { model: step.model, messages, max_tokens: maxTokens, temperature: 0.2 };
  if (wantJson) body.response_format = { type: 'json_object' };
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(step.key && env[step.key] ? { authorization: `Bearer ${env[step.key]}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = await res.json();
  return { text: out.choices?.[0]?.message?.content || '', usage: out.usage || {} };
}

export function parseJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').replace(/```(?:json)?/g, '');
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start], close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

async function log(env, task, step, usage, ms, ok, error) {
  await env.DB.prepare('INSERT INTO llm_calls (task, provider, model, tokens_in, tokens_out, latency_ms, ok, error) VALUES (?,?,?,?,?,?,?,?)')
    .bind(task, step.provider, step.model, usage.prompt_tokens ?? null, usage.completion_tokens ?? null, ms, ok, error).run().catch(() => {});
}
