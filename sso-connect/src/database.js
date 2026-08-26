import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  invite_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
  ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx
  ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visit_id TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS email_verification_tokens_expiry_idx
  ON email_verification_tokens(expires_at);

CREATE TABLE IF NOT EXISTS invite_visits (
  id TEXT PRIMARY KEY,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (invite_code, visitor_key)
) STRICT;
CREATE INDEX IF NOT EXISTS invite_visits_inviter_idx
  ON invite_visits(inviter_user_id);

CREATE TABLE IF NOT EXISTS invite_attributions (
  id TEXT PRIMARY KEY,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  visit_id TEXT NOT NULL UNIQUE REFERENCES invite_visits(id) ON DELETE RESTRICT,
  attributed_at INTEGER NOT NULL,
  CHECK (inviter_user_id <> invitee_user_id)
) STRICT;
CREATE INDEX IF NOT EXISTS invite_attributions_inviter_idx
  ON invite_attributions(inviter_user_id);

CREATE TABLE IF NOT EXISTS merchant_integrations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  normalized_origin TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_ciphertext TEXT,
  redirect_uri TEXT NOT NULL,
  start_url TEXT,
  handoff_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  config_revealed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS handoff_bindings (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchant_integrations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (merchant_id, user_id),
  UNIQUE (merchant_id, subject)
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  merchant_id TEXT REFERENCES merchant_integrations(id) ON DELETE SET NULL,
  details_ciphertext TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS oidc_artifacts (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  expires_at INTEGER,
  consumed_at INTEGER,
  grant_id TEXT,
  uid TEXT,
  user_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (model, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS oidc_artifacts_expires_at_idx
  ON oidc_artifacts(expires_at);
CREATE INDEX IF NOT EXISTS oidc_artifacts_grant_id_idx
  ON oidc_artifacts(grant_id);
CREATE INDEX IF NOT EXISTS oidc_artifacts_uid_idx
  ON oidc_artifacts(model, uid);
CREATE INDEX IF NOT EXISTS oidc_artifacts_user_code_idx
  ON oidc_artifacts(model, user_code);
`;

function invoke(statement, method, parameters) {
  if (parameters === undefined) {
    return statement[method]();
  }
  if (Array.isArray(parameters)) {
    return statement[method](...parameters);
  }
  return statement[method](parameters);
}

function migrateSchema(database) {
  const integrationColumns = database.prepare(
    'PRAGMA table_info(merchant_integrations)',
  ).all().map(({ name }) => name);
  if (!integrationColumns.includes('owner_user_id')) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        ALTER TABLE merchant_integrations
        ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      `);
      const hasIntegrations = database.prepare(
        'SELECT 1 FROM merchant_integrations LIMIT 1',
      ).get();
      if (hasIntegrations) {
        let owner = database.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get();
        if (!owner) {
          const now = Math.floor(Date.now() / 1000);
          database.prepare(`
            INSERT INTO users (
              id, email, display_name, email_verified, invite_code, created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?, ?)
          `).run(
            'usr_migration_owner',
            'migration-owner@zeroone.local',
            '迁移恢复账号',
            'MIGRATION-OWNER',
            now,
            now,
          );
          owner = { id: 'usr_migration_owner' };
        }
        database.prepare(
          'UPDATE merchant_integrations SET owner_user_id = ? WHERE owner_user_id IS NULL',
        ).run(owner.id);
      }
      database.exec('COMMIT');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS merchant_integrations_owner_required
    BEFORE INSERT ON merchant_integrations
    WHEN NEW.owner_user_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'merchant integration owner is required');
    END;
    PRAGMA user_version = 1;
  `);
}

export function initializeDatabase(database) {
  if (!(database instanceof DatabaseSync)) {
    throw new TypeError('database must be a node:sqlite DatabaseSync instance');
  }

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  database.exec(SCHEMA);
  migrateSchema(database);
  return database;
}

export function createDatabase(filename = ':memory:') {
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new TypeError('filename must be a non-empty string');
  }

  if (filename === ':memory:') {
    return initializeDatabase(new DatabaseSync(filename, {
      timeout: 5_000,
      allowExtension: false,
    }));
  }

  const resolved = resolve(filename);
  const directory = dirname(resolved);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const previousUmask = process.umask(0o077);
  try {
    closeSync(openSync(resolved, 'a', 0o600));
    chmodSync(resolved, 0o600);
    const database = initializeDatabase(new DatabaseSync(resolved, {
      timeout: 5_000,
      allowExtension: false,
    }));
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${resolved}${suffix}`;
      if (existsSync(candidate)) chmodSync(candidate, 0o600);
    }
    return database;
  } finally {
    process.umask(previousUmask);
  }
}

export function closeDatabase(database) {
  database.close();
}

export function queryOne(database, sql, parameters) {
  return invoke(database.prepare(sql), 'get', parameters);
}

export function queryAll(database, sql, parameters) {
  return invoke(database.prepare(sql), 'all', parameters);
}

export function execute(database, sql, parameters) {
  return invoke(database.prepare(sql), 'run', parameters);
}

export function withTransaction(database, callback, mode = 'IMMEDIATE') {
  if (typeof callback !== 'function') {
    throw new TypeError('callback must be a function');
  }
  if (!['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(mode)) {
    throw new RangeError('transaction mode must be DEFERRED, IMMEDIATE, or EXCLUSIVE');
  }
  if (database.isTransaction) {
    throw new Error('nested transactions are not supported');
  }

  database.exec(`BEGIN ${mode}`);
  try {
    const result = callback(database);
    if (result && typeof result.then === 'function') {
      throw new TypeError('DatabaseSync transactions require a synchronous callback');
    }
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec('ROLLBACK');
    }
    throw error;
  }
}

export { DatabaseSync };
