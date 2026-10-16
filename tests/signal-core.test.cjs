const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../docs/signal-core.js');
test('channel gain beats stale common metadata, raw remains unchanged', () => {
  const ctx = core.context(core.metadata('# ads_gain=24\n# ads_vref_volts=4.5\n# ads_channel_gains=ch1:6 ch2:24\n# channel_registers CH1SET=0x30 CH2SET=0x60'), ['ch1','ch2']);
  assert.equal(ctx.channels.ch1.gain, 6);
  assert.equal(ctx.channels.ch2.gain, 24);
  assert.equal(core.lsb(6, 4.5), 0.08940696716308594);
  assert.equal(core.microvolts(100, ctx, 'ch1'), 4 * core.microvolts(100, ctx, 'ch2'));
  assert.ok(ctx.warnings.some(w => w.includes('공통 Gain')));
  assert.equal(ctx.channels.ch1.source, 'legacy_register_unverified');
});
test('missing settings remain unknown, schema 2 readback wins conflicting gain', () => {
  assert.ok(Number.isNaN(core.microvolts(3, core.context({}, ['ch1']), 'ch1')));
  const ctx = core.context({adc_vref_volts: '4.5', channel_1_gain: '24', channel_1_chnset_readback: '0x30'}, ['ch1']);
  assert.equal(ctx.channels.ch1.gain, 6); assert.equal(ctx.channels.ch1.source, 'readback');
});
test('DC, RMS, AC RMS and clipping are distinct', () => {
  const s = core.stats([2,4]); assert.equal(s.mean, 3); assert.equal(s.rms, Math.sqrt(10)); assert.equal(s.acRms, 1);
  assert.equal(core.stats([-8388608,8388607,0]).clipped, 2);
  assert.equal(core.stats([1,1,1]).stuck, true);
});
test('sine fitting uses irregular timestamps, not saved sample count', () => {
  for (const freq of [2,2.5,10,39]) {
    const t = Array.from({length: 1800}, (_, i) => i * .004 + (i % 7 === 0 ? .0001 : 0));
    const y = t.map(x => 3140 + 5000 * Math.sin(2 * Math.PI * freq * x));
    const before = y.slice(), fit = core.sineFit(t, y, freq);
    assert.ok(Math.abs(fit.frequency - freq) < 1e-5);
    assert.ok(Math.abs(fit.p2p - 10000) < .01); assert.ok(fit.r2 > .99999); assert.deepEqual(y, before);
  }
});
test('Welch physical density integrates to centered power', () => {
  const x = Array.from({length: 4096}, (_, i) => 100 + 5 * Math.sin(2 * Math.PI * 16 * i / 256));
  const psd = core.welch(x, 256), df = psd[1].f - psd[0].f;
  const power = psd.reduce((sum, p) => sum + p.y * df, 0);
  assert.ok(Math.abs(power - 12.5) < .001);
});
test('time diagnostics do not invent DRDY rate or packet loss', () => {
  const t = core.timing([0,4000,8000,20000].map(t_us => ({t_us}))); assert.equal(t.longIntervals, 1);
  assert.equal(t.packetLoss, null); assert.equal(t.drdyRate, null);
});
