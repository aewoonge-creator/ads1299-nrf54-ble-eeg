# ADS1299 nRF54 BLE EEG

[웹 GUI 바로 열기 - 채널별 Gain / 측정 검증 v7](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/?v=2026-10-16-measurement-v7)

## GUI v7: 설정 확인과 신호 검증

- SPS는 ADC 공통 속도입니다. 위쪽 Gain은 **일괄 복사 선택값**이며 현재 적용값이 아닙니다. `Gain만 전체 채널에 복사` → 채널별 요청 Gain 확인 → `채널 설정 적용` → 실제 Gain/readback 확인 → `Start` 순서로 사용합니다. 적용 버튼은 채널 표까지 전송하고 레지스터를 다시 읽습니다.
- Requested / Applied(명령 ACK) / Readback을 분리했습니다. ACK만으로 실제 레지스터가 맞다고 판정하지 않습니다. 미확인은 미확인으로 표시합니다. BIAS sensing 선택은 전체 복사/drive OFF로 덮어쓰지 않습니다.
- Raw/CSV는 수신 signed 24-bit counts를 그대로 보존합니다. 입력 환산은 채널별 `raw × VREF × 1e6 / (2^23 × Gain)`으로 통일했습니다. VREF 전압은 사용자가 선언한 값이며 실측 전압이 아닙니다.
- CSV schema 2는 채널별 Gain/LSB/readback/시각과 설정 버전을 저장합니다. 기존 CSV의 공통 Gain이 채널 설정과 다르면 경고하고 채널 설정을 우선합니다. 구형 레지스터 메타데이터는 실제 readback 여부가 불확실하다고 표시합니다. 파일 설정은 분석에만 사용하며 연결된 보드의 요청 설정을 바꾸지 않습니다.
- `Signal Validation`에서 파일 또는 최근 수신 버퍼의 사인파/내부 Input-short 구간을 분석합니다. 발생기 진폭 단위는 **mVpp**이며 WaveForms의 peak 진폭 5 mV는 10 mVpp입니다. 주파수/진폭/R²/DC/RMS/AC RMS/clipping/PSD/50·60 Hz 주변값과 JSON 보고서를 제공합니다. 파일 B가 있으면 B/A raw 피팅 진폭비와 Gain 예상비도 표시합니다.
- Input-short 잡음은 offset 보정과 별개입니다. SHORTED MUX로 60초 이상 원본을 녹화한 뒤 분석 종류를 Input-short로 선택하세요. PSD는 Hann, 50% overlap, 구간별 DC 제거, one-sided µV²/Hz입니다. ADC full scale clipping과 고정값은 구분합니다.
- 설정 변경은 녹화를 끝내고 새 CSV에서 시작합니다. 설정 적용/Start/Preset은 기존 녹화를 종료하고, 수동 레지스터 변경은 녹화 중 차단합니다. 원본에는 필터/offset 보정/보간을 적용하지 않습니다.
- 저장률은 `(N−1)/(마지막 device read 시각−첫 시각)`이며 ADC DRDY 주파수 또는 BLE 손실률이 아닙니다. 현재 FW v6에는 DRDY 계수·sequence 계측이 없으므로 해당 지표는 미확인입니다. 불규칙 간격에서 FFT/PSD는 등간격 가정의 근사 결과이고, 사인파 피팅은 실제 `t_us`를 사용합니다.

이번 버전은 GUI 변경입니다. FW는 `2026-10-16-drdy-p111-v6` 그대로이며 플래시하지 않습니다.
재현 명령과 확인 범위는 [v7 검증 기록](validation-v7.md)을 참고하세요.

## 측정 원칙 및 확인된 배선 (2026-10-16)

목표는 ADS1299 실제 변환 수집 → BLE 전달 → GUI의 원시값 저장 및 파형 표시입니다.
테스트를 통과시키기 위해 데이터 재생, 보간, 반복 샘플 삽입, 명목 SPS 타임스탬프 생성으로
수집 실패를 숨기지 않습니다. CSV는 수신한 signed 24-bit ADC 정수값을 그대로 보존합니다.

