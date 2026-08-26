#ifndef ADS1299_H
#define ADS1299_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ADS1299_CHANNEL_COUNT 8

struct ads1299_sample {
	uint32_t t_ms;
	int32_t channel[ADS1299_CHANNEL_COUNT];
};

struct ads1299_config {
	uint16_t sample_rate_sps;
	uint8_t gain;
	bool bias_enabled;
	bool lead_off_enabled;
	bool test_signal_enabled;
	uint8_t enabled_channel_mask;
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
