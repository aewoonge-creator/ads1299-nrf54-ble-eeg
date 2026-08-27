# ADS1299 nRF54 BLE EEG

[웹 GUI 바로 열기](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/)

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
- BIAS / lead-off / internal test signal 설정
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
ADS1299 CONFIG RATE=250 GAIN=24 MUX=NORMAL REF=SRB1 BIAS=ON LOFF=OFF TEST=OFF MASK=0xFF
ADS1299 CHANNELS MASK=0xFF
ADS1299 STREAM MASK=0xFF
```

nRF -> PC GUI:

```text
OK INIT
OK START
REG ID 0x3E
t_ms,ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8
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

## Safety

EEG 전극을 인체에 연결하기 전에는 반드시 배터리 전원, 절연, 입력 보호, 전류 제한을 확인해야 합니다.
USB 전원 또는 외부 어댑터를 그대로 인체 연결 회로에 쓰지 마세요.

## Reference

- Original concept reference: https://github.com/lukaszmargielewski/EEG_BLE
- ADS1299 device family: Texas Instruments ADS1299
