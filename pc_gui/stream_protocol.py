from __future__ import annotations


CHANNELS = 8


def parse_sample_line(line: str, time_scale_to_us: int = 1) -> dict[str, int] | None:
    """Parse a numeric ADS1299 row and normalize its time column to t_us."""
    if not line or line.startswith(("t_ms", "t_us")):
        return None
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 2:
        return None
    try:
        values = [int(float(part)) for part in parts[: CHANNELS + 1]]
    except ValueError:
        return None
    row = {"t_us": values[0] * time_scale_to_us}
    for index, value in enumerate(values[1:], start=1):
        row[f"ch{index}"] = value
    for index in range(len(values), CHANNELS + 1):
        row[f"ch{index}"] = 0
    return row
