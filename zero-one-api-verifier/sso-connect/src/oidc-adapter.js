import { decryptPayload, encryptPayload } from './crypto-store.js';

function epochSeconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('now() must return a Date or milliseconds since Unix epoch');
  }
  return Math.floor(milliseconds / 1_000);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('OIDC adapter payload must be an object');
  }
}

function expiresAt(now, expiresIn) {
  if (expiresIn === undefined || expiresIn === null) {
    return null;
  }
  if (!Number.isFinite(expiresIn) || expiresIn < 0) {
    throw new RangeError('expiresIn must be a non-negative number of seconds');
  }
  return now + Math.trunc(expiresIn);
}

/**
 * Creates an oidc-provider Adapter class bound to one DatabaseSync connection.
 * The returned class can be passed directly as oidc-provider's `adapter` option.
 */
export function createOidcAdapter({ database, encryptionKey, now = Date.now } = {}) {
  if (!database || typeof database.prepare !== 'function') {
    throw new TypeError('database must be a DatabaseSync-compatible connection');
  }

  const statements = {
    upsert: database.prepare(`
      INSERT INTO oidc_artifacts (
        model, id, payload_ciphertext, expires_at, consumed_at,
        grant_id, uid, user_code, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT (model, id) DO UPDATE SET
        payload_ciphertext = excluded.payload_ciphertext,
        expires_at = excluded.expires_at,
        consumed_at = NULL,
        grant_id = excluded.grant_id,
        uid = excluded.uid,
        user_code = excluded.user_code,
        updated_at = excluded.updated_at
    `),
    find: database.prepare(`
      SELECT id, payload_ciphertext, consumed_at
      FROM oidc_artifacts
      WHERE model = ? AND id = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `),
    findByUid: database.prepare(`
      SELECT id, payload_ciphertext, consumed_at
      FROM oidc_artifacts
      WHERE model = ? AND uid = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    findByUserCode: database.prepare(`
      SELECT id, payload_ciphertext, consumed_at
      FROM oidc_artifacts
      WHERE model = ? AND user_code = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `),
    consume: database.prepare(`
      UPDATE oidc_artifacts
      SET consumed_at = ?, updated_at = ?
      WHERE model = ? AND id = ? AND consumed_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `),
    destroy: database.prepare(`
      DELETE FROM oidc_artifacts WHERE model = ? AND id = ?
    `),
    revokeByGrantId: database.prepare(`
      DELETE FROM oidc_artifacts WHERE model = ? AND grant_id = ?
    `),
    cleanupExpired: database.prepare(`
      DELETE FROM oidc_artifacts
      WHERE expires_at IS NOT NULL AND expires_at <= ?
    `),
  };

  function unpack(model, row) {
    if (!row) {
      return undefined;
    }
    const payload = decryptPayload(
      row.payload_ciphertext,
      encryptionKey,
      `${model}:${row.id}`,
    );
    return row.consumed_at === null
      ? payload
      : { ...payload, consumed: row.consumed_at };
  }

  return class SQLiteOidcAdapter {
    constructor(model) {
      if (typeof model !== 'string' || model.length === 0) {
        throw new TypeError('OIDC adapter model must be a non-empty string');
      }
      this.model = model;
    }

    async upsert(id, payload, expiresIn) {
      validatePayload(payload);
      const currentTime = epochSeconds(now);
      const artifactId = String(id);
      const encrypted = encryptPayload(
        payload,
        encryptionKey,
        `${this.model}:${artifactId}`,
      );
      statements.upsert.run(
        this.model,
        artifactId,
        encrypted,
        expiresAt(currentTime, expiresIn),
        payload.grantId ?? null,
        payload.uid ?? null,
        payload.userCode ?? null,
        currentTime,
      );
    }

    async find(id) {
      const artifactId = String(id);
      const row = statements.find.get(this.model, artifactId, epochSeconds(now));
      return unpack(this.model, row);
    }

    async findByUid(uid) {
      return unpack(
        this.model,
        statements.findByUid.get(this.model, String(uid), epochSeconds(now)),
      );
    }

    async findByUserCode(userCode) {
      return unpack(
        this.model,
        statements.findByUserCode.get(
          this.model,
          String(userCode),
          epochSeconds(now),
        ),
      );
    }

    async consume(id) {
      const currentTime = epochSeconds(now);
      const result = statements.consume.run(
        currentTime,
        currentTime,
        this.model,
        String(id),
        currentTime,
      );
      return result.changes === 1;
    }

    async destroy(id) {
      const result = statements.destroy.run(this.model, String(id));
      return result.changes > 0;
    }

    async revokeByGrantId(grantId) {
      return statements.revokeByGrantId.run(this.model, String(grantId)).changes;
    }

    async cleanupExpired() {
      return statements.cleanupExpired.run(epochSeconds(now)).changes;
    }
  };
}

export default createOidcAdapter;
