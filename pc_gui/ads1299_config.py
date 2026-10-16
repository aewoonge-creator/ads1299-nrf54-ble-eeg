from __future__ import annotations


REFERENCE_MODES = ("SRB1", "SRB2_COMMON", "SRB2_TO_SRB1", "DIFFERENTIAL")
ADC_REFERENCE_MODES = ("INTERNAL", "EXTERNAL")
BIAS_REFERENCE_MODES = ("INTERNAL", "EXTERNAL")
TEST_AMPLITUDES = ("1X", "2X")
TEST_FREQUENCIES = ("SLOW", "FAST", "DC")


def channel_mask(enabled: list[bool] | tuple[bool, ...]) -> int:
    return sum(1 << index for index, value in enumerate(enabled[:8]) if value)


def raw_to_microvolts(raw: int | float, gain: int, vref_volts: float) -> float:
    if gain <= 0 or vref_volts <= 0:
        raise ValueError("gain and VREF must be positive")
    return float(raw) * float(vref_volts) * 1_000_000.0 / float(gain) / 8_388_607.0


def build_config_command(
    *,
    rate: int,
    gain: int,
    mux: str,
    reference: str,
    reference_channel: int,
    adc_reference: str,
    vref_volts: float,
    bias_enabled: bool,
    bias_reference: str,
    bias_sensp_mask: int,
    bias_sensn_mask: int,
    lead_off_enabled: bool,
    enabled_mask: int,
    test_enabled: bool = False,
    test_amplitude: str = "1X",
    test_frequency: str = "SLOW",
    test_channel_mask: int = 0,
) -> str:
    if reference not in REFERENCE_MODES:
        raise ValueError(f"unsupported reference mode: {reference}")
    if adc_reference not in ADC_REFERENCE_MODES:
        raise ValueError(f"unsupported ADC reference mode: {adc_reference}")
    if bias_reference not in BIAS_REFERENCE_MODES:
        raise ValueError(f"unsupported BIAS reference mode: {bias_reference}")
    if not 1 <= reference_channel <= 8:
        raise ValueError("reference channel must be 1..8")
    if not 0.1 <= vref_volts <= 10.0:
        raise ValueError("VREF must be 0.1..10 V")
    if test_amplitude not in TEST_AMPLITUDES:
        raise ValueError(f"unsupported test amplitude: {test_amplitude}")
    if test_frequency not in TEST_FREQUENCIES:
        raise ValueError(f"unsupported test frequency: {test_frequency}")

    active_test_mask = (test_channel_mask & enabled_mask & 0xFF) if test_enabled else 0

    return " ".join(
        [
            "ADS1299 CONFIG",
            f"RATE={rate}",
            f"GAIN={gain}",
            f"MUX={mux}",
            f"REF={reference}",
            f"REF_CH={reference_channel}",
            f"ADC_REF={adc_reference}",
            f"VREF_MV={round(vref_volts * 1000)}",
            f"BIAS={'ON' if bias_enabled else 'OFF'}",
            f"BIASREF={bias_reference}",
            f"BIASP=0x{(bias_sensp_mask if bias_enabled else 0) & 0xFF:02X}",
            f"BIASN=0x{(bias_sensn_mask if bias_enabled else 0) & 0xFF:02X}",
            f"LOFF={'ON' if lead_off_enabled else 'OFF'}",
            f"TEST={'ON' if test_enabled else 'OFF'}",
            f"TEST_AMP={test_amplitude}",
            f"TEST_FREQ={test_frequency}",
            f"TEST_MASK=0x{active_test_mask:02X}",
            f"MASK=0x{enabled_mask & 0xFF:02X}",
        ]
    )
