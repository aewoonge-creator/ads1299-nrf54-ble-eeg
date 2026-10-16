const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
function harness() {
  const elements = { adsRunTestBtn: { disabled: true }, adsVrefVolts: { value: '4.5' } };
  const messages = {};
  const context = vm.createContext({
    state: { bleRxCharacteristic: {}, testDiagnostic: {
      phase: 'configuring', createdAt: 0, amplitude: '1X', frequency: 'SLOW', channels: [1]
    }, testRows: [] },
    $: id => elements[id],
    setText: (id, value) => { messages[id] = value; },
    setInterval: () => {},
    performance: { now: () => 100 },
    gainForChannel: () => 24,
    adsLsbMicrovolts: gain => 4.5e6 / (gain * 8388607)
  });
  vm.runInContext(html.slice(html.indexOf('function expectedInternalTest('), html.indexOf('async function applyAdsMode(')), context);
  return { context, state: context.state, elements, messages };
}

test('no samples after START produces a timeout and re-enables TEST', () => {
  const { context, state, messages, elements } = harness();
  context.handleInternalTestDeviceLine('OK START');
  assert.equal(state.testDiagnostic.phase, 'collecting');
  context.checkInternalTestTimeout(5200);
  assert.equal(state.testDiagnostic, null);
  assert.match(messages.adsTestResult, /샘플을 받지 못했습니다/);
  assert.equal(elements.adsRunTestBtn.disabled, false);
});

test('missing START acknowledgement cannot leave configuring indefinitely', () => {
  const { context, state, messages } = harness();
  context.checkInternalTestTimeout(21000);
  assert.equal(state.testDiagnostic, null);
  assert.match(messages.adsTestResult, /START 응답이 없습니다/);
});

test('DRDY error reports wiring instead of continuing setup', () => {
  const { context, state, messages } = harness();
  context.handleInternalTestDeviceLine('STREAM WAIT DRDY: no conversion-ready signal on P0.05');
  assert.equal(state.testDiagnostic, null);
  assert.match(messages.adsTestResult, /DRDY.*P0\.05/);
});

test('device errors and disconnection terminate the diagnostic', () => {
  const first = harness();
  first.context.handleInternalTestDeviceLine('ERR CONFIG');
  assert.equal(first.state.testDiagnostic, null);
  assert.match(first.messages.adsTestResult, /ERR CONFIG/);
  const second = harness();
  second.state.bleRxCharacteristic = null;
  second.context.checkInternalTestTimeout(101);
  assert.match(second.messages.adsTestResult, /BLE 연결이 끊겼습니다/);
});

test('fresh samples with frozen device timestamps also time out', () => {
  const { context, state, messages } = harness();
  context.handleInternalTestDeviceLine('OK START');
  state.testDiagnostic.lastSampleAt = 21000;
  context.checkInternalTestTimeout(21000);
  assert.match(messages.adsTestResult, /측정 시간이 진행되지 않습니다/);
});

test('valid raw SLOW square wave completes and passes; 62.5 Hz fails', () => {
  const { context, state, messages, elements } = harness();
  state.testRows = [{ t_us: 0, ch1: 999999 }];
  context.handleInternalTestDeviceLine('OK START');
  assert.equal(state.testRows.length, 0); // discard pre-start data
  const makeRows = hz => Array.from({ length: 1100 }, (_, i) => ({
    t_us: i * 4000,
    ch1: Math.sin(2 * Math.PI * hz * i / 250) >= 0 ? 83886 : -83886
  }));
  state.testRows = makeRows(0.9765625);
  context.renderInternalTestResults();
  assert.match(messages.adsTestResult, /CH1 PASS/);
  assert.equal(state.testDiagnostic, null);
  assert.equal(elements.adsRunTestBtn.disabled, false);
  const bad = context.analyzeInternalTestChannel(makeRows(62.5), 1, { amplitude: '1X', frequency: 'SLOW' });
  assert.equal(bad.passed, false);
});
