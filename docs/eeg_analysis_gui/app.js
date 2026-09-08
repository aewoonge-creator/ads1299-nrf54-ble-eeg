const state = {
  fileName: "",
  meta: {},
  headers: [],
  rows: [],
  channels: [],
  result: null,
  view: "raw",
};

const BANDS = [
  { name: "Delta", lo: 1, hi: 4, color: "#0f8b8d" },
  { name: "Theta", lo: 4, hi: 8, color: "#e85d04" },
  { name: "Alpha", lo: 8, hi: 13, color: "#1b998b" },
  { name: "Beta", lo: 13, hi: 30, color: "#3454d1" },
  { name: "Gamma", lo: 30, hi: 45, color: "#7b2cbf" },
];

const els = {
  csvFile: document.getElementById("csvFile"),
  fileName: document.getElementById("fileName"),
  sampleRate: document.getElementById("sampleRate"),
  channelSelect: document.getElementById("channelSelect"),
  timeWindow: document.getElementById("timeWindow"),
  lowCut: document.getElementById("lowCut"),
  highCut: document.getElementById("highCut"),
  notchToggle: document.getElementById("notchToggle"),
  convertUv: document.getElementById("convertUv"),
  vref: document.getElementById("vref"),
  gain: document.getElementById("gain"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  exportBtn: document.getElementById("exportBtn"),
  statusTitle: document.getElementById("statusTitle"),
  statusDetail: document.getElementById("statusDetail"),
  channelList: document.getElementById("channelList"),
  mainPlotTitle: document.getElementById("mainPlotTitle"),
  mainPlotMeta: document.getElementById("mainPlotMeta"),
  mainCanvas: document.getElementById("mainCanvas"),
  powerCanvas: document.getElementById("powerCanvas"),
  bandTable: document.getElementById("bandTable"),
  bandTableMeta: document.getElementById("bandTableMeta"),
  metricDuration: document.getElementById("metricDuration"),
  metricFs: document.getElementById("metricFs"),
  metricRms: document.getElementById("metricRms"),
  metricAlphaPeak: document.getElementById("metricAlphaPeak"),
  metricAlphaRel: document.getElementById("metricAlphaRel"),
};

els.csvFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    loadCsv(text, file.name);
    analyze();
  } catch (error) {
    setStatus("CSV 읽기 실패", error.message);
  }
});

els.analyzeBtn.addEventListener("click", analyze);
els.exportBtn.addEventListener("click", exportSummary);

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("active", node === tab));
    render();
  });
}

