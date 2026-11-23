// Screenshots an extension page with a stubbed WebExtension API so the UI can
// be reviewed without installing the extension.
//
//   node scripts/screenshot.js <url> <out.png> [--width=1280] [--height=900]
//                              [--full] [--wait=800] [--stub=options|popup|popup-empty]
//                              [--click=#selector]... [--type=#selector=value]
//
// The stub is injected before any page script runs, so storage, runtime and
// tabs behave like they do inside the browser.

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

if (!EDGE) {
  console.error('No Edge binary found. Set EDGE_PATH.');
  process.exit(2);
}

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  console.error('Usage: node scripts/screenshot.js <url> <out.png> [options]');
  process.exit(2);
}

const flag = (name, fallback) => {
  const found = args.find(a => a.startsWith('--' + name + '='));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const has = name => args.includes('--' + name);

const width = Number(flag('width', 1280));
const height = Number(flag('height', 900));
const waitMs = Number(flag('wait', 900));
const stub = flag('stub', 'none');
const clickSelectors = args
  .filter(a => a.startsWith('--click='))
  .map(a => a.slice('--click='.length));

const SAMPLE_PROFILE = {
  first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com',
  phone: '+91 98765 43210', dob: '2000-01-15', gender: 'Female',
  marital_status: 'Single', veteran_status: 'No', disability_status: 'No',
  address_line1: '12 Nehru Road', city: 'Bhopal', state: 'Madhya Pradesh',
  pincode: '462003', country: 'India',
  degree: 'B.Tech', branch: 'Computer Science', college_name: 'VIT Bhopal',
  cgpa: '9.01/10.00', graduation_year: '2024', tenth_percent: '92', twelfth_percent: '94',
  skills: ['JavaScript', 'React', 'Python'], languages: ['English', 'Hindi'],
  current_title: 'Frontend Developer', current_company: 'Acme Corp',
  experience_years: 2, total_experience_months: 24, notice_period_days: 30,
  preferred_location: 'Bhopal', work_authorization: 'Yes', relocation_ok: 'Yes',
  remote_work_ok: 'Yes',
  linkedin_url: 'https://linkedin.com/in/ada', github_url: 'https://github.com/ada',
  portfolio_url: 'https://ada.dev'
};

const SAMPLE_CORRECTIONS = [
  { domain: 'jobs.example.com', field_label: 'CGPA', corrected_value: '9.01', field_kind: 'value', updated_at: '2026-10-02T10:00:00.000Z' },
  { domain: 'jobs.example.com', field_label: 'Preferred Location', corrected_value: 'Bhopal', field_kind: 'value', updated_at: '2026-10-03T10:00:00.000Z' },
  { domain: 'forms.example.org', field_label: 'Notice period', corrected_value: '30 days', field_kind: 'value', updated_at: '2026-10-05T10:00:00.000Z' }
];

const RESULT_DETAILS = [
  { label: 'First name', status: 'filled', reason: '', source: 'Profile' },
  { label: 'Last name', status: 'filled', reason: '', source: 'Profile' },
  { label: 'Email', status: 'filled', reason: '', source: 'Profile' },
  { label: 'Phone number', status: 'filled', reason: '', source: 'Profile' },
  { label: 'Degree', status: 'filled', reason: '', source: 'Profile' },
  { label: 'Branch', status: 'filled', reason: '', source: 'Profile' },
  { label: 'CGPA', status: 'filled', reason: '', source: 'Learned correction' },
  { label: 'Preferred Location', status: 'filled', reason: '', source: 'Profile' },
  { label: 'Notice period', status: 'skipped', reason: 'No supported option matched the saved value.', source: '' },
  { label: 'Work authorization', status: 'skipped', reason: 'This field already has a value.', source: '' },
  { label: 'I agree to the terms', status: 'skipped', reason: 'Agreement left for your review.', source: '' }
];

const stubScript = {
  none: 'void 0;',
  options: `
    const data = {
      formpilotProfile: ${JSON.stringify(SAMPLE_PROFILE)},
      formpilotCorrections: ${JSON.stringify(SAMPLE_CORRECTIONS)}
    };
    window.browser = {
      storage: { local: {
        get: async keys => {
          if (keys === undefined) return Object.assign({}, data);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in data) out[key] = data[key];
          return out;
        },
        set: async obj => { Object.assign(data, obj); },
        remove: async keys => {
          for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key];
        }
      }},
      runtime: { id: 'screenshot', openOptionsPage: () => {}, sendMessage: async () => ({ success: true }) }
    };
  `,
  popup: `
    window.browser = {
      storage: { local: {
        get: async () => ({ formpilotProfile: ${JSON.stringify(SAMPLE_PROFILE)}, formpilotCorrections: [] }),
        set: async () => {}, remove: async () => {}
      }},
      runtime: {
        id: 'screenshot',
        openOptionsPage: () => {},
        sendMessage: async message => {
          if (message.action === 'detect_fields') {
            return { success: true, supportedFields: 11, matchedFields: 8, unreachableFrames: 0 };
          }
          if (message.action === 'run_autofill') {
            return {
              success: true,
              report: {
                totalFields: 11, filled: 8, noOption: 1, ambiguous: 0, noValue: 0,
                deferred: 0, unsupported: 0, skipped: 1, failed: 0, consent: 1,
                blocked: 0, unmatched: 0, failures: [], details: ${JSON.stringify(RESULT_DETAILS)}
              },
              unreachableFrames: 1
            };
          }
          return { success: true };
        }
      },
      tabs: { query: async () => [{ id: 1, url: 'https://jobs.example.com/careers/apply' }] }
    };
  `,
  'popup-empty': `
    window.browser = {
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
      runtime: { id: 'screenshot', openOptionsPage: () => {}, sendMessage: async () => ({ success: true }) },
      tabs: { query: async () => [{ id: 1, url: 'https://jobs.example.com/careers/apply' }] }
    };
  `
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(target, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(target);
      if (response.ok) return await response.json();
    } catch (error) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools endpoint never came up.');
}

(async () => {
  const profileDir = path.join(os.tmpdir(), 'formpilot-shot-' + process.pid);
  const port = 9500 + (process.pid % 300);
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--user-data-dir=' + profileDir, '--remote-debugging-port=' + port, 'about:blank'
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
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    }, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: stubScript[stub] || stubScript.none
    }, sessionId);

    await send('Page.navigate', { url }, sessionId);
    await sleep(waitMs);

    for (const selector of clickSelectors) {
      await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return !!el; })()`
      }, sessionId);
      await sleep(waitMs);
    }

    const typeSpec = flag('type', '');
    if (typeSpec) {
      const splitAt = typeSpec.indexOf('=');
      const selector = typeSpec.slice(0, splitAt);
      const value = typeSpec.slice(splitAt + 1);
      await send('Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
      }, sessionId);
      await sleep(600);
    }

    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: has('full'),
      omitBackground: false
    }, sessionId);
    if (!shot.result || !shot.result.data) throw new Error('capture failed');

    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('wrote ' + out);
    ws.close();
  } catch (error) {
    console.error('screenshot failed:', error.message);
    process.exitCode = 1;
  } finally {
    cleanup();
    process.exit(process.exitCode || 0);
  }
})();
