const test = require("node:test");
const assert = require("node:assert/strict");
const Recording = require("../docs/stream-recording.js");

const headers = ["t_us", "ch1", "ch2"];

test("a stopped recording is detached and the next recording starts clean", () => {
  const state = {};
  Recording.begin(state, { headers, startedAt: 1000, fileName: "first.csv" });
  Recording.append(state, { t_us: 0, ch1: 10, ch2: 20 });
  Recording.append(state, { t_us: 4000, ch1: 10, ch2: 20 });
  Recording.append(state, { t_us: 8000, ch1: 11, ch2: 20 });

  const first = Recording.finish(state, 2000);
  assert.equal(first.rows.length, 3);
  assert.deepEqual(first.repeatStats, { repeatedSamples: 1, comparablePairs: 2, percent: 50 });
  assert.equal(state.recordRows.length, 0);
  assert.equal(state.recording, false);
  assert.equal(Recording.elapsedMilliseconds(state, 9999), 1000);

  Recording.begin(state, { headers, startedAt: 3000, fileName: "second.csv" });
  Recording.append(state, { t_us: 0, ch1: 11, ch2: 20 });
  const second = Recording.finish(state, 3500);
  assert.equal(second.rows.length, 1);
  assert.deepEqual(second.repeatStats, { repeatedSamples: 0, comparablePairs: 0, percent: 0 });
  assert.equal(first.rows.length, 3, "the queued first export must not be mutated by session two");
});

test("invalid frames break adjacency for exact-repeat accounting", () => {
  const rows = [
    { t_us: 0, ch1: 1, ch2: 2 },
    { t_us: 4000, ch1: 1, ch2: NaN },
    { t_us: 8000, ch1: 1, ch2: 2 },
    { t_us: 12000, ch1: 1, ch2: 2 }
  ];
  assert.deepEqual(Recording.exactRepeatStats(headers, rows), {
    repeatedSamples: 1,
    comparablePairs: 1,
    percent: 100
  });
});

test("reset discards every session-specific field", () => {
  const state = {};
  Recording.begin(state, { headers, startedAt: 100, fileName: "closed_4.csv", adsSettings: { gain: 24 } });
  Recording.append(state, { t_us: 0, ch1: 7, ch2: 8 });
  Recording.reset(state);
  assert.equal(state.recording, false);
  assert.equal(state.recordHeaders, null);
  assert.deepEqual(state.recordRows, []);
  assert.equal(state.recordStartedAt, null);
  assert.equal(state.recordFileName, "");
  assert.equal(state.recordAdsSettings, null);
  assert.equal(state.recordPreviousFrame, null);
});

test("four 30-second 250 Hz save-stop cycles remain independent", () => {
  const state = {};
  const fullHeaders = ["t_us", ...Array.from({ length: 8 }, (_, index) => `ch${index + 1}`)];
  const snapshots = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    Recording.begin(state, { headers: fullHeaders, startedAt: cycle * 40000 });
    for (let sample = 0; sample < 7500; sample++) {
      const row = { t_us: sample * 4000 };
      for (let channel = 1; channel <= 8; channel++) row[`ch${channel}`] = cycle * 100000 + sample * 10 + channel;
      Recording.append(state, row);
    }
    snapshots.push(Recording.finish(state, cycle * 40000 + 30000));
  }

  assert.deepEqual(snapshots.map(snapshot => snapshot.rows.length), [7500, 7500, 7500, 7500]);
  assert.deepEqual(snapshots.map(snapshot => snapshot.repeatStats.repeatedSamples), [0, 0, 0, 0]);
  assert.deepEqual(snapshots.map(snapshot => snapshot.rows[0].t_us), [0, 0, 0, 0]);
  assert.notEqual(snapshots[0].rows, snapshots[1].rows);
});
