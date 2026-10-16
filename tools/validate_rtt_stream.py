"""Bench-only capture through J-Link RTT, NOT proof of BLE delivery.

Requires pylink-square. No electrodes: uses internal TEST or input-short.
Writes received raw CSV and a diagnostic JSON report; stops conversion on exit.
"""
import argparse
import csv
import json
import re
import statistics
import time
from pathlib import Path

import pylink

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', type=int, required=True)
parser.add_argument('--dll', required=True)
parser.add_argument('--seconds', type=float, default=30)
parser.add_argument('--mode', choices=['test', 'short'], default='test')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
p = pylink.JLink(lib=pylink.library.Library(dllpath=args.dll))
buffer = ''
rows = []
messages = []
bad = []
collect = False

def drain():
    global buffer
    buffer += bytes(p.rtt_read(0, 32768)).decode('utf-8', 'replace')
    lines = buffer.split('\n')
    buffer = lines.pop()
    for line in lines:
        line = line.strip()
        if re.fullmatch(r'\d+(?:,-?\d+){8}', line):
            values = [int(v) for v in line.split(',')]
            if all(-8388608 <= v <= 8388607 for v in values[1:]):
                if collect:
                    rows.append(values)
            else:
                bad.append(line)
        elif line:
            messages.append(line)
            if re.match(r'^\d+,', line):
                bad.append(line)

def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        drain()
        time.sleep(0.002)

def command(value):
    payload = (value + '\n').encode()
    offset = 0
    end = time.monotonic() + 5
    while offset < len(payload):
        if time.monotonic() >= end:
            raise TimeoutError(value)
        offset += p.rtt_write(0, payload[offset:offset + 8])
        drain()
        time.sleep(0.01)
    pump(0.3)

try:
    p.open(serial_no=args.serial)
    p.set_tif(pylink.enums.JLinkInterfaces.SWD)
    p.connect('NRF54L15_M33', speed=4000)
    p.rtt_start()
    pump(0.3)
    command('ADS1299 STOP')
    command('ADS1299 VERSION')
    command('ADS1299 INIT')
    mux, test = ('NORMAL', 'ON') if args.mode == 'test' else ('SHORTED', 'OFF')
    command(f'ADS1299 CONFIG RATE=250 GAIN=24 REF=DIFFERENTIAL MUX={mux} BIAS=OFF LOFF=OFF TEST={test} TEST_AMP=1X TEST_FREQ=SLOW MASK=0xFF')
    for addr in [1, 2, 3, 5, 12, 21]:
        command(f'ADS1299 RREG {addr}')
    command('ADS1299 START')
    pump(0.5)  # exclude startup settling
    collect = True
    pump(args.seconds)
    collect = False
    command('ADS1299 STOP')
finally:
    try:
        collect = False
        if p.connected():
            command('ADS1299 STOP')
    finally:
        p.close()

if len(rows) < 2:
    raise RuntimeError(f'No stream: {messages[-20:]}')
intervals = [b[0] - a[0] for a, b in zip(rows, rows[1:])]
period = statistics.median(intervals)
report = dict(transport='RTT (not BLE)', mode=args.mode, samples=len(rows),
    duration_s=(rows[-1][0] - rows[0][0]) / 1e6,
    rate_hz=(len(rows) - 1) * 1e6 / (rows[-1][0] - rows[0][0]),
    median_interval_us=period, max_interval_us=max(intervals),
    nonmonotonic_intervals=sum(dt <= 0 for dt in intervals),
    gaps_over_1_8_period=sum(dt > period * 1.8 for dt in intervals),
    malformed_lines=len(bad),
    repeated_all_channels=sum(a[1:] == b[1:] for a, b in zip(rows, rows[1:])),
    device_messages=[s for s in messages if s.startswith(('FW VERSION', 'REG ', 'ERR ', 'STREAM ERR', 'STREAM WAIT'))],
    channels=[])
lsb_uv = 4.5e6 / (24 * 8388607)
for ch in range(1, 9):
    values = [row[ch] for row in rows]
    ordered = sorted(values)
    tail = max(2, len(values) // 5)
    lo, hi = statistics.median(ordered[:tail]), statistics.median(ordered[-tail:])
    mid = (lo + hi) / 2
    edges = [rows[i][0] for i in range(1, len(rows)) if values[i - 1] < mid <= values[i]]
    hz = (len(edges) - 1) * 1e6 / (edges[-1] - edges[0]) if len(edges) > 1 else None
    report['channels'].append(dict(channel=ch, uvpp=(hi - lo) * lsb_uv,
        frequency_hz=hz if args.mode == 'test' else None,
        mean_raw=statistics.mean(values), std_uv=statistics.pstdev(values) * lsb_uv))
args.output.parent.mkdir(parents=True, exist_ok=True)
with args.output.with_suffix('.csv').open('w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)
    writer.writerow(['t_us'] + [f'ch{i}' for i in range(1, 9)])
    writer.writerows(rows)
args.output.with_suffix('.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2), flush=True)
