import importlib.util
import sys
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "pc_gui" / "stream_protocol.py"
SPEC = importlib.util.spec_from_file_location("stream_protocol", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

CONFIG_MODULE_PATH = Path(__file__).parents[1] / "pc_gui" / "ads1299_config.py"
CONFIG_SPEC = importlib.util.spec_from_file_location("ads1299_config", CONFIG_MODULE_PATH)
CONFIG_MODULE = importlib.util.module_from_spec(CONFIG_SPEC)
assert CONFIG_SPEC.loader is not None
CONFIG_SPEC.loader.exec_module(CONFIG_MODULE)

CALIBRATION_MODULE_PATH = Path(__file__).parents[1] / "pc_gui" / "ads1299_calibration.py"
CALIBRATION_SPEC = importlib.util.spec_from_file_location("ads1299_calibration", CALIBRATION_MODULE_PATH)
CALIBRATION_MODULE = importlib.util.module_from_spec(CALIBRATION_SPEC)
assert CALIBRATION_SPEC.loader is not None
sys.modules[CALIBRATION_SPEC.name] = CALIBRATION_MODULE
CALIBRATION_SPEC.loader.exec_module(CALIBRATION_MODULE)


def test_parse_current_microsecond_sample():
    row = MODULE.parse_sample_line("4000,1,2,3,4,5,6,7,8")
    assert row == {
        "t_us": 4000,
        "ch1": 1,
        "ch2": 2,
        "ch3": 3,
        "ch4": 4,
        "ch5": 5,
        "ch6": 6,
        "ch7": 7,
        "ch8": 8,
    }


def test_parse_legacy_millisecond_sample_normalizes_to_microseconds():
    row = MODULE.parse_sample_line("4,10,20", time_scale_to_us=1000)
    assert row["t_us"] == 4000
    assert row["ch1"] == 10
    assert row["ch2"] == 20
    assert row["ch8"] == 0


def test_headers_and_invalid_lines_are_not_samples():
    assert MODULE.parse_sample_line("t_us,ch1,ch2") is None
    assert MODULE.parse_sample_line("t_ms,ch1,ch2") is None
    assert MODULE.parse_sample_line("OK START") is None


def test_ads1299_config_command_carries_reference_bias_and_vref_state():
    command = CONFIG_MODULE.build_config_command(
        rate=250,
        gain=24,
        mux="BIAS_MEAS",
        reference="SRB2_TO_SRB1",
        reference_channel=3,
        adc_reference="EXTERNAL",
        vref_volts=2.5,
        bias_enabled=True,
        bias_reference="EXTERNAL",
        bias_sensp_mask=0x15,
        bias_sensn_mask=0x2A,
        lead_off_enabled=False,
        enabled_mask=0x3F,
    )
    assert "MUX=BIAS_MEAS" in command
    assert "REF=SRB2_TO_SRB1 REF_CH=3" in command
    assert "ADC_REF=EXTERNAL VREF_MV=2500" in command
    assert "BIAS=ON BIASREF=EXTERNAL BIASP=0x15 BIASN=0x2A" in command
    assert command.endswith("MASK=0x3F")


def test_bias_off_zeroes_both_bias_sense_masks():
    command = CONFIG_MODULE.build_config_command(
        rate=250,
        gain=24,
        mux="NORMAL",
        reference="SRB1",
        reference_channel=1,
        adc_reference="INTERNAL",
        vref_volts=4.5,
        bias_enabled=False,
        bias_reference="INTERNAL",
        bias_sensp_mask=0xFF,
        bias_sensn_mask=0xFF,
        lead_off_enabled=False,
        enabled_mask=0xFF,
    )
    assert "BIASP=0x00 BIASN=0x00" in command


def test_channel_mask_and_ads1299_lsb_conversion():
    assert CONFIG_MODULE.channel_mask([True, False, True, False, False, False, False, True]) == 0x85
    full_scale_uv = CONFIG_MODULE.raw_to_microvolts(8_388_607, gain=24, vref_volts=4.5)
    assert full_scale_uv == 187_500.0


def test_internal_test_configuration_carries_amplitude_frequency_and_channel_mask():
    command = CONFIG_MODULE.build_config_command(
        rate=250,
        gain=24,
        mux="NORMAL",
        reference="DIFFERENTIAL",
        reference_channel=1,
        adc_reference="INTERNAL",
        vref_volts=4.5,
        bias_enabled=False,
        bias_reference="INTERNAL",
        bias_sensp_mask=0,
        bias_sensn_mask=0,
        lead_off_enabled=False,
        enabled_mask=0xFF,
        test_enabled=True,
        test_amplitude="2X",
        test_frequency="FAST",
        test_channel_mask=0x25,
    )
    assert "TEST=ON TEST_AMP=2X TEST_FREQ=FAST TEST_MASK=0x25" in command


def test_internal_square_wave_is_automatically_judged():
    rate = 250
    expected_uv_pp = CALIBRATION_MODULE.expected_test_uv_pp(4.5, "1X")
    lsb_uv = 4.5 * 1_000_000 / 24 / 8_388_607
    half_raw = expected_uv_pp / lsb_uv / 2
    timestamps = [index * 1_000_000 / rate for index in range(rate * 4)]
    values = [half_raw if (timestamp / 1_000_000) % 1.024 < 0.512 else -half_raw for timestamp in timestamps]
    result = CALIBRATION_MODULE.analyze_internal_test(
        timestamps,
        values,
        gain=24,
        vref_volts=4.5,
        amplitude="1X",
        frequency="SLOW",
    )
    assert result is not None
    assert result.passed
    assert abs(result.measured_hz - 0.9765625) < 0.02


def test_input_short_offsets_are_computed_and_applied_per_channel():
    samples = [
        {"t_us": 0, "ch1": 100, "ch2": -20},
        {"t_us": 4000, "ch1": 104, "ch2": -24},
    ]
    offsets = CALIBRATION_MODULE.channel_offsets(samples, channels=2)
    assert offsets == [102, -22]
    corrected = CALIBRATION_MODULE.apply_offsets(samples[0], offsets)
    assert corrected["ch1"] == -2
    assert corrected["ch2"] == 2
