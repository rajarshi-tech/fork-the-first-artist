/**
 * Tool registry — provider-neutral.
 *
 * ## Why the steward runs the tool loop, not the provider
 *
 * The `ModelProvider` interface only turns messages into text + tool calls. **This**
 * file decides what a tool call actually does. That split means a model with native
 * tool calling (OpenAI, Anthropic, Gemini) and one without (the fake provider, a
 * local model that only does JSON) behave identically:
 *
 * ```
 *   declarations out ──► model returns JSON calls ──► registry executes ──► result as a message
 * ```
 *
 * ## v0 is deliberately tiny, and deliberately read-only
 *
 * Every tool here is **read-only or arithmetic. No tool can move money.**
 *
 * That is a security property, not an omission. Payments are made by the steward's
 * own wallet in `rails/payer.ts`, driven by the *steward's* control flow — never by a
 * model choosing to call a `pay()` tool. It removes an entire class of prompt-injection
 * risk: the worst a jailbroken model can do here is read the public bio and do
 * arithmetic.
 */
import type { ArtistProfile, ToolDeclaration } from './types.ts';

export interface ToolContext {
  artist: ArtistProfile;
  paymentsUrl?: string;
  /** injected in tests */
  fetchImpl?: typeof fetch;
}

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ToolExecResult {
  ok: boolean;
  output: unknown;
  latencyMs: number;
}

/** Kept in sync with `payments/src/config.ts` defaults; the split is the product promise. */
const SPLIT_ARTIST_BPS = 9631n;
const SPLIT_AGENT_BPS = 369n;

export class ToolRegistry {
  private readonly handlers = new Map<string, { decl: ToolDeclaration; run: ToolHandler }>();

  /** Fluent registration, so `defaultTools()` reads as a list. */
  register(decl: ToolDeclaration, run: ToolHandler): this {
    this.handlers.set(decl.name, { decl, run });
    return this;
  }

  names(): string[] {
    return [...this.handlers.keys()];
  }

  /** Declarations for the tools a request actually asked for (all when omitted). */
  declarations(names?: string[]): ToolDeclaration[] {
    const wanted = names ? new Set(names) : null;
    return [...this.handlers.values()]
      .filter((h) => !wanted || wanted.has(h.decl.name))
      .map((h) => h.decl);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /**
   * Execute one call.
   *
   * A thrown handler never propagates: a model that asks for a tool with malformed
   * arguments should get `{ ok: false, output: { error } }` and continue, not crash
   * the run. The error text is returned to the model, which can then correct itself.
   */
  async execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolExecResult> {
    const started = Date.now();
    const handler = this.handlers.get(name);
    if (!handler) {
      // a model can hallucinate a tool name; say so instead of throwing
      return { ok: false, output: { error: `unknown tool ${name}` }, latencyMs: 0 };
    }
    try {
      const output = await handler.run((input ?? {}) as Record<string, unknown>, ctx);
      return { ok: true, output, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        output: { error: (err as Error).message },
        latencyMs: Date.now() - started,
      };
    }
  }
}

/**
 * The demo toolset.
 *
 * Note the descriptions: they are **prompt text the model reads**, so each one states
 * its constraint ("Never invent titles"). A description is part of the safety surface.
 */
export function defaultTools(): ToolRegistry {
  const reg = new ToolRegistry();

  reg.register(
    {
      name: 'get_artist_profile',
      description:
        "Read the artist's public profile: name, bio, ENS name, payout account.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => ({
      name: ctx.artist.name,
      bio: ctx.artist.bio,
      ensName: ctx.artist.ensName,
      hederaAccount: ctx.artist.hederaAccount,
    }),
  );

  reg.register(
    {
      name: 'get_songs',
      description: "List the artist's songs exactly as published. Never invent titles.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_input, ctx) => ({ songs: ctx.artist.songs }),
  );

  reg.register(
    {
      name: 'quote_tip',
      description:
        'Compute how a tip splits between the artist and the agent compute share (96.31% / 3.69%).',
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'string', description: 'amount in the payment asset, e.g. "0.10"' },
          decimals: { type: 'number', description: 'asset decimals, default 6' },
        },
        required: ['amount'],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const decimals = typeof input.decimals === 'number' ? input.decimals : 6;

      // Prefer the LIVE payments service, so the number the fan is shown is
      // computed by the same code that will charge them. A disagreement between
      // two implementations of the split is exactly the bug we cannot afford.
      if (ctx.paymentsUrl) {
        try {
          const doFetch = ctx.fetchImpl ?? fetch;
          const res = await doFetch(
            `${ctx.paymentsUrl}/split-preview?amount=${encodeURIComponent(String(input.amount))}`,
            { signal: AbortSignal.timeout(5_000) },
          );
          if (res.ok) return (await res.json()) as unknown;
        } catch {
          // Fall through to local arithmetic. A fan question must not fail because
          // the payments service is briefly unavailable; the local result is
          // marked `source: 'local'` so the difference is visible.
        }
      }

      // Local fallback: the same algorithm as payments/src/split.ts — floor the
      // agent share, subtract for the artist, never use a float.
      const amount = typeof input.amount === 'string' ? input.amount : '0.10';
      const [whole, frac = ''] = amount.split('.');
      const atomic = BigInt(`${whole || '0'}${(frac + '0'.repeat(decimals)).slice(0, decimals)}`);
      const agent = (atomic * SPLIT_AGENT_BPS) / 10_000n;
      const artist = atomic - agent;
      return {
        amount,
        artistAtomic: artist.toString(),
        agentAtomic: agent.toString(),
        artistPct: 96.31,
        agentPct: 3.69,
        source: 'local',
      };
    },
  );

  return reg;
}
