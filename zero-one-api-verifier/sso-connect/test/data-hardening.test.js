import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  DatabaseSync,
  createDatabase,
  initializeDatabase,
} from '../src/database.js';
import { createOidcAdapter } from '../src/oidc-adapter.js';
import {
  pairwiseSubject,
  registerClient,
} from '../src/provider.js';
import { createRepository, tokenHash } from '../src/repository.js';
import { loadOrCreateSecrets } from '../src/secrets.js';
import { createRuntime } from '../src/server.js';

const execFileAsync = promisify(execFile);
const DAY_SECONDS = 24 * 60 * 60;
const INVITE_TTL_SECONDS = 30 * DAY_SECONDS;

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function repositoryFixture(t, prefix) {
  const directory = await temporaryDirectory(t, prefix);
  const secretsPath = path.join(directory, 'secrets.json');
  const secrets = await loadOrCreateSecrets(secretsPath);
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  return {
    database,
    directory,
    repository: createRepository(database, secrets),
    secrets,
    secretsPath,
  };
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function permissions(mode) {
  return mode & 0o777;
}

test('邀请首次访问固定保留 30 天且重复访问不延长归因窗口', async (t) => {
  const { database, repository } = await repositoryFixture(t, 'zeroone-invite-window-');
  const owner = repository.ensureDemoUser();
  const first = repository.recordInviteVisit(owner.invite_code, 'stable-browser-id');

  assert.equal(first.expires_at - first.first_seen_at, INVITE_TTL_SECONDS);

  database.prepare(
    'UPDATE invite_visits SET first_seen_at = ?, expires_at = ? WHERE id = ?',
  ).run(100, 100 + INVITE_TTL_SECONDS, first.id);
  const duplicate = repository.recordInviteVisit(owner.invite_code, 'stable-browser-id');
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.first_seen_at, 100);
  assert.equal(duplicate.expires_at, 100 + INVITE_TTL_SECONDS);

  database.prepare('UPDATE invite_visits SET expires_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1_000) + 60, first.id);
  const verification = repository.startEmailVerification('first@example.com', first.id);
  repository.verifyEmail(verification.rawToken);

  assert.equal(repository.inviteSummary(owner.id).clicks, 1);
  assert.equal(repository.inviteSummary(owner.id).registrations, 1);
});

test('过期邀请不归因，过期验证 Token 不验证账号', async (t) => {
  const { database, repository } = await repositoryFixture(t, 'zeroone-expiry-');
  const owner = repository.ensureDemoUser();
  const expiredVisit = repository.recordInviteVisit(owner.invite_code, 'expired-visitor');
  database.prepare('UPDATE invite_visits SET expires_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1_000) - 1, expiredVisit.id);

  const validToken = repository.startEmailVerification('late@example.com', expiredVisit.id);
  repository.verifyEmail(validToken.rawToken);
  assert.equal(repository.inviteSummary(owner.id).registrations, 0);
  assert.equal(
    database.prepare('SELECT email_verified FROM users WHERE email = ?').get('late@example.com').email_verified,
    1,
  );

  const expiredToken = repository.startEmailVerification('expired@example.com', null);
  database.prepare(
    'UPDATE email_verification_tokens SET expires_at = ? WHERE user_id = ?',
  ).run(
    Math.floor(Date.now() / 1_000) - 1,
    expiredToken.user.id,
  );
  assert.throws(
    () => repository.verifyEmail(expiredToken.rawToken),
    /验证链接无效或已过期/,
  );
  assert.equal(
    database.prepare('SELECT email_verified FROM users WHERE id = ?').get(expiredToken.user.id).email_verified,
    0,
  );
});

test('同一访客验证第二个邮箱不会阻断账号验证或重复归因', async (t) => {
  const { database, repository } = await repositoryFixture(t, 'zeroone-shared-visitor-');
  const owner = repository.ensureDemoUser();
  const visit = repository.recordInviteVisit(owner.invite_code, 'shared-browser');

  const first = repository.startEmailVerification('one@example.com', visit.id);
  repository.verifyEmail(first.rawToken);
  const second = repository.startEmailVerification('two@example.com', visit.id);
  const result = repository.verifyEmail(second.rawToken);

  assert.equal(result.user.email_verified, 1);
  assert.ok(result.sessionId);
  assert.equal(
    database.prepare('SELECT email_verified FROM users WHERE email = ?').get('two@example.com').email_verified,
    1,
  );
  assert.equal(repository.inviteSummary(owner.id).clicks, 1);
  assert.equal(repository.inviteSummary(owner.id).registrations, 1);
});

test('并发验证同一 Token 只有一个进程成功并只创建一次归因和会话', async (t) => {
  const directory = await temporaryDirectory(t, 'zeroone-concurrent-verify-');
  const databasePath = path.join(directory, 'sso.sqlite3');
  const secretsPath = path.join(directory, 'secrets.json');
  const secrets = await loadOrCreateSecrets(secretsPath);
  const database = createDatabase(databasePath);
  const repository = createRepository(database, secrets);
  const owner = repository.ensureDemoUser();
  const visit = repository.recordInviteVisit(owner.invite_code, 'concurrent-browser');
  const verification = repository.startEmailVerification('race@example.com', visit.id);
  database.close();

  const worker = `
    const { readFileSync } = await import('node:fs');
    const { createDatabase } = await import(process.env.ZEROONE_DATABASE_MODULE);
    const { createRepository } = await import(process.env.ZEROONE_REPOSITORY_MODULE);
    const secrets = JSON.parse(readFileSync(process.env.ZEROONE_SECRETS_PATH, 'utf8'));
    const database = createDatabase(process.env.ZEROONE_DATABASE_PATH);
    try {
      createRepository(database, secrets).verifyEmail(process.env.ZEROONE_RAW_TOKEN);
      process.stdout.write('success');
    } catch (error) {
      process.stdout.write('rejected:' + error.message);
    } finally {
      database.close();
    }
  `;
  const environment = {
    ...process.env,
    ZEROONE_DATABASE_MODULE: new URL('../src/database.js', import.meta.url).href,
    ZEROONE_REPOSITORY_MODULE: new URL('../src/repository.js', import.meta.url).href,
    ZEROONE_DATABASE_PATH: databasePath,
    ZEROONE_SECRETS_PATH: secretsPath,
    ZEROONE_RAW_TOKEN: verification.rawToken,
  };
  const attempts = await Promise.all(
    Array.from({ length: 10 }, () => execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', worker],
      { env: environment, maxBuffer: 16 * 1024 },
    )),
  );
  const outcomes = attempts.map(({ stdout }) => stdout.trim());
  assert.equal(outcomes.filter((value) => value === 'success').length, 1);
  assert.equal(
    outcomes.filter((value) => value === 'rejected:验证链接无效或已过期').length,
    9,
  );

  const reopened = createDatabase(databasePath);
  t.after(() => reopened.close());
  assert.equal(count(reopened, 'invite_attributions'), 1);
  assert.equal(count(reopened, 'user_sessions'), 1);
  assert.equal(
    reopened.prepare(
      'SELECT COUNT(*) AS count FROM email_verification_tokens WHERE consumed_at IS NOT NULL',
    ).get().count,
    1,
  );
});

test('平台 Session 只持久化 SHA-256 摘要且原始值才能恢复用户', async (t) => {
  const { database, repository } = await repositoryFixture(t, 'zeroone-session-hash-');
  const owner = repository.ensureDemoUser();
  const rawSession = repository.createSession(owner.id);
  const stored = database.prepare(
    'SELECT id FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(owner.id).id;

  assert.notEqual(stored, rawSession);
  assert.equal(stored, tokenHash(rawSession));
  assert.equal(repository.getSessionUser(rawSession).id, owner.id);
  assert.equal(repository.getSessionUser(stored), undefined);
});

test('平台、OIDC 与 Demo 商家清理各自的过期瞬时数据', async (t) => {
  const directory = await temporaryDirectory(t, 'zeroone-cleanup-');
  const runtime = await createRuntime({
    dataDir: directory,
    issuer: 'http://127.0.0.1:8910',
    demoMerchantOrigin: 'http://127.0.0.1:8911',
    platformPort: 8910,
    merchantPort: 8911,
    demoMode: true,
  });
  t.after(() => runtime.close());
  const now = Math.floor(Date.now() / 1_000);
  const owner = runtime.repository.ensureDemoUser();

  const preservedVisit = runtime.repository.recordInviteVisit(owner.invite_code, 'attributed');
  const attributed = runtime.repository.startEmailVerification('kept@example.com', preservedVisit.id);
  runtime.repository.verifyEmail(attributed.rawToken);
  runtime.database.prepare('UPDATE invite_visits SET expires_at = ? WHERE id = ?')
    .run(now - 1, preservedVisit.id);

  const expiredVisit = runtime.repository.recordInviteVisit(owner.invite_code, 'not-attributed');
  runtime.database.prepare('UPDATE invite_visits SET expires_at = ? WHERE id = ?')
    .run(now - 1, expiredVisit.id);
  const expiredVerification = runtime.repository.startEmailVerification('pending@example.com', null);
  runtime.database.prepare('UPDATE email_verification_tokens SET expires_at = ? WHERE user_id = ?')
    .run(now - 1, expiredVerification.user.id);
  const session = runtime.repository.createSession(owner.id);
  runtime.database.prepare('UPDATE user_sessions SET expires_at = ? WHERE id = ?')
    .run(now - 1, tokenHash(session));
  runtime.repository.audit('expired-audit');
  runtime.database.prepare("UPDATE audit_events SET created_at = ? WHERE event_type = 'expired-audit'")
    .run(now - 91 * DAY_SECONDS);

  const Adapter = createOidcAdapter({
    database: runtime.database,
    encryptionKey: runtime.secrets.databaseKey,
    now: () => now * 1_000,
  });
  const artifacts = new Adapter('AuthorizationCode');
  await artifacts.upsert('expired-code', { accountId: owner.id }, 0);

  const platformCleanup = runtime.repository.cleanupExpired();
  assert.ok(platformCleanup.sessions >= 1);
  assert.ok(platformCleanup.verificationTokens >= 2);
  assert.equal(platformCleanup.inviteVisits, 1);
  assert.equal(platformCleanup.auditEvents, 1);
  assert.equal(
    runtime.database.prepare('SELECT COUNT(*) AS count FROM invite_visits WHERE id = ?')
      .get(preservedVisit.id).count,
    1,
  );
  assert.equal(await artifacts.cleanupExpired(), 1);

  const merchant = runtime.demoMerchant.database;
  const merchantUserId = randomUUID();
  merchant.prepare(`
    INSERT INTO merchant_users (id, issuer, subject, email, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(merchantUserId, runtime.config.issuer, 'cleanup-sub', 'cleanup@example.com', 'Cleanup', now);
  merchant.prepare('INSERT INTO demo_flows VALUES (?, ?, ?, ?, ?)')
    .run('expired-flow', 'state', 'nonce', 'verifier', now - 1);
  merchant.prepare('INSERT INTO merchant_sessions VALUES (?, ?, ?)')
    .run('expired-session', merchantUserId, now - 1);
  merchant.prepare('INSERT INTO login_tickets VALUES (?, ?, ?, NULL)')
    .run('expired-ticket', merchantUserId, now - 1);
  merchant.prepare('INSERT INTO login_tickets VALUES (?, ?, ?, ?)')
    .run('consumed-ticket', merchantUserId, now + 60, now);
  merchant.prepare('INSERT INTO consumed_jtis VALUES (?, ?)')
    .run('expired-jti', now - 1);

  runtime.demoMerchant.cleanupExpired();
  for (const table of ['demo_flows', 'merchant_sessions', 'login_tickets', 'consumed_jtis']) {
    assert.equal(count(merchant, table), 0);
  }
});

test('旧 owner-less 数据库迁移后保留 Client、邀请归因与 handoff 绑定', async (t) => {
  const directory = await temporaryDirectory(t, 'zeroone-owner-migration-');
  const filename = path.join(directory, 'legacy.sqlite3');
  const database = new DatabaseSync(filename);
  t.after(() => database.close());
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      email_verified INTEGER NOT NULL, invite_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE invite_visits (
      id TEXT PRIMARY KEY, inviter_user_id TEXT NOT NULL REFERENCES users(id),
      invite_code TEXT NOT NULL, visitor_key TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, UNIQUE (invite_code, visitor_key)
    );
    CREATE TABLE invite_attributions (
      id TEXT PRIMARY KEY, inviter_user_id TEXT NOT NULL REFERENCES users(id),
      invitee_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
      visit_id TEXT NOT NULL UNIQUE REFERENCES invite_visits(id), attributed_at INTEGER NOT NULL
    );
    CREATE TABLE merchant_integrations (
      id TEXT PRIMARY KEY, site_url TEXT NOT NULL, normalized_origin TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, client_id TEXT NOT NULL UNIQUE, client_secret_ciphertext TEXT,
      redirect_uri TEXT NOT NULL, start_url TEXT, handoff_url TEXT, status TEXT NOT NULL,
      failure_reason TEXT, config_revealed_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_checked_at INTEGER
    );
    CREATE TABLE handoff_bindings (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL REFERENCES merchant_integrations(id),
      user_id TEXT NOT NULL REFERENCES users(id), subject TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE (merchant_id, user_id), UNIQUE (merchant_id, subject)
    );
    CREATE TABLE oidc_artifacts (
      model TEXT NOT NULL, id TEXT NOT NULL, payload_ciphertext TEXT NOT NULL,
      expires_at INTEGER, consumed_at INTEGER, grant_id TEXT, uid TEXT, user_code TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (model, id)
    ) WITHOUT ROWID;
    INSERT INTO users VALUES
      ('owner', 'owner@example.com', 'Owner', 1, 'OWNER-CODE', 1, 1),
      ('invitee', 'invitee@example.com', 'Invitee', 1, 'INVITEE-CODE', 2, 2);
    INSERT INTO invite_visits VALUES
      ('visit', 'owner', 'OWNER-CODE', 'visitor-hash', 3, 3000000);
    INSERT INTO invite_attributions VALUES
      ('attribution', 'owner', 'invitee', 'visit', 4);
    INSERT INTO merchant_integrations VALUES (
      'merchant', 'https://legacy.example.com', 'https://legacy.example.com', 'custom',
      'legacy-client', 'encrypted-secret', 'https://legacy.example.com/callback', NULL, NULL,
      'connected', NULL, 5, 5, 5, 5
    );
    INSERT INTO handoff_bindings VALUES
      ('binding', 'merchant', 'invitee', 'legacy-subject', 6);
    INSERT INTO oidc_artifacts VALUES
      ('Client', 'legacy-client', 'encrypted-client', NULL, NULL, NULL, NULL, NULL, 7);
  `);

  initializeDatabase(database);

  assert.equal(
    database.prepare('SELECT owner_user_id FROM merchant_integrations WHERE id = ?')
      .get('merchant').owner_user_id,
    'owner',
  );
  const restoredAttribution = database.prepare(
    'SELECT inviter_user_id, invitee_user_id, visit_id FROM invite_attributions',
  ).get();
  assert.equal(restoredAttribution.inviter_user_id, 'owner');
  assert.equal(restoredAttribution.invitee_user_id, 'invitee');
  assert.equal(restoredAttribution.visit_id, 'visit');
  assert.equal(
    database.prepare("SELECT payload_ciphertext FROM oidc_artifacts WHERE model = 'Client'")
      .get().payload_ciphertext,
    'encrypted-client',
  );
  assert.equal(
    database.prepare('SELECT subject FROM handoff_bindings WHERE id = ?').get('binding').subject,
    'legacy-subject',
  );
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
});

test('并发首次初始化只发布一套有效 Secrets', async (t) => {
  const directory = await temporaryDirectory(t, 'zeroone-secret-race-');
  await chmod(directory, 0o777);
  const filename = path.join(directory, 'nested', 'secrets.json');
  const results = await Promise.all(
    Array.from({ length: 12 }, () => loadOrCreateSecrets(filename)),
  );
  const persisted = JSON.parse(await readFile(filename, 'utf8'));

  for (const key of [
    'cookieKey',
    'databaseKey',
    'pairwiseSalt',
    'registrationToken',
    'handoffAudienceSalt',
  ]) {
    assert.equal(new Set(results.map((value) => value[key])).size, 1);
    assert.equal(results[0][key], persisted[key]);
  }
  assert.equal(new Set(results.map((value) => value.jwks.keys[0].kid)).size, 1);
  assert.equal(results[0].jwks.keys[0].kid, persisted.jwks.keys[0].kid);
});

test('同一数据目录重启后 JWK、pairwise sub、Client 与邀请统计保持稳定', async (t) => {
  const directory = await temporaryDirectory(t, 'zeroone-restart-');
  const options = {
    dataDir: directory,
    issuer: 'http://127.0.0.1:8920',
    demoMerchantOrigin: 'http://127.0.0.1:8921',
    platformPort: 8920,
    merchantPort: 8921,
    demoMode: true,
  };
  let runtime = await createRuntime(options);
  const owner = runtime.repository.ensureDemoUser();
  const visit = runtime.repository.recordInviteVisit(owner.invite_code, 'restart-browser');
  const pending = runtime.repository.startEmailVerification('restart@example.com', visit.id);
  runtime.repository.verifyEmail(pending.rawToken);
  const integrationId = 'integration-restart';
  const client = await registerClient(runtime.provider, {
    name: '重启稳定性商家',
    redirectUri: 'https://restart.example.com/callback',
    template: 'custom',
    integrationId,
  });
  runtime.repository.saveIntegration({
    id: integrationId,
    ownerUserId: owner.id,
    siteUrl: 'https://restart.example.com',
    origin: 'https://restart.example.com',
    kind: 'custom',
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri: 'https://restart.example.com/callback',
    status: 'connected',
  });
  const before = {
    clientId: client.clientId,
    invite: runtime.repository.inviteSummary(owner.id),
    kid: runtime.secrets.jwks.keys[0].kid,
    subject: pairwiseSubject(runtime.secrets.pairwiseSalt, owner.id, {
      clientId: client.clientId,
    }),
    visitId: visit.id,
  };
  await runtime.close();

  runtime = await createRuntime(options);
  t.after(() => runtime.close());
  const restoredClient = await runtime.provider.Client.find(before.clientId);
  const restoredIntegration = runtime.repository.getIntegration(integrationId);
  const restoredVisit = runtime.database.prepare('SELECT id FROM invite_visits WHERE id = ?')
    .get(before.visitId);

  assert.equal(runtime.secrets.jwks.keys[0].kid, before.kid);
  assert.equal(
    pairwiseSubject(runtime.secrets.pairwiseSalt, owner.id, { clientId: before.clientId }),
    before.subject,
  );
  assert.equal(restoredClient.clientId, before.clientId);
  assert.equal(restoredClient.compareClientSecret(client.clientSecret), true);
  assert.equal(restoredIntegration.client_id, before.clientId);
  assert.equal(runtime.repository.integrationSecret(restoredIntegration), client.clientSecret);
  assert.deepEqual(runtime.repository.inviteSummary(owner.id), before.invite);
  assert.equal(restoredVisit.id, before.visitId);
});

test('数据目录、Secrets、平台库与 Demo 商家库及 WAL/SHM 均使用最小权限', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 不提供 POSIX mode 位');
    return;
  }
  const directory = await temporaryDirectory(t, 'zeroone-permissions-');
  await chmod(directory, 0o777);
  const runtime = await createRuntime({
    dataDir: directory,
    issuer: 'http://127.0.0.1:8930',
    demoMerchantOrigin: 'http://127.0.0.1:8931',
    platformPort: 8930,
    merchantPort: 8931,
    demoMode: true,
  });
  t.after(() => runtime.close());

  runtime.database.prepare(
    'INSERT INTO audit_events (event_type, created_at) VALUES (?, ?)',
  ).run('permissions', Math.floor(Date.now() / 1_000));
  runtime.demoMerchant.database.prepare(`
    INSERT INTO merchant_users (id, issuer, subject, email, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    runtime.config.issuer,
    'permissions-subject',
    'permissions@example.com',
    'Permissions',
    Math.floor(Date.now() / 1_000),
  );

  assert.equal(permissions((await stat(directory)).mode), 0o700);
  const files = [
    runtime.config.secretsPath,
    runtime.config.databasePath,
    `${runtime.config.databasePath}-wal`,
    `${runtime.config.databasePath}-shm`,
    runtime.config.merchantDatabasePath,
    `${runtime.config.merchantDatabasePath}-wal`,
    `${runtime.config.merchantDatabasePath}-shm`,
  ];
  for (const filename of files) {
    assert.equal(
      permissions((await stat(filename)).mode),
      0o600,
      `${path.basename(filename)} 应为 0600`,
    );
  }
});

test('哈希格式固定为 SHA-256 base64url，避免 Session 明文回归', () => {
  const raw = 'session-value-that-must-not-be-stored';
  const expected = createHash('sha256').update(raw).digest('base64url');
  assert.equal(tokenHash(raw), expected);
  assert.doesNotMatch(tokenHash(raw), /session-value/);
});
