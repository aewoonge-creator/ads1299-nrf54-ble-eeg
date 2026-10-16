const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "docs", "index.html"), "utf8");
const scriptStart = html.lastIndexOf("<script>") + "<script>".length;
const scriptEnd = html.lastIndexOf("</script>");
const inlineScript = html.slice(scriptStart, scriptEnd);

test("web GUI inline script parses as JavaScript", () => {
  assert.ok(scriptStart > "<script>".length);
  assert.ok(scriptEnd > scriptStart);
  assert.doesNotThrow(() => new Function(inlineScript));
});

test("web configuration carries the implemented reference and BIAS controls", () => {
  assert.match(inlineScript, /REF_CH=/);
  assert.match(inlineScript, /ADC_REF=/);
  assert.match(inlineScript, /BIASREF=/);
  assert.match(inlineScript, /BIASP=/);
  assert.match(inlineScript, /BIASN=/);
  assert.match(inlineScript, /value \|= 0x10/);
  assert.doesNotMatch(
    inlineScript.slice(inlineScript.indexOf('$("adsStartBtn")'), inlineScript.indexOf('$("adsStopBtn")')),
    /forceElectrodeInputMode/
  );
});

test("web GUI exposes internal TEST routing, automatic verdict, and offset correction", () => {
  assert.match(html, /id="adsTestAmp"/);
  assert.match(html, /id="adsTestFreq"/);
  assert.match(html, /id="adsRunTestBtn"/);
  assert.match(html, /id="adsOffsetCalBtn"/);
  assert.match(inlineScript, /TEST_MASK=/);
  assert.match(inlineScript, /analyzeInternalTestChannel/);
  assert.match(inlineScript, /finishInputShortOffsetCalibration/);
  assert.doesNotMatch(inlineScript, /obj\[key\] -= state\.channelOffsetsRaw/);
  assert.match(inlineScript, /const display = xs\.map\(value => value - offset\)/);
});
