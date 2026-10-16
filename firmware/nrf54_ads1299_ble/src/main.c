#include "ads1299.h"

#include <zephyr/bluetooth/addr.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#if defined(CONFIG_USE_SEGGER_RTT)
#include <SEGGER_RTT.h>
#endif

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

#define UART_SERVICE_UUID_VAL BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e)
#define UART_RX_UUID_VAL      BT_UUID_128_ENCODE(0x6e400002, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e)
#define UART_TX_UUID_VAL      BT_UUID_128_ENCODE(0x6e400003, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e)
#define COMMAND_QUEUE_DEPTH   32
#define COMMAND_MAX_LEN       256
#define FW_VERSION            "2026-10-16-drdy-p111-v6"

static struct bt_uuid_128 uart_service_uuid = BT_UUID_INIT_128(UART_SERVICE_UUID_VAL);
static struct bt_uuid_128 uart_rx_uuid = BT_UUID_INIT_128(UART_RX_UUID_VAL);
static struct bt_uuid_128 uart_tx_uuid = BT_UUID_INIT_128(UART_TX_UUID_VAL);

static struct bt_conn *current_conn;
static bool tx_notify_enabled;
static char rx_line[COMMAND_MAX_LEN];
static size_t rx_len;
static char rtt_rx_line[COMMAND_MAX_LEN];
static size_t rtt_rx_len;
static char command_queue[COMMAND_QUEUE_DEPTH][COMMAND_MAX_LEN];
static uint8_t command_queue_head;
static uint8_t command_queue_tail;
static uint8_t command_queue_count;
static uint32_t ads_sample_rate_sps = 250;
static uint32_t ads_gain = 24;
static bool ads_bias_enabled = true;
static bool ads_lead_off_enabled;
static bool ads_test_signal_enabled;
static bool ads_test_signal_amplitude_2x;
static enum ads1299_test_frequency ads_test_signal_frequency = ADS1299_TEST_FREQ_SLOW;
static uint8_t ads_test_channel_mask;
static uint8_t ads_enabled_channel_mask = 0xFF;
static enum ads1299_input_mux ads_input_mux = ADS1299_MUX_NORMAL;
static enum ads1299_reference_mode ads_reference_mode = ADS1299_REF_SRB1;
static uint8_t ads_reference_channel;
static bool ads_internal_reference = true;
static uint32_t ads_vref_mv = 4500;
static bool ads_internal_bias_reference = true;
static uint8_t ads_bias_sensp_mask = 0xFF;
static uint8_t ads_bias_sensn_mask = 0xFF;

static void process_next_command(void);
K_MUTEX_DEFINE(command_lock);

static void ble_send_line(const char *line);
static void handle_ads1299_command(const char *command);
static void submit_command(const char *command);

static const char *command_find_value(const char *command, const char *key)
{
	const char *pos = command;
	size_t key_len = strlen(key);

	while ((pos = strstr(pos, key)) != NULL) {
		if (pos == command || pos[-1] == ' ') {
			return pos + key_len;
		}
		pos++;
	}
	return NULL;
}

static uint32_t command_get_u32(const char *command, const char *key, uint32_t fallback)
{
	const char *pos = command_find_value(command, key);

	if (!pos) {
		return fallback;
	}

	return (uint32_t)strtoul(pos, NULL, 0);
}

static bool command_value_is(const char *command, const char *key, const char *value)
{
	const char *pos = command_find_value(command, key);
	size_t value_len = strlen(value);

	return pos && strncmp(pos, value, value_len) == 0 &&
	       (pos[value_len] == '\0' || pos[value_len] == ' ');
}

