const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(overrides = {}) {
  const messages = {};
  const state = {commandChain: Promise.resolve(), commandJobs: 0, commandFault: false,
    bleSession: 0, bleRxCharacteristic: {}, streamSampleCount: 0};
  const c = vm.createContext({state, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    performance: {now: () => 100}, adsRegisterValues: {}, adsRegisterTimes: {}, adsAppliedRegisters: {},
    setText: (key, value) => { messages[key] = value; }, status: value => {messages.status = value;},
    logOnly: () => {}, renderAdsRegisterMap: () => {}, ...overrides});
  vm.runInContext(html.slice(html.indexOf('async function sendAds1299Command('), html.indexOf('function adsConfigCommand(')), c);
  return {c, state, messages};
}

test('next command waits for GATT write completion even when ACK arrives first', async () => {
  const {c} = harness();
  const sent = [];
  let finishWrite;
  c.writeBleCommandLine = line => {
    sent.push(line);
    c.handleCommandResponse('OK STOP');
    return sent.length === 1 ? new Promise(resolve => {finishWrite = resolve;}) : Promise.resolve();
  };
  const result = c.queueAdsCommands(['ADS1299 STOP', 'ADS1299 STOP']);
  await tick();
  const beforeCompletion = sent.length;
  finishWrite();
  await result;
  assert.equal(beforeCompletion, 1);
  assert.equal(sent.length, 2);
});

test('control writes prefer GATT response and never retry an ambiguous failed fragment', async () => {
  const {c, state} = harness();
  const calls = [];
  state.bleRxCharacteristic = {
    properties: {write: true, writeWithoutResponse: true},
    writeValueWithResponse: async () => {calls.push('response'); throw new Error('link failed');},
    writeValueWithoutResponse: async () => {calls.push('no-response');},
    writeValue: async () => {calls.push('legacy');}
  };
  await assert.rejects(c.writeBleCommandLine('ADS1299 STOP'), /link failed/);
  assert.deepEqual(calls, ['response']);
});

test('device errors leave an error status, not a permanent sending indicator', async () => {
  const {c, messages} = harness();
  c.writeBleCommandLine = async () => c.handleCommandResponse('ERR STOP');
  await assert.rejects(c.sendAds1299Commands(['ADS1299 STOP']), /ERR STOP/);
  assert.equal(messages.cmdState, '오류');
});

test('PING and firmware version require actual notification replies', async () => {
  const {c, state} = harness();
  const sent = [];
  c.writeBleCommandLine = async line => { sent.push(line); };
  const result = c.sendAds1299Commands(['PING', 'ADS1299 VERSION']);
  await tick();
  assert.deepEqual(sent, ['PING']);
  c.handleCommandResponse('RX PING');
  await tick();
  assert.deepEqual(sent, ['PING']);
  c.handleCommandResponse('PONG');
  await tick();
  assert.deepEqual(sent, ['PING', 'ADS1299 VERSION']);
  c.handleCommandResponse('FW VERSION 2026-10-16-drdy-p111-v6');
  await result;
  assert.equal(state.commandJobs, 0);
  assert.equal(state.pendingCommand, null);
});

test('no acknowledgement reports the failed command and blocks subsequent writes', async () => {
  const timers = new Set();
  const {c, state, messages} = harness({setTimeout: fn => {timers.add(fn); return fn;}, clearTimeout: fn => timers.delete(fn)});
  const sent = [];
  c.writeBleCommandLine = async line => {sent.push(line);};
  const result = c.sendAds1299Commands(['ADS1299 STOP', 'ADS1299 WREG 0x05 0x60']);
  const rejected = assert.rejects(result, /ADS1299 STOP:.*응답 시간 초과.*수신 확인 없음/);
  await tick();
  [...timers].forEach(fn => fn());
  await rejected;
  assert.equal(state.pendingCommand, null);
  assert.equal(state.commandFault, true);
  assert.equal(messages.cmdState, '오류');
  assert.deepEqual(sent, ['ADS1299 STOP']);
  await assert.rejects(c.sendAds1299Commands(['ADS1299 STOP']), /ADS1299 STOP:.*응답 시간 초과/);
  assert.deepEqual(sent, ['ADS1299 STOP']);
});

