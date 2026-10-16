// Isolated local Edge smoke test. No Bluetooth/hardware actions or existing browser profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const docs = path.resolve(__dirname, '../docs');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ads1299-gui-check-'));
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['index.html', 'stream-recording.js', 'signal-core.js', 'signal-validation-worker.js'].includes(name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(docs, name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'], {windowsHide: true, stdio: 'ignore'});
  let socket;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await delay(100);
    const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener('open', resolve, {once: true}));
    let id = 0; const pending = new Map(), errors = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (message.id && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(message.error) : p.resolve(message.result); }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, {resolve, reject}); socket.send(JSON.stringify({id, method, params})); });
    const evaluate = async expression => {
      const result = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await call('Runtime.enable');
    await call('Network.enable');
    await call('Network.setBlockedURLs', {urls: ['*cdn.jsdelivr.net*']});
    await call('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`});
    for (let i = 0; i < 100; i++) { if (await evaluate("typeof runSignalValidation === 'function' && document.querySelectorAll('[data-ads-ch]').length === 8")) break; await delay(100); }
    assert.equal(await evaluate("document.querySelectorAll('[data-ads-ch]').length"), 8);
    // Bulk selector alone is not a device setting or a channel-table mutation.
    assert.equal(await evaluate("$('adsGain').value='6'; $('adsGain').dispatchEvent(new Event('change')); adsChannelRows()[0].querySelector('.ads-ch-gain').value"), '24');
    assert.equal(await evaluate("$('adsCopyGainBtn').click(); adsChannelRows()[0].querySelector('.ads-ch-gain').value"), '6');
    assert.equal(await evaluate("Number.isFinite(adsRegisterValues[5])"), false);
    assert.equal(await evaluate("adsChannelRows()[0].querySelector('.ads-ch-biasp').checked=false; copyGlobalAdsSettingsToChannels(); adsChannelRows()[0].querySelector('.ads-ch-biasp').checked"), false);
    const reports = [];
    for (const file of process.argv.slice(2).filter(arg => arg.endsWith('.csv'))) {
      const csv = fs.readFileSync(file, 'utf8'), name = path.basename(file);
      const raw = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line && !line.startsWith('#')).slice(1).map(line => Number(line.split(',')[1]));
      await evaluate(`handleFile({name:${JSON.stringify(name)},text:async()=>${JSON.stringify(csv)}})`);
      assert.deepEqual(await evaluate('state.rows.map(row=>row.ch1)'), raw);
      const gain = Number(/Gain(\d+)/.exec(name)[1]);
      assert.equal(await evaluate('measurementContext().channels.ch1.gain'), gain);
      await evaluate(`$('signalUnit').value='uv'; document.querySelector('[data-view="validation"]').click(); $('validationFrequency').value=${JSON.stringify(name.startsWith('10Hz') ? '10' : '2')}; runSignalValidation()`);
      const result = await evaluate('state.validationResult');
      assert.equal(result.verdict, 'PASS_VS_GENERATOR_SETTINGS');
      assert.ok(result.sine.p2p > 9800 && result.sine.p2p < 10000);
      assert.equal(result.raw.clipped, 0);
      assert.deepEqual(await evaluate('state.rows.map(row=>row.ch1)'), raw);
      reports.push({file: name, gain, frequency: result.sine.frequency, uvPp: result.sine.p2p, r2: result.sine.r2});
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
    const screenshot = process.env.ADS_GUI_SCREENSHOT;
    if (screenshot) {
      await evaluate("$('validationResult').scrollIntoView({block:'center'})");
      const capture = await call('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(screenshot, Buffer.from(capture.data, 'base64'));
    }
    const roundtrip = await evaluate(`(async () => {
      // Simulator tests command/readback/export plumbing only, not physical BLE.
      const registers = Array(24).fill(0); const sent = [];
      state.bleRxCharacteristic = {}; state.datasetContext = null;
      writeBleCommandLine = async line => {
        sent.push(line);
        const w = /^ADS1299 WREG (0x[0-9A-F]+) (0x[0-9A-F]+)/i.exec(line);
        if (w) { registers[Number(w[1])] = Number(w[2]); updateAdsRegisterValueFromLine('OK WREG'); }
        else if (line.startsWith('ADS1299 CONFIG')) {
          updateAdsRegisterValueFromLine('OK CONFIG');
          updateAdsRegisterValueFromLine('FW STATE CONFIG RATE=250 GAIN=24 VREF_MV=4500');
          registers[1] = 0x96;
        } else if (line === 'ADS1299 RREG ALL') {
          registers.forEach((value, i) => updateAdsRegisterValueFromLine('REG '+hexByte(i)+' '+hexByte(value)));
        } else if (line.startsWith('ADS1299 STREAM')) updateAdsRegisterValueFromLine('OK STREAM MASK');
        else if (line === 'ADS1299 STOP') updateAdsRegisterValueFromLine('OK STOP');
        else if (line === 'ADS1299 START') updateAdsRegisterValueFromLine('OK START');
      };
      $('adsGain').value = '24';
      adsChannelRows().forEach((row,i) => { row.querySelector('.ads-ch-gain').value = i === 0 ? '6' : '24'; });
      await sendAds1299Commands(['ADS1299 STOP', ...adsFullConfigCommands()]);
      state.streamHeaders = ['t_us', 'ch1'];
      const rows = [{t_us:4000,ch1:-8388608},{t_us:8000,ch1:1234},{t_us:12000,ch1:8388607}];
      const snap = adsSettingsSnapshot();
      // Editing an unsent request must not alter effective gain, readback, or saved settings.
      adsChannelRows()[0].querySelector('.ads-ch-gain').value = '24'; updateAdsChannelPreview();
      const csv = adsMetadataLines(['t_us','ch1'], rows, {hz:250,timeCol:'t_us',durationSec:.008}, {adsSettings:snap}).join('\\n') + '\\nt_us,ch1\\n' + rows.map(r=>r.t_us+','+r.ch1).join('\\n');
      const reloaded = parseCsv(csv); const ctx = SignalCore.context(reloaded.metadata,reloaded.headers);
      await sendAds1299Commands(['ADS1299 START']);
      const savedRegister = adsRegisterValues[5]; adsRegisterValues[5] ^= 0x10;
      let mismatchStopped = false;
      try { await sendAds1299Commands(['ADS1299 START']); } catch { mismatchStopped = true; }
      adsRegisterValues[5] = savedRegister;
      let rejected = false; state.recording = true;
      try { await sendAds1299Commands(['ADS1299 WREG 0x05 0x60']); } catch { rejected = true; }
      state.recording = false;
      return {gain: ctx.channels.ch1.gain, lsb:ctx.channels.ch1.lsb, rows:reloaded.rows, effective:gainForChannel('ch1'),
        snapshotGain:snap.gain, requested:$('adsGain').value, readback:adsRegisterValues[5], applied:adsAppliedRegisters[5],
        expected:adsExpectedRegisters[5], rejected, mismatchStopped, busy:state.commandJobs, sent:sent.length, timestamp:reloaded.metadata.channel_1_readback_timestamp};
    })()`);
    assert.equal(roundtrip.gain, 6); assert.equal(roundtrip.effective, 6); assert.equal(roundtrip.snapshotGain, 6);
    assert.equal(roundtrip.lsb, 0.08940696716308594); assert.equal(roundtrip.rejected, true); assert.equal(roundtrip.busy, 0);
    assert.equal(roundtrip.mismatchStopped, true);
    assert.notEqual(roundtrip.expected, roundtrip.readback); assert.equal(roundtrip.readback, roundtrip.applied);
    assert.deepEqual(roundtrip.rows.map(r => r.ch1), [-8388608,1234,8388607]);
    assert.notEqual(roundtrip.timestamp, 'UNKNOWN');
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({browserErrors: errors.length, checks: 'gain copy/readback isolation; CSV raw preservation; four-file load, µV plot and worker sine analysis; simulated ACK/readback; schema2 roundtrip; recording config lock', reports, roundtrip, screenshot}, null, 2));
  } finally { socket?.close(); browser.kill(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
