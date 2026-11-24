// Builds the store packages from extension/.
//
//   node scripts/package.js
//
// Produces:
//   dist/formpilot-edge-<version>.zip     Chromium/Edge manifest (service worker)
//   dist/formpilot-firefox-<version>.zip  Firefox manifest (event page + gecko id)
//
// Test fixtures are never shipped. Node's zlib does the compression, so this
// needs no npm dependencies.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'extension');
const DIST_DIR = path.join(ROOT, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'staging');
const GECKO_ID = process.env.FORMPILOT_GECKO_ID || 'formpilot@example.com';

const EXCLUDED = new Set(['test', 'candidates', '.DS_Store', 'Thumbs.db']);

// ── ZIP writer ──
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

function dosTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5)
    | ((date.getSeconds() / 2) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5)
    | (date.getDate() & 0x1F);
  return { time, day };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    header.writeUInt32LE(offset, 42);

    central.push(header, name);
    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

// ── Packaging ──
function collectFiles(dir, base = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    const relative = base ? base + '/' + entry.name : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(absolute, relative));
    } else if (entry.isFile()) {
      files.push({ name: relative, data: fs.readFileSync(absolute) });
    }
  }
  return files;
}

function edgeManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));
  delete manifest.browser_specific_settings;
  delete manifest.background.scripts;
  manifest.background = { service_worker: 'background.js' };
  return manifest;
}

function firefoxManifest(base) {
  const manifest = JSON.parse(JSON.stringify(base));
  delete manifest.background.service_worker;
  manifest.background = { scripts: ['shared/storage.js', 'background.js'] };
  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: (base.browser_specific_settings
        && base.browser_specific_settings.gecko
        && base.browser_specific_settings.gecko.strict_min_version) || '142.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return manifest;
}

function writePackage(name, manifest, files) {
  const entries = files
    .filter(file => file.name !== 'manifest.json')
    .map(file => ({ name: file.name, data: file.data }));
  entries.push({
    name: 'manifest.json',
    data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  const target = path.join(DIST_DIR, name);
  fs.writeFileSync(target, buildZip(entries));
  return { target, count: entries.length };
}

function main() {
  const base = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, 'manifest.json'), 'utf8'));
  const version = base.version;
  const files = collectFiles(SOURCE_DIR);

  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(STAGING_DIR, { recursive: true });

  const packages = [
    { name: `formpilot-edge-${version}.zip`, manifest: edgeManifest(base) },
    { name: `formpilot-firefox-${version}.zip`, manifest: firefoxManifest(base) },
  ];

  for (const item of packages) {
    const { target, count } = writePackage(item.name, item.manifest, files);
    console.log(`wrote ${path.relative(ROOT, target)} (${count} files, ${fs.statSync(target).size} bytes)`);
  }

  // Keep an unpacked copy of the Firefox build so web-ext lint can inspect it.
  const firefoxDir = path.join(STAGING_DIR, 'firefox');
  fs.mkdirSync(firefoxDir, { recursive: true });
  for (const file of files) {
    const destination = path.join(firefoxDir, file.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.data);
  }
  fs.writeFileSync(
    path.join(firefoxDir, 'manifest.json'),
    JSON.stringify(firefoxManifest(base), null, 2) + '\n'
  );
  console.log(`unpacked firefox build at ${path.relative(ROOT, firefoxDir)}`);
}

main();
