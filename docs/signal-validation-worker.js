importScripts('./signal-core.js');
self.onmessage = ({data}) => {
  try {
    const {rows, channel, context, timeColumn, timeScale, options, sourceName} = data;
    const raw = rows.map(row => row[channel]), uv = raw.map(x => SignalCore.microvolts(x, context, channel));
    const times = rows.map(row => row[timeColumn] * timeScale);
    const timing = SignalCore.timing(rows, timeColumn, timeScale, context.requestedSps);
    const rawStats = SignalCore.stats(raw), input = SignalCore.stats(uv);
    const sine = options.mode === 'sine' ? SignalCore.sineFit(times, uv, options.frequency) : null;
    const psd = SignalCore.welch(uv, context.requestedSps);
    const peakIn = (lo, hi) => psd.filter(p => p.f >= lo && p.f <= hi).reduce((best, p) => !best || p.y > best.y ? p : best, null);
    const df = psd.length > 1 ? psd[1].f - psd[0].f : NaN;
    const warnings = [...context.warnings];
    if (timing.duration < options.duration - 1 / context.requestedSps) warnings.push(`요청 ${options.duration}s보다 짧은 ${timing.duration.toFixed(3)}s 구간입니다.`);
    if (timing.nonmonotonic) warnings.push('역전/중복 시각: 사인파 판정 불가');
    if (Math.abs(timing.savedRate / context.requestedSps - 1) > .01 || timing.longIntervals) warnings.push('저장 간격 불균일/nominal rate 차이: PSD는 등간격 가정 근사 결과입니다.');
    if (options.mode === 'short' && (context.channels[channel]?.register & 7) !== 1) warnings.push('CHnSET의 SHORTED MUX가 확인되지 않았습니다. Input-short 시험으로 확정할 수 없습니다.');
    if (options.mode === 'sine' && !sine) warnings.push('피팅 불가: Gain/VREF, 유효 시각, 최소 3주기를 확인하세요.');
    const ampError = sine && options.amplitudeMvPp > 0 ? 100 * (sine.p2p / (options.amplitudeMvPp * 1000) - 1) : null;
    const measuredError = sine && options.measuredAmplitudeMvPp > 0 ? 100 * (sine.p2p / (options.measuredAmplitudeMvPp * 1000) - 1) : null;
    let comparison = null;
    if (data.comparison && options.mode === 'sine') {
      const b = data.comparison, bRaw = b.rows.map(row => row[channel]);
      const bFit = SignalCore.sineFit(b.rows.map(row => row[b.timeColumn] * b.timeScale), bRaw, options.frequency);
      comparison = {sourceName: b.sourceName, expectedRawGainRatioBoverA: b.context.channels[channel]?.gain / context.channels[channel]?.gain,
        measuredRawAmplitudeRatioBoverA: bFit && sine ? bFit.p2p / (sine.p2p / context.channels[channel].lsb) : null,
        bFrequency: bFit?.frequency, bR2: bFit?.r2};
    }
    self.postMessage({sourceName, channel, options, context, sampleStart: times[0], sampleEnd: times.at(-1), timing,
      raw: rawStats, inputUv: input, sine, amplitudeErrorVsGeneratorPercent: ampError, amplitudeErrorVsMeasuredPercent: measuredError,
      verdict: !sine ? 'NOT_EVALUATED' : rawStats.clipped || Math.abs(sine.frequencyErrorPercent) > options.frequencyTolerance || Math.abs(ampError) > options.amplitudeTolerance || sine.r2 < .99 ? 'CHECK' : 'PASS_VS_GENERATOR_SETTINGS',
      psd: {unit: 'µV²/Hz', window: 'Hann symmetric', overlap: .5, detrend: 'segment mean', fs: context.requestedSps, bins: psd,
        integratedAcRms: Math.sqrt(psd.reduce((sum, p) => sum + p.y * df, 0)), band: [0, context.requestedSps / 2],
        peak: peakIn(df, Infinity), peak50: peakIn(49, 51), peak60: peakIn(59, 61)}, comparison, warnings});
  } catch (error) { self.postMessage({error: String(error.stack || error)}); }
};
