/**
 * The contract — and the whole point of the `agent/` package.
 *
 * ## One interface, many providers
 *
 * The product requirement was literally this: *"a configuration for the choice of
 * agent/provider (gemini, anthropic, openai, 0g, hedera and so on), and then an
 * interface which encapsulates the providers and abstracts the choice."*
 *
 * That is what this file is. Callers write:
 *
 * ```ts
 * const out = await steward.run({
 *   provider: '0g',                  // or omit for the configured default
 *   instruction: 'Greet a fan.',
 *   tools: ['get_artist_profile'],
 *   output: mySchema,                // optional structured output
 *   budget: { maxUsd: 0.002 },
 * });
 * ```
 *
 * and get the same envelope back regardless of vendor.
 *
 * ## The rule that keeps it honest
 *
 * Everything **above** `src/providers/` speaks only these types. No vendor shapes,
 * no SDK types, no `any` leaking upward. An adapter's job is to translate; the
 * moment a vendor quirk escapes into `steward.ts`, the abstraction has failed and
 * swapping providers stops being a config change.
 *
 * Vendor differences the adapters are responsible for:
 *
 * | Vendor | Quirk the adapter hides |
 * |---|---|
 * | OpenAI / 0G | near-baseline; tools are function objects in a `tools` array |
 * | Anthropic | `system` is a **top-level** field, content is a **block array**, tool results are `tool_result` blocks |
 * | Gemini | `contents`/`parts`, tools are `functionDeclarations`, JSON mode is `responseSchema` |
 */

// ---------------------------------------------------------------- ids and small unions

/** Inference providers. Chosen in config, never hard-coded in logic. */
export type ProviderId = '0g' | 'openai' | 'anthropic' | 'gemini' | 'local';

/** The money/audit rail. Not a model. */
export type RailId = 'hedera' | 'none';

export type Capability = 'tools' | 'json' | 'vision' | 'stream';

/**
 * How the steward reaches inference.
 *
 * - `x402-meter` — through `payments/`'s per-call meter, so the **agent pays for
 *   its own inference**. This is the demo path and the 0G sponsor requirement.
 * - `direct` — straight to the vendor. Local dev only; the agent would be spending
 *   someone else's API key, which is not the story we are telling.
 */
export type Transport = 'direct' | 'x402-meter';

/** The degradation ladder, applied in this order when budget is tight. */
export type Degradation = 'cheaper-model' | 'shorter-max-tokens' | 'template-reply';

/**
 * Every way a run can fail, as a closed set.
 *
 * A closed set is deliberate: the paywall (a separate service) switches on these
 * codes, so adding a new failure mode forces a compile error at the consumer rather
 * than a string that silently falls through to a generic 500.
 */
export type ErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'SPEND_CAP_EXCEEDED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'SCHEMA_MISMATCH'
  | 'PAYMENT_FAILED'
  | 'NO_CONSENT'
  | 'TIMEOUT'
  | 'BAD_REQUEST';

// ---------------------------------------------------------------- provider config

/**
 * One provider, described entirely as data.
 *
 * This type is why "switch provider" is a config edit: it contains no behaviour,
 * only the facts an adapter needs. `kind: 'rail'` entries describe the money side
 * and are skipped by the registry's model lookup.
 */
export interface ProviderConfig {
  kind: 'inference' | 'rail';
  label: string;
  /** which adapter family handles the wire format */
  sdk: 'openai' | 'anthropic' | 'google' | 'none';
  baseUrl: string;
  /**
   * Name of the env var holding the key — a **name**, never a key. Config files are
   * committed; secrets are not.
   */
  envKey?: string;
  defaultModel: string;
  transport: Transport;
  headers?: Record<string, string>;
  /** provider extensions passed verbatim, e.g. 0G's `verify_tee` */
  extensions?: Record<string, unknown>;
  capabilities: Capability[];
  /** used to estimate spend *before* a call when the provider reports nothing */
  priceFallbackUsdPerMTok?: { input: number; output: number };
  /** `true` for providers that exist to prove portability, not for the demo */
  devOnly?: boolean;
}

/** The whole registry, as loaded from `config/providers.json`. */
export interface AgentConfig {
  version: number;
  /** used when a request names no provider */
  default: ProviderId;
  rail: RailId;
  /**
   * Off by default. When on it must be **explicit**: the result envelope carries a
   * `degradation` marker. See `providers/registry.ts` for why silent substitution
   * is forbidden.
   */
  fallback: { enabled: boolean; chain: string[] };
  providers: Record<string, ProviderConfig>;
  generation: { temperature: number; maxTokens: number; maxToolTurns: number };
  budget: { maxUsdPerRequest: number; maxUsdPerHour: number; maxUsdTotal: number };
}

