#ifndef ADS1299_H
#define ADS1299_H

#include <stdbool.h>
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
int ads1299_read_id(uint8_t *id);
int ads1299_apply_config(const struct ads1299_config *config);
int ads1299_read_sample(struct ads1299_sample *sample);

#endif

