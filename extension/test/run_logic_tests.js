// Node harness: loads the shared logic files into one context and runs the
// assertions in test_logic.js. Lives in extension/test/ next to the HTML test
// pages; paths resolve against extension/.
//
//   node extension/test/run_logic_tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..');
const sandbox = { console, module: { exports: {} } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['shared/constants.js', 'shared/matching.js', 'test_logic.js']) {
  const code = fs.readFileSync(path.join(ext, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}
