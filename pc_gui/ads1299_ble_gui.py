from __future__ import annotations

import asyncio
import csv
import queue
import threading
import time
import tkinter as tk
from collections import deque
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from ads1299_config import (
    ADC_REFERENCE_MODES,
    BIAS_REFERENCE_MODES,
    REFERENCE_MODES,
    build_config_command,
    channel_mask,
    raw_to_microvolts,
)
from ads1299_calibration import analyze_internal_test, apply_offsets, channel_offsets
from stream_protocol import parse_sample_line

try:
    from bleak import BleakClient, BleakScanner
except ImportError:  # pragma: no cover - shown in GUI at runtime
    BleakClient = None
    BleakScanner = None


UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
UART_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
UART_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

CHANNELS = 8
MAX_POINTS = 900

DATA_RATES = ["250", "500", "1000", "2000", "4000", "8000", "16000"]
GAINS = ["1", "2", "4", "6", "8", "12", "24"]
INPUT_MUXES = ["NORMAL", "SHORTED", "BIAS_MEAS", "MVDD", "TEMP", "TEST"]


class BleWorker:
    def __init__(self, out_queue: queue.Queue[tuple[str, object]]) -> None:
        self.out_queue = out_queue
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.client: BleakClient | None = None
        self.buffer = ""
        self.time_scale_to_us = 1

    def start(self, address: str | None = None) -> None:
        if BleakClient is None or BleakScanner is None:
            self.out_queue.put(("error", "bleak is not installed. Run: python -m pip install -r requirements.txt"))
            return
        if self.thread and self.thread.is_alive():
            return
        self.buffer = ""
        self.time_scale_to_us = 1
        self.thread = threading.Thread(target=self._run_loop, args=(address,), daemon=True)
        self.thread.start()

    def stop(self) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(self._disconnect(), self.loop)

    def send_command(self, command: str) -> None:
        if not self.loop:
            self.out_queue.put(("error", "BLE is not connected."))
            return
        asyncio.run_coroutine_threadsafe(self._send_command(command), self.loop)

    def send_commands(self, commands: list[str]) -> None:
        if not self.loop:
            self.out_queue.put(("error", "BLE is not connected."))
            return
        asyncio.run_coroutine_threadsafe(self._send_commands(commands), self.loop)

    async def _send_commands(self, commands: list[str]) -> None:
        for command in commands:
            await self._send_command(command)
            await asyncio.sleep(0.025)

    async def _send_command(self, command: str) -> None:
        try:
            if not self.client or not self.client.is_connected:
                raise RuntimeError("BLE is not connected.")
            payload = (command.strip() + "\n").encode("utf-8")
            for offset in range(0, len(payload), 18):
                await self.client.write_gatt_char(
                    UART_RX_CHAR_UUID,
                    payload[offset : offset + 18],
                    response=False,
                )
                await asyncio.sleep(0.015)
            self.out_queue.put(("command", command.strip()))
        except Exception as exc:
            self.out_queue.put(("error", str(exc)))

    def _run_loop(self, address: str | None) -> None:
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._connect(address))

    async def _connect(self, address: str | None) -> None:
        try:
            target = address
            if not target:
                self.out_queue.put(("status", "Scanning for Nordic UART device..."))
                devices = await BleakScanner.discover(timeout=5.0)
                for device in devices:
                    uuids = [u.lower() for u in (device.metadata.get("uuids") or [])]
                    if UART_SERVICE_UUID in uuids:
                        target = device.address
                        break
                if not target:
                    raise RuntimeError("No Nordic UART BLE device found.")

            self.out_queue.put(("status", f"Connecting: {target}"))
            self.client = BleakClient(target)
            await self.client.connect()
            await self.client.start_notify(UART_TX_CHAR_UUID, self._on_notify)
            self.out_queue.put(("status", "Connected. Waiting for ADS1299 samples..."))
            while self.client and self.client.is_connected:
                await asyncio.sleep(0.2)
        except Exception as exc:
            self.out_queue.put(("error", str(exc)))
        finally:
            await self._disconnect()

    async def _disconnect(self) -> None:
        if self.client:
            try:
                if self.client.is_connected:
                    await self.client.stop_notify(UART_TX_CHAR_UUID)
                    await self.client.disconnect()
            except Exception:
                pass
        self.client = None
        self.buffer = ""
        self.out_queue.put(("status", "Disconnected"))

    def _on_notify(self, _sender: int, data: bytearray) -> None:
        self.buffer += data.decode("utf-8", errors="replace")
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            stripped = line.strip()
            if stripped.startswith("t_ms"):
                self.time_scale_to_us = 1000
            elif stripped.startswith("t_us"):
                self.time_scale_to_us = 1
            row = parse_sample_line(stripped, self.time_scale_to_us)
            if row:
                self.out_queue.put(("sample", row))
            elif line.strip():
                self.out_queue.put(("log", line.strip()))


