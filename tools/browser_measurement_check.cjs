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
    if (process.env.ADS_GUI_LAYOUT_CHECK) {
      const layout = await evaluate(`(() => {
        const workspace = document.querySelector('.workspace').getBoundingClientRect();
        const plot = $('plot').getBoundingClientRect();
        return {miniPanel: !!$('channelPlots'), workspaceWidth: workspace.width, plotWidth: plot.width, plotHeight: plot.height,
          channelSelectorPreserved: document.querySelector('.plotPanel').contains($('channels'))};
      })()`);
      assert.equal(layout.miniPanel, false);
      assert.ok(layout.plotWidth > layout.workspaceWidth * .97, JSON.stringify(layout));
      assert.ok(layout.plotHeight >= 520, JSON.stringify(layout));
      assert.equal(layout.channelSelectorPreserved, true);
      console.log('Desktop layout:', JSON.stringify(layout));
    }
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
      if (process.env.ADS_GUI_LAYOUT_CHECK) {
        await evaluate(`(() => {
          const channels = Array.from({length:8},(_,i)=>'ch'+(i+1));
          const metadata = {adc_vref_volts:'4.5', configured_adc_sps:'250'};
          channels.forEach((ch,i)=>metadata['channel_'+(i+1)+'_chnset_readback']='0x60');
          const rows = Array.from({length:1000},(_,i)=>Object.fromEntries([['t_us',i*4000],...channels.map((ch,n)=>[ch,Math.round(1000*Math.sin(2*Math.PI*(n+2)*i/250))])]));
          loadDataset(['t_us',...channels], rows, 'Synthetic layout check — not a hardware capture', {metadata});
          state.view='raw'; draw(); $('plot').scrollIntoView({block:'center'});
        })()`);
      } else await evaluate("$('validationResult').scrollIntoView({block:'center'})");
      const capture = await call('Page.captureScreenshot', {format: 'png'});
      fs.writeFileSync(screenshot, Buffer.from(capture.data, 'base64'));
    }
    if (process.env.ADS_GUI_LAYOUT_CHECK) {
      await call('Emulation.setDeviceMetricsOverride', {width:800,height:900,deviceScaleFactor:1,mobile:false});
      await delay(100);
      const narrow = await evaluate("({width:innerWidth, body:document.documentElement.scrollWidth, plot:$('plot').getBoundingClientRect().width, channelControls:!!$('selectAll')})");
      assert.ok(narrow.body <= narrow.width + 1, JSON.stringify(narrow));
      assert.ok(narrow.plot > 700, JSON.stringify(narrow));
      assert.equal(narrow.channelControls, true);
      console.log('Narrow layout:', JSON.stringify(narrow));
    }
    const bleCheck = await evaluate(`(async () => {
      // Exercise the real GUI transport against a simulated GATT peripheral.
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const registers = Array(24).fill(0); registers[0] = 0x3E;
      const device = new EventTarget(), tx = new EventTarget();
      let buffer = '', writes = 0, overlaps = 0, responseWrites = 0, noResponseWrites = 0;
      let dropStop = false;
      device.name = 'Simulated ADS1299';
      const notify = text => {
        for (let i = 0; i < text.length; i += 20) {
          tx.value = new DataView(new TextEncoder().encode(text.slice(i, i + 20)).buffer);
          tx.dispatchEvent(new Event('characteristicvaluechanged'));
        }
      };
      tx.startNotifications = async () => { notify('READY ADS1299 test peripheral\\n'); return tx; };
      const handle = line => {
        if (dropStop && line === 'ADS1299 STOP') return;
        notify('RX ' + line + '\\n');
        const words = line.split(' ');
        if (line === 'PING') notify('PONG\\n');
        else if (line === 'ADS1299 VERSION') notify('FW VERSION simulated-v6\\n');
        else if (words[1] === 'RREG') notify('REG ' + hexAddr(Number(words[2])) + ' ' + hexByte(registers[Number(words[2])]) + '\\n');
        else {
          if (words[1] === 'WREG') registers[Number(words[2])] = Number(words[3]);
          if (words[1] === 'CONFIG') registers[1] = 0x96;
          notify('OK ' + words[1] + '\\n');
          if (words[1] === 'CONFIG') notify('FW STATE CONFIG RATE=250 GAIN=24 VREF_MV=4500\\n');
          if (words[1] === 'START') setTimeout(() => {
            notify('t_us,ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8\\n');
            for (let i = 0; i < 100; i++) notify((i * 4000) + ',' + Array.from({length:8}, (_, ch) => Math.round(1000 * Math.sin(i / 5 + ch))).join(',') + '\\n');
          }, 30);
        }
      };
      const rx = {
        properties: {write: true, writeWithoutResponse: true},
        writeValueWithResponse: async chunk => {
          responseWrites++;
          if (writes++) overlaps++;
          buffer += new TextDecoder().decode(chunk);
          const lines = buffer.split('\\n'); buffer = lines.pop();
          lines.filter(Boolean).forEach(handle);
          await delay(4); // Board notification intentionally precedes GATT completion.
          writes--;
        },
        writeValueWithoutResponse: async () => {noResponseWrites++;}
      };
      device.gatt = {
        connected: false,
        connect: async () => {device.gatt.connected = true; return device.gatt;},
        disconnect: () => {device.gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected'));},
        getPrimaryService: async () => ({getCharacteristic: async uuid => uuid === $('bleChar').value ? tx : rx})
      };
      Object.defineProperty(navigator, 'bluetooth', {configurable: true, value: {requestDevice: async () => device}});
      await connectBle();
      const verified = state.bleVerified;
      $('adsStartBtn').click();
      for (let i = 0; i < 300 && (state.commandJobs || state.streamSampleCount < 100); i++) await delay(20);
      checkStreamStart();
      const first = {samples: state.streamSampleCount, pending: state.pendingCommand, fault: state.commandFault,
        applied: adsAppliedRegisters[5], readback: adsRegisterValues[5], detail: $('bleDiagnostic').textContent};
      dropStop = true;
      let failure = '';
      try { await sendAds1299Command('ADS1299 STOP'); } catch (error) {failure = error.message;}
      const failedState = $('cmdState').textContent;
      dropStop = false;
      await connectBle(); // Same device/characteristic objects: listeners must not accumulate.
      $('adsStartBtn').click();
      for (let i = 0; i < 300 && (state.commandJobs || state.streamSampleCount < 100); i++) await delay(20);
      checkStreamStart();
      const second = {samples: state.streamSampleCount, jobs: state.commandJobs, fault: state.commandFault, verified: state.bleVerified};
      releaseBleConnection();
      delete navigator.bluetooth;
      return {verified, first, second, failure, failedState, overlaps, responseWrites, noResponseWrites};
    })()`);
    assert.equal(bleCheck.verified, true);
    assert.equal(bleCheck.first.samples, 100);
    assert.equal(bleCheck.first.pending, null);
    assert.equal(bleCheck.first.fault, false);
    assert.equal(bleCheck.first.applied, bleCheck.first.readback);
    assert.match(bleCheck.first.detail, /샘플 수신 중/);
    assert.match(bleCheck.failure, /ADS1299 STOP:.*응답 시간 초과/);
    assert.equal(bleCheck.failedState, '오류');
    assert.equal(bleCheck.second.samples, 100);
    assert.equal(bleCheck.second.jobs, 0);
    assert.equal(bleCheck.second.fault, false);
    assert.equal(bleCheck.second.verified, true);
    assert.equal(bleCheck.overlaps, 0);
    assert.equal(bleCheck.noResponseWrites, 0);
    console.log('Simulated BLE lifecycle:', JSON.stringify(bleCheck));
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
        } else if (line.startsWith('ADS1299 RREG 0x')) {
          const addr = Number(line.split(' ').pop());
          updateAdsRegisterValueFromLine('REG '+hexByte(addr)+' '+hexByte(registers[addr]));
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