// ---------------------------------------------------------------- requests

/**
 * What the artist has agreed to share. The steward answers **only** from this.
 *
 * There is no scraping and no fetch: the type is the whole world the model is
 * allowed to know about the artist, which is how "consent first" is enforced in
 * code rather than in policy.
 */
export interface ArtistProfile {
  name: string;
  bio: string;
  songs: string[];
  ensName?: string;
  hederaAccount?: string;
  /** `false`/absent must stop the steward from answering at all */
  consent?: boolean;
}

export interface AgentContext {
  artist: ArtistProfile;
  fan?: { handle?: string; wallet?: string };
}

/**
 * Structured output. Providing one turns the reply into validated data instead of
 * prose, and the steward will spend at most one repair turn getting there.
 */
export interface OutputSchema<T> {
  /** validate + narrow the model's JSON */
  parse(value: unknown): T;
  /** optional JSON schema handed to the model in JSON mode */
  jsonSchema?: Record<string, unknown>;
  name?: string;
}

/** One run. Everything is optional except the instruction. */
export interface AgentRunRequest<T = unknown> {
  instruction: string;
  /** overrides `config.default` for this call only */
  provider?: ProviderId;
  model?: string;
  context?: Partial<AgentContext>;
  /** tool names to expose; unknown names are rejected before any model call */
  tools?: string[];
  output?: OutputSchema<T>;
  budget?: { maxUsd?: number };
}

// ---------------------------------------------------------------- responses

/**
 * Where the answer came from — the block that makes a claim checkable.
 *
 * `requestId` + `paymentTxId` together are the submission artifact: one payment
 * bound to one inference. `teeVerified` says whether 0G attested the run.
 */
export interface Provenance {
  /** 0G: `x_0g_trace.request_id` */
  requestId?: string;
  /** 0G: `x_0g_trace.tee_verified`; `null` = not reported */
  teeVerified?: boolean | null;
  /** Hedera x402 settlement transaction id (paid to the meter) */
  paymentTxId?: string;
  /** Hedera consensus log entry id */
  hcsTxId?: string | null;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  latencyMs: number;
}

/**
 * The single envelope every run returns.
 *
 * A discriminated union on `ok`, so `if (!res.ok)` narrows to the error shape and
 * a caller cannot forget to check. `degradation` is present only when the answer
 * was produced by something other than the requested path — and a caller must treat
 * that as "do not charge for this".
 */
export type AgentResult<T = unknown> =
  | {
      ok: true;
      reply: { text: string; data?: T };
      provider: ProviderId;
      model: string;
      usage: { inputTokens: number; outputTokens: number };
      costUsd: number;
      provenance: Provenance;
      toolCalls: ToolCallRecord[];
      degradation?: Degradation;
      latencyMs: number;
    }
  | { ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };

// ---------------------------------------------------------------- provider plumbing

export interface ModelInfo {
  id: string;
  capabilities: Capability[];
  priceUsdPerMTok?: { input: number; output: number };
}

export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * One conversation turn, vendor-neutral.
 *
 * `toolCallId` / `toolName` exist on `tool` messages because Anthropic and Gemini
 * both require a tool result to be attributed to the call that requested it, while
 * OpenAI uses a single id. Normalizing here means only the adapter has to know.
 */
export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** assistant messages only: the calls the model asked for, kept for history */
  toolCalls?: NormalizedToolCall[];
}

export interface NormalizedChatRequest {
  model: string;
  messages: NormalizedMessage[];
  tools?: ToolDeclaration[];
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
}

export interface NormalizedChatResponse {
  text: string;
  toolCalls?: NormalizedToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  provenance: Provenance;
  /** vendor payload, for debugging only — nothing above the adapter reads it */
  raw?: unknown;
}

/**
 * What every adapter implements.
 *
 * Deliberately small: four required members and two optional. Every method added
 * here is one every provider must be able to answer, so the interface stays at the
 * level of "send messages, get text and calls back".
 */
export interface ModelProvider {
  readonly id: ProviderId;
  readonly model: string;
  readonly transport: Transport;
  supports(cap: Capability): boolean;
  /** estimate spend before a call, so the budget gate can decide */
  estimateCost(req: NormalizedChatRequest): number;
  /** exact cost of a finished call, when the provider reports usage */
  costOf?(usage: { inputTokens: number; outputTokens: number }): number;
  chat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
}

/**
 * The interface the rest of the project calls. One method, plus a description for
 * `/health` and the docs.
 */
export interface AgentInterface {
  run<T = unknown>(req: AgentRunRequest<T>): Promise<AgentResult<T>>;
  describe(): {
    provider: ProviderId;
    model: string;
    transport: Transport;
    rail: RailId;
    tools: string[];
    capabilities: Capability[];
  };
}
