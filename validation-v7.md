# GUI v7 validation — 2026-10-16

## Changes and verification scope

`docs/signal-core.js`: shared gain/voltage conversion, legacy metadata, DC/RMS/AC RMS, timestamp diagnostics, actual-time sine fitting, normalized Welch density.
`docs/index.html`: requested/ACK/readback separation, explicit bulk gain copy, channel readback gain, command serialization and timeout, schema-2 snapshots, CSV metadata restore, physical-unit analysis and validation UI.
`docs/signal-validation-worker.js`: validation off the UI thread, configurable amplitude/frequency tolerances, generator-setting versus independently measured amplitude errors, input-short/noise report.

The four supplied generator CSVs were read without modification. They are not copied into this repository. Browser tests use an isolated Edge profile and local HTTP server. Mock command responses verify ACK/readback behavior; they do **not** establish physical BLE performance.

| Capture | Restored Gain | Fitted Hz | Fitted input µVpp | R² | Saved samples/s |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2 Hz / Gain 6 | 6 | 1.999904 | 9938.790 | 0.999869 | 247.862861 |
| 2 Hz / Gain 24 | 24 | 1.999871 | 9928.529 | 0.999811 | 247.439817 |
| 10 Hz / Gain 6 | 6 | 9.999489 | 9865.294 | 0.999557 | 248.343095 |
| 10 Hz / Gain 24 | 24 | 9.999455 | 9856.777 | 0.999558 | 247.714156 |

Fitted peak-to-peak differs from observed min/max peak-to-peak because noise and excursions affect extrema. All four raw captures have zero ADC full-scale clipping. Gain 6 files contain conflicting `ads_gain=24`; channel CH1SET=0x30 and channel metadata indicate 6. The corrected conversion restores Gain 6, not 24. Old register maps combined predictions/readbacks, so their hardware provenance remains unverified. VREF=4.5 V is the stored declaration, not independently measured.

## Reproduce

```powershell
node --test tests/*.test.cjs
node tools/analyze_signal_csv.cjs 'F:\2Hz,_5mV,_DC_2.5_offset,Gain6.csv' 'F:\2Hz,_5mV,_DC_2.5_offset,_Gain24.csv' 'F:\10Hz,_5mV,_DC_2.5_offset,_Gain6.csv' 'F:\10Hz,_5mV,_DC_2.5_offset,_Gain24.csv'
node tools/browser_measurement_check.cjs 'F:\2Hz,_5mV,_DC_2.5_offset,Gain6.csv' 'F:\2Hz,_5mV,_DC_2.5_offset,_Gain24.csv' 'F:\10Hz,_5mV,_DC_2.5_offset,_Gain6.csv' 'F:\10Hz,_5mV,_DC_2.5_offset,_Gain24.csv'
```

Browser checks: all four CSV imports preserve every raw integer; effective gain is independent of unsent GUI changes; µV rendering and worker sine fitting complete without JS exceptions; schema-2 export/reparse preserves raw limits and Gain 6; mock WREG ACK and readback are separate from requested values; register changes during recording are rejected. Optional `ADS_GUI_SCREENSHOT` specifies a local screenshot path. Unit tests independently check known synthetic sine frequencies and integrated PSD power. `ADS1299_CAPTURE_CSV` enables the existing optional RTT capture replay test.

## Remaining hardware acceptance

- Recheck live BLE Gain 6 and Gain 24 on the Bluetooth laptop, save each CSV, reopen it and compare amplitudes/readback. New GUI command ACK sequencing has only been simulated locally, not tested over physical BLE on this PC (no Bluetooth).
- DRDY edge counts, sample/notification sequence counters and firmware TX/drop counters are **not implemented in this GUI-only change**. Saving 247–248 samples/s does not identify the loss/delay stage. No zero-loss claim is made.
- Validate a fresh 60-second SHORTED capture; reported noise is chip/internal-path noise, not electrode or physiological signal quality. BIAS feedback and external common-mode limits still need physical verification.
- Multi-configuration CSV segmentation is deliberately not implemented: end recording before changing settings, then start a new file. Unavailable Gain/VREF prevents calibrated µV output and calibrated recording start.
