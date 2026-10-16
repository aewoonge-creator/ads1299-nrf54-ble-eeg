/* Shared, pure measurement calculations. Raw ADC rows are never modified. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SignalCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const gains = [1, 2, 4, 6, 8, 12, 24];
  const gainFromRegister = value => Number.isInteger(value) && value >= 0 && value <= 255 ? gains[(value >> 4) & 7] ?? NaN : NaN;
  const lsb = (gain, vref) => gains.includes(Number(gain)) && Number(vref) > 0 ? Number(vref) * 1e6 / (8388608 * Number(gain)) : NaN;
  function metadata(text) {
    const result = {};
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const pair = /^\s*#\s*([\w]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
      if (pair) result[pair[1]] = pair[2].trim();
    }
    return result;
  }
  function context(meta = {}, channels = []) {
    const vref = Number(meta.adc_vref_volts ?? meta.ads_vref_volts);
    const result = {metadata: {...meta}, vref, channels: {}, warnings: [], requestedSps: Number(meta.configured_adc_sps ?? meta.ads_config_rate_sps ?? meta.requested_sps), timebase: meta.timestamp_basis ?? meta.csv_timebase ?? 'unknown'};
    for (const ch of channels.filter(ch => /^ch[1-8]$/i.test(ch))) {
      const n = Number(ch.slice(2));
      const declared = /(?:^|\s)ch\d+:/i.test(meta.ads_channel_gains || '') ? Number(new RegExp(`(?:^|\\s)ch${n}:([\\d.]+)`, 'i').exec(meta.ads_channel_gains)?.[1]) : NaN;
      const legacyReg = new RegExp(`\\bCH${n}SET=(0x[0-9a-f]+)`, 'i').exec(meta.channel_registers || meta.registers || '');
      // v1 register maps mixed predictions with readbacks. Never label them verified.
      const explicitReg = meta[`channel_${n}_chnset_readback`];
      const reg = explicitReg != null ? Number(explicitReg) : Number(legacyReg?.[1]);
      const registerGain = gainFromRegister(reg);
      const perChannel = Number(meta[`channel_${n}_gain`] ?? declared);
      const common = Number(meta.ads_gain);
      const gain = Number.isFinite(registerGain) ? registerGain : gains.includes(perChannel) ? perChannel : gains.includes(common) ? common : NaN;
      const source = Number.isFinite(registerGain) ? (explicitReg != null ? 'readback' : 'legacy_register_unverified') : gains.includes(perChannel) ? 'channel_metadata' : 'legacy_global_unverified';
      if (gains.includes(common) && common !== gain) result.warnings.push(`${ch}: 공통 Gain ${common} 무시, 채널 Gain ${gain} 사용`);
      if (gains.includes(perChannel) && Number.isFinite(registerGain) && perChannel !== registerGain) result.warnings.push(`${ch}: 채널 Gain과 CHnSET 충돌, 레지스터 값 우선`);
      if (source.includes('unverified')) result.warnings.push(`${ch}: 구형 CSV 설정은 실제 readback 여부 미확인`);
      if (!Number.isFinite(lsb(gain, vref))) result.warnings.push(`${ch}: Gain/VREF 누락, µV 환산 불가`);
      result.channels[ch] = {gain, lsb: lsb(gain, vref), register: reg, source};
    }
    return result;
  }
  function microvolts(raw, ctx, ch) { return Number(raw) * (ctx?.channels?.[ch]?.lsb ?? NaN); }
  function stats(values) {
    let count = 0, mean = 0, m2 = 0, sum2 = 0, min = Infinity, max = -Infinity, clipped = 0;
    for (const x of values) {
      if (!Number.isFinite(x)) continue;
      count++; const delta = x - mean; mean += delta / count; m2 += delta * (x - mean);
      sum2 += x * x; min = Math.min(min, x); max = Math.max(max, x);
      if (x <= -8388608 || x >= 8388607) clipped++;
    }
    return {count, mean: count ? mean : NaN, rms: count ? Math.sqrt(sum2 / count) : NaN,
      acRms: count ? Math.sqrt(m2 / count) : NaN, min, max, p2p: count ? max - min : NaN,
      clipped, clippedPercent: count ? 100 * clipped / count : NaN, stuck: count > 1 && min === max};
  }
  function timing(rows, timeColumn = 't_us', scale = 1e-6, configuredSps = 250) {
    const deltas = []; let nonmonotonic = 0;
    for (let i = 1; i < rows.length; i++) {
      const dt = (rows[i][timeColumn] - rows[i - 1][timeColumn]) * scale;
      if (dt > 0) deltas.push(dt); else nonmonotonic++;
    }
    const sorted = deltas.slice().sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
    const duration = rows.length > 1 ? (rows.at(-1)[timeColumn] - rows[0][timeColumn]) * scale : NaN;
    return {duration, samples: rows.length, savedRate: duration > 0 ? (rows.length - 1) / duration : NaN,
      medianInterval: median, medianRate: median > 0 ? 1 / median : NaN,
      maxInterval: sorted.at(-1), nonmonotonic, longIntervals: deltas.filter(dt => dt > 1.8 / configuredSps).length,
      drdyRate: null, packetLoss: null, note: '시각 간격은 읽기 지연/누락 후보이며 DRDY 주기 또는 BLE 손실률이 아닙니다. DRDY/sequence 계측 없음.'};
  }
  function solve3(a, b) {
    const m = a.map((row, i) => [...row, b[i]]);
    for (let k = 0; k < 3; k++) {
      let pivot = k;
      for (let j = k + 1; j < 3; j++) if (Math.abs(m[j][k]) > Math.abs(m[pivot][k])) pivot = j;
      [m[k], m[pivot]] = [m[pivot], m[k]];
      if (Math.abs(m[k][k]) < 1e-12) return null;
      const d = m[k][k]; for (let j = k; j < 4; j++) m[k][j] /= d;
      for (let i = 0; i < 3; i++) if (i !== k) { const q = m[i][k]; for (let j = k; j < 4; j++) m[i][j] -= q * m[k][j]; }
    }
    return m.map(row => row[3]);
  }
  // Least-squares sine + cosine + DC, evaluated on actual device timestamps.
  function sineFit(times, values, targetHz) {
    if (times.length !== values.length || values.length < 16 || !(targetHz > 0)) return null;
    const origin = times[0], t = times.map(x => x - origin), duration = t.at(-1);
    if (!(duration * targetHz >= 3) || t.some((x, i) => !Number.isFinite(x) || (i && x <= t[i - 1])) || values.some(x => !Number.isFinite(x))) return null;
    const s = stats(values);
    function fit(f) {
      let ss = 0, cc = 0, sc = 0, sy = 0, cy = 0, sn = 0, cn = 0;
      for (let i = 0; i < t.length; i++) {
        const sin = Math.sin(2 * Math.PI * f * t[i]), cos = Math.cos(2 * Math.PI * f * t[i]);
        ss += sin * sin; cc += cos * cos; sc += sin * cos; sn += sin; cn += cos;
        sy += sin * values[i]; cy += cos * values[i];
      }
      const p = solve3([[ss, sc, sn], [sc, cc, cn], [sn, cn, t.length]], [sy, cy, s.mean * t.length]);
      if (!p) return {error: Infinity};
      let error = 0;
      for (let i = 0; i < t.length; i++) error += (values[i] - p[0] * Math.sin(2 * Math.PI * f * t[i]) - p[1] * Math.cos(2 * Math.PI * f * t[i]) - p[2]) ** 2;
      return {frequency: f, p2p: 2 * Math.hypot(p[0], p[1]), dc: p[2], r2: s.acRms > 0 ? 1 - error / (t.length * s.acRms ** 2) : NaN, error};
    }
    const lower = targetHz * 0.8, upper = targetHz * 1.2;
    const steps = Math.max(40, Math.ceil((upper - lower) * duration * 8));
    let best = {error: Infinity};
    for (let i = 0; i <= steps; i++) { const found = fit(lower + (upper - lower) * i / steps); if (found.error < best.error) best = found; }
    let lo = Math.max(lower, best.frequency - (upper - lower) / steps), hi = Math.min(upper, best.frequency + (upper - lower) / steps);
    for (let i = 0; i < 36; i++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (fit(a).error < fit(b).error) hi = b; else lo = a;
    }
    best = fit((lo + hi) / 2); best.frequencyErrorPercent = 100 * (best.frequency / targetHz - 1);
    return best;
  }
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) for (let start = 0; start < n; start += len) for (let j = 0; j < len / 2; j++) {
      const angle = -2 * Math.PI * j / len, a = start + j, b = a + len / 2;
      const tr = re[b] * Math.cos(angle) - im[b] * Math.sin(angle), ti = re[b] * Math.sin(angle) + im[b] * Math.cos(angle);
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
  // One-sided density, Hann window, 50% overlap, per-segment DC removal.
  function welch(values, fs, requestedSegment = 1024) {
    if (!(fs > 0) || values.length < 16 || values.some(x => !Number.isFinite(x))) return [];
    const n = 2 ** Math.floor(Math.log2(Math.min(requestedSegment, values.length)));
    const window = Array.from({length: n}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    const energy = window.reduce((s, x) => s + x * x, 0), bins = Array(n / 2 + 1).fill(0); let count = 0;
    for (let start = 0; start + n <= values.length; start += n / 2) {
      const part = values.slice(start, start + n), mean = stats(part).mean;
      const re = part.map((x, i) => (x - mean) * window[i]), im = Array(n).fill(0); fft(re, im);
      bins.forEach((_, k) => { bins[k] += (k === 0 || k === n / 2 ? 1 : 2) * (re[k] ** 2 + im[k] ** 2) / (fs * energy); }); count++;
    }
    return bins.map((value, k) => ({f: k * fs / n, y: value / count}));
  }
  return {metadata, context, gainFromRegister, lsb, microvolts, stats, timing, sineFit, welch};
});
