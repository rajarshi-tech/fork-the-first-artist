/**
 * Tiny `node:http` helpers — deliberately no framework.
 *
 * Two endpoints and a health check do not justify a dependency tree. Every extra
 * package is a line the repo owner's agent has to reproduce in his real repo, so
 * the rule for this project is: if it fits in a page and it is only used twice,
 * write it here.
 *
 * Everything in this file is small enough to read in full. That is the point.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** What a route handler receives. `body` is already parsed; `raw` is kept for debugging. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** parsed URL, so `?atomic=` etc. is available without re-parsing */
  url: URL;
  /** `undefined` when the body was empty or was not JSON */
  body: unknown;
  raw: string;
}

/**
 * Send a JSON response.
 *
 * `cache-control: no-store` is the default and is not optional: every response
 * from this service is per-payer (it contains settlement metadata), so a shared
 * cache storing one fan's answer and serving it to another would leak both the
 * content and the proof. Callers may override `headers`, but they have to do it
 * deliberately.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // explicit length so keep-alive works and clients do not wait for EOF
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * Read a request body with a hard size ceiling.
 *
 * The ceiling exists because this is a public-facing paid endpoint: an unbounded
 * body read is a trivial memory-exhaustion vector. 256 KB is far more than a fan
 * question needs and small enough to be harmless.
 *
 * @throws when the body exceeds `limitBytes`. Callers turn that into a 413.
 */
export async function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse JSON, returning `undefined` instead of throwing.
 *
 * A malformed body should produce a clean 400 from the handler, not an unhandled
 * rejection. An empty body is `undefined` (a GET has none) rather than an error.
 */
export function parseJson(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Case-insensitive header lookup that returns `undefined`, never `''`.
 *
 * `req.headers` lowercases names and may hand back a string array for repeated
 * headers; a missing header must be distinguishable from an empty one, because
 * "no X-PAYMENT" and "X-PAYMENT: ''" are different states.
 */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v || undefined;
}

/** Minimal structured logger. One JSON object per line, so `jq` and log shippers work. */
export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export const log: Logger = {
  info: (msg, extra) => console.log(JSON.stringify({ level: 'info', msg, ...extra })),
  warn: (msg, extra) => console.warn(JSON.stringify({ level: 'warn', msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ level: 'error', msg, ...extra })),
};
