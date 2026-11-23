  // Smoke tests for local profile and global correction persistence.
  const assert = require('node:assert/strict');
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
  await store.saveProfile({ email: 'ada@example.com', skills: ['JS', 'Python'] });
  assert.equal((await store.loadProfile()).email, 'ada@example.com');

  await store.saveCorrection({ domain: 'example.com', field_label: 'email address', corrected_value: 'ada@work.test' });
  await store.saveCorrection({ domain: 'example.com', field_label: 'phone number', corrected_value: '+91 99999 88888' });
  // Same field label on a different site replaces the previous correction (global, not per-site).
  await store.saveCorrection({ domain: 'other.example', field_label: 'email address', corrected_value: 'ada@other.test' });
  assert.equal((await store.loadCorrections()).length, 2);

  await store.updateCorrection('email address', 'ada@updated.test');
  const backup = await store.exportData();
  assert.equal(backup.profile.email, 'ada@example.com');
  assert.equal(backup.corrections.find(item => item.field_label === 'email address').corrected_value, 'ada@updated.test');

  await store.clearUserData();
  assert.deepEqual(JSON.parse(JSON.stringify(await store.loadProfile())), {});
  assert.equal((await store.loadCorrections()).length, 0);

  await store.importData(backup);
  assert.equal((await store.loadProfile()).email, 'ada@example.com');
  await store.deleteCorrection('email address');
  const remaining = await store.loadCorrections();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].field_label, 'phone number');

  await store.clearUserData();
  assert.equal((await store.loadCorrections()).length, 0);
  console.log('Local storage tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
