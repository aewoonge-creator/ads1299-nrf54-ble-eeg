"""Read firmware/version logs over RTT without resetting or configuring the ADC."""
import argparse
import time

import pylink

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', type=int, required=True)
parser.add_argument('--dll', required=True)
parser.add_argument('--seconds', type=float, default=6)
args = parser.parse_args()
probe = pylink.JLink(lib=pylink.library.Library(dllpath=args.dll))
try:
    probe.open(serial_no=args.serial)
    probe.set_tif(pylink.enums.JLinkInterfaces.SWD)
    probe.connect('NRF54L15_M33', speed=4000)
    probe.rtt_start()
    time.sleep(0.5)
    payload = b'ADS1299 VERSION\n'
    offset = 0
    deadline = time.monotonic() + 5
    while offset < len(payload):
        if time.monotonic() > deadline:
            raise TimeoutError('RTT VERSION write timed out')
        offset += probe.rtt_write(0, payload[offset:offset + 8])
        time.sleep(0.02)
    deadline = time.monotonic() + args.seconds
    while time.monotonic() < deadline:
        print(bytes(probe.rtt_read(0, 32768)).decode('utf-8', 'replace'), end='', flush=True)
        time.sleep(0.05)
finally:
    probe.close()
