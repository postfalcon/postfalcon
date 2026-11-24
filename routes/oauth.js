import express, { Router } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashToken } from '../lib/tokens.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { logProductEvent } from '../lib/activityLog.js';

// OAuth 2.1 authorization server for the remote MCP endpoint (/mcp), so connector-style
// clients — Claude.ai/Desktop/mobile custom connectors, ChatGPT, and anything else following
// the MCP authorization spec — can sign a user in rather than needing a pasted pf_ token.
// Hand-rolled like every other OAuth flow in this codebase. What a client does:
//   1. POST /mcp with no token -> 401 + WWW-Authenticate pointing at the resource metadata.
//   2. GET /.well-known/oauth-protected-resource/mcp -> "authorized by this server".
//   3. GET /.well-known/oauth-authorization-server -> the endpoints below.
//   4. POST /oauth/register (RFC 7591) -> a client_id. Open to anyone, as the spec expects.
//   5. Sends the user to GET /oauth/authorize (PKCE S256 required) -> log in if needed, then
//      the consent page; Allow posts to /api/oauth/consent, which hands back a one-time code.
//   6. POST /oauth/token swaps code + code_verifier for a 1-hour pfo_ access token and a
//      90-day pfr_ refresh token (rotated on every refresh). middleware/auth.js accepts pfo_
//      tokens everywhere a pf_ API token works, so the MCP tools need no changes.
// Users see and disconnect approved apps under Settings -> API access (/api/oauth/apps).

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
// Consent requests kept per session at once (several open tabs), oldest dropped first.
const MAX_PENDING = 5;

export function issuer() {
  return (process.env.BASE_URL || '').replace(/\/+$/, '');
}
export function mcpResourceUrl() {
  return `${issuer()}/mcp`;
}
export function resourceMetadataUrl() {
  return `${issuer()}/.well-known/oauth-protected-resource/mcp`;
}

function randomToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

function sameHash(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);

// https anywhere, http only to this machine (desktop/CLI clients listening on a loopback port),
// or an app's own private-use scheme (cursor://…, RFC 8252) — never a script-ish scheme.
function acceptableRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

// Exact match, except a loopback http redirect may use any port (RFC 8252 §7.3): native apps
// pick a free port each time they start.
function redirectUriRegistered(client, redirectUri) {
  if (client.redirect_uris.includes(redirectUri)) return true;
  let asked;
  try {
    asked = new URL(redirectUri);
  } catch {
    return false;
  }
  if (asked.protocol !== 'http:' || !LOOPBACK_HOSTS.has(asked.hostname)) return false;
  return client.redirect_uris.some((registered) => {
    try {
      const r = new URL(registered);
      return r.protocol === 'http:' && r.hostname === asked.hostname && r.pathname === asked.pathname && r.search === asked.search;
    } catch {
      return false;
    }
  });
}

async function findClient(clientId) {
  if (typeof clientId !== 'string' || !clientId) return null;
  const { rows } = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
  return rows[0] ?? null;
}

function oauthError(res, status, error, description) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

// validate() answers {error:'validation_failed'}; the OAuth endpoints must answer in RFC 6749's
// error shape instead, which clients parse — same idea, OAuth-shaped.
function validateOAuth(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      return oauthError(res, 400, 'invalid_request', `${issue.path.join('.') || 'body'}: ${issue.message}`);
    }
    req.body = result.data;
    next();
  };
}

// Registration and token calls come from the connector's servers (one IP for many users), so
// these limits are per IP but generous; the real protection is that nothing here is guessable.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
  skip: () => process.env.NODE_ENV === 'test',
});
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
  skip: () => process.env.NODE_ENV === 'test',
});

const registerSchema = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().max(100).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('none'),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

const authorizeQuerySchema = z.object({
  response_type: z.string(),
  client_id: z.string().max(200),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/, 'must be a base64url S256 challenge'),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
});

const tokenSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().max(200),
    redirect_uri: z.string().max(2000).optional(),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, 'invalid code_verifier'),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(200).optional(),
    resource: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().max(200),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(200).optional(),
    scope: z.string().optional(),
    resource: z.string().optional(),
  }),
]);

