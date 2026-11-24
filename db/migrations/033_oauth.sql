-- OAuth 2.1 for the remote MCP endpoint (routes/oauth.js): lets Claude.ai, ChatGPT and other
-- connector-style clients sign a user in instead of needing a pasted pf_ API token.
-- Clients register themselves (RFC 7591 dynamic client registration); a user approves one on
-- the consent page, which issues a short-lived code that the client swaps for tokens.
-- Every secret is stored only as a SHA-256 hash, like api_tokens.

CREATE TABLE oauth_clients (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,              -- NULL = public client (PKCE only), the usual case
  client_name TEXT,
  redirect_uris TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ              -- NULL until a user first approves it; never-used ones are pruned
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per approval (a "connected app"); a refresh rotates both tokens in place.
CREATE TABLE oauth_tokens (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_hash TEXT NOT NULL UNIQUE,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_oauth_tokens_user_id ON oauth_tokens (user_id);
