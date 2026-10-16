(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StreamRecording = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function eegHeaders(headers) {
    return (headers || []).filter(header => /^(?:ch\d+|eeg)/i.test(String(header)));
  }

  function emptyRepeatState(state) {
    state.recordPreviousFrame = null;
    state.recordComparablePairs = 0;
    state.recordRepeatedSamples = 0;
  }

  function reset(state) {
    state.recording = false;
    state.recordHeaders = null;
    state.recordRows = [];
    state.recordStartedAt = null;
    state.recordStoppedAt = null;
    state.recordLastElapsedMs = 0;
    state.lastRecordingUiAt = 0;
    state.recordFirstTime = NaN;
    state.recordLastTime = NaN;
    state.recordTimedSamples = 0;
    state.recordFileName = "";
    state.recordAdsSettings = null;
    emptyRepeatState(state);
    return state;
  }

  function begin(state, options) {
    reset(state);
    state.recording = true;
    state.recordHeaders = (options.headers || []).slice();
    state.recordStartedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
    state.lastRecordingUiAt = Number.isFinite(options.uiStartedAt) ? options.uiStartedAt : 0;
    state.recordFileName = options.fileName || "";
    state.recordAdsSettings = options.adsSettings || null;
    return state;
  }

  function addRepeatObservation(state, row) {
    const channels = eegHeaders(state.recordHeaders);
    const frame = channels.map(channel => row[channel]);
    if (!frame.length || frame.some(value => !Number.isFinite(value))) {
      state.recordPreviousFrame = null;
      return;
    }
    if (state.recordPreviousFrame) {
      state.recordComparablePairs++;
      if (frame.every((value, index) => value === state.recordPreviousFrame[index])) {
        state.recordRepeatedSamples++;
      }
    }
    state.recordPreviousFrame = frame;
  }

  function append(state, row) {
    if (!state.recording || !state.recordHeaders) return false;
    const saved = { ...row };
    state.recordRows.push(saved);
    addRepeatObservation(state, saved);
    const timeColumn = state.recordHeaders[0];
    const time = saved[timeColumn];
    if (Number.isFinite(time)) {
      if (!Number.isFinite(state.recordFirstTime)) state.recordFirstTime = time;
      state.recordLastTime = time;
      state.recordTimedSamples++;
    }
    return true;
  }

  function repeatSummary(repeatedSamples, comparablePairs) {
    return {
      repeatedSamples,
      comparablePairs,
      percent: comparablePairs > 0 ? repeatedSamples / comparablePairs * 100 : 0
    };
  }

  function finish(state, stoppedAt = Date.now()) {
    if (!state.recording) return null;
    const stopTime = Number.isFinite(stoppedAt) ? stoppedAt : Date.now();
    const elapsedMs = Math.max(0, stopTime - state.recordStartedAt);
    const snapshot = {
      headers: state.recordHeaders,
      rows: state.recordRows,
      startedAt: state.recordStartedAt,
      stoppedAt: stopTime,
      elapsedMs,
      fileName: state.recordFileName,
      adsSettings: state.recordAdsSettings,
      repeatStats: repeatSummary(state.recordRepeatedSamples, state.recordComparablePairs)
    };

    state.recording = false;
    state.recordHeaders = null;
    state.recordRows = [];
    state.recordStartedAt = null;
    state.recordStoppedAt = stopTime;
    state.recordLastElapsedMs = elapsedMs;
    state.lastRecordingUiAt = 0;
    state.recordFirstTime = NaN;
    state.recordLastTime = NaN;
    state.recordTimedSamples = 0;
    state.recordFileName = "";
    state.recordAdsSettings = null;
    emptyRepeatState(state);
    return snapshot;
  }

  function elapsedMilliseconds(state, now = Date.now()) {
    if (state.recording && Number.isFinite(state.recordStartedAt)) {
      return Math.max(0, now - state.recordStartedAt);
    }
    return Math.max(0, state.recordLastElapsedMs || 0);
  }

  function exactRepeatStats(headers, rows) {
    const channels = eegHeaders(headers);
    let previous = null;
    let comparablePairs = 0;
    let repeatedSamples = 0;
    for (const row of rows || []) {
      const frame = channels.map(channel => row[channel]);
      if (!frame.length || frame.some(value => !Number.isFinite(value))) {
        previous = null;
        continue;
      }
      if (previous) {
        comparablePairs++;
        if (frame.every((value, index) => value === previous[index])) repeatedSamples++;
      }
      previous = frame;
    }
    return repeatSummary(repeatedSamples, comparablePairs);
  }

  return { reset, begin, append, finish, elapsedMilliseconds, exactRepeatStats };
});
