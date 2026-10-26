# BLE command verification - 2026-10-26

## Reproduced failures

Three regression tests failed against the previous GUI: a notification ACK could
advance the command queue before the GATT write completed; ambiguous failed writes
could be retried with a different API; device errors left the command status at
"sending". The user's exact failed command and wireless trace were unavailable,
so these are reproduced software defects, not proof of the physical failure cause.

## Changes

- Prefer write-with-response and wait for both write completion and firmware reply.
- Bound GATT writes and reply waits; do not retry ambiguous fragments or continue
  configuration after an uncertain command. Keep the original error visible.
- Verify PONG and VERSION at connection; register notification listeners before
  subscription; remove old listeners and cancel old-session jobs on reconnect.
- Read registers 0x00-0x17 individually during configuration and Start, avoiding
  reliance on a single burst of 24 notifications. Validate readback before START.
- Report START acknowledgement separately from arrival of EEG samples.
- Preserve firmware, ADC/raw sample parsing, recording values and gain conversion.

## Verification

```
node --test tests/*.test.cjs
node tools/browser_measurement_check.cjs
```

The added command tests cover early ACKs, write failures, no replies, partial
register dumps, normalized register addresses, session cancellation, late old
write failures, stalled writes and START without samples.

The isolated Edge browser test uses a simulated GATT peripheral with 18-byte
command chunks and 20-byte notification chunks. Notifications precede completion
of GATT writes. It exercises actual GUI connect and Start controls, observes 100
samples, suppresses STOP replies to trigger the real timeout, reconnects to the
same device/characteristic objects, and receives exactly 100 new samples without
duplicate listeners. Assertions check zero overlapping writes, zero use of
write-without-response, applied/readback agreement, error status, cleared queues,
and preservation of raw CSV values. The simulator is test-only, not part of the GUI.

No physical BLE capture or firmware flashing was performed. Existing optional RTT
capture replay is skipped unless ADS1299_CAPTURE_CSV is supplied. Input CSV file
analysis in the browser test runs only when file paths are supplied.
