// Renders extension/icons/icon.svg into the PNG sizes the extension manifest
// and the browser stores need. Uses the Edge that is already installed and
// Node's built-in WebSocket, so it needs no npm dependencies.
//
//   node scripts/generate-icons.js

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'extension', 'icons', 'icon.svg');
const SOURCE_16 = path.join(ROOT, 'extension', 'icons', 'icon-16.svg');
const OUT_DIR = path.join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 96, 128];

const EDGE = process.env.EDGE_PATH
  || [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ].find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!EDGE) {
  console.error('No Edge binary found. Set EDGE_PATH.');
  process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never came up.');
}

(async () => {
  if (!fs.existsSync(SOURCE)) {
    console.error('Missing source icon: ' + SOURCE);
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const svg = fs.readFileSync(SOURCE, 'utf8');
  const svg16 = fs.existsSync(SOURCE_16) ? fs.readFileSync(SOURCE_16, 'utf8') : svg;
  const profileDir = path.join(os.tmpdir(), 'formpilot-icons-' + process.pid);
  const port = 9700 + (process.pid % 200);

  const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + port,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const cleanup = () => {
    try { edge.kill('SIGKILL'); } catch (error) { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  };

  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      pending.get(message.id)(message);
      pending.delete(message.id);
    };
    const send = (method, params = {}, sessionId) => new Promise(resolve => {
      const messageId = ++id;
      pending.set(messageId, resolve);
      ws.send(JSON.stringify({ id: messageId, method, params, sessionId }));
    });

    const { result: created } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: attached } = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await send('Page.enable', {}, sessionId);

    for (const size of SIZES) {
      const source = size === 16 ? svg16 : svg;
      const html = '<!doctype html><meta charset="utf-8">'
        + '<style>html,body{margin:0;padding:0;background:transparent}'
        + 'svg{display:block;width:' + size + 'px;height:' + size + 'px}</style>'
        + source;
      const page = path.join(profileDir, 'icon-' + size + '.html');
      fs.writeFileSync(page, html);

      await send('Emulation.setDeviceMetricsOverride', {
        width: size, height: size, deviceScaleFactor: 1, mobile: false,
      }, sessionId);
      await send('Page.navigate', { url: 'file:///' + page.replace(/\\/g, '/') }, sessionId);
      await sleep(400);

      const shot = await send('Page.captureScreenshot', {
        format: 'png', omitBackground: true, captureBeyondViewport: false,
      }, sessionId);
      if (!shot.result || !shot.result.data) throw new Error('capture failed for ' + size + 'px');

      const outFile = path.join(OUT_DIR, 'icon-' + size + '.png');
      fs.writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'));
      console.log('wrote ' + path.relative(ROOT, outFile));
    }

    ws.close();
  } catch (error) {
    console.error('icon generation failed:', error.message);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
