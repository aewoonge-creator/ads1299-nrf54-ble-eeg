#ifndef ADS1299_H
#define ADS1299_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ADS1299_CHANNEL_COUNT 8

enum ads1299_input_mux {
	ADS1299_MUX_NORMAL = 0,
	ADS1299_MUX_SHORTED = 1,
	ADS1299_MUX_BIAS_MEAS = 2,
	ADS1299_MUX_MVDD = 3,
	ADS1299_MUX_TEMP = 4,
	ADS1299_MUX_TEST = 5,
	ADS1299_MUX_BIAS_DRP = 6,
	ADS1299_MUX_BIAS_DRN = 7,
};

enum ads1299_reference_mode {
	ADS1299_REF_DIFFERENTIAL = 0,
	ADS1299_REF_SRB1,
	ADS1299_REF_SRB2_COMMON,
	ADS1299_REF_SRB2_TO_SRB1,
};

enum ads1299_test_frequency {
	ADS1299_TEST_FREQ_SLOW = 0,
	ADS1299_TEST_FREQ_FAST = 1,
	ADS1299_TEST_FREQ_DC = 3,
};

struct ads1299_sample {
	uint32_t t_us;
	int32_t channel[ADS1299_CHANNEL_COUNT];
};

struct ads1299_config {
	uint16_t sample_rate_sps;
	uint8_t gain;
	bool bias_enabled;
	bool lead_off_enabled;
	bool test_signal_enabled;
	bool test_signal_amplitude_2x;
	enum ads1299_test_frequency test_signal_frequency;
	uint8_t test_channel_mask;
	uint8_t enabled_channel_mask;
	enum ads1299_input_mux input_mux;
	enum ads1299_reference_mode reference_mode;
	uint8_t reference_channel;
	bool internal_reference;
	bool internal_bias_reference;
	uint8_t bias_sensp_mask;
	uint8_t bias_sensn_mask;
};

int ads1299_init_device(void);
int ads1299_start_stream(void);
int ads1299_stop_stream(void);
bool ads1299_is_streaming(void);
int ads1299_read_id(uint8_t *id);
int ads1299_spi_loopback(uint8_t rx[3]);
int ads1299_set_spi_mode(uint8_t mode);
int ads1299_probe_id_modes(char *response, size_t response_len);
int ads1299_probe_after_reset(char *response, size_t response_len);
int ads1299_gpio_status(char *response, size_t response_len);
int ads1299_miso_gpio_probe(char *response, size_t response_len);
int ads1299_miso_cs_low_probe(char *response, size_t response_len);
int ads1299_bitbang_probe_id_modes(char *response, size_t response_len);
int ads1299_read_register(uint8_t reg, uint8_t *value);
int ads1299_write_register(uint8_t reg, uint8_t value);
int ads1299_apply_config(const struct ads1299_config *config);
int ads1299_read_sample(struct ads1299_sample *sample);

#endif
