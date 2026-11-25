// Exercises frame scoping and correction selection in the background worker.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const origin = 'https://example.test';
const tab = { id: 7, url: origin + '/form' };
const profile = { email: 'profile@example.test' };
const corrections = [
  { domain: '', field_label: 'Email', corrected_value: 'global@example.test' },
  { domain: 'other.example', field_label: 'Email', corrected_value: 'different@example.test' },
  { domain: 'example.test', field_label: 'Email', corrected_value: 'scoped@example.test' }
];
const top = { origin, length: 2, document: {} };
top.top = top;
const same = { origin, length: 0, top, parent: top };
const foreign = {
  origin: 'https://other.example',
  length: 0,
  top,
  parent: { get document() { throw new Error('Cross-origin frame'); } }
};

const injected = [];
const messages = [];
const sandbox = {
  URL,
  FormPilotStore: {
    loadUserData: async () => ({ profile, corrections, generation: null })
  },
  chrome: {
    runtime: { onMessage: { addListener() {} } },
    scripting: {
      async executeScript(details) {
        assert.equal(details.world, 'ISOLATED');
        assert.equal(details.target.tabId, tab.id);
        assert.equal('args' in details, false);
        if (details.func) {
          assert.equal(details.target.allFrames, true);
          return [top, same, foreign].map((frame, frameId) => {
            sandbox.window = frame;
            return { frameId, documentId: 'document-' + frameId, result: details.func() };
          });
        }
        injected.push(...details.target.documentIds);
        return [];
      }
    },
    tabs: {
      async sendMessage(tabId, message, { documentId }) {
        assert.equal(tabId, tab.id);
        messages.push({ message, documentId });
        return { success: true, supportedFields: 1, matchedFields: 1, existingFields: 0 };
      }
    }
  }
};

vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'),
  sandbox,
  { filename: 'background.js' }
);

async function run() {
  const result = await sandbox.detectFields(tab);
  assert.equal(result.matchedFields, 2);
  assert.equal(result.unreachableFrames, 1);
  assert.deepEqual(injected, ['document-0', 'document-1']);
  assert.deepEqual(messages.map(item => item.documentId), injected);
  for (const { message } of messages) {
    assert.equal(message.origin, origin);
    assert.equal(message.profile, profile);
    assert.equal(message.corrections.length, 2);
    assert.equal(message.corrections[0], corrections[2]);
    assert.equal(message.corrections[1], corrections[0]);
  }
  console.log('Background frame scoping and correction tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
