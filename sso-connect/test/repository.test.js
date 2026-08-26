import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDatabase } from '../src/database.js';
import { createRepository } from '../src/repository.js';
import { loadOrCreateSecrets } from '../src/secrets.js';

test('邀请注册只在首次验证时归因一次', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zeroone-repository-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = await loadOrCreateSecrets(path.join(dir, 'secrets.json'));
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  const repository = createRepository(database, secrets);
  const owner = repository.ensureDemoUser();
  const rawSession = repository.createDemoSession();
  const storedSession = database.prepare('SELECT id FROM user_sessions ORDER BY created_at DESC LIMIT 1').get().id;
  assert.notEqual(storedSession, rawSession);

  const firstVisit = repository.recordInviteVisit(owner.invite_code, 'visitor-a');
  const duplicateVisit = repository.recordInviteVisit(owner.invite_code, 'visitor-a');
  assert.equal(duplicateVisit.id, firstVisit.id);

  const pending = repository.startEmailVerification('new@example.com', firstVisit.id);
  repository.verifyEmail(pending.rawToken);
  assert.deepEqual(repository.inviteSummary(owner.id), {
    inviteCode: owner.invite_code,
    clicks: 1,
    registrations: 1,
    conversionRate: 100,
    latestRegistrationAt: repository.inviteSummary(owner.id).latestRegistrationAt,
  });

  const repeated = repository.startEmailVerification('new@example.com', firstVisit.id);
  repository.verifyEmail(repeated.rawToken);
  assert.equal(repository.inviteSummary(owner.id).registrations, 1);
  const sharedBrowser = repository.startEmailVerification('second@example.com', firstVisit.id);
  repository.verifyEmail(sharedBrowser.rawToken);
  assert.equal(
    database.prepare('SELECT email_verified FROM users WHERE email = ?').get('second@example.com').email_verified,
    1,
  );
  assert.equal(repository.inviteSummary(owner.id).registrations, 1);
  assert.match(repository.inviteRegistrations(owner.id)[0].email, /\*+@example\.com/);
});

test('已有账号和自邀不会增加邀请注册人数', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zeroone-self-invite-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = await loadOrCreateSecrets(path.join(dir, 'secrets.json'));
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  const repository = createRepository(database, secrets);
  const owner = repository.ensureDemoUser();
  const visit = repository.recordInviteVisit(owner.invite_code, 'owner-browser');

  const login = repository.startEmailVerification(owner.email, visit.id);
  repository.verifyEmail(login.rawToken);
  assert.equal(repository.inviteSummary(owner.id).registrations, 0);
});