static enum ads1299_input_mux parse_input_mux(const char *command)
{
	if (command_value_is(command, "MUX=", "SHORTED")) return ADS1299_MUX_SHORTED;
	if (command_value_is(command, "MUX=", "BIAS_MEAS")) return ADS1299_MUX_BIAS_MEAS;
	if (command_value_is(command, "MUX=", "MVDD")) return ADS1299_MUX_MVDD;
	if (command_value_is(command, "MUX=", "TEMP")) return ADS1299_MUX_TEMP;
	if (command_value_is(command, "MUX=", "TEST")) return ADS1299_MUX_TEST;
	if (command_value_is(command, "MUX=", "BIAS_DRP")) return ADS1299_MUX_BIAS_DRP;
	if (command_value_is(command, "MUX=", "BIAS_DRN")) return ADS1299_MUX_BIAS_DRN;
	return command_find_value(command, "MUX=") ? ADS1299_MUX_NORMAL : ads_input_mux;
}

static enum ads1299_test_frequency parse_test_frequency(const char *command)
{
	if (command_value_is(command, "TEST_FREQ=", "FAST")) return ADS1299_TEST_FREQ_FAST;
	if (command_value_is(command, "TEST_FREQ=", "DC")) return ADS1299_TEST_FREQ_DC;
	if (command_value_is(command, "TEST_FREQ=", "SLOW")) return ADS1299_TEST_FREQ_SLOW;
	return ads_test_signal_frequency;
}

static const char *test_frequency_name(enum ads1299_test_frequency frequency)
{
	switch (frequency) {
	case ADS1299_TEST_FREQ_FAST: return "FAST";
	case ADS1299_TEST_FREQ_DC: return "DC";
	case ADS1299_TEST_FREQ_SLOW:
	default: return "SLOW";
	}
}

static enum ads1299_reference_mode parse_reference_mode(const char *command)
{
	if (command_value_is(command, "REF=", "SRB1")) return ADS1299_REF_SRB1;
	if (command_value_is(command, "REF=", "SRB2_COMMON") ||
	    command_value_is(command, "REF=", "SRB2")) return ADS1299_REF_SRB2_COMMON;
	if (command_value_is(command, "REF=", "SRB2_TO_SRB1") ||
	    command_value_is(command, "REF=", "PROGRAMMABLE")) return ADS1299_REF_SRB2_TO_SRB1;
	if (command_value_is(command, "REF=", "DIFFERENTIAL")) return ADS1299_REF_DIFFERENTIAL;
	return ads_reference_mode;
}

static const char *input_mux_name(enum ads1299_input_mux mux)
{
	switch (mux) {
	case ADS1299_MUX_SHORTED: return "SHORTED";
	case ADS1299_MUX_BIAS_MEAS: return "BIAS_MEAS";
	case ADS1299_MUX_MVDD: return "MVDD";
	case ADS1299_MUX_TEMP: return "TEMP";
	case ADS1299_MUX_BIAS_DRP: return "BIAS_DRP";
	case ADS1299_MUX_BIAS_DRN: return "BIAS_DRN";
	case ADS1299_MUX_TEST: return "TEST";
	case ADS1299_MUX_NORMAL:
	default: return "NORMAL";
	}
}

static const char *reference_mode_name(enum ads1299_reference_mode mode)
{
	switch (mode) {
	case ADS1299_REF_SRB1: return "SRB1";
	case ADS1299_REF_SRB2_COMMON: return "SRB2_COMMON";
	case ADS1299_REF_SRB2_TO_SRB1: return "SRB2_TO_SRB1";
	case ADS1299_REF_DIFFERENTIAL:
	default: return "DIFFERENTIAL";
	}
}

static uint8_t parse_channel_mask(const char *command)
{
	const char *pos = command_find_value(command, "MASK=");
	uint8_t mask = 0;

	if (pos) {
		return (uint8_t)strtoul(pos, NULL, 0);
	}

	pos = command_find_value(command, "ENABLE=");
	if (!pos) {
		return ads_enabled_channel_mask;
	}

	if (strncmp(pos, "NONE", 4) == 0) {
		return 0x00;
	}

	while (*pos) {
		char *end = NULL;
		long channel = strtol(pos, &end, 10);

		if (end == pos) {
			pos++;
			continue;
		}
		if (channel >= 1 && channel <= ADS1299_CHANNEL_COUNT) {
			mask |= BIT(channel - 1);
		}
		pos = end;
	}

	return mask;
}

