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

    def start(self, address: str | None = None) -> None:
        if BleakClient is None or BleakScanner is None:
            self.out_queue.put(("error", "bleak is not installed. Run: python -m pip install -r requirements.txt"))
            return
        if self.thread and self.thread.is_alive():
            return
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

    async def _send_command(self, command: str) -> None:
        try:
            if not self.client or not self.client.is_connected:
                raise RuntimeError("BLE is not connected.")
            payload = (command.strip() + "\n").encode("utf-8")
            await self.client.write_gatt_char(UART_RX_CHAR_UUID, payload, response=False)
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
        self.out_queue.put(("status", "Disconnected"))

    def _on_notify(self, _sender: int, data: bytearray) -> None:
        self.buffer += data.decode("utf-8", errors="replace")
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            row = parse_sample_line(line.strip())
            if row:
                self.out_queue.put(("sample", row))
            elif line.strip():
                self.out_queue.put(("log", line.strip()))


def parse_sample_line(line: str) -> dict[str, int] | None:
    if not line or line.startswith("t_ms"):
        return None
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 2:
        return None
    try:
        values = [int(float(p)) for p in parts[: CHANNELS + 1]]
    except ValueError:
        return None
    row = {"t_ms": values[0]}
    for idx, value in enumerate(values[1:], start=1):
        row[f"ch{idx}"] = value
    for idx in range(len(values), CHANNELS + 1):
        row[f"ch{idx}"] = 0
    return row


class Ads1299Gui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("ADS1299 BLE Live GUI")
        self.geometry("1180x720")
        self.minsize(980, 600)

        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.ble = BleWorker(self.events)
        self.samples: list[dict[str, int]] = []
        self.plot_data = [deque(maxlen=MAX_POINTS) for _ in range(CHANNELS)]
        self.active_channel = tk.IntVar(value=1)
        self.address_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ready")
        self.sample_count_var = tk.StringVar(value="0")
        self.latest_value_var = tk.StringVar(value="-")
        self.csv_path: Path | None = None
        self.csv_file = None
        self.csv_writer: csv.DictWriter | None = None
        self.recording_var = tk.StringVar(value="Not recording")
        self.data_rate_var = tk.StringVar(value="250")
        self.gain_var = tk.StringVar(value="24")
        self.input_mux_var = tk.StringVar(value="NORMAL")
        self.reference_var = tk.StringVar(value="SRB1")
        self.bias_enabled_var = tk.BooleanVar(value=True)
        self.lead_off_enabled_var = tk.BooleanVar(value=False)
        self.test_signal_var = tk.BooleanVar(value=False)
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
        ttk.Combobox(control, textvariable=self.reference_var, values=["SRB1", "SRB2", "DIFFERENTIAL"], state="readonly", width=10).pack(fill=tk.X)

        ttk.Checkbutton(control, text="BIAS drive", variable=self.bias_enabled_var).pack(anchor="w", pady=(7, 0))
        ttk.Checkbutton(control, text="Lead-off detect", variable=self.lead_off_enabled_var).pack(anchor="w")
        ttk.Checkbutton(control, text="Internal test signal", variable=self.test_signal_var).pack(anchor="w")
        ttk.Button(control, text="Apply Config", command=self._send_config).pack(fill=tk.X, pady=(7, 2))

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

    def _send_init(self) -> None:
        self._send_command("ADS1299 INIT")

    def _send_config(self) -> None:
        command = (
            "ADS1299 CONFIG "
            f"RATE={self.data_rate_var.get()} "
            f"GAIN={self.gain_var.get()} "
            f"MUX={self.input_mux_var.get()} "
            f"REF={self.reference_var.get()} "
            f"BIAS={'ON' if self.bias_enabled_var.get() else 'OFF'} "
            f"LOFF={'ON' if self.lead_off_enabled_var.get() else 'OFF'} "
            f"TEST={'ON' if self.test_signal_var.get() else 'OFF'}"
        )
        self._send_command(command)

    def _send_channel_config(self) -> None:
        enabled = ",".join(
            str(idx)
            for idx, var in enumerate(self.channel_enabled_vars, start=1)
            if var.get()
        )
        if not enabled:
            messagebox.showwarning("ADS1299 channels", "At least one channel must be enabled.")
            return
        self._send_command(f"ADS1299 CHANNELS ENABLE={enabled}")

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
        self.csv_path = Path(path)
        self.csv_file = self.csv_path.open("w", newline="", encoding="utf-8")
        fields = ["pc_time_s", "t_ms"] + [f"ch{i}" for i in range(1, CHANNELS + 1)]
        self.csv_writer = csv.DictWriter(self.csv_file, fieldnames=fields)
        self.csv_writer.writeheader()
        self.recording_var.set(f"Recording: {self.csv_path.name}")

    def _stop_csv(self) -> None:
        if self.csv_file:
            self.csv_file.close()
        self.csv_file = None
        self.csv_writer = None
        self.recording_var.set("Not recording")

    def _clear(self) -> None:
        self.samples.clear()
        for channel_data in self.plot_data:
            channel_data.clear()
        self.sample_count_var.set("0")
        self.latest_value_var.set("-")

    def _drain_events(self) -> None:
        while True:
            try:
                kind, payload = self.events.get_nowait()
            except queue.Empty:
                break
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
        self.after(50, self._drain_events)

    def _add_sample(self, row: object) -> None:
        sample = row if isinstance(row, dict) else {}
        if "t_ms" not in sample:
            return
        sample["pc_time_s"] = time.time()
        self.samples.append(sample)
        for idx in range(CHANNELS):
            self.plot_data[idx].append(int(sample.get(f"ch{idx + 1}", 0)))
        channel = self.active_channel.get()
        self.sample_count_var.set(str(len(self.samples)))
        self.latest_value_var.set(str(sample.get(f"ch{channel}", 0)))
        if self.csv_writer:
            self.csv_writer.writerow(sample)

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
