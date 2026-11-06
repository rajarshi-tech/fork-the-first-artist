/**
 * Provider config + adapter tests (step 08).
 *
 * Step 08 is the provider abstraction, so these tests answer one question:
 * **is provider choice really just configuration?** They check that the shipped
 * catalog is valid, that a broken catalog is refused loudly, that availability is
 * reported rather than hidden, and that each adapter translates its vendor's wire
 * format into the same normalized request/response.
 *
 * Adapter tests use an injected `fetchImpl`, so no network, no keys, no cost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { loadAgentConfig, providerAvailability } from '../src/config.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { GoogleProvider } from '../src/providers/google.ts';
import { FakeProvider } from '../src/providers/fake.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import type { NormalizedChatRequest } from '../src/types.ts';

const baseReq: NormalizedChatRequest = {
  model: 'test-model',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'who is the artist?' },
  ],
  temperature: 0.4,
  maxTokens: 100,
};

/** Capture the request the adapter built, and hand back a canned body. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'x-0g-request-id': 'req-from-header' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// --------------------------------------------------------------------------- config

test('config: ships a valid default provider catalog', () => {
  const cfg = loadAgentConfig();
  assert.equal(cfg.default, '0g');
  assert.equal(cfg.rail, 'hedera');

  const p = cfg.providers['0g'];
  assert.equal(p.kind, 'inference');
  // the demo path: 0G is reached through the paid meter, not directly
  assert.equal(p.transport, 'x402-meter');
  assert.deepEqual(p.extensions, { verify_tee: true });
  assert.equal(p.headers?.['X-0G-Provider-Trust-Mode'], 'verified');

  // fallback must be OFF for the demo: 0G must be the only inference path on stage
  assert.equal(cfg.fallback.enabled, false);
  assert.ok(cfg.budget.maxUsdTotal > 0 && cfg.budget.maxUsdTotal <= 5);
});

test('config: every inference provider is described as data, with no secret', () => {
  const cfg = loadAgentConfig();
  for (const [id, p] of Object.entries(cfg.providers)) {
    if (p.kind === 'rail') continue;
    // envKey is a NAME, never a value — config files are committed
    if (p.envKey) assert.match(p.envKey, /^[A-Z0-9_]+$/, `${id}.envKey must be an env var name`);
    assert.ok(p.baseUrl, `${id} needs a baseUrl`);
    assert.ok(p.defaultModel, `${id} needs a defaultModel`);
    assert.equal(
      JSON.stringify(p).match(/sk-[a-zA-Z0-9]{10,}/),
      null,
      `${id} must not embed a key`,
    );
  }
});

test('config: rejects a default provider that is not configured', () => {
  const cfg = loadAgentConfig();
  const broken = { ...cfg, default: 'nope' as never };
  const path = 'data/__broken-default.json';
  writeFileSync(path, JSON.stringify(broken));
  try {
    assert.throws(() => loadAgentConfig(path), /is not in providers/);
  } finally {
    unlinkSync(path);
  }
});

test('config: rejects an unknown capability, rather than silently disabling a feature', () => {
  const cfg = loadAgentConfig();
  const broken = {
    ...cfg,
    providers: {
      ...cfg.providers,
      openai: { ...cfg.providers['openai']!, capabilities: ['tools', 'telekinesis'] },
    },
  };
  const path = 'data/__broken-cap.json';
  writeFileSync(path, JSON.stringify(broken));
  try {
    assert.throws(() => loadAgentConfig(path), /unknown capability telekinesis/);
  } finally {
    unlinkSync(path);
  }
});

test('config: env tightens a budget without editing the committed config', () => {
  const before = process.env.BUDGET_TOTAL_USD;
  process.env.BUDGET_TOTAL_USD = '0.25';
  try {
    const cfg = loadAgentConfig();
    assert.equal(cfg.budget.maxUsdTotal, 0.25);
  } finally {
    if (before === undefined) delete process.env.BUDGET_TOTAL_USD;
    else process.env.BUDGET_TOTAL_USD = before;
  }
});

test('providerAvailability: a missing key is reported, not hidden', () => {
  const cfg = loadAgentConfig();
  const before = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const avail = providerAvailability(cfg.providers['openai']!);
    assert.equal(avail.usable, false);
    assert.match(avail.reason ?? '', /OPENAI_API_KEY/);
  } finally {
    if (before !== undefined) process.env.OPENAI_API_KEY = before;
  }
  // the meter provider needs a wallet, not a vendor API key — the agent never
  // holds an upstream key, which is the architectural point
  assert.equal(providerAvailability(cfg.providers['0g']!).usable, true);
});

// --------------------------------------------------------------------------- registry

test('registry: an unknown provider names the ones that exist', () => {
  const cfg = loadAgentConfig();
  const registry = new ProviderRegistry(cfg, { forceFake: true });
  assert.throws(() => registry.get('nope' as never), /unknown provider "nope"; configured:/);
});

test('registry: a rail entry is not an inference provider', () => {
  const cfg = loadAgentConfig();
  const registry = new ProviderRegistry(cfg, { forceFake: true });
  assert.throws(() => registry.get('hedera' as never), /is a rail, not an inference provider/);
});

test('registry: a configured provider with no key refuses to run — never a silent swap', () => {
  const cfg = loadAgentConfig();
  const before = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const registry = new ProviderRegistry(cfg, {});
    // the error must say which provider and which variable, not fall back to 0G
    assert.throws(() => registry.get('openai'), /openai: OPENAI_API_KEY is not set/);
  } finally {
    if (before !== undefined) process.env.OPENAI_API_KEY = before;
  }
});

test('registry: forceFake is the only way to get the offline provider', () => {
  const cfg = loadAgentConfig();
  const registry = new ProviderRegistry(cfg, { forceFake: true });
  assert.ok(registry.get('0g') instanceof FakeProvider);
});

// --------------------------------------------------------------------------- adapters

test('openai adapter: baseline shape, and direct-transport 0G provenance comes from x_0g_trace', async () => {
  const { impl, calls } = stubFetch({
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    x_0g_trace: { request_id: 'trace-id', tee_verified: true },
  });
  const p = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://router.example/v1',
    apiKey: 'k',
    defaultModel: 'm',
    transport: 'direct',
    capabilities: ['tools', 'json'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
    headers: { 'X-0G-Provider-Trust-Mode': 'verified' },
    extensions: { verify_tee: true },
    fetchImpl: impl,
  });

  const out = await p.chat(baseReq);
  assert.equal(out.text, 'hello');
  assert.deepEqual(out.usage, { inputTokens: 10, outputTokens: 5 });
  // On the DIRECT transport the adapter reads provenance from the response body's
  // x_0g_trace block only — it does not consult the response header. That is
  // correct: a direct call is not paid through our meter, so there is no payment
  // tx to bind, and the trace block is what 0G documents for a direct call.
  assert.equal(out.provenance.requestId, 'trace-id');
  assert.equal(out.provenance.teeVerified, true);
  // and no payment is claimed, because the agent paid nobody on this path
  assert.equal(out.provenance.paymentTxId, undefined);

  const sent = JSON.parse(String(calls[0]!.init.body));
  // 0G extension and trust-mode header are passed verbatim
  assert.equal(sent.verify_tee, true);
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-0G-Provider-Trust-Mode'], 'verified');
});

test('openai adapter: tool calls are normalized to {id,name,input}', async () => {
  const { impl } = stubFetch({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'get_songs', arguments: '{"x":1}' } }],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const p = new OpenAICompatibleProvider({
    id: 'openai',
    baseUrl: 'https://api.example/v1',
    apiKey: 'k',
    defaultModel: 'm',
    transport: 'direct',
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
    fetchImpl: impl,
  });
  const out = await p.chat(baseReq);
  assert.deepEqual(out.toolCalls, [{ id: 'c1', name: 'get_songs', input: { x: 1 } }]);
});

test('anthropic adapter: system goes top-level and tools use input_schema', async () => {
  const { impl, calls } = stubFetch({
    content: [{ type: 'text', text: 'hi from claude' }],
    usage: { input_tokens: 7, output_tokens: 3 },
  });
  const p = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'k',
    defaultModel: 'claude',
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 3, output: 15 },
    fetchImpl: impl,
  });
  const out = await p.chat({
    ...baseReq,
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  });

  assert.equal(out.text, 'hi from claude');
  assert.deepEqual(out.usage, { inputTokens: 7, outputTokens: 3 });

  const sent = JSON.parse(String(calls[0]!.init.body));
  // the two vendor differences we hide: top-level system, and the anthropic
  // tool schema key name
  assert.equal(sent.system, 'be brief');
  assert.equal(sent.messages.length, 1, 'system must not appear as a message');
  assert.equal(sent.tools[0].input_schema.type, 'object');
});

test('anthropic adapter: a tool_result block is emitted for tool messages', async () => {
  const { impl, calls } = stubFetch({ content: [{ type: 'text', text: 'ok' }], usage: {} });
  const p = new AnthropicProvider({
    id: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'k',
    defaultModel: 'claude',
    capabilities: ['tools'],
    priceUsdPerMTok: { input: 3, output: 15 },
    fetchImpl: impl,
  });
  await p.chat({
    ...baseReq,
    messages: [
      { role: 'user', content: 'q' },
      { role: 'tool', content: '{"songs":[]}', toolCallId: 'c1', toolName: 'get_songs' },
    ],
  });
  const sent = JSON.parse(String(calls[0]!.init.body));
  const last = sent.messages.at(-1);
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'c1');
});

test('google adapter: contents/parts and functionDeclarations', async () => {
  const { impl, calls } = stubFetch({
    candidates: [{ content: { parts: [{ text: 'hi from gemini' }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  });
  const p = new GoogleProvider({
    id: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'k',
    defaultModel: 'gemini-2.5-flash',
    capabilities: ['tools', 'json'],
    priceUsdPerMTok: { input: 0.1, output: 0.4 },
    fetchImpl: impl,
  });
  const out = await p.chat({
    ...baseReq,
    tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  });

  assert.equal(out.text, 'hi from gemini');
  assert.deepEqual(out.usage, { inputTokens: 5, outputTokens: 2 });

  const sent = JSON.parse(String(calls[0]!.init.body));
  assert.ok(Array.isArray(sent.contents));
  assert.equal(sent.tools[0].functionDeclarations[0].name, 't');
  // gemini's system instruction is its own field, not a message
  assert.ok(sent.systemInstruction);
});

test('fake provider: reports itself as fake so a demo cannot mistake it for real', async () => {
  const p = new FakeProvider('fake-1');
  const out = await p.chat(baseReq);
  assert.match(out.text, /dev-mock|fake/i);
  assert.ok(out.usage.inputTokens > 0);
  // A fake call must never claim a payment or a TEE attestation. Its request id is
  // prefixed `fake-` rather than `dev-`: `dev-` belongs to the meter's offline
  // upstream, and the two must be distinguishable in a ledger.
  assert.equal(out.provenance.paymentTxId, undefined);
  assert.equal(out.provenance.teeVerified, null);
  assert.match(out.provenance.requestId ?? '', /^fake-req-/);
});

test('openai adapter on the meter transport: provenance comes from x_meter and binds a payment', async () => {
  // This is the demo path. The x_meter block is what the payments meter attaches,
  // and it is the only thing that carries BOTH the 0G request id and the Hedera
  // payment tx id — the pair that is the submission artifact.
  const { impl } = stubFetch({
    choices: [{ message: { role: 'assistant', content: 'metered answer' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
    x_meter: {
      paymentTxId: '0.0.1234@1762400000.000000001',
      hcsTxId: '0.0.5678@1762400000.000000002',
      upstream: { requestId: '0g-req-xyz', teeVerified: true },
    },
  });

  // The payer is only consulted when actually paying; a stub that returns a
  // signed header is enough here because no real settlement happens.
  // The real Payer interface is `{ kind, accountId?, fetch(url, init) }`: paying is
  // an HTTP concern, so the payer is a fetch wrapper that attaches X-PAYMENT.
  const payer = {
    kind: 'mock' as const,
    accountId: '0.0.6666',
    fetch: impl,
  } as unknown as import('../src/rails/payer.ts').Payer;

  const p = new OpenAICompatibleProvider({
    id: '0g',
    baseUrl: 'https://meter.local/v1',
    defaultModel: 'm',
    transport: 'x402-meter',
    capabilities: ['json'],
    priceUsdPerMTok: { input: 0.2, output: 0.8 },
    meter: { url: 'https://meter.local/v1/chat/completions', payer },
    fetchImpl: impl,
  });

  const out = await p.chat(baseReq);
  assert.equal(out.text, 'metered answer');
  // the payment tx and the upstream request id arrive TOGETHER, from one block
  assert.equal(out.provenance.paymentTxId, '0.0.1234@1762400000.000000001');
  assert.equal(out.provenance.requestId, '0g-req-xyz');
  assert.equal(out.provenance.teeVerified, true);
  assert.equal(out.provenance.hcsTxId, '0.0.5678@1762400000.000000002');
});
