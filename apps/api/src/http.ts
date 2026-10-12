import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError, type ZodType } from 'zod';
import { verifyToken, type AuthUser, type Role } from './auth';
import { env } from './env';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);

export interface Ctx {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Set for routes that need a signed-in user */
  user: AuthUser;
  /** Response status, 200 unless the handler changes it */
  status: number;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface RouteOptions {
  /** 'user' = a signed-in user (default), 'ingest' = tracker devices with the ingest key, 'none' = public */
  auth?: 'user' | 'ingest' | 'none';
  /** Roles allowed to call this route; any signed-in role when left out */
  roles?: Role[];
}

interface Route extends RouteOptions {
  method: string;
  parts: string[];
  handler: Handler;
}

/** Validate a request body or query with a zod schema, turning failures into a 400. */
export function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, opts: RouteOptions, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, ...opts });
  }
  get(path: string, opts: RouteOptions, h: Handler) {
    this.add('GET', path, opts, h);
  }
  post(path: string, opts: RouteOptions, h: Handler) {
    this.add('POST', path, opts, h);
  }
  patch(path: string, opts: RouteOptions, h: Handler) {
    this.add('PATCH', path, opts, h);
  }

  private match(method: string, pathname: string) {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = r.parts.every((p, i) => {
        if (p.startsWith(':')) {
          params[p.slice(1)] = decodeURIComponent(parts[i]);
          return true;
        }
        return p === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return pathMatched ? 'method' : null;
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', env.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-ingest-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const found = this.match(req.method ?? 'GET', url.pathname);
      if (found === null) throw notFound(`No route for ${url.pathname}`);
      if (found === 'method') throw new HttpError(405, `${req.method} is not allowed on ${url.pathname}`);
      const { route, params } = found;
      const ctx: Ctx = { req, params, query: url.searchParams, body: undefined, user: undefined as unknown as AuthUser, status: 200 };

      const auth = route.auth ?? 'user';
      if (auth === 'user') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const user = token ? verifyToken(token) : null;
        if (!user) throw new HttpError(401, 'Sign in first: send a valid token in the Authorization header');
        if (route.roles && !route.roles.includes(user.role)) throw new HttpError(403, `Your role (${user.role}) can't do this`);
        ctx.user = user;
      } else if (auth === 'ingest') {
        if (req.headers['x-ingest-key'] !== env.ingestKey) throw new HttpError(401, 'Wrong or missing x-ingest-key header');
      }

      if (req.method === 'POST' || req.method === 'PATCH') ctx.body = await readJson(req);
      const out = await route.handler(ctx);
      send(res, ctx.status, out ?? { ok: true });
    } catch (e) {
      if (e instanceof ZodError) {
        send(res, 400, { error: 'Some fields are missing or invalid', details: e.issues.map((i) => ({ field: i.path.join('.'), problem: i.message })) });
      } else if (e instanceof HttpError) {
        send(res, e.status, { error: e.message, details: e.details });
      } else if (isPgError(e) && e.code === '23505') {
        send(res, 409, { error: 'That already exists', details: e.detail });
      } else if (isPgError(e) && (e.code === '22P02' || e.code === '23503')) {
        send(res, 400, { error: 'An id in the request is not valid or does not exist', details: e.detail ?? e.message });
      } else {
        console.error(e);
        send(res, 500, { error: 'Something went wrong on the server' });
      }
    }
  }
}

function isPgError(e: unknown): e is { code: string; detail?: string; message: string } {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > env.maxBodyBytes) throw new HttpError(413, `Request body is larger than ${env.maxBodyBytes} bytes`);
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('The request body is not valid JSON');
  }
}
