const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Recording = require('../docs/stream-recording.js');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
function source(start, end) { return html.slice(html.indexOf(start), html.indexOf(end)); }
function harness() {
  const state = {streamHeaders: ['t_us', 'ch1', 'ch2'], streamRows: [], streamSampleCount: 0,
    testRows: [], offsetApplied: true, channelOffsetsRaw: [100, -200],
    lastUiUpdateAt: 100, lastRecordingUiAt: 100, lastLiveStatsAt: 100, lastStreamPlotAt: 100};
  Recording.begin(state, {headers: state.streamHeaders, startedAt: 1});
  const noop = () => {};
  let blob;
  const c = vm.createContext({state, StreamRecording: Recording, performance: {now: () => 100},
    handleInternalTestDeviceLine: noop, logOnly: noop, status: noop,
    updateAdsRegisterValueFromLine: noop, needsFullLiveAnalysis: () => false,
    $: () => ({checked: false, value: '0'}),
    actualSavedRate: () => ({hz: 250, timeCol: 't_us'}), adsMetadataLines: () => [],
    Blob, URL: {createObjectURL: b => {blob = b; return 'blob:test';}, revokeObjectURL: noop},
    document: {createElement: () => ({click: noop})}, setTimeout: fn => {fn(); return 1;}});
  vm.runInContext(source('function appendStreamText(', 'function sanitizeCsvFileName('), c);
  vm.runInContext(source('function filterSignal(', 'function bandSignal('), c);
  vm.runInContext(source('function sanitizeCsvFileName(', 'function enqueueRowsCsv('), c);
  return {c, state, blob: () => blob};
}
test('fragmented BLE notifications preserve signed ADC limits, raw rows and recorded CSV with offset ON', async () => {
  const h = harness();
  for (const part of ['4000,-838', '8608,8388607\n80', '00,100,-200\n']) h.c.appendStreamText(part, 'BLE');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.streamRows)), [
    {t_us: 4000, ch1: -8388608, ch2: 8388607}, {t_us: 8000, ch1: 100, ch2: -200}]);
  const snapshot = Recording.finish(h.state);
  await h.c.downloadRowsCsv({...snapshot, withMeta: false, prefix: 'test'});
  assert.match(await h.blob().text(), /t_us,ch1,ch2\n4000,-8388608,8388607\n8000,100,-200\n/);
});
test('display offset changes a copy, not raw ADC values', () => {
  const {c} = harness();
  const raw = [100, 101, 102];
  assert.deepEqual(Array.from(c.filterSignal(raw, 250, 'ch1')), [0, 1, 2]);
  assert.deepEqual(raw, [100, 101, 102]);
  assert.deepEqual(Array.from(c.filterSignal(raw, 250)), raw);
});
test('malformed/truncated lines cannot replace headers or reset a recording', () => {
  const {c, state} = harness();
  c.appendStreamText('4000,1,2\n8000,3\n12000,NaN,4\n16000,8388608,0\n20000,5,6\n', 'BLE');
  assert.equal(state.recording, true);
  assert.equal(state.recordRows.length, 2);
  assert.deepEqual(state.streamHeaders, ['t_us','ch1','ch2']);
  assert.equal(state.streamRows[1].t_us, 20000); // no invented fill samples
});
test('CSV declares raw unfiltered values and real device timebase', () => {
  assert.match(html, /csv_data=raw_signed_24bit_adc_counts/);
  assert.match(html, /csv_filters=NONE/);
  assert.match(html, /csv_timebase=device_read_elapsed_us/);
  assert.match(html, /ads_offset_correction=OFF/);
});

test('optional real bench capture survives GUI parsing, TEST analysis and CSV byte-for-byte',
  {skip: !process.env.ADS1299_CAPTURE_CSV}, async () => {
    const csv = fs.readFileSync(process.env.ADS1299_CAPTURE_CSV, 'utf8').replace(/\r\n/g, '\n');
    const {c, state, blob} = harness();
    const headers = csv.trim().split('\n')[0].split(',');
    state.streamHeaders = headers;
    Recording.begin(state, {headers, startedAt: 1});
    for (let i = 0; i < csv.length; i += 37) c.appendStreamText(csv.slice(i, i + 37), 'BLE replay of RTT capture');
    const expected = csv.trim().split('\n').slice(1).map(line => line.split(',').map(Number));
    assert.equal(state.recordRows.length, expected.length);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(headers.map(key => state.recordRows[i][key]), expected[i]);
    }
    Object.assign(c, {setInterval: () => {}, gainForChannel: () => 24,
      adsLsbMicrovolts: gain => 4.5e6 / (gain * 8388607)});
    vm.runInContext(source('function expectedInternalTest(', 'async function applyAdsMode('), c);
    for (let channel = 1; channel <= 8; channel++) {
      const result = c.analyzeInternalTestChannel(state.recordRows, channel, {amplitude: '1X', frequency: 'SLOW'});
      assert.equal(result.passed, true, `CH${channel}: ${JSON.stringify(result)}`);
    }
    const snapshot = Recording.finish(state);
    await c.downloadRowsCsv({...snapshot, withMeta: false, prefix: 'bench-replay'});
    assert.equal((await blob().text()).replace(/^\uFEFF/, ''), csv);
  });