const revokeSchema = z.object({
  token: z.string().max(200),
  token_type_hint: z.string().optional(),
  client_id: z.string().max(200).optional(),
  client_secret: z.string().max(200).optional(),
});

const consentSchema = z.object({
  request_id: z.string().max(100),
  approve: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Public endpoints: discovery, registration, token, revocation. Mounted at the app root ahead
// of csrfProtection (none of these use a cookie), with open CORS for browser-based clients.
// ---------------------------------------------------------------------------------------------
const router = Router();
const openCors = cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version'] });
const formOrJson = [express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' })];

function protectedResourceMetadata(req, res) {
  res.json({
    resource: mcpResourceUrl(),
    authorization_servers: [issuer()],
    bearer_methods_supported: ['header'],
    resource_name: res.locals.siteName || 'Postfalcon',
    resource_documentation: `${issuer()}/api-docs`,
  });
}
router.get('/.well-known/oauth-protected-resource', openCors, protectedResourceMetadata);
router.get('/.well-known/oauth-protected-resource/mcp', openCors, protectedResourceMetadata);

router.get('/.well-known/oauth-authorization-server', openCors, (req, res) => {
  const base = issuer();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/api-docs`,
  });
});

router.options(['/oauth/register', '/oauth/token', '/oauth/revoke'], openCors);

router.post(
  '/oauth/register',
  openCors,
  registerLimiter,
  express.json({ limit: '16kb' }),
  validateOAuth(registerSchema),
  asyncHandler(async (req, res) => {
    const { redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: authMethod } = req.body;
    const bad = redirectUris.find((uri) => !acceptableRedirectUri(uri));
    if (bad) {
      return oauthError(res, 400, 'invalid_redirect_uri', `Redirect URI not allowed: ${bad.slice(0, 200)}`);
    }

    // Registrations nobody ever approved are clutter (anyone can register): drop week-old ones.
    await pool.query(
      `DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < now() - interval '7 days'`
    );

    const clientId = `pfc_${crypto.randomBytes(16).toString('hex')}`;
    const clientSecret = authMethod === 'none' ? null : randomToken('pfs_');
    const { rows } = await pool.query(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris)
       VALUES ($1, $2, $3, $4) RETURNING created_at`,
      [clientId, clientSecret ? hashToken(clientSecret) : null, clientName || null, redirectUris]
    );

    res.set('Cache-Control', 'no-store');
    res.status(201).json({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(new Date(rows[0].created_at).getTime() / 1000),
      client_name: clientName || undefined,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: authMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  })
);

// The client credentials from a token/revoke request: HTTP Basic or form fields.
function clientCredentials(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const i = decoded.indexOf(':');
    if (i > 0) {
      return {
        clientId: decodeURIComponent(decoded.slice(0, i)),
        clientSecret: decodeURIComponent(decoded.slice(i + 1)),
      };
    }
  }
  return { clientId: req.body.client_id, clientSecret: req.body.client_secret };
}

// null = authentication failed. A public client needs no secret; a confidential one must send it.
async function authenticateClient(req) {
  const { clientId, clientSecret } = clientCredentials(req);
  const client = await findClient(clientId);
  if (!client) return null;
  if (client.client_secret_hash) {
    if (!clientSecret || !sameHash(hashToken(clientSecret), client.client_secret_hash)) return null;
  }
  return client;
}

function pkceMatches(verifier, challenge) {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return sameHash(computed, challenge);
}

async function issueTokens({ clientId, userId, scope }) {
  const accessToken = randomToken('pfo_');
  const refreshToken = randomToken('pfr_');
  await pool.query(
    `INSERT INTO oauth_tokens (client_id, user_id, access_token_hash, access_expires_at,
                               refresh_token_hash, refresh_expires_at, scope)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5, $6, $7)`,
    [clientId, userId, hashToken(accessToken), ACCESS_TTL_SECONDS, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), scope]
  );
  return { accessToken, refreshToken };
}

function tokenResponse(res, { accessToken, refreshToken, scope }) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    ...(scope ? { scope } : {}),
  });
}

