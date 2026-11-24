import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../app.js';
import { pool } from '../db/pool.js';

// The OAuth 2.1 server in routes/oauth.js, driven the way Claude.ai / ChatGPT drive it:
// discovery -> dynamic registration -> authorize (log in + consent) -> token -> API calls.

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function loginNewUser(email = `oauth${Date.now()}${Math.random()}@example.com`) {
  const agent = request.agent(app);
  await agent.post('/api/users').send({ email, password: 'password123' });
  await agent.post('/api/auth/login').send({ email, password: 'password123' });
  return agent;
}

async function registerClient(body = {}) {
  const res = await request(app)
    .post('/oauth/register')
    .send({ client_name: 'Claude', redirect_uris: [REDIRECT], ...body });
  expect(res.status).toBe(201);
  return res.body;
}

function authorizeUrl(clientId, challenge, extra = {}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
  return `/oauth/authorize?${params}`;
}

// Logs in, approves on the consent page, and returns the code from the redirect.
async function approve(agent, clientId, challenge) {
  const page = await agent.get(authorizeUrl(clientId, challenge));
  expect(page.status).toBe(200);
  const requestId = page.text.match(/data-request="([0-9a-f]+)"/)[1];
  const consent = await agent.post('/api/oauth/consent').send({ request_id: requestId, approve: true });
  expect(consent.status).toBe(200);
  const redirect = new URL(consent.body.redirect);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get('state')).toBe('xyz');
  return redirect.searchParams.get('code');
}