static int apply_current_ads_config(void)
{
	bool was_streaming = ads1299_is_streaming();
	struct ads1299_config config = {
		.sample_rate_sps = ads_sample_rate_sps,
		.gain = ads_gain,
		.bias_enabled = ads_bias_enabled,
		.lead_off_enabled = ads_lead_off_enabled,
		.test_signal_enabled = ads_test_signal_enabled,
		.test_signal_amplitude_2x = ads_test_signal_amplitude_2x,
		.test_signal_frequency = ads_test_signal_frequency,
		.test_channel_mask = ads_test_channel_mask,
		.enabled_channel_mask = ads_enabled_channel_mask,
		.input_mux = ads_input_mux,
		.reference_mode = ads_reference_mode,
		.reference_channel = ads_reference_channel,
		.internal_reference = ads_internal_reference,
		.internal_bias_reference = ads_internal_bias_reference,
		.bias_sensp_mask = ads_bias_sensp_mask,
		.bias_sensn_mask = ads_bias_sensn_mask,
	};
	int err;

	if (was_streaming) {
		err = ads1299_stop_stream();
		if (err) {
			return err;
		}
	}
	err = ads1299_apply_config(&config);
	if (err) {
		return err;
	}
	return was_streaming ? ads1299_start_stream() : 0;
}

static uint8_t stream_channel_mask(void)
{
	return ads_enabled_channel_mask ? ads_enabled_channel_mask : 0xFF;
}

static int64_t uptime_us(void)
{
	return k_ticks_to_us_floor64(k_uptime_ticks());
}

static void send_stream_header(void)
{
	char line[80];
	size_t used;
	uint8_t mask = stream_channel_mask();

	used = snprintk(line, sizeof(line), "t_us");
	for (int i = 0; i < ADS1299_CHANNEL_COUNT; i++) {
		if ((mask & BIT(i)) == 0) {
			continue;
		}
		if (used < sizeof(line)) {
			used += snprintk(line + used, sizeof(line) - used, ",ch%d", i + 1);
		}
	}
	if (used < sizeof(line)) {
		snprintk(line + used, sizeof(line) - used, "\n");
	}
	ble_send_line(line);
}

static void send_stream_sample(const struct ads1299_sample *sample)
{
	char line[160];
	size_t used;
	uint8_t mask = stream_channel_mask();

	used = snprintk(line, sizeof(line), "%llu", (unsigned long long)sample->t_us);
	for (int i = 0; i < ADS1299_CHANNEL_COUNT; i++) {
		if ((mask & BIT(i)) == 0) {
			continue;
		}
		if (used < sizeof(line)) {
			used += snprintk(line + used, sizeof(line) - used, ",%d",
					 sample->channel[i]);
		}
	}
	if (used < sizeof(line)) {
		snprintk(line + used, sizeof(line) - used, "\n");
	}
	ble_send_line(line);
}

static void send_ads_state(const char *prefix)
{
	char line[COMMAND_MAX_LEN];

	snprintk(line, sizeof(line),
		 "FW STATE %s RATE=%u GAIN=%u MUX=%s REF=%s REF_CH=%u "
		 "ADC_REF=%s VREF_MV=%u BIAS=%s BIASREF=%s BIASP=0x%02X "
		 "BIASN=0x%02X TEST=%s TEST_AMP=%s TEST_FREQ=%s TEST_MASK=0x%02X MASK=0x%02X\n",
		 prefix,
		 ads_sample_rate_sps,
		 ads_gain,
		 input_mux_name(ads_input_mux),
		 reference_mode_name(ads_reference_mode),
		 ads_reference_channel + 1,
		 ads_internal_reference ? "INTERNAL" : "EXTERNAL",
		 ads_vref_mv,
		 ads_bias_enabled ? "ON" : "OFF",
		 ads_internal_bias_reference ? "INTERNAL" : "EXTERNAL",
		 ads_bias_sensp_mask,
		 ads_bias_sensn_mask,
		 ads_test_signal_enabled ? "ON" : "OFF",
		 ads_test_signal_amplitude_2x ? "2X" : "1X",
		 test_frequency_name(ads_test_signal_frequency),
		 ads_test_channel_mask,
		 ads_enabled_channel_mask);
	ble_send_line(line);
}

