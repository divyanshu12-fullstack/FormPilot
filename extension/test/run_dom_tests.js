// Minimal Edge DevTools Protocol driver — no npm dependencies.
// Node 18+ ships a global WebSocket, which is all we need to talk to Edge.
//
//   node run_dom_tests.js <url> [timeoutMs]
//
// Prints every console message / page error, then the #summary text and each
// result row, so a headless run reports exactly what a human would see.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const EDGE = process.env.EDGE_PATH
  || [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ].find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!EDGE) { console.error('No Edge binary found. Set EDGE_PATH.'); process.exit(2); }

const url = process.argv[2];
const timeoutMs = Number(process.argv[3] || 60000);
const port = 9333 + (process.pid % 400);
const profileDir = path.join(os.tmpdir(), 'formpilot-cdp-' + process.pid);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--allow-file-access-from-files',
  '--disable-extensions',
  '--user-data-dir=' + profileDir,
  '--remote-debugging-port=' + port,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
edge.stderr.on('data', d => { stderr += d.toString(); });

async function fetchJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never came up.\n' + stderr.slice(-2000));
}

function cleanup() {
  try { edge.kill('SIGKILL'); } catch (e) { /* ignore */ }
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

(async () => {
  let code = 1;
  try {
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let id = 0;
    const pending = new Map();
    const logs = [];

    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
        logs.push(`[console.${msg.params.type}] ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        logs.push(`[pageerror] ${d.text} ${d.exception ? d.exception.description || d.exception.value : ''}`);
      }
      if (msg.method === 'Log.entryAdded') {
        logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
      }
      if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
        logs.push(`[http ${msg.params.response.status}] ${msg.params.response.url}`);
      }
      if (msg.method === 'Network.loadingFailed') {
        logs.push(`[netfail] ${msg.params.errorText} ${msg.params.type}`);
      }
    };

    const send = (method, params = {}, sessionId) => new Promise(res => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });

    // Open our own tab so we control exactly which target we evaluate in.
    const { result: created } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: attached } = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;

    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);

    // Wait for the runner to publish a summary that is no longer "Running…".
    const deadline = Date.now() + timeoutMs;
    let summary = null;
    while (Date.now() < deadline) {
      await sleep(400);
      const r = await send('Runtime.evaluate', {
        expression: `(function(){
          var s = document.getElementById('summary');
          return s ? s.textContent : null;
        })()`,
        returnByValue: true,
      }, sessionId);
      const val = r.result && r.result.result && r.result.result.value;
      if (val && val !== 'Running…' && val !== 'Not run yet.') { summary = val; break; }
    }

    const rowsRes = await send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('#rows tr[data-result]')).map(function(tr){
        if (tr.dataset.result === 'ERR') return 'ERR | ' + tr.children[1].textContent.trim();
        return tr.dataset.result + ' | ' + tr.children[1].textContent + ' | ' + tr.children[2].textContent.replace(/\\s+/g,' ').trim() + ' | got: ' + tr.children[3].textContent;
      })`,
      returnByValue: true,
    }, sessionId);
    const rows = (rowsRes.result && rowsRes.result.result && rowsRes.result.result.value) || [];

    if (logs.length) {
      console.log('--- page log ---');
      for (const l of logs.slice(0, 60)) console.log(l);
      console.log('----------------');
    }

    if (!summary) {
      console.log('TIMED OUT waiting for results.');
      code = 1;
    } else {
      console.log('SUMMARY: ' + summary);
      console.log('--- results ---');
      for (const r of rows) console.log(r);
      const fails = rows.filter(r => r.startsWith('FAIL')).length;
      const err = rows.filter(r => r.startsWith('ERR')).length;
      const passes = rows.filter(r => r.startsWith('PASS')).length;
      console.log('---');
      console.log(`${passes} passing, ${fails} failing, ${err} errors`);
      code = (fails || err || !passes || summary.startsWith('Harness error:')) ? 1 : 0;
    }

    ws.close();
  } catch (e) {
    console.error('driver error:', e.message);
    code = 2;
  } finally {
    cleanup();
    process.exit(code);
  }
})();