async function fullFlow() {
  const agent = await loginNewUser();
  const client = await registerClient();
  const { verifier, challenge } = pkce();
  const code = await approve(agent, client.client_id, challenge);
  const token = await request(app)
    .post('/oauth/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
  expect(token.status).toBe(200);
  return { agent, client, code, verifier, tokens: token.body };
}

describe('oauth discovery', () => {
  it('publishes protected-resource and authorization-server metadata', async () => {
    const prm = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toMatch(/\/mcp$/);
    expect(prm.body.authorization_servers).toHaveLength(1);

    const as = await request(app).get('/.well-known/oauth-authorization-server');
    expect(as.status).toBe(200);
    expect(as.body.issuer).toBe(prm.body.authorization_servers[0]);
    expect(as.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(as.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('oauth registration', () => {
  it('registers a public client', async () => {
    const client = await registerClient();
    expect(client.client_id).toMatch(/^pfc_/);
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe('none');
  });

  it('accepts loopback http and app schemes, refuses plain http and script schemes', async () => {
    const ok = await request(app)
      .post('/oauth/register')
      .send({ redirect_uris: ['http://127.0.0.1:33418/callback', 'cursor://anysphere.cursor-retrieval/oauth/callback'] });
    expect(ok.status).toBe(201);

    for (const uri of ['http://evil.example.com/cb', 'javascript:alert(1)', 'https://example.com/cb#frag']) {
      const bad = await request(app).post('/oauth/register').send({ redirect_uris: [uri] });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('invalid_redirect_uri');
    }
  });

  it('answers malformed registrations in OAuth error shape', async () => {
    const res = await request(app).post('/oauth/register').send({ client_name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('oauth authorize', () => {
  it('sends a logged-out user to log in, then back here', async () => {
    const client = await registerClient();
    const url = authorizeUrl(client.client_id, pkce().challenge);
    const res = await request(app).get(url);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(url)}`);
  });

  it("shows an error page (no redirect) for an unknown client or unregistered redirect_uri", async () => {
    const agent = await loginNewUser();
    const unknown = await agent.get(authorizeUrl('pfc_nope', pkce().challenge));
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('isn’t registered');

    const client = await registerClient();
    const wrong = await agent.get(authorizeUrl(client.client_id, pkce().challenge, { redirect_uri: 'https://evil.example.com/cb' }));
    expect(wrong.status).toBe(400);
    expect(wrong.headers.location).toBeUndefined();
  });

  it('redirects back with an error when PKCE is missing', async () => {
    const agent = await loginNewUser();
    const client = await registerClient();
    const res = await agent.get(authorizeUrl(client.client_id, pkce().challenge, { code_challenge_method: 'plain' }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('xyz');
  });

  it('shows the consent page with the app name and where it returns to', async () => {
    const agent = await loginNewUser('consent-page@example.com');
    const client = await registerClient({ client_name: '<b>Claude</b>' });
    const res = await agent.get(authorizeUrl(client.client_id, pkce().challenge));
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;b&gt;Claude&lt;/b&gt;');
    expect(res.text).toContain('claude.ai');
    expect(res.text).toContain('consent-page@example.com');
  });

  it('returns access_denied when the user cancels', async () => {
    const agent = await loginNewUser();
    const client = await registerClient();
    const page = await agent.get(authorizeUrl(client.client_id, pkce().challenge));
    const requestId = page.text.match(/data-request="([0-9a-f]+)"/)[1];
    const res = await agent.post('/api/oauth/consent').send({ request_id: requestId, approve: false });
    const redirect = new URL(res.body.redirect);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('code')).toBeNull();
  });

  it("won't approve a request from another session", async () => {
    const agent = await loginNewUser();
    const client = await registerClient();
    const page = await agent.get(authorizeUrl(client.client_id, pkce().challenge));
    const requestId = page.text.match(/data-request="([0-9a-f]+)"/)[1];
    const other = await loginNewUser();
    const res = await other.post('/api/oauth/consent').send({ request_id: requestId, approve: true });
    expect(res.status).toBe(400);
  });
});

describe('oauth token', () => {
  it('swaps a code for tokens that work on the API', async () => {
    const { tokens } = await fullFlow();
    expect(tokens.access_token).toMatch(/^pfo_/);
    expect(tokens.refresh_token).toMatch(/^pfr_/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(3600);

    const res = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${tokens.access_token}`);
    expect(res.status).toBe(200);
  });

  it("can't reach account routes outside /api/v1 with an OAuth token", async () => {
    const { tokens } = await fullFlow();
    const res = await request(app).get('/api/auth/api-token').set('Authorization', `Bearer ${tokens.access_token}`);
    expect(res.status).toBe(401);
    const del = await request(app)
      .post('/api/auth/delete-account')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .send({});
    expect(del.status).toBe(401);
  });

  it('uses a code once only', async () => {
    const { client, code, verifier } = await fullFlow();
    const again = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('rejects a wrong code_verifier', async () => {
    const agent = await loginNewUser();
    const client = await registerClient();
    const code = await approve(agent, client.client_id, pkce().challenge);
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client.client_id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it("rejects a code presented by a different client", async () => {
    const agent = await loginNewUser();
    const client = await registerClient();
    const other = await registerClient();
    const { verifier, challenge } = pkce();
    const code = await approve(agent, client.client_id, challenge);
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: other.client_id });
    expect(res.body.error).toBe('invalid_grant');
  });

  it('rotates tokens on refresh; the old refresh and access tokens stop working', async () => {
    const { client, tokens } = await fullFlow();
    const refreshed = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(tokens.access_token);

    const reuse = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(reuse.body.error).toBe('invalid_grant');

    const oldAccess = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${tokens.access_token}`);
    expect(oldAccess.status).toBe(401);
    const newAccess = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${refreshed.body.access_token}`);
    expect(newAccess.status).toBe(200);
  });

  it('needs the secret for a confidential client (Basic auth)', async () => {
    const agent = await loginNewUser();
    const client = await registerClient({ token_endpoint_auth_method: 'client_secret_basic' });
    expect(client.client_secret).toMatch(/^pfs_/);
    const { verifier, challenge } = pkce();
    const code = await approve(agent, client.client_id, challenge);

    const noSecret = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe('invalid_client');

    const code2 = await approve(agent, client.client_id, challenge);
    const ok = await request(app)
      .post('/oauth/token')
      .auth(client.client_id, client.client_secret)
      .type('form')
      .send({ grant_type: 'authorization_code', code: code2, code_verifier: verifier });
    expect(ok.status).toBe(200);
  });

  it('refuses unsupported grant types', async () => {
    const res = await request(app).post('/oauth/token').type('form').send({ grant_type: 'password' });
    expect(res.body.error).toBe('unsupported_grant_type');
  });

  it("stops working for a suspended user", async () => {
    const { client, tokens } = await fullFlow();
    const { rows } = await pool.query('SELECT user_id FROM oauth_tokens LIMIT 1');
    await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [rows[0].user_id]);
    const api = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${tokens.access_token}`);
    expect(api.status).toBe(401);
    const refresh = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refresh.body.error).toBe('invalid_grant');
  });
});

describe('oauth revoke and connected apps', () => {
  it('revokes a token via /oauth/revoke', async () => {
    const { client, tokens } = await fullFlow();
    const res = await request(app)
      .post('/oauth/revoke')
      .type('form')
      .send({ token: tokens.refresh_token, client_id: client.client_id });
    expect(res.status).toBe(200);
    const api = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${tokens.access_token}`);
    expect(api.status).toBe(401);
  });

  it('lists connected apps in Settings and disconnects one', async () => {
    const { agent, client, tokens } = await fullFlow();
    const list = await agent.get('/api/oauth/apps');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].client_name).toBe('Claude');

    const del = await agent.delete(`/api/oauth/apps/${client.client_id}`);
    expect(del.status).toBe(204);
    const api = await request(app).get('/api/v1/posts').set('Authorization', `Bearer ${tokens.access_token}`);
    expect(api.status).toBe(401);
    expect((await agent.get('/api/oauth/apps')).body).toHaveLength(0);
  });

  it("can't disconnect another user's app", async () => {
    const { client } = await fullFlow();
    const other = await loginNewUser();
    const res = await other.delete(`/api/oauth/apps/${client.client_id}`);
    expect(res.status).toBe(404);
  });
});
