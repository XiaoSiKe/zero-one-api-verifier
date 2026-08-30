import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import { decryptPayload, encryptPayload } from './crypto-store.js';
import { withTransaction } from './database.js';

const INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const VERIFY_TTL_SECONDS = 10 * 60;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('base64url');
}

function normalizeEmail(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error('请输入有效邮箱地址');
  }
  return normalized;
}

function inviteCode() {
  return randomBytes(8).toString('base64url').toUpperCase();
}

export function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  const visible = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, name.length - visible.length))}@${domain}`;
}

export function createRepository(database, secrets) {
  const visitorHmacKey = Buffer.from(secrets.cookieKey, 'base64url');

  function createSession(userId, db = database) {
    const id = randomToken(32);
    const now = nowSeconds();
    db.prepare(
      'INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    ).run(tokenHash(id), userId, now + SESSION_TTL_SECONDS, now);
    return id;
  }

  function getSessionUser(sessionId) {
    if (!sessionId) return undefined;
    const now = nowSeconds();
    database.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now);
    return database.prepare(`
      SELECT u.id, u.email, u.display_name, u.email_verified, u.invite_code
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?
    `).get(tokenHash(sessionId), now);
  }

  function ensureDemoUser() {
    const now = nowSeconds();
    database.prepare(`
      INSERT INTO users (
        id, email, display_name, email_verified, invite_code, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (email) DO UPDATE SET
        display_name = excluded.display_name,
        email_verified = 1,
        updated_at = excluded.updated_at
    `).run('usr_demo_owner', 'merchant@zeroone.local', '演示商家', 'ZEROONE-DEMO', now, now);
    return database.prepare('SELECT * FROM users WHERE email = ?').get('merchant@zeroone.local');
  }

  function createDemoSession() {
    return createSession(ensureDemoUser().id);
  }

  function recordInviteVisit(code, visitorId) {
    const inviter = database.prepare(
      'SELECT id, invite_code FROM users WHERE invite_code = ?',
    ).get(String(code));
    if (!inviter) return undefined;
    const visitorKey = createHmac('sha256', visitorHmacKey)
      .update(String(visitorId))
      .digest('base64url');
    const now = nowSeconds();
    const id = randomUUID();
    database.prepare(`
      INSERT INTO invite_visits (
        id, inviter_user_id, invite_code, visitor_key, first_seen_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (invite_code, visitor_key) DO NOTHING
    `).run(id, inviter.id, inviter.invite_code, visitorKey, now, now + INVITE_TTL_SECONDS);
    return database.prepare(
      'SELECT * FROM invite_visits WHERE invite_code = ? AND visitor_key = ?',
    ).get(inviter.invite_code, visitorKey);
  }

  function startEmailVerification(email, visitId) {
    const normalizedEmail = normalizeEmail(email);
    const now = nowSeconds();
    let user = database.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    if (!user) {
      const id = randomUUID();
      database.prepare(`
        INSERT INTO users (
          id, email, display_name, email_verified, invite_code, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, ?)
      `).run(id, normalizedEmail, normalizedEmail.split('@')[0], inviteCode(), now, now);
      user = database.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    const rawToken = randomToken(32);
    database.prepare(`
      INSERT INTO email_verification_tokens (
        id, token_hash, user_id, visit_id, expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(
      randomUUID(),
      tokenHash(rawToken),
      user.id,
      user.email_verified ? null : (visitId || null),
      now + VERIFY_TTL_SECONDS,
      now,
    );
    return { rawToken, user, isNew: !user.email_verified };
  }

  function verifyEmail(rawToken) {
    const hash = tokenHash(rawToken);
    return withTransaction(database, (db) => {
      const now = nowSeconds();
      const token = db.prepare(`
        SELECT * FROM email_verification_tokens
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `).get(hash, now);
      if (!token) throw new Error('验证链接无效或已过期');

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(token.user_id);
      const wasVerified = Boolean(user.email_verified);
      db.prepare(
        'UPDATE email_verification_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
      ).run(now, token.id);
      db.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').run(now, user.id);

      if (!wasVerified && token.visit_id) {
        const visit = db.prepare(
          'SELECT * FROM invite_visits WHERE id = ? AND expires_at > ?',
        ).get(token.visit_id, now);
        if (visit && visit.inviter_user_id !== user.id) {
          db.prepare(`
            INSERT INTO invite_attributions (
              id, inviter_user_id, invitee_user_id, visit_id, attributed_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `).run(randomUUID(), visit.inviter_user_id, user.id, visit.id, now);
        }
      }

      return { user: { ...user, email_verified: 1 }, sessionId: createSession(user.id, db) };
    });
  }

  function inviteSummary(userId) {
    const user = database.prepare('SELECT invite_code FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    const clicks = database.prepare(
      'SELECT COUNT(*) AS count FROM invite_visits WHERE inviter_user_id = ?',
    ).get(userId).count;
    const registrations = database.prepare(
      'SELECT COUNT(*) AS count FROM invite_attributions WHERE inviter_user_id = ?',
    ).get(userId).count;
    const recent = database.prepare(
      'SELECT MAX(attributed_at) AS value FROM invite_attributions WHERE inviter_user_id = ?',
    ).get(userId).value;
    return {
      inviteCode: user.invite_code,
      clicks,
      registrations,
      conversionRate: clicks ? Number(((registrations / clicks) * 100).toFixed(1)) : 0,
      latestRegistrationAt: recent || null,
    };
  }

  function inviteRegistrations(userId) {
    return database.prepare(`
      SELECT u.email, a.attributed_at
      FROM invite_attributions a
      JOIN users u ON u.id = a.invitee_user_id
      WHERE a.inviter_user_id = ?
      ORDER BY a.attributed_at DESC
      LIMIT 100
    `).all(userId).map((row) => ({
      email: maskEmail(row.email),
      registeredAt: row.attributed_at,
    }));
  }

  function saveIntegration(record) {
    const now = nowSeconds();
    const cipher = record.clientSecret
      ? encryptPayload(
        { value: record.clientSecret },
        secrets.databaseKey,
        `merchant:${record.id}`,
      )
      : null;
    database.prepare(`
      INSERT INTO merchant_integrations (
        id, owner_user_id, site_url, normalized_origin, kind, client_id, client_secret_ciphertext,
        redirect_uri, start_url, handoff_url, status, failure_reason,
        config_revealed_at, created_at, updated_at, last_checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
    `).run(
      record.id,
      record.ownerUserId,
      record.siteUrl,
      record.origin,
      record.kind,
      record.clientId,
      cipher,
      record.redirectUri,
      record.startUrl || null,
      record.handoffUrl || null,
      record.status || 'pending',
      record.clientSecret ? now : null,
      now,
      now,
    );
    return getIntegration(record.id);
  }

  function getIntegration(id) {
    return database.prepare('SELECT * FROM merchant_integrations WHERE id = ?').get(id);
  }

  function findIntegrationByOrigin(origin) {
    return database.prepare(
      'SELECT * FROM merchant_integrations WHERE normalized_origin = ?',
    ).get(origin);
  }

  function getIntegrationForOwner(id, ownerUserId) {
    return database.prepare(
      'SELECT * FROM merchant_integrations WHERE id = ? AND owner_user_id = ?',
    ).get(id, ownerUserId);
  }

  function integrationSecret(integration) {
    if (!integration?.client_secret_ciphertext) return undefined;
    return decryptPayload(
      integration.client_secret_ciphertext,
      secrets.databaseKey,
      `merchant:${integration.id}`,
    ).value;
  }

  function updateIntegration(id, changes) {
    const allowed = new Map([
      ['status', 'status'],
      ['failureReason', 'failure_reason'],
      ['lastCheckedAt', 'last_checked_at'],
      ['startUrl', 'start_url'],
    ]);
    const entries = Object.entries(changes).filter(([key]) => allowed.has(key));
    if (!entries.length) return getIntegration(id);
    const clauses = entries.map(([key]) => `${allowed.get(key)} = ?`);
    const values = entries.map(([, value]) => value ?? null);
    clauses.push('updated_at = ?');
    values.push(nowSeconds(), id);
    database.prepare(`UPDATE merchant_integrations SET ${clauses.join(', ')} WHERE id = ?`).run(...values);
    return getIntegration(id);
  }

  function rotateIntegrationSecret(id, clientSecret) {
    const cipher = encryptPayload(
      { value: clientSecret },
      secrets.databaseKey,
      `merchant:${id}`,
    );
    const now = nowSeconds();
    database.prepare(`
      UPDATE merchant_integrations
      SET client_secret_ciphertext = ?, config_revealed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(cipher, now, now, id);
    return getIntegration(id);
  }

  function audit(eventType, { actorId = null, merchantId = null, details = null } = {}) {
    const encrypted = details
      ? encryptPayload(details, secrets.databaseKey, `audit:${eventType}`)
      : null;
    database.prepare(`
      INSERT INTO audit_events (event_type, actor_id, merchant_id, details_ciphertext, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventType, actorId, merchantId, encrypted, nowSeconds());
  }

  function cleanupExpired() {
    const now = nowSeconds();
    const sessions = database.prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now).changes;
    const verificationTokens = database.prepare(
      'DELETE FROM email_verification_tokens WHERE expires_at <= ? OR consumed_at IS NOT NULL',
    ).run(now).changes;
    const inviteVisits = database.prepare(`
      DELETE FROM invite_visits
      WHERE expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM invite_attributions a WHERE a.visit_id = invite_visits.id
        )
    `).run(now).changes;
    const auditEvents = database.prepare(
      'DELETE FROM audit_events WHERE created_at < ?',
    ).run(now - 90 * 24 * 60 * 60).changes;
    return { sessions, verificationTokens, inviteVisits, auditEvents };
  }

  return {
    audit,
    cleanupExpired,
    createDemoSession,
    createSession,
    ensureDemoUser,
    findIntegrationByOrigin,
    getIntegration,
    getIntegrationForOwner,
    getSessionUser,
    integrationSecret,
    inviteRegistrations,
    inviteSummary,
    recordInviteVisit,
    rotateIntegrationSecret,
    saveIntegration,
    startEmailVerification,
    updateIntegration,
    verifyEmail,
  };
}

export { normalizeEmail, tokenHash };
