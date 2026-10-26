# Firmware/readback fix validation (2026-10-26)

## Physical board

- USB-connected PCA10156 (nRF54L15 DK), inspected through J-Link RTT.
- Before update: device replied `FW VERSION 2026-09-09-gain-sync-v1` and repeatedly emitted `AUTO SPI PROBE`, `AUTO BITBANG PROBE`, `AUTO RESET_PROBE`.
- Firmware source is the existing repository v6, built with NCS v2.9.3, not the stale separate SDK working copy.
- Flashed `docs/firmware/ads1299-nrf54l15-2026-10-16-drdy-p111-v6.hex` using nrfutil, erase only ranges touched, `VERIFY_READ`, then system reset. Post-flash VERSION reply confirmed v6; automatic probe messages disappeared.
- Electrodes were disconnected with user confirmation before flashing and internal TEST.
- Initial 10-second RTT TEST: 2,500 samples, 249.991997 samples/s, zero nonmonotonic intervals, gaps >1.8 periods, malformed rows or identical adjacent 8-channel frames.
- Readback test: all CH1SET..CH8SET registers were `0x65` after internal TEST configuration and still `0x65` after a 4-second wait and sequential reread. This spans the old 3-second auto-probe interval.
- Subsequent RTT TEST: 2,497 samples over 9.984384 device seconds, 249.990385 samples/s. All eight channels approximately 0.976522 Hz and 3740.30-3742.75 microvolts peak-to-peak using declared 4.5 V reference and gain 24. No large gaps, malformed rows or repeated full frames.
- Capture/report files are local under `build/validation-v9/`, excluded from Git. After testing, the board was restarted to leave internal TEST off and normal measurement idle.

## GUI and regression tests

```powershell
$env:ADS1299_CAPTURE_CSV='build/validation-v9/internal-test-readback.csv'
node --test tests/*.test.cjs
node tools/browser_measurement_check.cjs
```

- 39 tests passed, none skipped when the actual RTT capture was supplied. Replay through GUI parsing, internal TEST analysis and CSV export preserves every raw value.
- Isolated Edge mock-GATT test: 100 samples before and after reconnect; zero overlapping writes; timeout reports failed STOP; no JavaScript exceptions.
- Legacy AUTO notification displays the firmware warning and blocks START. Reconnection to a current simulated firmware clears it.
- Firmware warning screenshots checked at 1600 px and 390 px; the warning remains visible and fits its container.
- Register mismatch still blocks START and now identifies the register and differing values. The guard was not bypassed.

## Limits

RTT tests validate ADC acquisition and firmware command/readback behavior, not over-the-air delivery.
Actual BLE reception and rendering on the user's other laptop remain to be checked there.
Sample rate is computed from device timestamps; it is not an independent DRDY count or BLE packet-loss measurement.
No human EEG recording or clinical interpretation was performed.
