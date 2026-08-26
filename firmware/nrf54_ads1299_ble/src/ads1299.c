#include "ads1299.h"

#include <errno.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(ads1299, LOG_LEVEL_INF);

#define ADS1299_NODE DT_NODELABEL(ads1299)
#define ADS1299_CONTROL_NODE DT_NODELABEL(ads1299_control)

#define ADS1299_CMD_WAKEUP  0x02
#define ADS1299_CMD_STANDBY 0x04
#define ADS1299_CMD_RESET   0x06
#define ADS1299_CMD_START   0x08
#define ADS1299_CMD_STOP    0x0A
#define ADS1299_CMD_RDATAC  0x10
#define ADS1299_CMD_SDATAC  0x11
#define ADS1299_CMD_RDATA   0x12
#define ADS1299_CMD_RREG    0x20
#define ADS1299_CMD_WREG    0x40

#define ADS1299_REG_ID      0x00
#define ADS1299_REG_CONFIG1 0x01
#define ADS1299_REG_CONFIG2 0x02
#define ADS1299_REG_CONFIG3 0x03
#define ADS1299_REG_LOFF    0x04
#define ADS1299_REG_CH1SET  0x05
#define ADS1299_REG_BIAS_SENSP 0x0D
#define ADS1299_REG_BIAS_SENSN 0x0E

#define ADS1299_FRAME_BYTES (3 + ADS1299_CHANNEL_COUNT * 3)

static const struct spi_dt_spec ads1299_spi = SPI_DT_SPEC_GET(
	ADS1299_NODE,
	SPI_OP_MODE_MASTER | SPI_WORD_SET(8) | SPI_TRANSFER_MSB | SPI_MODE_CPHA,
	0);

static const struct gpio_dt_spec drdy_gpio =
	GPIO_DT_SPEC_GET(ADS1299_CONTROL_NODE, drdy_gpios);
static const struct gpio_dt_spec cs_gpio =
	GPIO_DT_SPEC_GET(ADS1299_CONTROL_NODE, cs_gpios);
static const struct gpio_dt_spec reset_gpio =
	GPIO_DT_SPEC_GET(ADS1299_CONTROL_NODE, reset_gpios);
static const struct gpio_dt_spec start_gpio =
	GPIO_DT_SPEC_GET(ADS1299_CONTROL_NODE, start_gpios);

static bool streaming;
static bool spi_pins_configured;
static bool data_pins_configured;
static K_MUTEX_DEFINE(spi_lock);
static uint8_t spi_tx_buf[ADS1299_FRAME_BYTES + 1];
static uint8_t spi_rx_buf[ADS1299_FRAME_BYTES + 1];

static struct spi_config ads1299_manual_cs_config(void)
{
	struct spi_config config = ads1299_spi.config;

	memset(&config.cs, 0, sizeof(config.cs));
	return config;
}

static int ads1299_spi_ready(void)
{
	if (!device_is_ready(ads1299_spi.bus)) {
		return -ENODEV;
	}
	if (!gpio_is_ready_dt(&cs_gpio)) {
		return -ENODEV;
	}
	return 0;
}

static int ads1299_configure_spi_pins(void)
{
	int err;

	if (spi_pins_configured) {
		return 0;
	}

	err = ads1299_spi_ready();
	if (err) {
		return err;
	}
	if (!gpio_is_ready_dt(&reset_gpio)) {
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&cs_gpio, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}
	err = gpio_pin_configure_dt(&reset_gpio, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}
	spi_pins_configured = true;
	return 0;
}

static int ads1299_configure_data_pins(void)
{
	int err;

	if (data_pins_configured) {
		return 0;
	}

	err = ads1299_configure_spi_pins();
	if (err) {
		return err;
	}
	if (!gpio_is_ready_dt(&drdy_gpio) ||
	    !gpio_is_ready_dt(&start_gpio)) {
		return -ENODEV;
	}

	err = gpio_pin_configure_dt(&drdy_gpio, GPIO_INPUT);
	if (err) {
		return err;
	}
	err = gpio_pin_configure_dt(&start_gpio, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}

	data_pins_configured = true;
	return 0;
}

