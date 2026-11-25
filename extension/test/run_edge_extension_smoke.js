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
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
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

function isFormPilotWorker(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  return new Promise(resolve => {
    const finish = matches => {
      clearTimeout(timeout);
      socket.close();
      resolve(matches);
    };
    const timeout = setTimeout(() => finish(false), 1500);
    socket.onopen = () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: '({manifest: chrome.runtime.getManifest(), ready: typeof FormPilotStore !== "undefined"})',
          returnByValue: true
        }
      }));
    };
    socket.onerror = () => finish(false);
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      const result = message.result?.result?.value;
      finish(result?.ready === true && result.manifest?.name === manifest.name
        && result.manifest.version === manifest.version);
    };
  });
}

async function run() {
  try {
    let targets = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      if (edge.exitCode !== null) throw new Error('Edge exited before its DevTools endpoint started.');
      try {
        targets = await fetchTargets();
        const workers = targets.filter(target => target.type === 'service_worker'
          && target.url.endsWith('/' + manifest.background.service_worker) && target.webSocketDebuggerUrl);
        for (const worker of workers) {
          if (await isFormPilotWorker(worker)) {
            console.log('Edge loaded FormPilot ' + manifest.version + ' and initialized its background storage.');
            return;
          }
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
    await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

run();
