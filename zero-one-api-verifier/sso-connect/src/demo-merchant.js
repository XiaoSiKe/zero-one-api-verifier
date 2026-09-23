import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import express from 'express';
import {
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  fetchUserInfo,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { parse, serialize } from 'cookie';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('base64url');
}

function cookieOptions(config, maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    path: '/',
    maxAge,
  };
}

function initializeDemoDatabase(filename) {
  const resolved = resolve(filename);
  const directory = dirname(resolved);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const previousUmask = process.umask(0o077);
  let db;
  try {
    closeSync(openSync(resolved, 'a', 0o600));
    chmodSync(resolved, 0o600);
    db = new DatabaseSync(resolved);
    db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS demo_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      issuer TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS demo_flows (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      nonce TEXT NOT NULL,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS merchant_users (
      id TEXT PRIMARY KEY,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (issuer, subject)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS merchant_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS consumed_jtis (
      jti_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS login_tickets (
      ticket_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES merchant_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    ) STRICT;
    `);
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${resolved}${suffix}`;
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
    return db;
  } finally {
    process.umask(previousUmask);
  }
}

function upsertMerchantUser(db, claims, issuer) {
  const existing = db.prepare(
    'SELECT * FROM merchant_users WHERE issuer = ? AND subject = ?',
  ).get(issuer, claims.sub);
  if (existing) return { user: existing, created: false };
  const id = randomUUID();
  db.prepare(`
    INSERT INTO merchant_users (id, issuer, subject, email, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, issuer, claims.sub, claims.email, claims.name || claims.preferred_username || claims.email, nowSeconds());
  return { user: db.prepare('SELECT * FROM merchant_users WHERE id = ?').get(id), created: true };
}

export function createDemoMerchant({ config, publicDir, viewsDir }) {
  const db = initializeDemoDatabase(config.merchantDatabasePath);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(publicDir));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.set('views', viewsDir);
  app.set('view engine', 'ejs');

  function getConfig() {
    return db.prepare('SELECT * FROM demo_config WHERE id = 1').get();
  }

  function configure({ issuer, clientId, clientSecret, redirectUri }) {
    db.prepare(`
      INSERT INTO demo_config (id, issuer, client_id, client_secret, redirect_uri, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        issuer = excluded.issuer,
        client_id = excluded.client_id,
        client_secret = excluded.client_secret,
        redirect_uri = excluded.redirect_uri,
        updated_at = excluded.updated_at
    `).run(issuer, clientId, clientSecret, redirectUri, nowSeconds());
  }

  function cleanupExpired() {
    const now = nowSeconds();
    db.prepare('DELETE FROM demo_flows WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM merchant_sessions WHERE expires_at <= ?').run(now);
    db.prepare('DELETE FROM login_tickets WHERE expires_at <= ? OR consumed_at IS NOT NULL').run(now);
    db.prepare('DELETE FROM consumed_jtis WHERE expires_at <= ?').run(now);
  }

  async function clientConfiguration() {
    const stored = getConfig();
    if (!stored) throw new Error('演示商家尚未配置 OIDC');
    return discovery(
      new URL(stored.issuer),
      stored.client_id,
      stored.client_secret,
      undefined,
      { execute: [allowInsecureRequests], timeout: 5 },
    );
  }

  function setMerchantSession(res, userId) {
    const id = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO merchant_sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hash(id), userId, nowSeconds() + 8 * 60 * 60);
    res.setHeader('set-cookie', serialize('zeroone_demo_merchant', id, cookieOptions(config, 8 * 60 * 60)));
  }

  function currentUser(req) {
    const sessionId = parse(req.headers.cookie || '').zeroone_demo_merchant;
    if (!sessionId) return undefined;
    return db.prepare(`
      SELECT u.* FROM merchant_sessions s
      JOIN merchant_users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?
    `).get(hash(sessionId), nowSeconds());
  }

  app.get('/api/status', (_req, res) => {
    res.json({ data: { zeroone_demo: true, oidc_enabled: Boolean(getConfig()) } });
  });

  app.get('/sso/zeroone/start', async (_req, res, next) => {
    try {
      const stored = getConfig();
      const client = await clientConfiguration();
      const verifier = randomPKCECodeVerifier();
      const challenge = await calculatePKCECodeChallenge(verifier);
      const state = randomState();
      const nonce = randomNonce();
      const flowId = randomBytes(24).toString('base64url');
      db.prepare(
        'INSERT INTO demo_flows (id, state, nonce, verifier, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(flowId, state, nonce, verifier, nowSeconds() + 10 * 60);
      res.setHeader('set-cookie', serialize('zeroone_demo_flow', flowId, cookieOptions(config, 10 * 60)));
      const target = buildAuthorizationUrl(client, {
        redirect_uri: stored.redirect_uri,
        scope: 'openid profile email',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      res.redirect(target.href);
    } catch (error) {
      next(error);
    }
  });

  app.get('/oauth/oidc', async (req, res, next) => {
    try {
      const flowId = parse(req.headers.cookie || '').zeroone_demo_flow;
      const flow = db.prepare(
        'SELECT * FROM demo_flows WHERE id = ? AND expires_at > ?',
      ).get(flowId, nowSeconds());
      if (!flow) throw new Error('登录流程已过期，请重新开始');
      const stored = getConfig();
      const client = await clientConfiguration();
      const currentUrl = new URL(req.originalUrl, config.demoMerchantOrigin);
      const tokens = await authorizationCodeGrant(client, currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      const idClaims = tokens.claims();
      const claims = await fetchUserInfo(client, tokens.access_token, idClaims.sub);
      const result = upsertMerchantUser(db, claims, stored.issuer);
      db.prepare('DELETE FROM demo_flows WHERE id = ?').run(flow.id);
      setMerchantSession(res, result.user.id);
      res.redirect('/?sso=success');
    } catch (error) {
      next(error);
    }
  });

  app.post('/zeroone/sso/handoff', express.json({ limit: '8kb' }), async (req, res, next) => {
    try {
      const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (!token) return res.status(401).json({ success: false, error: 'missing token' });
      const stored = getConfig();
      const jwks = createRemoteJWKSet(new URL(`${stored.issuer}/.well-known/jwks.json`));
      const { payload } = await jwtVerify(token, jwks, {
        issuer: stored.issuer,
        audience: config.demoMerchantOrigin,
      });
      if (
        typeof payload.jti !== 'string'
        || payload.jti.length < 8
        || typeof payload.sub !== 'string'
        || payload.sub.length === 0
        || typeof payload.exp !== 'number'
      ) {
        return res.status(401).json({ success: false, error: 'invalid handoff claims' });
      }
      const jtiHash = hash(payload.jti);
      const consumed = db.prepare('SELECT 1 FROM consumed_jtis WHERE jti_hash = ?').get(jtiHash);
      if (consumed) return res.status(409).json({ success: false, error: 'replayed jti' });
      db.prepare('INSERT INTO consumed_jtis (jti_hash, expires_at) VALUES (?, ?)')
        .run(jtiHash, payload.exp);
      const result = upsertMerchantUser(db, payload, stored.issuer);
      const ticket = randomBytes(24).toString('base64url');
      db.prepare(`
        INSERT INTO login_tickets (ticket_hash, user_id, expires_at, consumed_at)
        VALUES (?, ?, ?, NULL)
      `).run(hash(ticket), result.user.id, nowSeconds() + 60);
      res.json({
        success: true,
        external_user_id: result.user.id,
        redirect_url: `${config.demoMerchantOrigin}/sso/consume?ticket=${encodeURIComponent(ticket)}`,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/sso/consume', (req, res, next) => {
    try {
      const ticket = db.prepare(`
        SELECT * FROM login_tickets
        WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).get(hash(req.query.ticket), nowSeconds());
      if (!ticket) throw new Error('登录票据无效或已使用');
      const result = db.prepare(
        'UPDATE login_tickets SET consumed_at = ? WHERE ticket_hash = ? AND consumed_at IS NULL',
      ).run(nowSeconds(), ticket.ticket_hash);
      if (result.changes !== 1) throw new Error('登录票据已使用');
      setMerchantSession(res, ticket.user_id);
      res.redirect('/?sso=handoff');
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (req, res) => {
    const user = currentUser(req);
    const count = db.prepare('SELECT COUNT(*) AS count FROM merchant_users').get().count;
    if (!user) {
      return res.status(200).send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>零一演示商家</title><link rel="stylesheet" href="/sso.css"></head><body><main class="shell"><section class="card"><p class="eyebrow">DEMO MERCHANT</p><h1>零一演示商家</h1><p>尚未登录。请从零一智鉴接入页运行完整演示。</p><a class="button" href="${config.issuer}/connect?demo=1">返回接入页</a></section></main></body></html>`);
    }
    return res.render('merchant-success', {
      merchantName: '零一演示商家',
      userLabel: `${user.display_name} · ${user.email}`,
      userCount: count,
      created: req.query.sso === 'success',
      continueUrl: `${config.issuer}/connect?demo=1&success=1`,
    });
  });

  app.use((error, _req, res, _next) => {
    res.status(400).render('error', { title: '演示商家登录失败', message: error.message });
  });

  return { app, cleanupExpired, configure, database: db, getConfig };
}