class Ads1299Gui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("ADS1299 BLE Live GUI")
        self.geometry("1240x820")
        self.minsize(1020, 680)

        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.ble = BleWorker(self.events)
        self.sample_count = 0
        self.plot_data = [deque(maxlen=MAX_POINTS) for _ in range(CHANNELS)]
        self.active_channel = tk.IntVar(value=1)
        self.address_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ready")
        self.sample_count_var = tk.StringVar(value="0")
        self.latest_value_var = tk.StringVar(value="-")
        self.csv_path: Path | None = None
        self.csv_file = None
        self.csv_writer: csv.DictWriter | None = None
        self.csv_sample_count = 0
        self.csv_comparable_pairs = 0
        self.csv_repeated_samples = 0
        self.csv_previous_frame: tuple[int, ...] | None = None
        self.recording_var = tk.StringVar(value="Not recording")
        self.data_rate_var = tk.StringVar(value="250")
        self.gain_var = tk.StringVar(value="24")
        self.input_mux_var = tk.StringVar(value="NORMAL")
        self.reference_var = tk.StringVar(value="SRB1")
        self.reference_channel_var = tk.StringVar(value="1")
        self.adc_reference_var = tk.StringVar(value="INTERNAL")
        self.vref_volts_var = tk.StringVar(value="4.5")
        self.bias_reference_var = tk.StringVar(value="INTERNAL")
        self.bias_enabled_var = tk.BooleanVar(value=True)
        self.lead_off_enabled_var = tk.BooleanVar(value=False)
        self.test_signal_var = tk.BooleanVar(value=False)
        self.test_amplitude_var = tk.StringVar(value="1X")
        self.test_frequency_var = tk.StringVar(value="SLOW")
        self.test_channel_vars = [tk.BooleanVar(value=True) for _ in range(CHANNELS)]
        self.test_result_var = tk.StringVar(value="Internal TEST: idle")
        self.offset_apply_var = tk.BooleanVar(value=False)
        self.offset_result_var = tk.StringVar(value="Input-short offset: not calibrated")
        self.channel_offset_raw = [0.0] * CHANNELS
        self.test_samples: list[dict[str, float]] = []
        self.test_running = False
        self.offset_samples: list[dict[str, float]] = []
        self.offset_running = False
        self.offset_ignore_until = 0.0
        self.offset_restore_command = ""
        self.channel_enabled_vars = [tk.BooleanVar(value=True) for _ in range(CHANNELS)]
        self.last_command_var = tk.StringVar(value="-")

        self._build_ui()
        self.after(50, self._drain_events)
        self.after(80, self._draw_plot)

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=12)
        root.pack(fill=tk.BOTH, expand=True)
        root.columnconfigure(1, weight=1)
        root.rowconfigure(0, weight=1)

        side = ttk.Frame(root, padding=(0, 0, 12, 0))
        side.grid(row=0, column=0, sticky="ns")

        ttk.Label(side, text="ADS1299 BLE", font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(side, text="Nordic UART notify receiver").pack(anchor="w", pady=(0, 16))

        ttk.Label(side, text="BLE address (optional)").pack(anchor="w")
        ttk.Entry(side, textvariable=self.address_var, width=34).pack(fill=tk.X, pady=(4, 8))

        ttk.Button(side, text="Connect", command=self._connect).pack(fill=tk.X, pady=3)
        ttk.Button(side, text="Disconnect", command=self.ble.stop).pack(fill=tk.X, pady=3)

        control = ttk.LabelFrame(side, text="ADS1299 control", padding=8)
        control.pack(fill=tk.X, pady=(4, 10))

        ttk.Button(control, text="Reset + Init", command=self._send_init).pack(fill=tk.X, pady=2)
        ttk.Button(control, text="Start Stream", command=lambda: self._send_command("ADS1299 START")).pack(fill=tk.X, pady=2)
        ttk.Button(control, text="Stop Stream", command=lambda: self._send_command("ADS1299 STOP")).pack(fill=tk.X, pady=2)
        ttk.Button(control, text="Read Registers", command=lambda: self._send_command("ADS1299 RREG ALL")).pack(fill=tk.X, pady=2)

        ttk.Label(control, text="Sample rate SPS").pack(anchor="w", pady=(8, 0))
        ttk.Combobox(control, textvariable=self.data_rate_var, values=DATA_RATES, state="readonly", width=10).pack(fill=tk.X)
        ttk.Label(control, text="Global gain").pack(anchor="w", pady=(6, 0))
        ttk.Combobox(control, textvariable=self.gain_var, values=GAINS, state="readonly", width=10).pack(fill=tk.X)
        ttk.Label(control, text="Input mux").pack(anchor="w", pady=(6, 0))
        ttk.Combobox(control, textvariable=self.input_mux_var, values=INPUT_MUXES, state="readonly", width=10).pack(fill=tk.X)
        ttk.Label(control, text="Reference").pack(anchor="w", pady=(6, 0))
        ttk.Combobox(control, textvariable=self.reference_var, values=REFERENCE_MODES, state="readonly", width=18).pack(fill=tk.X)
        ref_row = ttk.Frame(control)
        ref_row.pack(fill=tk.X, pady=(6, 0))
        ttk.Label(ref_row, text="Reference CH").pack(side=tk.LEFT)
        ttk.Combobox(ref_row, textvariable=self.reference_channel_var, values=[str(i) for i in range(1, 9)], state="readonly", width=4).pack(side=tk.RIGHT)
        ttk.Label(control, text="ADC VREF").pack(anchor="w", pady=(6, 0))
        adc_ref_row = ttk.Frame(control)
        adc_ref_row.pack(fill=tk.X)
        ttk.Combobox(adc_ref_row, textvariable=self.adc_reference_var, values=ADC_REFERENCE_MODES, state="readonly", width=10).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Entry(adc_ref_row, textvariable=self.vref_volts_var, width=6).pack(side=tk.LEFT, padx=(5, 0))
        ttk.Label(adc_ref_row, text="V").pack(side=tk.LEFT)
        ttk.Label(control, text="BIAS reference").pack(anchor="w", pady=(6, 0))
        ttk.Combobox(control, textvariable=self.bias_reference_var, values=BIAS_REFERENCE_MODES, state="readonly", width=12).pack(fill=tk.X)

        ttk.Checkbutton(control, text="BIAS drive", variable=self.bias_enabled_var).pack(anchor="w", pady=(7, 0))
        ttk.Label(
            control,
            text="SRB2_TO_SRB1 needs a physical SRB2↔SRB1 bridge. BIAS drive needs the BIASOUT→BIASINV feedback loop and BIAS electrode.",
            wraplength=250,
            foreground="#7c2d12",
        ).pack(anchor="w", pady=(2, 0))
        ttk.Checkbutton(control, text="Lead-off detect", variable=self.lead_off_enabled_var).pack(anchor="w")
        ttk.Checkbutton(control, text="Internal test signal", variable=self.test_signal_var).pack(anchor="w")
        test_row = ttk.Frame(control)
        test_row.pack(fill=tk.X)
        ttk.Combobox(test_row, textvariable=self.test_amplitude_var, values=["1X", "2X"], state="readonly", width=5).pack(side=tk.LEFT)
        ttk.Combobox(test_row, textvariable=self.test_frequency_var, values=["SLOW", "FAST", "DC"], state="readonly", width=7).pack(side=tk.LEFT, padx=(5, 0))
        ttk.Button(control, text="Apply Config", command=self._send_config).pack(fill=tk.X, pady=(7, 2))
        ttk.Button(control, text="Run + judge internal TEST", command=self._start_internal_test).pack(fill=tk.X, pady=2)
        ttk.Label(control, textvariable=self.test_result_var, wraplength=250).pack(anchor="w")
        ttk.Button(control, text="Calibrate input-short offset (3 s)", command=self._start_offset_calibration).pack(fill=tk.X, pady=(6, 2))
        ttk.Checkbutton(control, text="Apply saved offsets to plot/CSV", variable=self.offset_apply_var).pack(anchor="w")
        ttk.Label(control, textvariable=self.offset_result_var, wraplength=250).pack(anchor="w")

        channel_box = ttk.LabelFrame(side, text="Channels", padding=8)
        channel_box.pack(fill=tk.X, pady=(0, 10))
        channel_grid = ttk.Frame(channel_box)
        channel_grid.pack(fill=tk.X)
        for channel in range(1, CHANNELS + 1):
            row = (channel - 1) // 4
            col = (channel - 1) % 4
            ttk.Checkbutton(
                channel_grid,
                text=f"CH{channel}",
                variable=self.channel_enabled_vars[channel - 1],
            ).grid(row=row, column=col, sticky="w", padx=(0, 8), pady=2)
        ttk.Label(channel_grid, text="TEST MUX").grid(row=2, column=0, sticky="w", pady=(5, 0))
        for channel in range(1, CHANNELS + 1):
            ttk.Checkbutton(
                channel_grid,
                text=f"T{channel}",
                variable=self.test_channel_vars[channel - 1],
            ).grid(row=3 + (channel - 1) // 4, column=(channel - 1) % 4, sticky="w", padx=(0, 8), pady=2)
        ttk.Button(channel_box, text="Apply Channels", command=self._send_channel_config).pack(fill=tk.X, pady=(6, 0))

        custom_box = ttk.LabelFrame(side, text="Command", padding=8)
        custom_box.pack(fill=tk.X, pady=(0, 10))
        self.custom_command_var = tk.StringVar(value="ADS1299 RREG ID")
        ttk.Entry(custom_box, textvariable=self.custom_command_var).pack(fill=tk.X)
        ttk.Button(custom_box, text="Send", command=self._send_custom_command).pack(fill=tk.X, pady=(6, 0))

        ttk.Separator(side).pack(fill=tk.X, pady=14)
        ttk.Label(side, text="Plot channel").pack(anchor="w")
        for channel in range(1, CHANNELS + 1):
            ttk.Radiobutton(side, text=f"CH{channel}", value=channel, variable=self.active_channel).pack(anchor="w")

        ttk.Separator(side).pack(fill=tk.X, pady=14)
        ttk.Button(side, text="Start CSV", command=self._start_csv).pack(fill=tk.X, pady=3)
        ttk.Button(side, text="Stop CSV", command=self._stop_csv).pack(fill=tk.X, pady=3)
        ttk.Button(side, text="Clear", command=self._clear).pack(fill=tk.X, pady=3)

        ttk.Separator(side).pack(fill=tk.X, pady=14)
        ttk.Label(side, text="Status").pack(anchor="w")
        ttk.Label(side, textvariable=self.status_var, wraplength=260).pack(anchor="w", pady=(4, 10))
        ttk.Label(side, text="Samples").pack(anchor="w")
        ttk.Label(side, textvariable=self.sample_count_var, font=("Segoe UI", 13, "bold")).pack(anchor="w")
        ttk.Label(side, text="Latest value").pack(anchor="w", pady=(10, 0))
        ttk.Label(side, textvariable=self.latest_value_var, font=("Segoe UI", 13, "bold")).pack(anchor="w")
        ttk.Label(side, text="Last command").pack(anchor="w", pady=(10, 0))
        ttk.Label(side, textvariable=self.last_command_var, wraplength=260).pack(anchor="w")
        ttk.Label(side, textvariable=self.recording_var, foreground="#0f766e").pack(anchor="w", pady=(10, 0))

        panel = ttk.Frame(root)
        panel.grid(row=0, column=1, sticky="nsew")
        panel.rowconfigure(1, weight=1)
        panel.rowconfigure(2, weight=0)
        panel.columnconfigure(0, weight=1)

        ttk.Label(panel, text="Live ADS1299 Sample Plot", font=("Segoe UI", 16, "bold")).grid(row=0, column=0, sticky="w")
        self.canvas = tk.Canvas(panel, bg="white", highlightthickness=1, highlightbackground="#d7dce5")
        self.canvas.grid(row=1, column=0, sticky="nsew", pady=(8, 0))
        self.log_text = tk.Text(panel, height=8, wrap="word")
        self.log_text.grid(row=2, column=0, sticky="ew", pady=(8, 0))
        self._append_log("Command/firmware responses will appear here.")

    def _connect(self) -> None:
        address = self.address_var.get().strip() or None
        self.ble.start(address)

    def _send_command(self, command: str) -> None:
        self.last_command_var.set(command)
        self._append_log(f"> {command}")
        self.ble.send_command(command)

    def _send_commands(self, commands: list[str]) -> None:
        self.last_command_var.set(commands[-1] if commands else "-")
        for command in commands:
            self._append_log(f"> {command}")
        self.ble.send_commands(commands)

    def _send_init(self) -> None:
        self._send_command("ADS1299 INIT")

    def _config_command(self, **overrides: object) -> str:
        if self.reference_var.get() == "SRB2_TO_SRB1":
            self.channel_enabled_vars[int(self.reference_channel_var.get()) - 1].set(True)
        enabled_mask = int(overrides.get("enabled_mask", channel_mask([var.get() for var in self.channel_enabled_vars])))
        test_mask = channel_mask([var.get() for var in self.test_channel_vars]) & enabled_mask
        return build_config_command(
                rate=int(overrides.get("rate", int(self.data_rate_var.get()))),
                gain=int(overrides.get("gain", int(self.gain_var.get()))),
                mux=str(overrides.get("mux", self.input_mux_var.get())),
                reference=self.reference_var.get(),
                reference_channel=int(self.reference_channel_var.get()),
                adc_reference=self.adc_reference_var.get(),
                vref_volts=float(self.vref_volts_var.get()),
                bias_enabled=bool(overrides.get("bias_enabled", self.bias_enabled_var.get())),
                bias_reference=self.bias_reference_var.get(),
                bias_sensp_mask=enabled_mask,
                bias_sensn_mask=enabled_mask,
                lead_off_enabled=bool(overrides.get("lead_off_enabled", self.lead_off_enabled_var.get())),
                enabled_mask=enabled_mask,
                test_enabled=bool(overrides.get("test_enabled", self.test_signal_var.get())),
                test_amplitude=self.test_amplitude_var.get(),
                test_frequency=self.test_frequency_var.get(),
                test_channel_mask=int(overrides.get("test_channel_mask", test_mask)),
            )

    def _send_config(self) -> None:
        try:
            command = self._config_command()
        except ValueError as exc:
            messagebox.showerror("ADS1299 configuration", str(exc))
            return
        self._send_command(command)

    def _start_internal_test(self) -> None:
        if self.offset_running:
            messagebox.showwarning("ADS1299 internal TEST", "Wait for offset calibration to finish.")
            return
        self.test_signal_var.set(True)
        self.bias_enabled_var.set(False)
        self.lead_off_enabled_var.set(False)
        self.reference_var.set("DIFFERENTIAL")
        if not any(var.get() for var in self.test_channel_vars):
            messagebox.showwarning("ADS1299 internal TEST", "Select at least one TEST MUX channel.")
            return
        try:
            command = self._config_command(test_enabled=True)
        except ValueError as exc:
            messagebox.showerror("ADS1299 internal TEST", str(exc))
            return
        self.test_samples = []
        self.test_running = True
        self.test_result_var.set("Internal TEST: collecting samples...")
        self._send_commands(["ADS1299 STOP", command, "ADS1299 START"])

    def _start_offset_calibration(self) -> None:
        if self.offset_running:
            return
        try:
            self.offset_restore_command = self._config_command()
            short_command = self._config_command(
                mux="SHORTED",
                bias_enabled=False,
                lead_off_enabled=False,
                test_enabled=False,
                test_channel_mask=0,
            )
        except ValueError as exc:
            messagebox.showerror("ADS1299 offset calibration", str(exc))
            return
        self.offset_samples = []
        self.test_running = False
        self.test_samples = []
        self.offset_running = True
        self.offset_result_var.set("Input-short offset: collecting 3 s...")
        self._send_commands(["ADS1299 STOP", short_command, "ADS1299 START"])

    def _send_channel_config(self) -> None:
        if not any(var.get() for var in self.channel_enabled_vars):
            messagebox.showwarning("ADS1299 channels", "At least one channel must be enabled.")
            return
        self._send_config()

    def _send_custom_command(self) -> None:
        command = self.custom_command_var.get().strip()
        if command:
            self._send_command(command)

    def _start_csv(self) -> None:
        path = filedialog.asksaveasfilename(
            title="Save ADS1299 CSV",
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile=f"ads1299_ble_{time.strftime('%Y%m%d_%H%M%S')}.csv",
        )
        if not path:
            return
        self._stop_csv(update_status=False)
        csv_path = Path(path)
        csv_file = csv_path.open("w", newline="", encoding="utf-8")
        fields = ["pc_time_s", "t_us"] + [f"ch{i}" for i in range(1, CHANNELS + 1)]
        csv_writer = csv.DictWriter(csv_file, fieldnames=fields)
        csv_writer.writeheader()
        self.csv_path = csv_path
        self.csv_file = csv_file
        self.csv_writer = csv_writer
        self.csv_sample_count = 0
        self.csv_comparable_pairs = 0
        self.csv_repeated_samples = 0
        self.csv_previous_frame = None
        self.recording_var.set(f"Recording: {self.csv_path.name}")

    def _stop_csv(self, update_status: bool = True) -> None:
        csv_file = self.csv_file
        self.csv_path = None
        self.csv_file = None
        self.csv_writer = None
        self.csv_previous_frame = None
        if csv_file:
            csv_file.flush()
            csv_file.close()
        if update_status:
            repeat_percent = (
                100.0 * self.csv_repeated_samples / self.csv_comparable_pairs
                if self.csv_comparable_pairs else 0.0
            )
            self.recording_var.set(
                f"Not recording · {self.csv_sample_count} samples · "
                f"repeated {repeat_percent:.3f}%"
            )

    def _clear(self) -> None:
        self.sample_count = 0
        for channel_data in self.plot_data:
            channel_data.clear()
        self.sample_count_var.set("0")
        self.latest_value_var.set("-")

    def _drain_events(self) -> None:
        deadline = time.perf_counter() + 0.010
        processed = 0
        while processed < 500 and time.perf_counter() < deadline:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
            processed += 1
            if kind == "sample":
                self._add_sample(payload)
            elif kind == "status":
                self.status_var.set(str(payload))
                self._append_log(str(payload))
            elif kind == "command":
                self.last_command_var.set(str(payload))
            elif kind == "error":
                self.status_var.set(f"Error: {payload}")
                self._append_log(f"ERROR: {payload}")
                messagebox.showerror("BLE error", str(payload))
            elif kind == "log":
                self._append_log(str(payload))
        self.after(1 if not self.events.empty() else 20, self._drain_events)

    def _add_sample(self, row: object) -> None:
        sample = row if isinstance(row, dict) else {}
        if "t_us" not in sample:
            return
        raw_sample = dict(sample)
        if self.offset_running:
            self.offset_samples.append(raw_sample)
            if len(self.offset_samples) >= max(20, int(self.data_rate_var.get()) * 3):
                self.channel_offset_raw = channel_offsets(self.offset_samples, CHANNELS)
                self.offset_running = False
                self.offset_apply_var.set(True)
                summary = ", ".join(f"CH{i + 1} {value:.1f}" for i, value in enumerate(self.channel_offset_raw))
                self.offset_result_var.set(f"Input-short offset raw: {summary}")
                self._send_commands(["ADS1299 STOP", self.offset_restore_command, "ADS1299 START"])
                self.offset_ignore_until = time.monotonic() + 0.5
                self._clear()
            return
        if time.monotonic() < self.offset_ignore_until:
            return
        if self.test_running:
            self.test_samples.append(raw_sample)
            selected = [
                i for i, var in enumerate(self.test_channel_vars)
                if var.get() and self.channel_enabled_vars[i].get()
            ]
            required = int(self.data_rate_var.get()) * (4 if self.test_frequency_var.get() == "SLOW" else 2)
            if selected and len(self.test_samples) >= required:
                results = []
                for index in selected:
                    channel = index + 1
                    result = analyze_internal_test(
                        [float(item["t_us"]) for item in self.test_samples],
                        [float(item.get(f"ch{channel}", 0)) for item in self.test_samples],
                        gain=int(self.gain_var.get()),
                        vref_volts=float(self.vref_volts_var.get()),
                        amplitude=self.test_amplitude_var.get(),
                        frequency=self.test_frequency_var.get(),
                    )
                    if result:
                        results.append((channel, result))
                if results:
                    passed = sum(1 for _, result in results if result.passed)
                    details = "; ".join(
                        f"CH{channel} {'PASS' if result.passed else 'FAIL'} "
                        f"{result.measured_uv_pp:.1f}/{result.expected_uv_pp:.1f} µV"
                        for channel, result in results
                    )
                    self.test_result_var.set(f"{passed}/{len(results)} PASS · {details}")
                    self.test_running = False
        if self.offset_apply_var.get() and not self.offset_running:
            sample = apply_offsets(sample, self.channel_offset_raw)
        sample["pc_time_s"] = time.time()
        self.sample_count += 1
        for idx in range(CHANNELS):
            self.plot_data[idx].append(int(sample.get(f"ch{idx + 1}", 0)))
        channel = self.active_channel.get()
        self.sample_count_var.set(str(self.sample_count))
        raw = int(sample.get(f"ch{channel}", 0))
        try:
            microvolts = raw_to_microvolts(raw, int(self.gain_var.get()), float(self.vref_volts_var.get()))
            self.latest_value_var.set(f"{raw} raw / {microvolts:.3f} µV")
        except ValueError:
            self.latest_value_var.set(f"{raw} raw")
        if self.csv_writer:
            self.csv_writer.writerow(sample)
            self.csv_sample_count += 1
            frame = tuple(int(sample.get(f"ch{i}", 0)) for i in range(1, CHANNELS + 1))
            if self.csv_previous_frame is not None:
                self.csv_comparable_pairs += 1
                if frame == self.csv_previous_frame:
                    self.csv_repeated_samples += 1
            self.csv_previous_frame = frame
            if self.csv_sample_count % 250 == 0 and self.csv_file:
                self.csv_file.flush()

    def _append_log(self, line: str) -> None:
        if not hasattr(self, "log_text"):
            return
        self.log_text.insert(tk.END, line + "\n")
        self.log_text.see(tk.END)

    def _draw_plot(self) -> None:
        self.canvas.delete("all")
        width = max(self.canvas.winfo_width(), 10)
        height = max(self.canvas.winfo_height(), 10)
        pad = 36
        self.canvas.create_rectangle(pad, pad, width - pad, height - pad, outline="#cfd7e6")

        values = list(self.plot_data[self.active_channel.get() - 1])
        if len(values) >= 2:
            low = min(values)
            high = max(values)
            span = max(high - low, 1)
            usable_w = width - pad * 2
            usable_h = height - pad * 2
            points = []
            for idx, value in enumerate(values):
                x = pad + (idx / max(len(values) - 1, 1)) * usable_w
                y = height - pad - ((value - low) / span) * usable_h
                points.extend([x, y])
            self.canvas.create_line(points, fill="#0f766e", width=2)
            self.canvas.create_text(pad + 8, pad + 8, anchor="nw", text=f"max {high}", fill="#344054")
            self.canvas.create_text(pad + 8, height - pad - 22, anchor="nw", text=f"min {low}", fill="#344054")
        else:
            self.canvas.create_text(width / 2, height / 2, text="Waiting for samples...", fill="#667085")

        self.after(80, self._draw_plot)

    def destroy(self) -> None:
        self._stop_csv()
        self.ble.stop()
        super().destroy()


def main() -> None:
    app = Ads1299Gui()
    app.mainloop()


if __name__ == "__main__":
    main()