static void ccc_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	tx_notify_enabled = (value == BT_GATT_CCC_NOTIFY);
	LOG_INF("Notifications %s", tx_notify_enabled ? "enabled" : "disabled");
}

static ssize_t rx_written(
	struct bt_conn *conn,
	const struct bt_gatt_attr *attr,
	const void *buf,
	uint16_t len,
	uint16_t offset,
	uint8_t flags)
{
	const uint8_t *data = buf;

	for (uint16_t i = 0; i < len; i++) {
		char c = (char)data[i];
		if (c == '\r') {
			continue;
		}
		if (c == '\n') {
			rx_line[rx_len] = '\0';
			if (rx_len > 0) {
				LOG_INF("RX: %s", rx_line);
				submit_command(rx_line);
			}
			rx_len = 0;
			continue;
		}
		if (rx_len < sizeof(rx_line) - 1) {
			rx_line[rx_len++] = c;
		}
	}

	return len;
}

BT_GATT_SERVICE_DEFINE(uart_service,
	BT_GATT_PRIMARY_SERVICE(&uart_service_uuid),
	BT_GATT_CHARACTERISTIC(&uart_rx_uuid.uuid,
			       BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
			       BT_GATT_PERM_WRITE,
			       NULL, rx_written, NULL),
	BT_GATT_CHARACTERISTIC(&uart_tx_uuid.uuid,
			       BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE,
			       NULL, NULL, NULL),
	BT_GATT_CCC(ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE)
);

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, UART_SERVICE_UUID_VAL),
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static void connected(struct bt_conn *conn, uint8_t err)
{
	struct bt_le_conn_param param = {
		.interval_min = 6,
		.interval_max = 12,
		.latency = 0,
		.timeout = 400,
	};

	if (err) {
		LOG_ERR("Connection failed: %u", err);
		return;
	}
	current_conn = bt_conn_ref(conn);
	err = bt_conn_le_param_update(conn, &param);
	if (err) {
		LOG_WRN("Connection parameter update failed: %d", err);
	}
	LOG_INF("Connected");
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	LOG_INF("Disconnected: %u", reason);
	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
	}
	tx_notify_enabled = false;
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = connected,
	.disconnected = disconnected,
};

static void ble_send_line(const char *line)
{
	int err;
	size_t len;
	size_t offset;

#if defined(CONFIG_USE_SEGGER_RTT)
	SEGGER_RTT_WriteString(0, line);
#endif

	if (!current_conn || !tx_notify_enabled) {
		return;
	}

	len = strlen(line);
	const size_t payload_len = MAX((size_t)1, (size_t)bt_gatt_get_mtu(current_conn) - 3);
	for (offset = 0; offset < len; offset += payload_len) {
		size_t chunk_len = MIN(payload_len, len - offset);

		err = bt_gatt_notify(current_conn, &uart_service.attrs[4],
				     line + offset, chunk_len);
		if (err) {
			LOG_WRN("Notify failed: %d", err);
			return;
		}
	}
}

static void submit_command(const char *command)
{
	bool queued = false;

	k_mutex_lock(&command_lock, K_FOREVER);
	if (command_queue_count < COMMAND_QUEUE_DEPTH) {
		strncpy(command_queue[command_queue_tail], command,
			sizeof(command_queue[command_queue_tail]) - 1);
		command_queue[command_queue_tail][sizeof(command_queue[command_queue_tail]) - 1] = '\0';
		command_queue_tail = (command_queue_tail + 1) % COMMAND_QUEUE_DEPTH;
		command_queue_count++;
		queued = true;
	}
	k_mutex_unlock(&command_lock);
	if (!queued) {
		LOG_ERR("Command queue full");
	}
}