router.post(
  '/oauth/token',
  openCors,
  tokenLimiter,
  formOrJson,
  (req, res, next) => {
    const grant = req.body?.grant_type;
    if (grant && grant !== 'authorization_code' && grant !== 'refresh_token') {
      return oauthError(res, 400, 'unsupported_grant_type');
    }
    next();
  },
  validateOAuth(tokenSchema),
  asyncHandler(async (req, res) => {
    const client = await authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client or bad client credentials.');

    // Housekeeping while we're here: it's cheap and keeps both tables small.
    await pool.query('DELETE FROM oauth_codes WHERE expires_at < now()');
    await pool.query('DELETE FROM oauth_tokens WHERE refresh_expires_at < now()');

    if (req.body.grant_type === 'authorization_code') {
      // Deleting it is what makes a code single-use, even if two requests race.
      const { rows } = await pool.query(
        `DELETE FROM oauth_codes WHERE code_hash = $1
         RETURNING client_id, user_id, redirect_uri, code_challenge, scope, expires_at`,
        [hashToken(req.body.code)]
      );
      const code = rows[0];
      if (!code || code.client_id !== client.id || code.expires_at < new Date()) {
        return oauthError(res, 400, 'invalid_grant', 'The authorization code is invalid or has expired.');
      }
      if (req.body.redirect_uri && req.body.redirect_uri !== code.redirect_uri) {
        return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
      }
      if (!pkceMatches(req.body.code_verifier, code.code_challenge)) {
        return oauthError(res, 400, 'invalid_grant', 'code_verifier does not match the code_challenge.');
      }
      const { rows: users } = await pool.query('SELECT 1 FROM users WHERE id = $1 AND suspended_at IS NULL', [code.user_id]);
      if (users.length === 0) return oauthError(res, 400, 'invalid_grant', 'This account is not available.');

      const tokens = await issueTokens({ clientId: client.id, userId: code.user_id, scope: code.scope });
      await pool.query('UPDATE oauth_clients SET last_used_at = now() WHERE id = $1', [client.id]);
      return tokenResponse(res, { ...tokens, scope: code.scope });
    }

    // refresh_token: rotate both tokens on the same row, so the old refresh token stops working.
    const accessToken = randomToken('pfo_');
    const refreshToken = randomToken('pfr_');
    const { rows } = await pool.query(
      `UPDATE oauth_tokens t
       SET access_token_hash = $1, access_expires_at = now() + make_interval(secs => $2),
           refresh_token_hash = $3, refresh_expires_at = $4
       FROM users u
       WHERE t.refresh_token_hash = $5 AND t.client_id = $6 AND t.refresh_expires_at > now()
         AND u.id = t.user_id AND u.suspended_at IS NULL
       RETURNING t.scope`,
      [hashToken(accessToken), ACCESS_TTL_SECONDS, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), hashToken(req.body.refresh_token), client.id]
    );
    if (rows.length === 0) {
      return oauthError(res, 400, 'invalid_grant', 'The refresh token is invalid or has expired.');
    }
    await pool.query('UPDATE oauth_clients SET last_used_at = now() WHERE id = $1', [client.id]);
    tokenResponse(res, { accessToken, refreshToken, scope: rows[0].scope });
  })
);

// RFC 7009: always 200, whether or not the token existed, so it can't be used to probe tokens.
router.post(
  '/oauth/revoke',
  openCors,
  tokenLimiter,
  formOrJson,
  validateOAuth(revokeSchema),
  asyncHandler(async (req, res) => {
    const client = await authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client');
    const hash = hashToken(req.body.token);
    await pool.query(
      'DELETE FROM oauth_tokens WHERE client_id = $1 AND (access_token_hash = $2 OR refresh_token_hash = $2)',
      [client.id, hash]
    );
    res.set('Cache-Control', 'no-store');
    res.status(200).end();
  })
);

