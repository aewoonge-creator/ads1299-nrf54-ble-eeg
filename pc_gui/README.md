# PC GUI

실행:

```powershell
cd "C:\Users\GC\OneDrive - 가천대학교\문서\애웅이\work\ads1299_nrf54_ble\pc_gui"
python -m pip install -r requirements.txt
python .\ads1299_ble_gui.py
```

이 GUI는 Nordic UART RX characteristic으로 ADS1299 제어 명령을 보내고,
TX notify로 들어오는 `t_us,ch1,...,ch8` sample line을 plot/CSV 저장합니다. 이전 `t_ms` 펌웨어와
연결하면 PC GUI가 시간을 마이크로초로 변환해 CSV의 `t_us` 형식으로 통일합니다.

CSV 저장을 다시 시작하면 이전 파일 핸들, 샘플 수, 직전 프레임 비교 상태를 모두 초기화합니다.
저장 중지는 파일을 flush/close하고, 상태 줄에 해당 파일의 샘플 수와 모든 8채널이 직전 프레임과
동일했던 비율을 표시합니다. BLE 이벤트는 UI가 오래 멈추지 않도록 제한된 시간 단위로 처리합니다.

Reference는 SRB1 common, SRB2 common, 선택 채널을 이용한 SRB2→SRB1 방식, differential을
구분해 전송합니다. SRB2→SRB1 방식은 보드의 물리적 SRB2-SRB1 브리지가 필요합니다. ADC VREF의
internal/external 선택과 실제 전압값은 펌웨어 설정 및 raw→µV 환산에 사용됩니다. BIAS drive는
P/N sense mask와 내부/외부 BIAS reference를 함께 전송하며, 실제 동작에는 BIASOUT-BIASINV
피드백 네트워크와 BIAS 전극이 필요합니다. BIAS_MEAS를 고르면 펌웨어가 CONFIG3.BIAS_MEAS도
활성화합니다.

`Internal test signal`을 켜고 1X/2X 및 SLOW/FAST/DC를 선택할 수 있습니다. Channels의
`T1`~`T8` 체크박스가 채널별 TEST MUX mask이며, **Run + judge internal TEST**는 선택된 모든
채널의 input-referred 진폭과 주파수를 계산해 PASS/FAIL을 표시합니다(진폭 ±20%, 주파수 ±10%).
**Calibrate input-short offset (3 s)**는 현재 설정을 기억한 뒤 BIAS/lead-off/test를 끄고 입력을
short하여 채널 평균을 구한 다음 원 설정으로 복원합니다. 저장된 offset 적용을 켜면 이후 plot과
CSV 값에서 채널별 평균이 차감됩니다. 이 보정값은 PC GUI 프로세스 안에서만 유지됩니다.
