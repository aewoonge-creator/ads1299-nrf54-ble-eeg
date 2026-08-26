#include "ads1299.h"

#include <zephyr/bluetooth/addr.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include <stdlib.h>
#include <string.h>

LOG_MODULE_REGISTER(main, LOG_LEVEL_INF);

#define UART_SERVICE_UUID_VAL BT_UUID_128_ENCODE(0x6e400001, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e)
#define UART_RX_UUID_VAL      BT_UUID_128_ENCODE(0x6e400002, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e)
#define UART_TX_UUID_VAL      BT_UUID_128_ENCODE(0x6e400003, 0xb5a3, 0xf393, 0xe0a9, 0xe50e24dcca9e)

static struct bt_uuid_128 uart_service_uuid = BT_UUID_INIT_128(UART_SERVICE_UUID_VAL);
static struct bt_uuid_128 uart_rx_uuid = BT_UUID_INIT_128(UART_RX_UUID_VAL);
static struct bt_uuid_128 uart_tx_uuid = BT_UUID_INIT_128(UART_TX_UUID_VAL);

static struct bt_conn *current_conn;
static bool tx_notify_enabled;
static char rx_line[160];
static size_t rx_len;
static char command_line[160];

static void command_work_handler(struct k_work *work);
K_WORK_DEFINE(command_work, command_work_handler);
K_MUTEX_DEFINE(command_lock);

static void ble_send_line(const char *line);
static void handle_ads1299_command(const char *command);

static bool command_has_token(const char *command, const char *token)
{
	return strstr(command, token) != NULL;
}

static uint32_t command_get_u32(const char *command, const char *key, uint32_t fallback)
{
	const char *pos = strstr(command, key);

	if (!pos) {
		return fallback;
	}

	pos += strlen(key);
	return (uint32_t)strtoul(pos, NULL, 0);
}

static uint8_t parse_channel_mask(const char *command)
{
	const char *pos = strstr(command, "ENABLE=");
	uint8_t mask = 0;

	if (!pos) {
		return 0xFF;
	}

	pos += strlen("ENABLE=");
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
				k_mutex_lock(&command_lock, K_FOREVER);
				strncpy(command_line, rx_line, sizeof(command_line) - 1);
				command_line[sizeof(command_line) - 1] = '\0';
				k_mutex_unlock(&command_lock);
				k_work_submit(&command_work);
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
	if (err) {
		LOG_ERR("Connection failed: %u", err);
		return;
	}
	current_conn = bt_conn_ref(conn);
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

	if (!current_conn) {
		return;
	}

	err = bt_gatt_notify(current_conn, &uart_service.attrs[4], line, strlen(line));
	if (err) {
		LOG_WRN("Notify failed: %d", err);
	}
}

static void handle_ads1299_command(const char *command)
{
	char ack[180];

	snprintk(ack, sizeof(ack), "RX %s\n", command);
	ble_send_line(ack);

	if (strcmp(command, "PING") == 0) {
		ble_send_line("PONG\n");
		return;
	}

	if (strcmp(command, "ADS1299 INIT") == 0) {
		int err = ads1299_init_device();
		if (err == 0) {
			ble_send_line("OK INIT\n");
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
		return;
	}
	if (strcmp(command, "ADS1299 STOP") == 0) {
		int err = ads1299_stop_stream();
		ble_send_line(err == 0 ? "OK STOP\n" : "ERR STOP\n");
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
			ble_send_line("SPI PROBE ");
			ble_send_line(response);
			ble_send_line("\n");
		} else {
			snprintk(response, sizeof(response), "ERR SPI PROBE %d\n", err);
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
		char response[128];
		uint8_t id = 0;
		uint8_t config1 = 0;
		uint8_t config2 = 0;
		uint8_t config3 = 0;
		int err = ads1299_read_register(0x00, &id);

		if (err == 0) {
			err = ads1299_read_register(0x01, &config1);
		}
		if (err == 0) {
			err = ads1299_read_register(0x02, &config2);
		}
		if (err == 0) {
			err = ads1299_read_register(0x03, &config3);
		}
		if (err == 0) {
			snprintk(response, sizeof(response),
				"REG ID=0x%02X CONFIG1=0x%02X CONFIG2=0x%02X CONFIG3=0x%02X\n",
				id, config1, config2, config3);
			ble_send_line(response);
		} else {
			ble_send_line("ERR RREG_ALL\n");
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
		struct ads1299_config config = {
			.sample_rate_sps = command_get_u32(command, "RATE=", 250),
			.gain = command_get_u32(command, "GAIN=", 24),
			.bias_enabled = command_has_token(command, "BIAS=ON"),
			.lead_off_enabled = command_has_token(command, "LOFF=ON"),
			.test_signal_enabled = command_has_token(command, "TEST=ON") ||
				command_has_token(command, "MUX=TEST"),
			.enabled_channel_mask = 0xFF,
		};
		int err = ads1299_apply_config(&config);
		ble_send_line(err == 0 ? "OK CONFIG\n" : "ERR CONFIG\n");
		return;
	}
	if (strncmp(command, "ADS1299 CHANNELS", 16) == 0) {
		struct ads1299_config config = {
			.sample_rate_sps = 250,
			.gain = 24,
			.bias_enabled = true,
			.lead_off_enabled = false,
			.test_signal_enabled = false,
			.enabled_channel_mask = parse_channel_mask(command),
		};
		int err = ads1299_apply_config(&config);
		ble_send_line(err == 0 ? "OK CHANNELS\n" : "ERR CHANNELS\n");
		return;
	}

	ble_send_line("ERR UNKNOWN_COMMAND\n");
}

static void command_work_handler(struct k_work *work)
{
	char command[160];

	ARG_UNUSED(work);

	k_mutex_lock(&command_lock, K_FOREVER);
	strncpy(command, command_line, sizeof(command) - 1);
	command[sizeof(command) - 1] = '\0';
	k_mutex_unlock(&command_lock);

	handle_ads1299_command(command);
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

	while (1) {
		struct ads1299_sample sample;
		char line[160];

		if (ads1299_read_sample(&sample) == 0) {
			snprintk(line, sizeof(line),
				"%u,%d,%d,%d,%d,%d,%d,%d,%d\n",
				sample.t_ms,
				sample.channel[0],
				sample.channel[1],
				sample.channel[2],
				sample.channel[3],
				sample.channel[4],
				sample.channel[5],
				sample.channel[6],
				sample.channel[7]);
			ble_send_line(line);
		}

		k_sleep(K_MSEC(4));
	}

	return 0;
}
