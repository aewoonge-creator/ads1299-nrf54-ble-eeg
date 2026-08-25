# PC GUI

실행:

```powershell
cd "C:\Users\GC\OneDrive - 가천대학교\문서\애웅이\work\ads1299_nrf54_ble\pc_gui"
python -m pip install -r requirements.txt
python .\ads1299_ble_gui.py
```

이 GUI는 Nordic UART RX characteristic으로 ADS1299 제어 명령을 보내고,
TX notify로 들어오는 `t_ms,ch1,...,ch8` sample line을 plot/CSV 저장합니다.
