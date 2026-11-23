// Checks the dark theme palette against WCAG contrast minimums.
// Reads the real tokens out of extension/theme.css so the numbers cannot drift
// from what ships.
//
//   node scripts/check-contrast.js

const fs = require('fs');
const path = require('path');

const THEME = path.join(__dirname, '..', 'extension', 'theme.css');
const source = fs.readFileSync(THEME, 'utf8');

const tokens = {};
for (const match of source.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\));/g)) {
  tokens[match[1]] = match[2].trim();
}

function parseColor(value) {
  if (!value) throw new Error('Missing color: ' + value);
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);
  }
  const parts = value.match(/[\d.]+/g).map(Number);
  return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts[3] === undefined ? 1 : parts[3]];
}

function composite(color, background) {
  const alpha = color[3];
  if (alpha >= 1) return color.slice(0, 3);
  return color.slice(0, 3).map((channel, i) => channel * alpha + background[i] * (1 - alpha));
}

function luminance(color) {
  const [r, g, b] = color.map(channel => (
    channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  ));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(foreground, background) {
  const l1 = luminance(composite(foreground, background));
  const l2 = luminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const TEXT = 4.5;
const UI = 3;

const checks = [
  ['body text on page', 'text', 'bg', TEXT],
  ['body text on card', 'text', 'surface', TEXT],
  ['muted text on page', 'text-muted', 'bg', TEXT],
  ['muted text on card', 'text-muted', 'surface', TEXT],
  ['muted text on raised surface', 'text-muted', 'surface-3', TEXT],
  ['subtle text on page', 'text-subtle', 'bg', TEXT],
  ['subtle text on card', 'text-subtle', 'surface', TEXT],
  ['subtle text on inset', 'text-subtle', 'surface-inset', TEXT],
  ['accent text on page', 'accent', 'bg', TEXT],
  ['accent text on card', 'accent', 'surface', TEXT],
  ['accent text on inset', 'accent', 'surface-inset', TEXT],
  ['accent text on soft chip', 'accent', 'accent-soft', TEXT],
  ['on-accent on accent fill', 'on-accent', 'accent-strong', TEXT],
  ['on-accent on accent hover', 'on-accent', 'accent-hover', TEXT],
  ['success text on card', 'success', 'surface', TEXT],
  ['success text on soft chip', 'success', 'success-soft', TEXT],
  ['warning text on card', 'warning', 'surface', TEXT],
  ['warning text on soft chip', 'warning', 'warning-soft', TEXT],
  ['danger text on card', 'danger', 'surface', TEXT],
  ['danger text on soft chip', 'danger', 'danger-soft', TEXT],
  ['border on page', 'border-strong', 'bg', UI],
  ['border on card', 'border-strong', 'surface', UI],
  ['accent fill on page', 'accent-strong', 'bg', UI],
  ['accent fill on card', 'accent-strong', 'surface', UI]
];

let failures = 0;
for (const [label, foreground, background, minimum] of checks) {
  const fg = parseColor(tokens[foreground]);
  let bg = parseColor(tokens[background]);
  // Translucent backgrounds (soft chips) sit on top of a card.
  if (bg[3] < 1) bg = composite(bg, parseColor(tokens.surface));
  const value = ratio(fg, bg);
  const passed = value >= minimum;
  if (!passed) failures += 1;
  const mark = passed ? 'pass' : 'FAIL';
  console.log(
    `${mark.padEnd(4)} ${value.toFixed(2).padStart(6)} (min ${minimum})  ${label}`
  );
}

if (failures) {
  console.error(`\n${failures} contrast check(s) below the minimum.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} contrast checks passed.`);