static void handle_ads1299_command(const char *command)
{
	char ack[COMMAND_MAX_LEN + 16];

	snprintk(ack, sizeof(ack), "RX %s\n", command);
	ble_send_line(ack);

	if (strcmp(command, "PING") == 0) {
		ble_send_line("PONG\n");
		return;
	}
	if (strcmp(command, "ADS1299 VERSION") == 0) {
		char response[80];

		snprintk(response, sizeof(response), "FW VERSION %s\n", FW_VERSION);
		ble_send_line(response);
		send_ads_state("VERSION");
		return;
	}

	if (strcmp(command, "ADS1299 INIT") == 0) {
		int err = ads1299_init_device();
		if (err == 0) {
			ads_sample_rate_sps = 250;
			ads_gain = 24;
			ads_bias_enabled = true;
			ads_lead_off_enabled = false;
			ads_test_signal_enabled = false;
			ads_test_signal_amplitude_2x = false;
			ads_test_signal_frequency = ADS1299_TEST_FREQ_SLOW;
			ads_test_channel_mask = 0x00;
			ads_enabled_channel_mask = 0xFF;
			ads_input_mux = ADS1299_MUX_NORMAL;
			ads_reference_mode = ADS1299_REF_SRB1;
			ads_reference_channel = 0;
			ads_internal_reference = true;
			ads_vref_mv = 4500;
			ads_internal_bias_reference = true;
			ads_bias_sensp_mask = 0xFF;
			ads_bias_sensn_mask = 0xFF;
			ble_send_line("OK INIT\n");
			send_ads_state("INIT");
			send_stream_header();
		} else {
			char response[32];

			snprintk(response, sizeof(response), "ERR INIT %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 START") == 0) {
		int err = ads1299_start_stream();
		ble_send_line(err == 0 ? "OK START\n" : "ERR START\n");
		if (err == 0) {
			send_ads_state("START");
			send_stream_header();
		}
		return;
	}
	if (strcmp(command, "ADS1299 STOP") == 0) {
		int err = ads1299_stop_stream();
		ble_send_line(err == 0 ? "OK STOP\n" : "ERR STOP\n");
		if (err == 0) {
			send_ads_state("STOP");
		}
		return;
	}
	if (strcmp(command, "TST") == 0 ||
	    strcmp(command, "ADS1299 TEST") == 0) {
		ads_test_signal_enabled = true;
		ads_test_signal_amplitude_2x = false;
		ads_test_signal_frequency = ADS1299_TEST_FREQ_SLOW;
		ads_test_channel_mask = ads_enabled_channel_mask;
		int err = apply_current_ads_config();
		ble_send_line(err == 0 ? "OK TEST\n" : "ERR TEST\n");
		if (err == 0) {
			send_ads_state("TEST");
		}
		return;
	}
	if (strcmp(command, "ADS1299 SPI LOOPBACK") == 0) {
		uint8_t rx[3] = { 0 };
		char response[64];
		int err = ads1299_spi_loopback(rx);

		if (err == 0) {
			snprintk(response, sizeof(response),
				"SPI LOOPBACK RX 0x%02X 0x%02X 0x%02X\n",
				rx[0], rx[1], rx[2]);
			ble_send_line(response);
		} else {
			snprintk(response, sizeof(response), "ERR SPI LOOPBACK %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 SPI PROBE") == 0) {
		char response[128];
		int err = ads1299_probe_id_modes(response, sizeof(response));

		if (err == 0) {
			char line[160];

			snprintk(line, sizeof(line), "SPI PROBE %s\n", response);
			ble_send_line(line);
		} else {
			snprintk(response, sizeof(response), "ERR SPI PROBE %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 RESET PROBE") == 0) {
		char response[128];
		int err = ads1299_probe_after_reset(response, sizeof(response));

		if (err == 0) {
			char line[160];

			snprintk(line, sizeof(line), "%s\n", response);
			ble_send_line(line);
		} else {
			snprintk(response, sizeof(response), "ERR RESET PROBE %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 GPIO") == 0) {
		char response[128];
		int err = ads1299_gpio_status(response, sizeof(response));

		if (err == 0) {
			char line[160];

			snprintk(line, sizeof(line), "%s\n", response);
			ble_send_line(line);
		} else {
			snprintk(response, sizeof(response), "ERR GPIO %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 DATA DIAG") == 0) {
		char response[256];
		int err = ads1299_data_diagnostic(response, sizeof(response));
		if (err) {
			snprintk(response, sizeof(response), "ERR DATA_DIAG %d\n", err);
		}
		ble_send_line(response);
		return;
	}
	if (strcmp(command, "ADS1299 MISO GPIO") == 0) {
		char response[128];
		int err = ads1299_miso_gpio_probe(response, sizeof(response));

		if (err == 0) {
			char line[160];

			snprintk(line, sizeof(line), "%s\n", response);
			ble_send_line(line);
		} else {
			snprintk(response, sizeof(response), "ERR MISO GPIO %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 MISO CS LOW") == 0) {
		char response[128];
		int err = ads1299_miso_cs_low_probe(response, sizeof(response));

		if (err == 0) {
			char line[160];

			snprintk(line, sizeof(line), "%s\n", response);
			ble_send_line(line);
		} else {
			snprintk(response, sizeof(response), "ERR MISO CS LOW %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 BITBANG PROBE") == 0) {
		char response[128];
		int err = ads1299_bitbang_probe_id_modes(response, sizeof(response));

		if (err == 0) {
			char line[160];

			snprintk(line, sizeof(line), "BITBANG PROBE %s\n", response);
			ble_send_line(line);
		} else {
			snprintk(response, sizeof(response), "ERR BITBANG PROBE %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strncmp(command, "ADS1299 SPI MODE ", 17) == 0) {
		uint8_t mode = (uint8_t)strtoul(command + 17, NULL, 0);
		int err = ads1299_set_spi_mode(mode);

		ble_send_line(err == 0 ? "OK SPI MODE\n" : "ERR SPI MODE\n");
		return;
	}
	if (strcmp(command, "ADS1299 RREG ALL") == 0) {
		char response[32];
		int err = 0;

		for (uint8_t reg = 0x00; reg <= 0x17; reg++) {
			uint8_t value = 0;

			err = ads1299_read_register(reg, &value);
			if (err) {
				break;
			}
			snprintk(response, sizeof(response), "REG 0x%02X 0x%02X\n", reg, value);
			ble_send_line(response);
			k_sleep(K_MSEC(2));
		}
		if (err) {
			snprintk(response, sizeof(response), "ERR RREG_ALL %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strcmp(command, "ADS1299 RREG ID") == 0) {
		uint8_t id = 0;
		char response[32];
		int err = ads1299_read_id(&id);
		if (err == 0) {
			snprintk(response, sizeof(response), "REG ID 0x%02X\n", id);
			ble_send_line(response);
		} else {
			snprintk(response, sizeof(response), "ERR RREG %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strncmp(command, "ADS1299 RREG ", 13) == 0) {
		uint8_t reg = (uint8_t)strtoul(command + 13, NULL, 0);
		uint8_t value = 0;
		char response[32];
		int err = ads1299_read_register(reg, &value);

		if (err == 0) {
			snprintk(response, sizeof(response), "REG 0x%02X 0x%02X\n", reg, value);
			ble_send_line(response);
		} else {
			snprintk(response, sizeof(response), "ERR RREG %d\n", err);
			ble_send_line(response);
		}
		return;
	}
	if (strncmp(command, "ADS1299 WREG ", 13) == 0) {
		char *end = NULL;
		uint8_t reg = (uint8_t)strtoul(command + 13, &end, 0);
		uint8_t value = (uint8_t)strtoul(end, NULL, 0);

		int err = ads1299_write_register(reg, value);

		ble_send_line(err == 0 ? "OK WREG\n" : "ERR WREG\n");
		return;
	}
	if (strncmp(command, "ADS1299 CONFIG", 14) == 0) {
		ads_sample_rate_sps = command_get_u32(command, "RATE=", ads_sample_rate_sps);
		ads_gain = command_get_u32(command, "GAIN=", ads_gain);
		ads_input_mux = parse_input_mux(command);
		ads_reference_mode = parse_reference_mode(command);
		if (command_find_value(command, "REF_CH=")) {
			uint32_t channel = command_get_u32(command, "REF_CH=", 1);

			ads_reference_channel = (uint8_t)CLAMP(channel, 1, ADS1299_CHANNEL_COUNT) - 1;
		}
		if (command_find_value(command, "ADC_REF=")) {
			ads_internal_reference = command_value_is(command, "ADC_REF=", "INTERNAL");
		}
		ads_vref_mv = command_get_u32(command, "VREF_MV=", ads_vref_mv);
		if (ads_vref_mv < 100 || ads_vref_mv > 10000) {
			ads_vref_mv = 4500;
		}
		if (command_find_value(command, "BIAS=")) {
			ads_bias_enabled = command_value_is(command, "BIAS=", "ON");
		}
		if (command_find_value(command, "BIASREF=")) {
			ads_internal_bias_reference = command_value_is(command, "BIASREF=", "INTERNAL");
		}
		if (command_find_value(command, "LOFF=")) {
			ads_lead_off_enabled = command_value_is(command, "LOFF=", "ON");
		}
		ads_enabled_channel_mask = parse_channel_mask(command);
		if (command_find_value(command, "TEST=")) {
			ads_test_signal_enabled = command_value_is(command, "TEST=", "ON");
		}
		if (command_find_value(command, "TEST_AMP=")) {
			ads_test_signal_amplitude_2x = command_value_is(command, "TEST_AMP=", "2X");
		}
		ads_test_signal_frequency = parse_test_frequency(command);
		ads_test_channel_mask = (uint8_t)command_get_u32(
			command, "TEST_MASK=", ads_test_signal_enabled ? ads_enabled_channel_mask : 0x00);
		if (ads_input_mux == ADS1299_MUX_TEST) {
			ads_test_signal_enabled = true;
			ads_test_channel_mask = ads_enabled_channel_mask;
			ads_input_mux = ADS1299_MUX_NORMAL;
		}
		ads_test_channel_mask &= ads_enabled_channel_mask;
		if (!ads_test_signal_enabled) {
			ads_test_channel_mask = 0x00;
		}
		ads_bias_sensp_mask = (uint8_t)command_get_u32(
			command, "BIASP=", ads_enabled_channel_mask);
		ads_bias_sensn_mask = (uint8_t)command_get_u32(
			command, "BIASN=", ads_enabled_channel_mask);

		int err = apply_current_ads_config();
		ble_send_line(err == 0 ? "OK CONFIG\n" : "ERR CONFIG\n");
		if (err == 0) {
			send_ads_state("CONFIG");
			send_stream_header();
		}
		return;
	}
	if (strncmp(command, "ADS1299 CHANNELS", 16) == 0) {
		ads_enabled_channel_mask = parse_channel_mask(command);
		int err = apply_current_ads_config();
		ble_send_line(err == 0 ? "OK CHANNELS\n" : "ERR CHANNELS\n");
		if (err == 0) {
			send_ads_state("CHANNELS");
			send_stream_header();
		}
		return;
	}
	if (strncmp(command, "ADS1299 STREAM MASK", 19) == 0) {
		ads_enabled_channel_mask = parse_channel_mask(command);
		ble_send_line("OK STREAM MASK\n");
		send_ads_state("STREAM_MASK");
		send_stream_header();
		return;
	}

	ble_send_line("ERR UNKNOWN_COMMAND\n");
}

static void process_next_command(void)
{
	char command[COMMAND_MAX_LEN];
	k_mutex_lock(&command_lock, K_FOREVER);
	if (command_queue_count == 0) {
		k_mutex_unlock(&command_lock);
		return;
	}
	strncpy(command, command_queue[command_queue_head], sizeof(command) - 1);
	command[sizeof(command) - 1] = '\0';
	command_queue_head = (command_queue_head + 1) % COMMAND_QUEUE_DEPTH;
	command_queue_count--;
	k_mutex_unlock(&command_lock);
	handle_ads1299_command(command);
}

static void poll_rtt_commands(void)
{
#if defined(CONFIG_USE_SEGGER_RTT)
	char c;

	while (SEGGER_RTT_Read(0, &c, 1) == 1) {
		if (c == '\r') {
			continue;
		}
		if (c == '\n') {
			rtt_rx_line[rtt_rx_len] = '\0';
			if (rtt_rx_len > 0) {
				LOG_INF("RTT RX: %s", rtt_rx_line);
				submit_command(rtt_rx_line);
			}
			rtt_rx_len = 0;
			continue;
		}
		if (rtt_rx_len < sizeof(rtt_rx_line) - 1) {
			rtt_rx_line[rtt_rx_len++] = c;
		}
	}
#endif
}

int main(void)
{
	int err;

	err = bt_enable(NULL);
	if (err) {
		LOG_ERR("Bluetooth init failed: %d", err);
		return err;
	}

	err = bt_le_adv_start(BT_LE_ADV_CONN, ad, ARRAY_SIZE(ad), NULL, 0);
	if (err) {
		LOG_ERR("Advertising failed: %d", err);
		return err;
	}

	LOG_INF("ADS1299 nRF54 BLE started");
	ble_send_line("READY ADS1299 RTT/BLE FW " FW_VERSION "\n");
	send_ads_state("READY");

	while (1) {
		struct ads1299_sample sample;
		char line[160];
		static int64_t last_stream_status_ms;
		static int64_t last_sample_ms;
		static int64_t stream_started_us;
		static bool stream_was_active;
		int64_t now_us;
		int sample_err;

		poll_rtt_commands();
		/* Keep commands and acquisition on one thread. Background reset/probe
		 * routines must never run while the GUI is configuring the ADC. GATT
		 * notifications here may wait for buffers, unlike system-workqueue TX.
		 */
		process_next_command();
		now_us = uptime_us();

		if (!ads1299_is_streaming()) {
			stream_was_active = false;
		}

		if (ads1299_is_streaming() && !stream_was_active) {
			stream_was_active = true;
			stream_started_us = now_us;
			last_sample_ms = k_uptime_get();
		}

		if (ads1299_is_streaming()) {
			sample_err = ads1299_read_sample(&sample);
			if (sample_err == 0) {
				last_sample_ms = k_uptime_get();
				/* Use the actual device read time so missed conversions remain
				 * visible as timestamp gaps instead of being hidden by a nominal
				 * sample index clock.  The protocol field remains t_us.
				 */
				int64_t elapsed_us = MAX((int64_t)0, uptime_us() - stream_started_us);

				sample.t_us = (uint64_t)elapsed_us;
				send_stream_sample(&sample);
			} else if (sample_err == -EAGAIN &&
				   k_uptime_get() - last_sample_ms > 1000 &&
				   k_uptime_get() - last_stream_status_ms > 2000) {
				last_stream_status_ms = k_uptime_get();
				ble_send_line("STREAM WAIT DRDY: no conversion-ready signal on P1.11\n");
			} else if (sample_err != -EAGAIN &&
				   k_uptime_get() - last_stream_status_ms > 1000) {
				last_stream_status_ms = k_uptime_get();
				snprintk(line, sizeof(line), "STREAM ERR %d\n", sample_err);
				ble_send_line(line);
			}
		}

		k_sleep(K_USEC(100));
	}

	return 0;
}