static int ads1299_transfer(const uint8_t *tx, uint8_t *rx, size_t len)
{
	struct spi_config config = ads1299_manual_cs_config();
	struct spi_buf tx_buf = {
		.buf = spi_tx_buf,
		.len = len,
	};
	struct spi_buf rx_buf = {
		.buf = spi_rx_buf,
		.len = len,
	};
	const struct spi_buf_set tx_set = {
		.buffers = &tx_buf,
		.count = 1,
	};
	const struct spi_buf_set rx_set = {
		.buffers = &rx_buf,
		.count = 1,
	};
	int err;

	if (!tx || len > sizeof(spi_tx_buf)) {
		return -EINVAL;
	}

	err = ads1299_configure_spi_pins();
	if (err) {
		return err;
	}

	k_mutex_lock(&spi_lock, K_FOREVER);

	memcpy(spi_tx_buf, tx, len);
	memset(spi_rx_buf, 0, len);

	gpio_pin_set_dt(&cs_gpio, 1);
	k_busy_wait(2);
	err = spi_transceive(ads1299_spi.bus, &config, &tx_set, rx ? &rx_set : NULL);
	k_busy_wait(2);
	gpio_pin_set_dt(&cs_gpio, 0);

	if (err == 0 && rx) {
		memcpy(rx, spi_rx_buf, len);
	}

	k_mutex_unlock(&spi_lock);
	return err;
}

static int ads1299_cmd(uint8_t command)
{
	uint8_t tx = command;

	return ads1299_transfer(&tx, NULL, sizeof(tx));
}

static int ads1299_read_reg(uint8_t reg, uint8_t *value)
{
	uint8_t tx[3] = { ADS1299_CMD_RREG | reg, 0x00, 0x00 };
	uint8_t rx[3] = { 0 };
	int err;

	err = ads1299_transfer(tx, rx, sizeof(tx));
	if (err) {
		return err;
	}

	*value = rx[2];
	return 0;
}

static int ads1299_write_reg(uint8_t reg, uint8_t value)
{
	uint8_t tx[3] = { ADS1299_CMD_WREG | reg, 0x00, value };

	return ads1299_transfer(tx, NULL, sizeof(tx));
}

static uint8_t data_rate_bits(uint16_t sps)
{
	switch (sps) {
	case 16000: return 0x00;
	case 8000: return 0x01;
	case 4000: return 0x02;
	case 2000: return 0x03;
	case 1000: return 0x04;
	case 500: return 0x05;
	case 250:
	default: return 0x06;
	}
}

static uint8_t gain_bits(uint8_t gain)
{
	switch (gain) {
	case 1: return 0x01;
	case 2: return 0x02;
	case 4: return 0x04;
	case 8: return 0x05;
	case 12: return 0x06;
	case 24: return 0x07;
	case 6:
	default: return 0x00;
	}
}

static int32_t sign_extend_24(uint32_t value)
{
	if (value & 0x800000) {
		value |= 0xFF000000;
	}
	return (int32_t)value;
}

int ads1299_init_device(void)
{
	int err;
	uint8_t id = 0;
	struct ads1299_config config = {
		.sample_rate_sps = 250,
		.gain = 24,
		.bias_enabled = true,
		.lead_off_enabled = false,
		.test_signal_enabled = true,
		.enabled_channel_mask = 0xFF,
	};

	err = ads1299_configure_spi_pins();
	if (err) {
		return err;
	}

	streaming = false;

	gpio_pin_set_dt(&reset_gpio, 1);
	k_sleep(K_MSEC(5));
	gpio_pin_set_dt(&reset_gpio, 0);
	k_sleep(K_MSEC(20));

	err = ads1299_cmd(ADS1299_CMD_SDATAC);
	if (err) {
		return -1000 + err;
	}
	k_sleep(K_MSEC(2));

	err = ads1299_read_id(&id);
	if (err) {
		return -2000 + err;
	}
	LOG_INF("ADS1299 ID: 0x%02x", id);

	err = ads1299_apply_config(&config);
	if (err) {
		return -3000 + err;
	}

	return 0;
}

int ads1299_start_stream(void)
{
	int err;

	err = ads1299_configure_data_pins();
	if (err) {
		return err;
	}

	gpio_pin_set_dt(&start_gpio, 1);
	err = ads1299_cmd(ADS1299_CMD_START);
	if (err) {
		return err;
	}
	k_sleep(K_MSEC(2));
	streaming = true;
	return 0;
}

int ads1299_stop_stream(void)
{
	int err;

	streaming = false;
	err = ads1299_cmd(ADS1299_CMD_STOP);
	if (data_pins_configured) {
		gpio_pin_set_dt(&start_gpio, 0);
	}
	return err;
}

