# ADS1299 nRF54 BLE EEG

[웹 GUI 바로 열기 - Internal TEST / Offset 보정](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/?v=2026-10-16-test-cal-v4)

ADS1299 EEG front-end를 nRF54L15/nRF54L19 보드에 SPI로 연결하고, BLE Nordic UART
형식으로 PC GUI에 EEG sample을 보내기 위한 프로젝트 시작점입니다.

이 프로젝트는 TI ADS1299 EVM의 MMB0/전용 소프트웨어 흐름을 직접 대체하는 것을 목표로 합니다.

## Target Architecture

```text
ADS1299
  - 24-bit EEG ADC
  - SPI command/register interface
  - DRDY sample-ready pin
        |
        v
nRF54L15 / nRF54L19
  - SPI master
  - GPIO: START, RESET, CS, DRDY
  - BLE Nordic UART style GATT service
        |
        v
Web GUI or Python GUI
  - ADS1299 control panel
  - live plot
  - CSV recording
```

중요: ADS1299를 쓰는 경우 nRF의 내장 ADC가 아니라 ADS1299가 ADC입니다.
nRF는 ADS1299 register 제어, sample read, BLE 전송을 담당합니다.

## Repository Layout

```text
firmware/nrf54_ads1299_ble/
  CMakeLists.txt
  prj.conf
  boards/nrf54l15dk_nrf54l15_cpuapp.overlay
  src/main.c
  src/ads1299.c
  src/ads1299.h

pc_gui/
  README.md

docs/
  index.html
```

## One-click Web GUI

GitHub Pages를 켜면 노트북에서 아래 주소 하나로 GUI를 열 수 있습니다.

https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/

Web Bluetooth는 HTTPS 또는 localhost에서만 안정적으로 동작하므로, 다른 노트북에서는
GitHub Pages 방식이 가장 간단합니다.

웹 GUI에는 ADS1299 bring-up에 필요한 핵심 제어 기능을 먼저 넣어두었습니다.

- Init / Start / Stop
- Read ID / Read all registers
- sample rate, gain, MUX, reference 설정
- BIAS / lead-off / 채널별 internal test signal 설정
- internal square-wave 실측 진폭·주파수 자동 PASS/FAIL
- Input-short 채널별 offset 측정 및 plot/CSV 보정
- channel enable mask
- single register read/write
- custom command

## BLE Text Protocol

PC GUI -> nRF:

```text
ADS1299 INIT
ADS1299 START
ADS1299 STOP
ADS1299 RREG ALL
ADS1299 RREG ID
ADS1299 CONFIG RATE=250 GAIN=24 MUX=NORMAL REF=SRB1 REF_CH=1 ADC_REF=INTERNAL VREF_MV=4500 BIAS=ON BIASREF=INTERNAL BIASP=0xFF BIASN=0xFF LOFF=OFF TEST=ON TEST_AMP=1X TEST_FREQ=SLOW TEST_MASK=0x03 MASK=0xFF
ADS1299 CHANNELS MASK=0xFF
ADS1299 STREAM MASK=0xFF
```

Reference 모드는 `SRB1`, `SRB2_COMMON`, `SRB2_TO_SRB1`, `DIFFERENTIAL`을 지원합니다.
`SRB2_TO_SRB1`은 선택한 `REF_CH`의 SRB2 스위치와 MISC1.SRB1을 함께 설정하지만, 보드에서
SRB2와 SRB1 사이의 물리적 브리지/점퍼가 있어야 실제 programmable reference가 됩니다.
`ADC_REF=EXTERNAL`은 내부 reference buffer를 끄므로 VREFP/VREFN에 외부 기준전압이 필요합니다.
BIAS drive는 BIASOUT-BIASINV 피드백 네트워크와 BIAS 전극이 실제로 연결되어 있어야 합니다.
`MUX=BIAS_MEAS`는 채널 MUX뿐 아니라 CONFIG3.BIAS_MEAS도 함께 설정합니다.

Internal TEST는 `TEST_AMP=1X|2X`, `TEST_FREQ=SLOW|FAST|DC`, `TEST_MASK=0xNN`으로
설정합니다. SLOW/FAST는 각각 fCLK/2^21, fCLK/2^20이며, `TEST_MASK`의 채널만 CHnSET
MUX=101로 연결됩니다. 웹/Python GUI의 자동 판정은 기본 2.048 MHz clock, 진폭 ±20%,
주파수 ±10% 기준입니다. Input-short offset은 ADS1299 내부 보정 레지스터가 아니라 GUI가
채널별 short 평균을 저장해 이후 plot/CSV 샘플에서 빼는 host-side 보정이며, GUI를 종료하면
초기화됩니다.

nRF -> PC GUI:

```text
OK INIT
OK START
REG ID 0x3E
t_us,ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8
0,123,-45,0,0,0,0,0,0
```

## Bring-up Order

1. nRF54 board BLE advertising 확인
2. PC GUI에서 BLE 연결 확인
3. `ADS1299 INIT` 명령 수신 확인
4. ADS1299 ID register 읽기
5. ADS1299 internal test signal 모드 확인
6. 1채널 streaming
7. 8채널 streaming
8. CSV 저장 및 plot 확인

## 반복 저장 및 데이터 무결성 확인

펌웨어 `2026-10-14-drdy-stream-v2`부터는 설정 SPS를 기준으로 `RDATA`를 반복 호출하지 않고,
DRDY가 새 변환을 알릴 때만 한 프레임을 읽습니다. `t_us`도 실제 장치 읽기 시각을 사용하므로
처리가 늦어져 변환을 놓친 경우 CSV 시간 간격으로 확인할 수 있습니다.

웹 GUI의 **저장 멈춤**은 완료된 세션을 즉시 분리한 뒤 CSV를 작은 청크로 생성합니다. 이전
세션의 행·타이머·중복 비교 상태는 다음 **저장 시작**에 재사용되지 않습니다. 생성된 CSV에는
다음 진단 메타데이터가 포함됩니다.

```text
# repeated_all_channel_samples=0
# repeated_all_channel_comparisons=7499
# repeated_all_channel_percent=0.000000
```

검증할 때는 새 펌웨어를 플래시하고 웹 페이지를 강력 새로고침한 뒤, 같은 BLE 연결에서
`저장 시작 → 30초 이상 측정 → 저장 멈춤`을 4회 연속 반복하세요. 각 파일의 첫 `t_us`는
해당 저장 창에 들어온 값부터 시작해야 하고, `saved_samples`와 중복 진단값은 파일마다 독립적이어야
합니다. 정상 EEG에서 모든 저장 채널의 24-bit 값이 직전 프레임과 완전히 같은 비율은 보통 0%에
가까워야 합니다. 새 펌웨어에서도 반복값이 남으면 DRDY(P0.05) 배선과 논리 레벨을 로직
애널라이저로 먼저 확인하세요.

## Safety

EEG 전극을 인체에 연결하기 전에는 반드시 배터리 전원, 절연, 입력 보호, 전류 제한을 확인해야 합니다.
USB 전원 또는 외부 어댑터를 그대로 인체 연결 회로에 쓰지 마세요.

## Reference

- Original concept reference: https://github.com/lukaszmargielewski/EEG_BLE
- ADS1299 device family: Texas Instruments ADS1299
