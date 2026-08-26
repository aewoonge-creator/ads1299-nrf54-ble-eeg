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
#define ADS1299_MISO_PROBE_NODE DT_NODELABEL(gpio0)
#define ADS1299_BB_SCK_PIN 0
#define ADS1299_BB_MOSI_PIN 1
#define ADS1299_MISO_PROBE_PIN 2
#define ADS1299_BB_CS_PIN 3
#define ADS1299_BB_RESET_PIN 4

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
#define ADS1299_SPI_FREQUENCY_HZ 1000000U
#define ADS1299_BITBANG_MODE 1
#define ADS1299_SPI_BASE_OPERATION \
	(SPI_OP_MODE_MASTER | SPI_WORD_SET(8) | SPI_TRANSFER_MSB)

static const struct spi_dt_spec ads1299_spi = SPI_DT_SPEC_GET(
	ADS1299_NODE,
	ADS1299_SPI_BASE_OPERATION | SPI_MODE_CPHA,
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
static spi_operation_t current_spi_operation = ADS1299_SPI_BASE_OPERATION | SPI_MODE_CPHA;
static K_MUTEX_DEFINE(spi_lock);
static uint8_t spi_tx_buf[ADS1299_FRAME_BYTES + 1];
static uint8_t spi_rx_buf[ADS1299_FRAME_BYTES + 1];

static int bitbang_cmd(uint8_t command);
static int bitbang_read_reg(uint8_t reg, uint8_t *value);
static int bitbang_write_reg(uint8_t reg, uint8_t value);

static int ads1299_spi_ready(void)
{
	if (!spi_is_ready_dt(&ads1299_spi)) {
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
	struct spi_config config = ads1299_spi.config;
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

	config.operation = current_spi_operation;
	config.frequency = ADS1299_SPI_FREQUENCY_HZ;
	err = spi_transceive(ads1299_spi.bus, &config, &tx_set, rx ? &rx_set : NULL);

	if (err == 0 && rx) {
		memcpy(rx, spi_rx_buf, len);
	}

	k_mutex_unlock(&spi_lock);
	return err;
}

static int ads1299_transfer_no_cs(const uint8_t *tx, uint8_t *rx, size_t len)
{
	struct spi_config config = ads1299_spi.config;
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

	memset(&config.cs, 0, sizeof(config.cs));
	config.operation = current_spi_operation;
	config.frequency = ADS1299_SPI_FREQUENCY_HZ;

	memcpy(spi_tx_buf, tx, len);
	memset(spi_rx_buf, 0, len);

	err = spi_transceive(ads1299_spi.bus, &config, &tx_set, rx ? &rx_set : NULL);
	if (err == 0 && rx) {
		memcpy(rx, spi_rx_buf, len);
	}

	return err;
}

static int ads1299_cmd(uint8_t command)
{
	return bitbang_cmd(command);
}

static int ads1299_read_reg(uint8_t reg, uint8_t *value)
{
	return bitbang_read_reg(reg, value);
}

static int ads1299_write_reg(uint8_t reg, uint8_t value)
{
	return bitbang_write_reg(reg, value);
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

bool ads1299_is_streaming(void)
{
	return streaming;
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

int ads1299_set_spi_mode(uint8_t mode)
{
	switch (mode) {
	case 0:
		current_spi_operation = ADS1299_SPI_BASE_OPERATION;
		return 0;
	case 1:
		current_spi_operation = ADS1299_SPI_BASE_OPERATION | SPI_MODE_CPHA;
		return 0;
	case 2:
		current_spi_operation = ADS1299_SPI_BASE_OPERATION | SPI_MODE_CPOL;
		return 0;
	case 3:
		current_spi_operation = ADS1299_SPI_BASE_OPERATION | SPI_MODE_CPOL | SPI_MODE_CPHA;
		return 0;
	default:
		return -EINVAL;
	}
}

int ads1299_probe_id_modes(char *response, size_t response_len)
{
	size_t used = 0;
	uint8_t saved_mode = 1;

	if (!response || response_len == 0) {
		return -EINVAL;
	}

	response[0] = '\0';
	for (uint8_t mode = 0; mode < 4; mode++) {
		uint8_t id = 0;
		int err;
		int written;

		ads1299_set_spi_mode(mode);
		err = ads1299_read_id(&id);
		if (err == 0) {
			written = snprintk(response + used, response_len - used,
					   "M%u=0x%02X ", mode, id);
		} else {
			written = snprintk(response + used, response_len - used,
					   "M%u=ERR%d ", mode, err);
		}
		if (written < 0 || (size_t)written >= response_len - used) {
			break;
		}
		used += (size_t)written;
	}

	ads1299_set_spi_mode(saved_mode);
	return 0;
}

int ads1299_probe_after_reset(char *response, size_t response_len)
{
	uint8_t id = 0;
	int err;

	if (!response || response_len == 0) {
		return -EINVAL;
	}

	err = ads1299_configure_spi_pins();
	if (err) {
		snprintk(response, response_len, "RESET_PROBE CFG_ERR%d", err);
		return 0;
	}

	gpio_pin_set_dt(&reset_gpio, 1);
	k_sleep(K_MSEC(5));
	gpio_pin_set_dt(&reset_gpio, 0);
	k_sleep(K_MSEC(50));

	err = ads1299_cmd(ADS1299_CMD_SDATAC);
	if (err) {
		snprintk(response, response_len, "RESET_PROBE SDATAC_ERR%d", err);
		return 0;
	}
	k_sleep(K_MSEC(2));

	err = ads1299_read_id(&id);
	if (err) {
		snprintk(response, response_len, "RESET_PROBE RREG_ERR%d", err);
		return 0;
	}

	snprintk(response, response_len, "RESET_PROBE ID=0x%02X", id);
	return 0;
}

int ads1299_gpio_status(char *response, size_t response_len)
{
	int err;
	int cs;
	int reset;
	int drdy = -1;

	if (!response || response_len == 0) {
		return -EINVAL;
	}

	err = ads1299_configure_spi_pins();
	if (err) {
		snprintk(response, response_len, "GPIO CFG_ERR%d", err);
		return 0;
	}

	cs = gpio_pin_get_dt(&cs_gpio);
	reset = gpio_pin_get_dt(&reset_gpio);
	if (gpio_is_ready_dt(&drdy_gpio)) {
		gpio_pin_configure_dt(&drdy_gpio, GPIO_INPUT);
		drdy = gpio_pin_get_dt(&drdy_gpio);
	}

	snprintk(response, response_len, "GPIO CS=%d RESET=%d DRDY=%d",
		 cs, reset, drdy);
	return 0;
}

int ads1299_miso_gpio_probe(char *response, size_t response_len)
{
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	int err;
	int pull_down;
	int pull_up;

	if (!response || response_len == 0) {
		return -EINVAL;
	}
	if (!device_is_ready(gpio)) {
		snprintk(response, response_len, "MISO_GPIO GPIO_NOT_READY");
		return 0;
	}

	err = gpio_pin_configure(gpio, ADS1299_MISO_PROBE_PIN, GPIO_INPUT | GPIO_PULL_DOWN);
	if (err) {
		snprintk(response, response_len, "MISO_GPIO PD_CFG_ERR%d", err);
		return 0;
	}
	k_sleep(K_MSEC(2));
	pull_down = gpio_pin_get(gpio, ADS1299_MISO_PROBE_PIN);

	err = gpio_pin_configure(gpio, ADS1299_MISO_PROBE_PIN, GPIO_INPUT | GPIO_PULL_UP);
	if (err) {
		snprintk(response, response_len, "MISO_GPIO PU_CFG_ERR%d", err);
		return 0;
	}
	k_sleep(K_MSEC(2));
	pull_up = gpio_pin_get(gpio, ADS1299_MISO_PROBE_PIN);

	spi_pins_configured = false;
	ads1299_configure_spi_pins();

	snprintk(response, response_len, "MISO_GPIO PD=%d PU=%d", pull_down, pull_up);
	return 0;
}

int ads1299_miso_cs_low_probe(char *response, size_t response_len)
{
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	int err;
	int pull_down;
	int pull_up;

	if (!response || response_len == 0) {
		return -EINVAL;
	}

	err = ads1299_configure_spi_pins();
	if (err) {
		snprintk(response, response_len, "MISO_CS_LOW CFG_ERR%d", err);
		return 0;
	}
	if (!device_is_ready(gpio)) {
		snprintk(response, response_len, "MISO_CS_LOW GPIO_NOT_READY");
		return 0;
	}

	gpio_pin_set_dt(&cs_gpio, 1);
	k_busy_wait(10);

	err = gpio_pin_configure(gpio, ADS1299_MISO_PROBE_PIN, GPIO_INPUT | GPIO_PULL_DOWN);
	if (err) {
		gpio_pin_set_dt(&cs_gpio, 0);
		snprintk(response, response_len, "MISO_CS_LOW PD_CFG_ERR%d", err);
		return 0;
	}
	k_sleep(K_MSEC(2));
	pull_down = gpio_pin_get(gpio, ADS1299_MISO_PROBE_PIN);

	err = gpio_pin_configure(gpio, ADS1299_MISO_PROBE_PIN, GPIO_INPUT | GPIO_PULL_UP);
	if (err) {
		gpio_pin_set_dt(&cs_gpio, 0);
		snprintk(response, response_len, "MISO_CS_LOW PU_CFG_ERR%d", err);
		return 0;
	}
	k_sleep(K_MSEC(2));
	pull_up = gpio_pin_get(gpio, ADS1299_MISO_PROBE_PIN);

	gpio_pin_set_dt(&cs_gpio, 0);
	spi_pins_configured = false;
	ads1299_configure_spi_pins();

	snprintk(response, response_len, "MISO_CS_LOW PD=%d PU=%d", pull_down, pull_up);
	return 0;
}

static void bitbang_delay(void)
{
	k_busy_wait(10);
}

static int bitbang_gpio_configure(const struct device *gpio)
{
	int err;

	if (!device_is_ready(gpio)) {
		return -ENODEV;
	}

	err = gpio_pin_configure(gpio, ADS1299_BB_SCK_PIN, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}
	err = gpio_pin_configure(gpio, ADS1299_BB_MOSI_PIN, GPIO_OUTPUT_INACTIVE);
	if (err) {
		return err;
	}
	err = gpio_pin_configure(gpio, ADS1299_BB_CS_PIN, GPIO_OUTPUT_ACTIVE);
	if (err) {
		return err;
	}
	err = gpio_pin_configure(gpio, ADS1299_BB_RESET_PIN, GPIO_OUTPUT_ACTIVE);
	if (err) {
		return err;
	}
	return gpio_pin_configure(gpio, ADS1299_MISO_PROBE_PIN, GPIO_INPUT);
}

static uint8_t bitbang_transfer_byte(const struct device *gpio, uint8_t tx, uint8_t mode)
{
	bool cpol = (mode & 0x02) != 0;
	bool cpha = (mode & 0x01) != 0;
	uint8_t rx = 0;

	gpio_pin_set(gpio, ADS1299_BB_SCK_PIN, cpol ? 1 : 0);
	bitbang_delay();

	for (int bit = 7; bit >= 0; bit--) {
		gpio_pin_set(gpio, ADS1299_BB_MOSI_PIN, (tx >> bit) & 0x01);
		bitbang_delay();

		if (!cpha) {
			gpio_pin_set(gpio, ADS1299_BB_SCK_PIN, cpol ? 0 : 1);
			bitbang_delay();
			rx = (rx << 1) | (gpio_pin_get(gpio, ADS1299_MISO_PROBE_PIN) ? 1 : 0);
			gpio_pin_set(gpio, ADS1299_BB_SCK_PIN, cpol ? 1 : 0);
		} else {
			gpio_pin_set(gpio, ADS1299_BB_SCK_PIN, cpol ? 0 : 1);
			bitbang_delay();
			gpio_pin_set(gpio, ADS1299_BB_SCK_PIN, cpol ? 1 : 0);
			bitbang_delay();
			rx = (rx << 1) | (gpio_pin_get(gpio, ADS1299_MISO_PROBE_PIN) ? 1 : 0);
		}
		bitbang_delay();
	}

	return rx;
}

static int bitbang_cmd(uint8_t command)
{
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	int err;

	err = bitbang_gpio_configure(gpio);
	if (err) {
		return err;
	}

	k_mutex_lock(&spi_lock, K_FOREVER);
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 0);
	bitbang_delay();
	bitbang_transfer_byte(gpio, command, ADS1299_BITBANG_MODE);
	bitbang_delay();
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 1);
	k_mutex_unlock(&spi_lock);

	spi_pins_configured = false;
	ads1299_configure_spi_pins();
	return 0;
}

static int bitbang_read_reg(uint8_t reg, uint8_t *value)
{
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	int err;

	if (!value) {
		return -EINVAL;
	}

	err = bitbang_gpio_configure(gpio);
	if (err) {
		return err;
	}

	k_mutex_lock(&spi_lock, K_FOREVER);
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 0);
	bitbang_delay();
	bitbang_transfer_byte(gpio, ADS1299_CMD_RREG | reg, ADS1299_BITBANG_MODE);
	bitbang_delay();
	bitbang_transfer_byte(gpio, 0x00, ADS1299_BITBANG_MODE);
	bitbang_delay();
	*value = bitbang_transfer_byte(gpio, 0x00, ADS1299_BITBANG_MODE);
	bitbang_delay();
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 1);
	k_mutex_unlock(&spi_lock);

	spi_pins_configured = false;
	ads1299_configure_spi_pins();
	return 0;
}

