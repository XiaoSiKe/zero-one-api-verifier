import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  decryptPayload,
  encryptPayload,
  generateEncryptionKey,
} from '../src/crypto-store.js';
import {
  DatabaseSync,
  createDatabase,
  execute,
  queryAll,
  queryOne,
  initializeDatabase,
  withTransaction,
} from '../src/database.js';
import { createOidcAdapter } from '../src/oidc-adapter.js';

const resources = [];

afterEach(() => {
  while (resources.length > 0) {
    const resource = resources.pop();
    resource.database?.close();
    if (resource.directory) {
      rmSync(resource.directory, { recursive: true, force: true });
    }
  }
});

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'sso-storage-'));
  const filename = join(directory, 'sso.sqlite');
  const database = createDatabase(filename);
  const resource = { database, directory, filename };
  resources.push(resource);
  return resource;
}

describe('encrypted payload storage', () => {
  test('round-trips JSON and fails closed after tampering', () => {
    const key = generateEncryptionKey();
    const encrypted = encryptPayload({ secret: 'only-once' }, key, 'Client:1');

    assert.deepEqual(decryptPayload(encrypted, key, 'Client:1'), {
      secret: 'only-once',
    });
    assert.doesNotMatch(encrypted, /only-once/);

    const parts = encrypted.split('.');
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
    const tampered = parts.join('.');
    assert.throws(() => decryptPayload(tampered, key, 'Client:1'));
    assert.throws(() => decryptPayload(encrypted, key, 'Client:2'));
  });
});

describe('database', () => {
  test('initializes required tables and safety pragmas', () => {
    const { database, directory, filename } = temporaryDatabase();
    const tables = queryAll(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).map(({ name }) => name);

    assert.deepEqual(
      [
        'audit_events',
        'handoff_bindings',
        'invite_attributions',
        'invite_visits',
        'merchant_integrations',
        'oidc_artifacts',
        'user_sessions',
        'users',
      ].every((table) => tables.includes(table)),
      true,
    );
    assert.equal(queryOne(database, 'PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(queryOne(database, 'PRAGMA busy_timeout').timeout, 5_000);
    assert.equal(queryOne(database, 'PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(filename).mode & 0o777, 0o600);

    const integrationColumns = queryAll(
      database,
      'PRAGMA table_info(merchant_integrations)',
    ).map(({ name }) => name);
    for (const column of [
      'start_url',
      'handoff_url',
      'failure_reason',
      'config_revealed_at',
    ]) {
      assert.ok(integrationColumns.includes(column));
    }
  });

  test('migrates the pre-owner merchant schema without losing integrations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sso-migration-'));
    const filename = join(directory, 'old.sqlite');
    const database = new DatabaseSync(filename);
    resources.push({ database, directory, filename });
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
        email_verified INTEGER NOT NULL, invite_code TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE merchant_integrations (
        id TEXT PRIMARY KEY, site_url TEXT NOT NULL, normalized_origin TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL, client_id TEXT UNIQUE NOT NULL, client_secret_ciphertext TEXT,
        redirect_uri TEXT NOT NULL, start_url TEXT, handoff_url TEXT, status TEXT NOT NULL,
        failure_reason TEXT, config_revealed_at INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, last_checked_at INTEGER
      );
      INSERT INTO users VALUES (
        'old-owner', 'old@example.com', '旧账号', 1, 'OLD-CODE', 1, 1
      );
      INSERT INTO merchant_integrations VALUES (
        'old-integration', 'https://old.example.com', 'https://old.example.com',
        'new-api', 'old-client', NULL, 'https://old.example.com/oauth/oidc',
        NULL, NULL, 'pending', NULL, NULL, 1, 1, NULL
      );
    `);
    initializeDatabase(database);
    assert.equal(
      queryOne(database, 'SELECT owner_user_id FROM merchant_integrations WHERE id = ?', ['old-integration']).owner_user_id,
      'old-owner',
    );
    assert.equal(queryOne(database, 'PRAGMA user_version').user_version, 1);
  });

  test('commits or rolls back a synchronous business transaction', () => {
    const { database } = temporaryDatabase();
    const insertUser = (id, email) =>
      execute(
        database,
        `INSERT INTO users
          (id, email, display_name, email_verified, invite_code, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, 1, 1)`,
        [id, email, id, `invite-${id}`],
      );

    withTransaction(database, () => insertUser('one', 'one@example.test'));
    assert.equal(queryOne(database, 'SELECT count(*) AS count FROM users').count, 1);

    assert.throws(() =>
      withTransaction(database, () => {
        insertUser('two', 'two@example.test');
        throw new Error('abort');
      }),
    );
    assert.equal(queryOne(database, 'SELECT count(*) AS count FROM users').count, 1);
  });
});

describe('oidc-provider adapter', () => {
  test('supports lookup, atomic consumption, expiration, deletion, and grant revocation', async () => {
    const { database, filename } = temporaryDatabase();
    const encryptionKey = generateEncryptionKey();
    let currentTime = Date.parse('2026-08-26T00:00:00Z');
    const Adapter = createOidcAdapter({
      database,
      encryptionKey,
      now: () => currentTime,
    });
    const authorizationCodes = new Adapter('AuthorizationCode');

    await authorizationCodes.upsert(
      'code-1',
      {
        accountId: 'private-account-value',
        grantId: 'grant-1',
        uid: 'uid-1',
        userCode: 'ABCD-EFGH',
      },
      60,
    );

    assert.deepEqual(await authorizationCodes.find('code-1'), {
      accountId: 'private-account-value',
      grantId: 'grant-1',
      uid: 'uid-1',
      userCode: 'ABCD-EFGH',
    });
    assert.equal(
      (await authorizationCodes.findByUid('uid-1')).accountId,
      'private-account-value',
    );
    assert.equal(
      (await authorizationCodes.findByUserCode('ABCD-EFGH')).accountId,
      'private-account-value',
    );

    assert.equal(await authorizationCodes.consume('code-1'), true);
    assert.equal(await authorizationCodes.consume('code-1'), false);
    assert.equal(
      (await authorizationCodes.find('code-1')).consumed,
      Math.floor(currentTime / 1_000),
    );

    const raw = queryOne(
      database,
      'SELECT payload_ciphertext FROM oidc_artifacts WHERE model = ? AND id = ?',
      ['AuthorizationCode', 'code-1'],
    ).payload_ciphertext;
    assert.doesNotMatch(raw, /private-account-value/);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.doesNotMatch(readFileSync(filename, 'latin1'), /private-account-value/);

    await authorizationCodes.upsert('code-2', { grantId: 'grant-1' }, 10);
    assert.equal(await authorizationCodes.revokeByGrantId('grant-1'), 2);
    assert.equal(await authorizationCodes.find('code-1'), undefined);

    await authorizationCodes.upsert('expired', { accountId: 'user-2' }, 1);
    currentTime += 1_000;
    assert.equal(await authorizationCodes.find('expired'), undefined);
    assert.equal(await authorizationCodes.consume('expired'), false);
    assert.equal(await authorizationCodes.cleanupExpired(), 1);

    await authorizationCodes.upsert('destroyed', { accountId: 'user-3' }, 60);
    assert.equal(await authorizationCodes.destroy('destroyed'), true);
    assert.equal(await authorizationCodes.find('destroyed'), undefined);
  });
});
