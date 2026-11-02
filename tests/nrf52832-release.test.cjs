const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const release = path.join(root, 'docs/firmware');
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'manifest-nrf52832.json'), 'utf8').replace(/^\uFEFF/, ''));

test('nRF52832 downloadable HEX matches the release digest and GUI link', () => {
  assert.equal(manifest.board, 'nrf52dk/nrf52832');
  const hex = fs.readFileSync(path.join(release, manifest.hex_file));
  assert.equal(crypto.createHash('sha256').update(hex).digest('hex'), manifest.sha256);
  assert.ok(fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8').includes(`firmware/${manifest.hex_file}`));
});

test('nRF52832 Intel HEX checksums and address ranges are valid', () => {
  const lines = fs.readFileSync(path.join(release, manifest.hex_file), 'utf8').trim().split(/\r?\n/);
  let base = 0, bytes = 0, eof = false;
  for (const line of lines) {
    assert.match(line, /^:(?:[0-9a-f]{2})+$/i);
    assert.equal(eof, false, 'record after EOF');
    const record = Buffer.from(line.slice(1), 'hex');
    assert.equal(record.length, record[0] + 5);
    assert.equal(record.reduce((sum, v) => sum + v, 0) & 255, 0);
    const type = record[3];
    if (type === 4) base = record.readUInt16BE(4) * 65536;
    else if (type === 2) base = record.readUInt16BE(4) * 16;
    else if (type === 0) {
      const address = base + record.readUInt16BE(1);
      const end = address + record[0];
      assert.ok((address >= 0 && end <= 512 * 1024) ||
        (address >= 0x10001000 && end <= 0x10002000), `unexpected address ${address.toString(16)}`);
      bytes += record[0];
    } else if (type === 1) eof = true;
    else assert.ok(type === 3 || type === 5, 'unsupported HEX record type');
  }
  assert.ok(eof);
  assert.ok(bytes > 100000);
});