static int bitbang_write_reg(uint8_t reg, uint8_t value)
{
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	int err;

	err = bitbang_gpio_configure(gpio);
	if (err) {
		return err;
	}

	k_mutex_lock(&spi_lock, K_FOREVER);
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 0);
	bitbang_delay();
	bitbang_transfer_byte(gpio, ADS1299_CMD_WREG | reg, ADS1299_BITBANG_MODE);
	bitbang_delay();
	bitbang_transfer_byte(gpio, 0x00, ADS1299_BITBANG_MODE);
	bitbang_delay();
	bitbang_transfer_byte(gpio, value, ADS1299_BITBANG_MODE);
	bitbang_delay();
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 1);
	k_mutex_unlock(&spi_lock);

	spi_pins_configured = false;
	ads1299_configure_spi_pins();
	return 0;
}

static int bitbang_read_id_mode(uint8_t mode, uint8_t *id)
{
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	int err;

	err = bitbang_gpio_configure(gpio);
	if (err) {
		return err;
	}

	gpio_pin_set(gpio, ADS1299_BB_RESET_PIN, 0);
	k_sleep(K_MSEC(5));
	gpio_pin_set(gpio, ADS1299_BB_RESET_PIN, 1);
	k_sleep(K_MSEC(50));

	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 0);
	bitbang_delay();
	bitbang_transfer_byte(gpio, ADS1299_CMD_SDATAC, mode);
	bitbang_delay();
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 1);
	k_sleep(K_MSEC(2));

	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 0);
	bitbang_delay();
	bitbang_transfer_byte(gpio, ADS1299_CMD_RREG | ADS1299_REG_ID, mode);
	bitbang_delay();
	bitbang_transfer_byte(gpio, 0x00, mode);
	bitbang_delay();
	*id = bitbang_transfer_byte(gpio, 0x00, mode);
	bitbang_delay();
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 1);

	spi_pins_configured = false;
	ads1299_configure_spi_pins();
	return 0;
}