// The page a client sends the user to. Errors that mean the redirect_uri can't be trusted are
// shown here; any other error goes back to the client, as RFC 6749 §4.1.2.1 says.
router.get(
  '/oauth/authorize',
  asyncHandler(async (req, res) => {
    const renderError = (message) => res.status(400).render('oauth-authorize', { error: message, request: null });

    const client = await findClient(req.query.client_id);
    if (!client) return renderError('This app isn’t registered with this server. Try connecting again from the app.');

    let redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : null;
    if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
    if (!redirectUri || !redirectUriRegistered(client, redirectUri)) {
      return renderError('The app asked to return to an address it didn’t register. Try connecting again from the app.');
    }

    const back = (error, description) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      if (description) url.searchParams.set('error_description', description);
      if (typeof req.query.state === 'string') url.searchParams.set('state', req.query.state);
      url.searchParams.set('iss', issuer());
      return res.redirect(url.toString());
    };

    const parsed = authorizeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return back('invalid_request', `${issue.path.join('.')}: ${issue.message}`);
    }
    if (parsed.data.response_type !== 'code') return back('unsupported_response_type');

    if (!req.isAuthenticated()) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }

    // Kept in the session rather than in the page: the consent POST only names the request,
    // so nothing the browser sends back can change where the code goes or who it's for.
    const requestId = crypto.randomBytes(16).toString('hex');
    const pending = (req.session.oauthPending ||= {});
    pending[requestId] = {
      clientId: client.id,
      redirectUri,
      codeChallenge: parsed.data.code_challenge,
      state: parsed.data.state ?? null,
      scope: parsed.data.scope ?? null,
      createdAt: Date.now(),
    };
    const ids = Object.keys(pending).sort((a, b) => pending[a].createdAt - pending[b].createdAt);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PENDING))) delete pending[id];

    let redirectHost;
    try {
      const u = new URL(redirectUri);
      redirectHost = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : u.protocol.replace(/:$/, '');
    } catch {
      redirectHost = redirectUri;
    }

    res.render('oauth-authorize', {
      error: null,
      request: {
        id: requestId,
        clientName: client.client_name || 'An app',
        redirectHost,
        email: req.user.email,
      },
    });
  })
);

export default router;

// ---------------------------------------------------------------------------------------------
// Session endpoints: the consent decision and the "connected apps" list. Mounted at /api/oauth,
// behind csrfProtection like the rest of /api. Consent needs a real browser session — a Bearer
// token must never be able to approve another app.
// ---------------------------------------------------------------------------------------------
export const oauthSessionRouter = Router();

oauthSessionRouter.post(
  '/consent',
  validate(consentSchema),
  asyncHandler(async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });

    const pending = req.session.oauthPending?.[req.body.request_id];
    if (!pending || Date.now() - pending.createdAt > CODE_TTL_MS * 3) {
      return res.status(400).json({ error: 'expired', message: 'This request has expired. Start connecting again from the app.' });
    }
    delete req.session.oauthPending[req.body.request_id];

    const url = new URL(pending.redirectUri);
    if (pending.state !== null) url.searchParams.set('state', pending.state);
    url.searchParams.set('iss', issuer());

    if (!req.body.approve) {
      url.searchParams.set('error', 'access_denied');
      return res.json({ redirect: url.toString() });
    }

    const code = randomToken('pfa_');
    await pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hashToken(code), pending.clientId, req.user.id, pending.redirectUri, pending.codeChallenge, pending.scope, new Date(Date.now() + CODE_TTL_MS)]
    );
    logProductEvent(req.user.id, 'oauth_app_approved', { client: pending.clientId }).catch((err) =>
      req.log.error({ err }, 'failed to record product event')
    );
    url.searchParams.set('code', code);
    res.json({ redirect: url.toString() });
  })
);

oauthSessionRouter.get(
  '/apps',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.client_id, c.client_name, MIN(t.created_at) AS connected_at, MAX(t.last_used_at) AS last_used_at
       FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
       WHERE t.user_id = $1 AND t.refresh_expires_at > now()
       GROUP BY c.id ORDER BY MIN(t.created_at) DESC`,
      [req.user.id]
    );
    res.json(rows);
  })
);

oauthSessionRouter.delete(
  '/apps/:clientId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(
      `DELETE FROM oauth_tokens t USING oauth_clients c
       WHERE c.id = t.client_id AND c.client_id = $1 AND t.user_id = $2`,
      [req.params.clientId, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  })
);
