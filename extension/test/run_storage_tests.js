// Smoke tests for local profile, corrections, and backup persistence.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const values = {};
const storage = {
  async get(keys) {
    if (typeof keys === 'string') return { [keys]: values[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, values[key]]));
    return { ...keys, ...values };
  },
  async set(items) { Object.assign(values, items); },
  async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }
};

const sandbox = {
  browser: { storage: { local: storage }, runtime: {} },
  crypto: { randomUUID },
  console,
  Date,
  Promise,
  TypeError,
  Error
};
sandbox.globalThis = sandbox;
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'shared', 'storage.js'), 'utf8'),
  sandbox,
  { filename: 'shared/storage.js' }
);

async function run() {
  const store = sandbox.FormPilotStore;
  const { generation } = await store.loadProfileState();
  await Promise.all([
    store.saveProfileChanges({ email: 'ada@example.com' }, generation),
    store.saveProfileChanges({ first_name: 'Ada', skills: ['JS', 'Python'] }, generation)
  ]);
  assert.equal((await store.loadProfile()).email, 'ada@example.com');
  assert.equal((await store.loadProfile()).first_name, 'Ada');

  const globalEmail = { domain: '', field_label: 'email address', corrected_value: 'ada@work.test' };
  await Promise.all([
    store.saveCorrection(globalEmail, generation),
    store.saveCorrection({ domain: '', field_label: 'phone number', corrected_value: '+91 99999 88888' }, generation),
    store.saveCorrection({ ...globalEmail, domain: 'example.com', corrected_value: 'ada@scoped.test' }, generation)
  ]);
  await store.saveCorrection({ ...globalEmail, field_label: 'Email address?', corrected_value: 'ada@other.test' }, generation);
  assert.equal((await store.loadCorrections()).length, 3);

  await store.updateCorrection('', 'email address', 'ada@updated.test');
  const backup = await store.exportData();
  assert.equal(backup.profile.email, 'ada@example.com');
  assert.equal(backup.corrections.find(item => !item.domain && /email/i.test(item.field_label)).corrected_value, 'ada@updated.test');

  const [, staleProfile, staleCorrection] = await Promise.all([
    store.clearUserData(),
    store.saveProfileChanges({ email: 'stale@example.test' }, generation),
    store.saveCorrection(globalEmail, generation)
  ]);
  assert.equal(staleProfile, false);
  assert.equal(staleCorrection, false);
  assert.deepEqual(JSON.parse(JSON.stringify(await store.loadProfile())), {});
  assert.equal((await store.loadCorrections()).length, 0);

  const clearedGeneration = (await store.loadProfileState()).generation;
  await store.importData(backup);
  assert.equal(await store.saveProfileChanges({ email: 'stale@example.test' }, clearedGeneration), false);
  await assert.rejects(store.importData({ ...backup, version: 2 }), /not a valid FormPilot backup/);
  await assert.rejects(store.importData({ ...backup, profile: { email: {} } }), /not a valid FormPilot backup/);
  assert.equal((await store.loadProfile()).email, 'ada@example.com');
  await store.deleteCorrection('', 'email address');
  const remaining = await store.loadCorrections();
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].field_label, 'phone number');
  assert.equal(remaining[1].domain, 'example.com');
  assert.equal(remaining[1].corrected_value, 'ada@scoped.test');

  await store.clearUserData();
  assert.equal((await store.loadCorrections()).length, 0);
  console.log('Local storage tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