test('bulk read requires all 24 valid addresses and reports a missing response', async () => {
  let timeout;
  const {c} = harness({setTimeout: fn => {timeout = fn; return fn;}, clearTimeout: () => {}});
  c.writeBleCommandLine = async () => {};
  const result = c.sendAds1299Commands(['ADS1299 RREG ALL']);
  const rejected = assert.rejects(result, /23\/24/);
  await tick();
  for (let addr = 0; addr < 23; addr++) c.handleCommandResponse(`REG 0x${addr.toString(16).padStart(2, '0')} 0x60`);
  c.handleCommandResponse('REG 0x00 0x60');
  c.handleCommandResponse('REG 0xFF 0x60');
  timeout();
  await rejected;
});

test('a register read matches firmware zero-padded addresses, not other registers', async () => {
  const {c, state} = harness();
  c.writeBleCommandLine = async () => {};
  const result = c.sendAds1299Commands(['ADS1299 RREG 0x5']);
  await tick();
  c.handleCommandResponse('REG 0x06 0x60');
  assert.notEqual(state.pendingCommand, null);
  c.handleCommandResponse('REG 0x05 0x60');
  await result;
});

test('disconnect cancels queued commands and late old writes cannot clear new pending state', async () => {
  const {c, state} = harness();
  let rejectWrite;
  const sent = [];
  c.writeBleCommandLine = line => {sent.push(line); return new Promise((_, reject) => {rejectWrite = reject;});};
  const first = c.sendAds1299Commands(['ADS1299 STOP']);
  const queued = c.sendAds1299Commands(['ADS1299 STOP']);
  const rejected = assert.rejects(first, /disconnected/);
  const cancelled = assert.rejects(queued, /이전 BLE 연결/);
  await tick();
  state.bleSession++;
  state.pendingCommand.reject(new Error('disconnected'));
  await rejected;
  await cancelled;
  const newPending = {line: 'PING'};
  state.pendingCommand = newPending;
  state.commandFault = false;
  rejectWrite(new Error('late write failure'));
  await tick();
  assert.equal(state.pendingCommand, newPending);
  assert.equal(state.commandFault, false);
  assert.deepEqual(sent, ['ADS1299 STOP']);
});

test('long command fragments stop after connection changes', async () => {
  const {c, state} = harness();
  let writes = 0;
  state.bleRxCharacteristic = {properties: {write: true}, writeValueWithResponse: async () => {
    writes++;
    state.bleSession++;
  }};
  await assert.rejects(c.writeBleCommandLine('ADS1299 CONFIG RATE=250 GAIN=24'), /연결이 변경/);
  assert.equal(writes, 1);
});

test('hanging GATT write has a deadline, even without an expected ACK', async () => {
  let timeout;
  const {c, state, messages} = harness({setTimeout: fn => {timeout = fn; return fn;}, clearTimeout: () => {}});
  state.bleRxCharacteristic = {properties: {write: true}, writeValueWithResponse: () => new Promise(() => {})};
  const rejected = assert.rejects(c.sendAds1299Commands(['ADS1299 GPIO']), /BLE 쓰기 시간 초과/);
  await tick();
  timeout();
  await rejected;
  assert.equal(state.commandJobs, 0);
  assert.equal(state.commandFault, true);
  assert.equal(messages.cmdState, '오류');
});

test('START acknowledgement without samples reports a separate acquisition error', () => {
  const {c, state, messages} = harness();
  state.streamStartWatch = {session: 0, at: 100, samples: 0};
  c.checkStreamStart(5200);
  assert.match(messages.bleDiagnostic, /START 응답은 받았지만 EEG 샘플이 없습니다/);
  assert.equal(state.streamStartWatch, null);
  state.streamStartWatch = {session: 0, at: 100, samples: 0};
  state.streamSampleCount = 1;
  c.checkStreamStart(200);
  assert.equal(messages.bleDiagnostic, 'EEG 샘플 수신 중');
});