int ads1299_read_id(uint8_t *id)
{
	if (!id) {
		return -EINVAL;
	}

	return ads1299_read_reg(ADS1299_REG_ID, id);
}

int ads1299_spi_loopback(uint8_t rx[3])
{
	uint8_t tx[3] = { 0xA5, 0x5A, 0xC3 };
	int err;

	if (!rx) {
		return -EINVAL;
	}
	err = ads1299_spi_ready();
	if (err) {
		return err;
	}
	err = gpio_pin_configure_dt(&cs_gpio, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}

	memset(rx, 0, 3);
	return ads1299_transfer(tx, rx, sizeof(tx));
}

int ads1299_read_register(uint8_t reg, uint8_t *value)
{
	if (!value) {
		return -EINVAL;
	}

	return ads1299_read_reg(reg, value);
}

int ads1299_write_register(uint8_t reg, uint8_t value)
{
	return ads1299_write_reg(reg, value);
}

int ads1299_apply_config(const struct ads1299_config *config)
{
	int err;
	uint8_t config1;
	uint8_t config2;
	uint8_t config3;
	uint8_t loff;
	uint8_t chset_enabled;
	uint8_t chset_disabled;

	if (!config) {
		return -EINVAL;
	}

	err = ads1299_cmd(ADS1299_CMD_SDATAC);
	if (err) {
		return err;
	}
	k_sleep(K_MSEC(2));

	config1 = 0x90 | data_rate_bits(config->sample_rate_sps);
	config2 = config->test_signal_enabled ? 0xD0 : 0xC0;
	config3 = config->bias_enabled ? 0xEC : 0xE0;
	loff = config->lead_off_enabled ? 0x03 : 0x00;

	err = ads1299_write_reg(ADS1299_REG_CONFIG1, config1);
	if (err) {
		return err;
	}
	err = ads1299_write_reg(ADS1299_REG_CONFIG2, config2);
	if (err) {
		return err;
	}
	err = ads1299_write_reg(ADS1299_REG_CONFIG3, config3);
	if (err) {
		return err;
	}
	err = ads1299_write_reg(ADS1299_REG_LOFF, loff);
	if (err) {
		return err;
	}

	chset_enabled = (gain_bits(config->gain) << 4) |
			(config->test_signal_enabled ? 0x05 : 0x00);
	chset_disabled = 0x80 | chset_enabled;

	for (int i = 0; i < ADS1299_CHANNEL_COUNT; i++) {
		uint8_t value = (config->enabled_channel_mask & BIT(i)) ?
			chset_enabled : chset_disabled;
		err = ads1299_write_reg(ADS1299_REG_CH1SET + i, value);
		if (err) {
			return err;
		}
	}

	err = ads1299_write_reg(ADS1299_REG_BIAS_SENSP,
				config->bias_enabled ? config->enabled_channel_mask : 0x00);
	if (err) {
		return err;
	}
	err = ads1299_write_reg(ADS1299_REG_BIAS_SENSN,
				config->bias_enabled ? config->enabled_channel_mask : 0x00);
	if (err) {
		return err;
	}

	return 0;
}

int ads1299_read_sample(struct ads1299_sample *sample)
{
	if (!sample) {
		return -EINVAL;
	}
	if (!streaming) {
		return -EAGAIN;
	}
	if (!data_pins_configured) {
		return -EAGAIN;
	}

	int err;

	if (gpio_pin_get_dt(&drdy_gpio) <= 0) {
		return -EAGAIN;
	}

	memset(spi_tx_buf, 0, sizeof(spi_tx_buf));
	spi_tx_buf[0] = ADS1299_CMD_RDATA;
	err = ads1299_transfer(spi_tx_buf, spi_rx_buf, ADS1299_FRAME_BYTES + 1);
	if (err) {
		return err;
	}

	sample->t_ms = k_uptime_get_32();
	for (int i = 0; i < ADS1299_CHANNEL_COUNT; i++) {
		int base = 1 + 3 + i * 3;
		uint32_t raw = ((uint32_t)spi_rx_buf[base] << 16) |
			       ((uint32_t)spi_rx_buf[base + 1] << 8) |
			       (uint32_t)spi_rx_buf[base + 2];
		sample->channel[i] = sign_extend_24(raw);
	}

	return 0;
}