| nRF54L15 DK | ADS1299EEG-FE | 용도 |
| --- | --- | --- |
| P0.00 | J3-3 | SCLK |
| P0.01 | J3-11 | MOSI |
| P0.02 | J3-13 | MISO |
| P0.03 | J3-7 | CS |
| P0.04 | J3-8 | RESET |
| **P1.11** | **J3-15** | **DRDY** |
| GND | J4-5 | 공통 접지 |
| VBUS | J4-10 | 5 V 전원 |
| VDDIO | J4-9 | 디지털 전원, 실제 전압 확인 필요 |

QFN48의 P0.05/P0.06은 외부 GPIO로 제공되지 않습니다. 번호 없는 P0 헤더에 연결하지 마세요.
J3-12는 GPIO2이며 START가 아닙니다. 이 선은 제거했습니다. START/STOP은 SPI 명령으로
제어하며, EVM의 실제 START 신호는 LOW로 유지되어야 합니다.

v6 실기 검증: USB 디버거 RTT로 30초 동안 7,501행, 249.9877 SPS, 큰 간격/잘못된 행/
8채널 전체 반복값 0건. 내부 TEST 8채널 3740.39–3742.84 µVpp, 0.976514 Hz.
실제 수신 CSV를 웹 GUI 파서·TEST 판정·CSV 내보내기에 재생하여 8채널 PASS 및 숫자 원본
동일성을 확인했습니다. 이는 **무선 BLE 또는 실제 브라우저 렌더링 검증을 대체하지 않습니다.**
이 검증 PC에는 Bluetooth 어댑터가 없어 BLE 실측은 다른 노트북에서 수행해야 합니다.

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
- Input-short 채널별 offset 측정 및 실시간 Filtered 표시 보정 (웹 Raw/CSV는 항상 원본)
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
채널별 short 평균을 저장하는 host-side 보정이며, GUI를 종료하면 초기화됩니다.
웹 v6에서는 offset을 실시간 Filtered 표시에만 적용하고 Raw/CSV는 수정하지 않습니다.
필터·offset 설정을 바꿔도 녹화 중인 ADC 원본을 바꾸지 않습니다.

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

`2026-10-16-test-start-v5`에서는 설정 중 칩을 리셋하던 자동 SPI probe를 제거하고,
명령과 샘플 읽기를 같은 스레드에서 처리합니다. `TEST 설정 중` 무한 대기 대신 START 응답,
샘플 수신, DRDY 오류를 구분해 표시합니다. Internal TEST는 전극이 필요 없지만 DRDY 배선은
필요합니다. TI ADS1299EEG-FE의 **J3-15(DRDYB) → nRF P1.11** 연결을 확인하세요
([TI SLAU443B, Table 8](https://www.ti.com/lit/ug/slau443b/slau443b.pdf)).

`ADS1299 DATA DIAG`는 DRDY 200회 관찰 결과와 강제로 한 번 읽은 27바이트 프레임을 출력하는
개발용 명령입니다. 이 프레임은 새 변환 여부가 보장되지 않으므로 정상 EEG stream/CSV에 넣지 않습니다.
2026-10-16 연결 장치(1057721963) 검사에서 SLOW/1X 내부 신호는 8채널 모두 약
3740–3743 µVpp, 약 0.970 Hz였지만 당시 잘못 지정된 DRDY(P0.05)는 17000회 모두 HIGH였습니다.
이는 v5 저속 진단 읽기 결과입니다. 위 v6 배선 수정 후에는 DRDY 동기식 수집이 확인되었습니다.

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
가까워야 합니다. 새 펌웨어에서도 반복값이 남으면 DRDY(P1.11) 배선과 논리 레벨을 로직
애널라이저로 먼저 확인하세요.

## Safety

EEG 전극을 인체에 연결하기 전에는 반드시 배터리 전원, 절연, 입력 보호, 전류 제한을 확인해야 합니다.
USB 전원 또는 외부 어댑터를 그대로 인체 연결 회로에 쓰지 마세요.

## Reference

- Original concept reference: https://github.com/lukaszmargielewski/EEG_BLE
- ADS1299 device family: Texas Instruments ADS1299
