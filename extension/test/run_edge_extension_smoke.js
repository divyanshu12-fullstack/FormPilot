// Loads the unpacked extension in Edge and verifies its MV3 background worker
// starts. This catches manifest/background compatibility regressions that the
// page-only DOM harness cannot detect.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE = process.env.EDGE_PATH || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => fs.existsSync(file));

if (!EDGE) {
  console.error('Microsoft Edge was not found. Set EDGE_PATH.');
  process.exit(2);
}

const extensionDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..');
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formpilot-edge-smoke-'));
const port = 9500 + (process.pid % 800);
const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
edge.stderr.on('data', chunk => { stderr += chunk.toString(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTargets() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Edge DevTools returned HTTP ${response.status}`);
  return response.json();
}

async function run() {
  try {
    let targets = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      if (edge.exitCode !== null) throw new Error('Edge exited before its DevTools endpoint started.');
      try {
        targets = await fetchTargets();
        const worker = targets.find(target => target.type === 'service_worker'
          && target.url.endsWith('/background.js'));
        if (worker) {
          console.log('Edge loaded the FormPilot extension background service worker.');
          return;
        }
      } catch (error) {
        if (attempt === 59) throw error;
      }
      await sleep(250);
    }
    throw new Error('FormPilot background service worker was not found in Edge targets.');
  } catch (error) {
    console.error(error.message);
    if (stderr.trim()) console.error(stderr.trim());
    process.exitCode = 1;
  } finally {
    const exited = edge.exitCode !== null
      ? Promise.resolve()
      : new Promise(resolve => edge.once('exit', resolve));
    edge.kill();
    await exited;
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

run();
