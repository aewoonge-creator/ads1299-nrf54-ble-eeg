# nRF52832 port validation (2026-11-02)

Base: GitHub main `81c4060`. The old C:\ncs checkout had deleted firmware files;
those local deletions were not reverted. Work used a separate clone updated from GitHub.

## Build

- NCS v2.9.3, board `nrf52dk/nrf52832`, no sysbuild.
- Flash: 156180 / 524288 bytes (29.79%). RAM: 46048 / 65536 bytes (70.26%).
- Generated configuration confirms `CONFIG_SOC_NRF52832=y`, name `ADS1299_NRF52`.
- SPIM2 uses the devicetree `anomaly-58-workaround` together with
  `CONFIG_SOC_NRF52832_ALLOW_SPIM_DESPITE_PAN_58=y`. The SDK's generic PAN 58
  CMake warning still appears; the workaround is enabled in generated devicetree.
- nRF54L15 regression build also passes: Flash 178056 bytes, RAM 49064 bytes.
- Exact binaries/source hashes are in the board-specific manifests.

## Software

- Existing Node tests: 38 passed, one optional physical capture test skipped.
- Python GUI tests: 9 passed.
- Edge headless smoke test: zero browser errors. Simulated BLE command/readback,
  disconnect/reconnect, timeout, four-file CSV load, raw-value preservation,
  gain metadata, plot and worker analysis passed.
- Added nRF52832 version handshake and release HEX digest/checksum/address checks.
- These tests do not simulate SPIM electrical timing or prove real BLE throughput.

## Hardware: incomplete

`nrfjprog --ids` returned debugger serial `1050393707` alongside J-Link errors.
`--deviceversion --snr 1050393707` returned `UNKNOWN` and
`Access protection is enabled, can't read device version` (error -90).
No recover/erase/program/reset operation was issued. Chip identity, flashing,
ADS1299 register readback, DRDY cadence and live BLE collection remain unverified.

After resolving board access and rewiring per NRF52832_SETUP.md, verify ID 0x3E,
8-channel TEST and SHORT, repeated recording, disconnect/reconnect, and actual
250/500/1000 SPS delivery separately. Current code retains real read timestamps
and does not claim a nominal timestamp interval proves lossless conversion capture.
