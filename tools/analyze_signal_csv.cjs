// Read-only golden-capture validation: node tools/analyze_signal_csv.cjs <csv> ...
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('../docs/signal-core.js');
const results = process.argv.slice(2).map(file => {
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  const headers = lines.shift().split(',');
  const rows = lines.map(line => Object.fromEntries(line.split(',').map((v, i) => [headers[i], Number(v)])));
  const ctx = core.context(core.metadata(text), headers);
  const ch = headers.find(h => /^ch\d+$/.test(h));
  const raw = rows.map(row => row[ch]), uv = raw.map(x => core.microvolts(x, ctx, ch));
  const target = Number(/(\d+(?:\.\d+)?)Hz/i.exec(path.basename(file))?.[1]);
  return {file: path.basename(file), sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    gain: ctx.channels[ch]?.gain, warnings: ctx.warnings, timing: core.timing(rows, 't_us', 1e-6, ctx.requestedSps),
    raw: core.stats(raw), inputUv: core.stats(uv), sine: core.sineFit(rows.map(r => r.t_us * 1e-6), uv, target)};
});
console.log(JSON.stringify(results, null, 2));