function loadCsv(text, fileName) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const meta = {};
  let header = null;
  const rows = [];

  for (const line of lines) {
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      const idx = body.indexOf("=");
      if (idx > -1) meta[body.slice(0, idx).trim()] = body.slice(idx + 1).trim();
      continue;
    }
    const values = parseCsvLine(line);
    if (!header) {
      header = values.map((value) => value.trim());
      continue;
    }
    if (values.length < header.length) continue;
    rows.push(values.slice(0, header.length).map(toNumber));
  }

  if (!header || rows.length < 8) throw new Error("헤더와 충분한 데이터 행이 필요합니다.");

  state.fileName = fileName;
  state.meta = meta;
  state.headers = header;
  state.rows = rows;
  state.channels = detectChannels(header);
  if (!state.channels.length) throw new Error("ch1, EEG, channel 같은 수치 채널을 찾지 못했습니다.");

  const fs = inferSampleRate(header, rows, meta);
  if (Number.isFinite(fs)) els.sampleRate.value = round(fs, 3);
  fillChannels();
  setStatus("CSV 로드 완료", `${fileName} · ${rows.length.toLocaleString()} samples · ${state.channels.length} channels`);
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function toNumber(value) {
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function detectChannels(header) {
  const timeNames = new Set(["t", "t_s", "t_ms", "time", "time_s", "time_ms", "timestamp", "timestamp_ms", "sample", "index"]);
  return header
    .map((name, index) => ({ name, index, key: name.toLowerCase().replace(/\s+/g, "_") }))
    .filter((col) => !timeNames.has(col.key))
    .filter((col) => state.rows.some((row) => Number.isFinite(row[col.index])));
}

function inferSampleRate(header, rows, meta) {
  for (const key of ["actual_saved_rate_hz", "fs", "sample_rate", "sample_rate_hz", "sampling_rate_hz"]) {
    const value = Number(meta[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const timeIndex = findTimeColumn(header);
  if (timeIndex < 0) return Number(els.sampleRate.value);
  const times = rows.map((row) => row[timeIndex]).filter(Number.isFinite);
  if (times.length < 3) return Number(els.sampleRate.value);
  const dt = [];
  for (let i = 1; i < Math.min(times.length, 5000); i += 1) {
    const d = times[i] - times[i - 1];
    if (d > 0) dt.push(d);
  }
  if (!dt.length) return Number(els.sampleRate.value);
  const medianDt = median(dt);
  const timeName = header[timeIndex].toLowerCase();
  return timeName.includes("ms") || medianDt > 1 ? 1000 / medianDt : 1 / medianDt;
}

function findTimeColumn(header) {
  const candidates = ["t_ms", "time_ms", "timestamp_ms", "time_s", "t", "time", "timestamp"];
  const lower = header.map((h) => h.toLowerCase());
  for (const name of candidates) {
    const index = lower.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function fillChannels() {
  els.channelSelect.innerHTML = "";
  for (const channel of state.channels) {
    const option = document.createElement("option");
    option.value = String(channel.index);
    option.textContent = channel.name;
    els.channelSelect.appendChild(option);
  }

  els.channelList.innerHTML = "";
  for (const channel of state.channels) {
    const values = state.rows.map((row) => row[channel.index]).filter(Number.isFinite);
    const pill = document.createElement("div");
    pill.className = "channel-pill";
    pill.innerHTML = `<strong>${escapeHtml(channel.name)}</strong><span>${formatNumber(rms(values), 2)} raw RMS</span>`;
    els.channelList.appendChild(pill);
  }
}

function analyze() {
  if (!state.rows.length) {
    setStatus("CSV 대기 중", "먼저 CSV 파일을 선택해주세요.");
    return;
  }

  const fs = Number(els.sampleRate.value);
  const lowCut = Number(els.lowCut.value);
  const highCut = Number(els.highCut.value);
  const channelIndex = Number(els.channelSelect.value);
  const channelName = state.headers[channelIndex];
  if (!Number.isFinite(fs) || fs <= 0) throw new Error("샘플링 주파수를 확인해주세요.");

  let raw = state.rows.map((row) => row[channelIndex]).filter(Number.isFinite);
  raw = raw.filter((v) => v !== -8388608);
  if (raw.length < 16) throw new Error("분석 가능한 샘플이 너무 적습니다.");

  const unit = els.convertUv.checked ? "uV" : "count";
  if (els.convertUv.checked) {
    const lsbUv = Number(els.vref.value) / Number(els.gain.value) / (2 ** 23 - 1) * 1000000;
    raw = raw.map((v) => v * lsbUv);
  }
  raw = raw.map((v) => v - median(raw));
  const filtered = filterSignal(raw, fs, lowCut, highCut, els.notchToggle.checked);
  const fft = computeSpectrum(filtered, fs);
  const psd = computeWelch(filtered, fs);
  const powers = computeBandPowers(psd.freqs, psd.values);
  const alpha = powers.find((band) => band.name === "Alpha");
  const alphaPeak = peakInBand(psd.freqs, psd.values, 8, 13);

  state.result = {
    fs,
    unit,
    channelName,
    duration: raw.length / fs,
    raw,
    filtered,
    fft,
    psd,
    powers,
    alpha,
    alphaPeak,
    lowCut,
    highCut,
  };

  setStatus("분석 완료", `${state.fileName} · ${channelName} · band-pass ${lowCut}-${highCut} Hz`);
  render();
  els.exportBtn.disabled = false;
}

function filterSignal(values, fs, lowCut, highCut, useNotch) {
  let y = detrend(values);
  if (lowCut > 0 && lowCut < fs / 2) y = biquadHighpass(y, fs, lowCut, 0.707);
  if (highCut > 0 && highCut < fs / 2) y = biquadLowpass(y, fs, highCut, 0.707);
  if (useNotch) {
    if (fs / 2 > 50) y = biquadNotch(y, fs, 50, 20);
    if (fs / 2 > 60) y = biquadNotch(y, fs, 60, 20);
  }
  return y;
}

function detrend(values) {
  const n = values.length;
  const first = values[0];
  const slope = (values[n - 1] - first) / Math.max(1, n - 1);
  return values.map((v, i) => v - (first + slope * i));
}

function biquadLowpass(values, fs, cutoff, q) {
  const w0 = 2 * Math.PI * cutoff / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return runBiquad(values, (1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function biquadHighpass(values, fs, cutoff, q) {
  const w0 = 2 * Math.PI * cutoff / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return runBiquad(values, (1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function biquadNotch(values, fs, freq, q) {
  const w0 = 2 * Math.PI * freq / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  return runBiquad(values, 1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha);
}

function runBiquad(values, b0, b1, b2, a0, a1, a2) {
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const out = [];
  for (const x0 of values) {
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out.push(y0);
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function computeSpectrum(values, fs) {
  const n = Math.min(4096, previousPowerOfTwo(values.length));
  const start = Math.max(0, Math.floor((values.length - n) / 2));
  const segment = values.slice(start, start + n);
  const windowed = segment.map((v, i) => v * hann(i, n));
  const { re, im } = fftRadix2(windowed);
  const freqs = [];
  const amps = [];
  for (let k = 1; k <= n / 2; k += 1) {
    freqs.push(k * fs / n);
    amps.push((2 / n) * Math.hypot(re[k], im[k]));
  }
  return { freqs, amps };
}

function computeWelch(values, fs) {
  const segLen = Math.min(1024, previousPowerOfTwo(values.length));
  const step = Math.max(1, Math.floor(segLen / 2));
  const bins = segLen / 2 + 1;
  const psd = Array(bins).fill(0);
  let segments = 0;
  const winPower = Array.from({ length: segLen }, (_, i) => hann(i, segLen)).reduce((sum, v) => sum + v * v, 0);

  for (let start = 0; start + segLen <= values.length; start += step) {
    const chunk = values.slice(start, start + segLen);
    const base = mean(chunk);
    const windowed = chunk.map((v, i) => (v - base) * hann(i, segLen));
    const { re, im } = fftRadix2(windowed);
    for (let k = 0; k < bins; k += 1) {
      const scale = k === 0 || k === bins - 1 ? 1 : 2;
      psd[k] += scale * (re[k] * re[k] + im[k] * im[k]) / (fs * winPower);
    }
    segments += 1;
  }

  if (!segments) return { freqs: [], values: [] };
  return {
    freqs: Array.from({ length: bins }, (_, k) => k * fs / segLen),
    values: psd.map((v) => v / segments),
  };
}

function fftRadix2(input) {
  const n = input.length;
  const levels = Math.log2(n);
  const re = input.slice();
  const im = Array(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const j = reverseBits(i, levels);
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const theta = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = Math.cos(theta * k);
        const wi = Math.sin(theta * k);
        const even = start + k;
        const odd = even + half;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
      }
    }
  }
  return { re, im };
}

function reverseBits(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i += 1) {
    y = (y << 1) | (x & 1);
    x >>= 1;
  }
  return y;
}

function computeBandPowers(freqs, psd) {
  const total = integrateBand(freqs, psd, 1, Math.min(45, Number(els.sampleRate.value) / 2));
  return BANDS.map((band) => {
    const power = integrateBand(freqs, psd, band.lo, band.hi);
    return { ...band, power, relative: total > 0 ? power / total : 0 };
  });
}

function integrateBand(freqs, values, lo, hi) {
  let area = 0;
  for (let i = 1; i < freqs.length; i += 1) {
    const f0 = freqs[i - 1];
    const f1 = freqs[i];
    if (f1 < lo || f0 > hi) continue;
    area += ((values[i - 1] + values[i]) / 2) * (f1 - f0);
  }
  return area;
}

function peakInBand(freqs, values, lo, hi) {
  let bestFreq = NaN;
  let bestValue = -Infinity;
  for (let i = 0; i < freqs.length; i += 1) {
    if (freqs[i] >= lo && freqs[i] <= hi && values[i] > bestValue) {
      bestValue = values[i];
      bestFreq = freqs[i];
    }
  }
  return { freq: bestFreq, value: bestValue };
}

function render() {
  if (!state.result) {
    clearCanvas(els.mainCanvas, "CSV를 올리면 여기에 plot이 표시됩니다.");
    clearCanvas(els.powerCanvas, "상대 power 대기 중");
    return;
  }
  const r = state.result;
  els.metricDuration.textContent = `${formatNumber(r.duration, 1)} s`;
  els.metricFs.textContent = `${formatNumber(r.fs, 2)} Hz`;
  els.metricRms.textContent = `${formatNumber(rms(r.filtered), 2)} ${r.unit}`;
  els.metricAlphaPeak.textContent = Number.isFinite(r.alphaPeak.freq) ? `${formatNumber(r.alphaPeak.freq, 2)} Hz` : "-";
  els.metricAlphaRel.textContent = `${formatNumber((r.alpha?.relative || 0) * 100, 1)}%`;

  if (state.view === "raw") {
    els.mainPlotTitle.textContent = "Raw EEG";
    els.mainPlotMeta.textContent = `${r.channelName} · ${r.unit}`;
    drawLinePlot(els.mainCanvas, timeAxis(r.raw.length, r.fs), cropByWindow(r.raw, r.fs), "Time (s)", r.unit, "#0f8b8d");
  } else if (state.view === "filtered") {
    els.mainPlotTitle.textContent = "Filtered EEG";
    els.mainPlotMeta.textContent = `${r.lowCut}-${r.highCut} Hz · ${r.channelName}`;
    drawLinePlot(els.mainCanvas, timeAxis(cropByWindow(r.filtered, r.fs).length, r.fs), cropByWindow(r.filtered, r.fs), "Time (s)", r.unit, "#e85d04");
  } else if (state.view === "fft") {
    els.mainPlotTitle.textContent = "FFT Amplitude";
    els.mainPlotMeta.textContent = "0-45 Hz view";
    drawLinePlot(els.mainCanvas, r.fft.freqs, r.fft.amps, "Frequency (Hz)", `${r.unit}`, "#3454d1", 45);
  } else if (state.view === "psd") {
    els.mainPlotTitle.textContent = "Welch PSD";
    els.mainPlotMeta.textContent = "Power spectral density";
    drawLinePlot(els.mainCanvas, r.psd.freqs, r.psd.values, "Frequency (Hz)", `${r.unit}^2/Hz`, "#1b998b", 45, true);
  } else {
    els.mainPlotTitle.textContent = "Relative Band Power";
    els.mainPlotMeta.textContent = "1-45 Hz total 기준";
    drawBars(els.mainCanvas, r.powers, true);
  }
  drawBars(els.powerCanvas, r.powers, true);
  renderBandTable();
}

function cropByWindow(values, fs) {
  const seconds = Number(els.timeWindow.value);
  const n = Math.min(values.length, Math.max(1, Math.floor(seconds * fs)));
  return values.slice(0, n);
}

function timeAxis(length, fs) {
  return Array.from({ length }, (_, i) => i / fs);
}

function drawLinePlot(canvas, xs, ys, xLabel, yLabel, color, xMax = null, logY = false) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const pad = { l: 72, r: 26, t: 28, b: 58 };
  let points = xs.map((x, i) => ({ x, y: ys[i] })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (xMax !== null) points = points.filter((p) => p.x <= xMax);
  if (logY) points = points.filter((p) => p.y > 0).map((p) => ({ x: p.x, y: Math.log10(p.y) }));
  if (points.length < 2) {
    clearCanvas(canvas, "표시할 데이터가 부족합니다.");
    return;
  }
  const xMin = Math.min(...points.map((p) => p.x));
  const xHi = xMax ?? Math.max(...points.map((p) => p.x));
  let yMin = Math.min(...points.map((p) => p.y));
  let yMax = Math.max(...points.map((p) => p.y));
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad;
  yMax += yPad;
  drawAxes(ctx, width, height, pad, xLabel, logY ? `log10 ${yLabel}` : yLabel, xMin, xHi, yMin, yMax);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = scale(p.x, xMin, xHi, pad.l, width - pad.r);
    const y = scale(p.y, yMin, yMax, height - pad.b, pad.t);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawAxes(ctx, width, height, pad, xLabel, yLabel, xMin, xMax, yMin, yMax) {
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#ccd5df";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#627082";
  ctx.font = "22px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(xLabel, width / 2, height - 15);
  ctx.save();
  ctx.translate(20, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();

  ctx.font = "18px Segoe UI";
  for (let i = 0; i <= 5; i += 1) {
    const xVal = xMin + (xMax - xMin) * i / 5;
    const x = scale(xVal, xMin, xMax, pad.l, width - pad.r);
    ctx.strokeStyle = "#e7ebf0";
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, height - pad.b);
    ctx.stroke();
    ctx.fillText(formatNumber(xVal, 1), x, height - pad.b + 25);
  }
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i += 1) {
    const yVal = yMin + (yMax - yMin) * i / 5;
    const y = scale(yVal, yMin, yMax, height - pad.b, pad.t);
    ctx.strokeStyle = "#e7ebf0";
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(width - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = "#627082";
    ctx.fillText(formatNumber(yVal, 2), pad.l - 8, y + 6);
  }
  ctx.strokeStyle = "#9aa6b2";
  ctx.strokeRect(pad.l, pad.t, width - pad.l - pad.r, height - pad.t - pad.b);
}

function drawBars(canvas, bands, relative) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  const pad = { l: 54, r: 24, t: 28, b: 66 };
  const max = Math.max(...bands.map((b) => relative ? b.relative : b.power), 0.001);
  const gap = 18;
  const barW = (width - pad.l - pad.r - gap * (bands.length - 1)) / bands.length;
  ctx.strokeStyle = "#ccd5df";
  ctx.strokeRect(pad.l, pad.t, width - pad.l - pad.r, height - pad.t - pad.b);
  bands.forEach((band, i) => {
    const value = relative ? band.relative : band.power;
    const h = (height - pad.t - pad.b) * value / max;
    const x = pad.l + i * (barW + gap);
    const y = height - pad.b - h;
    ctx.fillStyle = band.color;
    ctx.fillRect(x, y, barW, h);
    ctx.fillStyle = "#17202a";
    ctx.font = "20px Segoe UI";
    ctx.textAlign = "center";
    ctx.fillText(band.name, x + barW / 2, height - 34);
    ctx.fillStyle = "#627082";
    ctx.font = "17px Segoe UI";
    ctx.fillText(relative ? `${formatNumber(value * 100, 1)}%` : formatNumber(value, 2), x + barW / 2, y - 8);
  });
}

function renderBandTable() {
  const r = state.result;
  els.bandTableMeta.textContent = `${r.channelName} · total 1-45 Hz`;
  els.bandTable.innerHTML = "";
  for (const band of r.powers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${band.name}</td>
      <td>${band.lo}-${band.hi}</td>
      <td>${formatNumber(band.power, 4)}</td>
      <td>${formatNumber(band.relative * 100, 2)}%</td>
    `;
    els.bandTable.appendChild(tr);
  }
}

function exportSummary() {
  if (!state.result) return;
  const r = state.result;
  const rows = [
    ["file", state.fileName],
    ["channel", r.channelName],
    ["sample_rate_hz", r.fs],
    ["duration_s", r.duration],
    ["filtered_rms", rms(r.filtered)],
    ["alpha_peak_hz", r.alphaPeak.freq],
    ...r.powers.map((band) => [`${band.name.toLowerCase()}_power`, band.power]),
    ...r.powers.map((band) => [`${band.name.toLowerCase()}_relative`, band.relative]),
  ];
  const csv = rows.map((row) => row.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.fileName.replace(/\.csv$/i, "")}_eeg_summary.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearCanvas(canvas, message) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#627082";
  ctx.font = "24px Segoe UI";
  ctx.textAlign = "center";
  ctx.fillText(message, canvas.width / 2, canvas.height / 2);
}

function setStatus(title, detail) {
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;
  els.fileName.textContent = state.fileName || "ADS1299 저장 CSV를 올려주세요";
}

function previousPowerOfTwo(n) {
  return 2 ** Math.floor(Math.log2(Math.max(2, n)));
}

function hann(i, n) {
  return 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
}

function scale(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values) {
  const sorted = values.slice().filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rms(values) {
  if (!values.length) return NaN;
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);
}

function round(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function formatNumber(value, digits) {
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 10000 || Math.abs(value) < 0.001 && value !== 0) return value.toExponential(2);
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[ch]));
}

render();