int ads1299_bitbang_probe_id_modes(char *response, size_t response_len)
{
	size_t used = 0;

	if (!response || response_len == 0) {
		return -EINVAL;
	}

	response[0] = '\0';
	for (uint8_t mode = 0; mode < 4; mode++) {
		uint8_t id = 0;
		int err = bitbang_read_id_mode(mode, &id);
		int written;

		if (err == 0) {
			written = snprintk(response + used, response_len - used,
					   "BBM%u=0x%02X ", mode, id);
		} else {
			written = snprintk(response + used, response_len - used,
					   "BBM%u=ERR%d ", mode, err);
		}
		if (written < 0 || (size_t)written >= response_len - used) {
			break;
		}
		used += (size_t)written;
	}

	return 0;
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
	const struct device *gpio = DEVICE_DT_GET(ADS1299_MISO_PROBE_NODE);
	uint8_t frame[ADS1299_FRAME_BYTES + 1];
	int err;

	if (!sample) {
		return -EINVAL;
	}
	if (!streaming) {
		return -EAGAIN;
	}
	if (!data_pins_configured) {
		return -EAGAIN;
	}

	err = bitbang_gpio_configure(gpio);
	if (err) {
		return err;
	}

	memset(frame, 0, sizeof(frame));

	k_mutex_lock(&spi_lock, K_FOREVER);
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 0);
	bitbang_delay();
	frame[0] = bitbang_transfer_byte(gpio, ADS1299_CMD_RDATA, ADS1299_BITBANG_MODE);
	for (int i = 1; i < ARRAY_SIZE(frame); i++) {
		frame[i] = bitbang_transfer_byte(gpio, 0x00, ADS1299_BITBANG_MODE);
	}
	bitbang_delay();
	gpio_pin_set(gpio, ADS1299_BB_CS_PIN, 1);
	k_mutex_unlock(&spi_lock);

	sample->t_ms = k_uptime_get_32();
	for (int i = 0; i < ADS1299_CHANNEL_COUNT; i++) {
		int base = 1 + 3 + i * 3;
		uint32_t raw = ((uint32_t)frame[base] << 16) |
			       ((uint32_t)frame[base + 1] << 8) |
			       (uint32_t)frame[base + 2];
		sample->channel[i] = sign_extend_24(raw);
	}

	return 0;
}
