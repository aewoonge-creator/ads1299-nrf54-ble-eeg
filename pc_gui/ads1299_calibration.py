from __future__ import annotations

from dataclasses import dataclass
from statistics import mean, median


@dataclass(frozen=True)
class TestResult:
    passed: bool
    measured_uv_pp: float
    expected_uv_pp: float
    measured_hz: float | None
    expected_hz: float | None
    amplitude_error_percent: float
    frequency_error_percent: float | None


def expected_test_uv_pp(vref_volts: float, amplitude: str) -> float:
    """Return the expected input-referred square-wave peak-to-peak voltage."""
    multiplier = 2.0 if amplitude == "2X" else 1.0
    return 2.0 * multiplier * vref_volts * 1_000_000.0 / 2400.0


def expected_test_hz(frequency: str, clock_hz: float = 2_048_000.0) -> float | None:
    if frequency == "DC":
        return None
    divisor = 2**20 if frequency == "FAST" else 2**21
    return clock_hz / divisor


def channel_offsets(samples: list[dict[str, float]], channels: int = 8) -> list[float]:
    offsets: list[float] = []
    for channel in range(1, channels + 1):
        values = [float(row[f"ch{channel}"]) for row in samples if f"ch{channel}" in row]
        offsets.append(mean(values) if values else 0.0)
    return offsets


def apply_offsets(sample: dict[str, float], offsets: list[float]) -> dict[str, float]:
    corrected = dict(sample)
    for index, offset in enumerate(offsets[:8], start=1):
        key = f"ch{index}"
        if key in corrected:
            corrected[key] = float(corrected[key]) - float(offset)
    return corrected


def analyze_internal_test(
    timestamps_us: list[float],
    raw_values: list[float],
    *,
    gain: int,
    vref_volts: float,
    amplitude: str,
    frequency: str,
    amplitude_tolerance: float = 0.20,
    frequency_tolerance: float = 0.10,
) -> TestResult | None:
    if len(raw_values) < 20 or len(timestamps_us) != len(raw_values):
        return None
    ordered = sorted(float(value) for value in raw_values)
    tail = max(2, len(ordered) // 5)
    low = median(ordered[:tail])
    high = median(ordered[-tail:])
    lsb_uv = vref_volts * 1_000_000.0 / gain / 8_388_607.0
    expected_uv_pp = expected_test_uv_pp(vref_volts, amplitude)
    if frequency == "DC":
        measured_uv_pp = abs(median(ordered)) * lsb_uv
        expected_uv_pp /= 2.0
    else:
        measured_uv_pp = (high - low) * lsb_uv
    amp_error = abs(measured_uv_pp - expected_uv_pp) / expected_uv_pp * 100.0

    expected_hz = expected_test_hz(frequency)
    measured_hz: float | None = None
    freq_error: float | None = None
    frequency_ok = True
    if expected_hz is not None:
        threshold = (high + low) / 2.0
        rising: list[float] = []
        previous = float(raw_values[0]) >= threshold
        for timestamp, value in zip(timestamps_us[1:], raw_values[1:]):
            current = float(value) >= threshold
            if current and not previous:
                rising.append(float(timestamp))
            previous = current
        periods = [b - a for a, b in zip(rising, rising[1:]) if b > a]
        if periods:
            measured_hz = 1_000_000.0 / median(periods)
            freq_error = abs(measured_hz - expected_hz) / expected_hz * 100.0
            frequency_ok = freq_error <= frequency_tolerance * 100.0
        else:
            frequency_ok = False

    return TestResult(
        passed=amp_error <= amplitude_tolerance * 100.0 and frequency_ok,
        measured_uv_pp=measured_uv_pp,
        expected_uv_pp=expected_uv_pp,
        measured_hz=measured_hz,
        expected_hz=expected_hz,
        amplitude_error_percent=amp_error,
        frequency_error_percent=freq_error,
    )
