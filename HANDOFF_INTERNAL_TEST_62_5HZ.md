# ADS1299 Internal TEST 62.500 Hz 문제 인계서

> **2026-10-16 실기 진단 업데이트 — 아래 초기 가설보다 이 결과를 우선할 것.**
> nRF54L15 DK 1057721963에 수정 펌웨어 `2026-10-16-test-start-v5`를 플래시했다.
> 자동 probe가 설정 중 ADC를 리셋하는 충돌을 실제 RTT 로그에서 확인하여 제거했고,
> 명령/수집을 메인 스레드로 직렬화했다. BLE 응답 버퍼 부족(-12)도 기존 로그에서 확인했다.
> 최신 펌웨어의 TEST 정지는 DRDY(P0.05) 입력에서 LOW를 못 받는 것이 직접 원인이다.
> SPI 강제 진단 읽기 85개에서 상태 헤더 C00000 및 정상 사각파를 확인했다.
> SLOW/1X 8채널: 3740.4–3742.8 µVpp, 약 0.9699 Hz(호스트 저속 진단 시각 추정).
> 같은 검사에서 DRDY 17000회 관찰은 모두 HIGH였다. 2X 진폭도 약 7480–7485 µVpp였다.
> 따라서 CH5/CH6의 ADC 고장은 현재 증거로 지지되지 않는다.
> **TI EVM J3-15(DRDYB) → nRF P0.05 배선/접촉/핀 위치를 확인하는 것이 다음 단계다.**
> 아직 정상 DRDY 동기식 250 SPS 수집이나 웹 GUI 전체 PASS를 달성했다고 보고하지 말 것.
> 강제 진단 읽기를 정상 stream에 섞거나 DRDY를 무시하는 우회로 해결 처리하지 말 것.
> GUI에는 START 응답/샘플 timeout 및 DRDY 오류 안내를 추가했고 회귀 테스트를 추가했다.

작성일: 2026-10-16  
저장소: https://github.com/aewoonge-creator/ads1299-nrf54-ble-eeg  
기준 브랜치/커밋: `main` / `69523bd Add ADS1299 internal test and offset calibration`

## 1. 현재 증상

웹 GUI에서 ADS1299 Internal TEST를 다음 조건으로 실행하면 모든 채널이 FAIL로 표시된다.

- SPS: 250
- Gain: 24
- ADC VREF: Internal 4.5 V
- TEST amplitude: `1x VREF/2400`
- TEST frequency: `fCLK / 2^21` (SLOW)
- BIAS drive: OFF
- Lead-off: OFF
- CH1~CH8: enabled, TEST MUX

GUI의 기대값은 다음과 같다.

- 진폭: `3750.0 uVpp`
- 주파수: `0.9765625 Hz` (`2.048 MHz / 2^21`)
- Gain 24, VREF 4.5 V 기준 기대 raw P2P: 약 `167772 counts`

실제 자동 판정 결과:

```text
CH1 FAIL: 3319.3/3750.0 uVpp, 62.500/0.977 Hz
CH2 FAIL: 3220.7/3750.0 uVpp, 62.500/0.977 Hz
CH3 FAIL: 3086.4/3750.0 uVpp, 62.500/0.977 Hz
CH4 FAIL: 3384.2/3750.0 uVpp, 62.500/0.977 Hz
CH5 FAIL:  637.8/3750.0 uVpp, 62.500/0.977 Hz
CH6 FAIL:  712.7/3750.0 uVpp, 62.500/0.977 Hz
CH7 FAIL: 3633.8/3750.0 uVpp, 62.500/0.977 Hz
CH8 FAIL: 3884.6/3750.0 uVpp, 62.500/0.977 Hz
```

해석:

- CH1~4, CH7~8의 진폭은 목표 대비 +/-20% 허용범위 안이다.
- CH5~6의 진폭은 지나치게 작다.
- 모든 채널의 `62.500 Hz`는 정확히 `250 SPS / 4`이다.
- 화면 파형에도 4-sample 주기의 빠른 반복 성분이 보인다.
- 따라서 전체 FAIL의 직접 원인은 주파수 불일치이며, 단순 전극 접촉 문제로 보이지 않는다.

## 2. 레지스터 확인 결과

Internal TEST 실행 상태에서 실제 readback 값은 모두 기대값과 일치했다.

```text
CONFIG1 = 0x96
CONFIG2 = 0xD0
CONFIG3 = 0xE8
CH1SET  = 0x65
CH2SET  = 0x65
CH3SET  = 0x65
CH4SET  = 0x65
CH5SET  = 0x65
CH6SET  = 0x65
CH7SET  = 0x65
CH8SET  = 0x65
MISC1   = 0x00
```

의미:나젤리

- `CONFIG1 0x96`: 250 SPS 설정
- `CONFIG2 0xD0`: internal test source ON, 1x amplitude, SLOW frequency
- `CONFIG3 0xE8`: internal 4.5 V reference 및 internal BIAS reference, BIAS drive OFF
- `CHnSET 0x65`: gain 24, TEST MUX
- `MISC1 0x00`: SRB1 OFF

따라서 GUI 명령 생성 및 ADS1299 레지스터 설정 단계는 정상이다. 문제 범위는 우선 다음으로 좁혀진다.

1. ADS1299 RDATA 프레임 수신/정렬
2. DRDY 샘플 동기화
3. bit-bang SPI data phase 또는 RDATA timing
4. BLE로 보내기 전의 raw sample 자체
5. GUI 주파수 추정기가 반복 글리치를 실제 rising edge로 계산하는 문제

## 3. 최신 펌웨어/GUI 정보

- 펌웨어 버전 문자열: `2026-10-15-test-cal-v4`
- BLE 연결 후 기대 로그: `FW VERSION 2026-10-15-test-cal-v4`
- 웹 GUI: https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/?v=2026-10-16-test-cal-v4
- 대상 보드 설정: `nrf54l15dk/nrf54l15/cpuapp`

최신 GUI가 보인다고 최신 펌웨어가 플래시된 것은 아니므로, 새 컴퓨터에서도 펌웨어 버전 문자열을 먼저 확인한다.

## 4. 관련 코드 위치

### 펌웨어

- `firmware/nrf54_ads1299_ble/src/ads1299.c`
  - bit-bang SPI mode/delay: 약 47~48행
  - `bitbang_transfer_byte()`: 약 655행
  - 레지스터 적용 `ads1299_apply_config()`: 약 850행
  - 샘플 수신 `ads1299_read_sample()`: 약 966행
  - 현재 RDATA 수신은 1 command byte + 27 data bytes를 bit-bang으로 읽고, 각 채널을 `frame[4]`부터 3바이트씩 해석한다.
- `firmware/nrf54_ads1299_ble/src/main.c`
  - 펌웨어 버전: 약 27행
  - stream loop/타임스탬프: 약 920행
- `firmware/nrf54_ads1299_ble/boards/nrf54l15dk_nrf54l15_cpuapp.overlay`
  - SCLK P0.00, MOSI P0.01, MISO P0.02, CS P0.03, RESET P0.04, DRDY P0.05, START P0.06

### 웹 GUI

- `docs/index.html`
  - 기대 진폭/주파수 계산 `expectedInternalTest()`: 약 1766행
  - 자동 판정 `analyzeInternalTestChannel()`: 약 1782행
  - 현재 주파수 판정은 global midpoint threshold의 rising edge 간격 median을 사용한다.
  - TEST 실행 `startInternalTestDiagnostic()`: 약 3680행
  - BLE/CSV stream parsing `appendStreamLine()`: 약 3744행

### Python GUI

- `pc_gui/ads1299_calibration.py`
- `pc_gui/ads1299_ble_gui.py`

## 5. 다음 컴퓨터에서 가장 먼저 할 진단

### A. raw CSV를 저장하고 4-sample 반복 여부 확인

필터된 plot만 보지 말고 TEST 상태에서 최소 6초간 raw CSV를 저장한다. 다음을 확인한다.

- `t_us` 차분의 median이 약 4000 us인지
- 각 채널에 `[a,b,c,d,a,b,c,d,...]` 형태의 4-sample 반복이 실제로 존재하는지
- 0.512초마다 바뀌어야 하는 SLOW square-wave plateau가 raw 값에 존재하는지
- 샘플 누락/중복/시간 역행이 있는지
- CH5/CH6만 raw amplitude가 실제로 작은지

만약 raw CSV에도 62.5 Hz가 있으면 GUI 그래프/필터 문제가 아니다.

### B. TEST 주파수 전환 실험

동일 설정에서 SLOW, FAST, DC를 각각 실행한다.

- SLOW 기대: 0.9765625 Hz
- FAST 기대: 1.953125 Hz
- DC 기대: 일정한 한쪽 레벨

판정:

- SLOW/FAST 모두 62.5 Hz: CAL_FREQ 문제가 아니라 acquisition 반복/프레임 문제 가능성이 높다.
- DC에서도 62.5 Hz: 내부 test generator가 아니라 SPI read/data parsing에서 생성된 패턴으로 거의 확정할 수 있다.
- SLOW와 FAST가 정확히 2배 관계로 변하지만 GUI만 62.5 Hz: 주파수 분석 알고리즘을 우선 수정한다.

### C. status 24-bit를 검증하도록 펌웨어 계측 추가

현재 `ads1299_read_sample()`은 status 3바이트를 버린다. 임시 진단 기능을 추가한다.

- 수신 frame 전체 28바이트를 16진수로 제한된 횟수만 출력하는 명령 추가
- status word 상위 nibble이 매 sample `0xC`인지 검증
- status가 맞지 않으면 frame alignment/SPI phase error counter 증가
- DRDY 물리 레벨과 logical level, RDATA 전후 레벨을 함께 기록
- 연속 프레임이 완전히 동일한 횟수와 4프레임 반복 횟수 집계

BLE 대역폭을 망치지 않도록 raw frame dump는 stream 중 처음 8~16프레임으로 제한한다.

### D. RDATA timing과 SPI 구현 비교

현재 샘플은 hardware SPIM이 아니라 GPIO bit-bang으로 읽는다.

확인할 항목:

- RDATA opcode 뒤 tSDECODE 여유시간
- CS가 command부터 27-byte frame 끝까지 계속 LOW인지
- ADS1299에 맞는 SPI mode 1(CPOL=0, CPHA=1) 파형인지
- status 시작 비트가 항상 `1100`인지
- logic analyzer에서 DRDY falling edge당 정확히 한 번만 RDATA가 실행되는지

가능하면 진단용 빌드에서 아래 두 경로를 비교한다.

1. 현재 bit-bang RDATA
2. Zephyr SPIM 기반 RDATA 또는 RDATAC 수신

두 경로 중 하나에서만 62.5 Hz가 나오면 SPI 구현 문제로 확정할 수 있다.

### E. DRDY를 polling 대신 edge 기반으로 검증

현재 코드는 active-low DRDY를 `gpio_pin_get_dt()`로 polling하고 logical 1일 때 읽는다. 다음을 계측하거나 임시 구현한다.

- DRDY falling-edge interrupt로 sample read를 1회만 예약
- conversion sequence counter 추가
- 연속 read 간 timestamp 분포 출력
- 한 DRDY low 구간에서 중복 RDATA가 발생하지 않는지 확인

## 6. GUI 자동 판정 개선은 acquisition 확인 후 진행

현재 GUI는 midpoint crossing을 모두 rising edge로 센다. square-wave 위에 62.5 Hz 글리치가 겹치면 잘못된 고주파를 선택할 수 있다. 단, 현재 화면에도 고주파 패턴이 실제로 보이므로 GUI만 먼저 고쳐서 PASS로 숨기면 안 된다.

acquisition이 정상임을 확인한 뒤 다음과 같이 개선한다.

- 기대 주파수 근처로 탐색 범위를 제한
- 예상 half-period에 맞는 window median/majority 사용
- hysteresis threshold 적용
- 최소 edge 간격 적용
- autocorrelation 또는 low-frequency matched detection으로 교차 확인
- 결과에 `raw dominant`, `expected-band`, `edge count`를 따로 표시

## 7. CH5/CH6 저진폭 문제

CH5/CH6도 `CHnSET=0x65`이므로 설정 누락은 아니다. 그러나 frame alignment 문제가 있으면 채널별 진폭 비교 자체가 잘못될 수 있으므로, 먼저 status/frame 정렬을 해결한다.

프레임 정렬이 정상임이 확인된 후에도 CH5/CH6만 작으면 다음을 검사한다.

- TEST DC/FAST에서도 동일하게 CH5/CH6만 작은지
- gain을 1, 6, 12, 24로 바꿨을 때 raw count가 예상 비율로 변하는지
- CH5/CH6 register readback이 stream 전후 동일한지
- ADS1299 전원/기준전압 및 해당 채널 입력 주변의 누설/쇼트
- 다른 ADS1299 보드에서도 재현되는지

Internal TEST는 칩 내부 신호이므로 전극 접촉이나 피험자 상태는 원인이 아니다. 검사 중에는 피험자와 전극을 분리한다.

## 8. 빌드 및 회귀 테스트

NCS가 설치된 컴퓨터에서:

```powershell
west build -b nrf54l15dk/nrf54l15/cpuapp --no-sysbuild `
  -d build/nrf54l15dk_nrf54l15_cpuapp `
  firmware/nrf54_ads1299_ble --pristine
west flash -d build/nrf54l15dk_nrf54l15_cpuapp
```

Windows 경로에 공백/한글/OneDrive가 있으면 devicetree overlay 처리 오류가 발생할 수 있다. 그 경우 저장소 또는 firmware 폴더를 공백 없는 짧은 경로로 복사해 빌드한다.

회귀 테스트:

```powershell
python -m pytest tests
node --test tests/*.test.cjs
```

기존 확인 결과는 Python 9개, Node 7개 통과였으며 nRF54L15 전체 compile/link도 통과했다.

## 9. 완료 기준

다음이 모두 만족되어야 이 문제를 해결한 것으로 본다.

- CONFIG2/CHnSET readback 정상 유지
- SLOW 측정값 약 0.977 Hz
- FAST 측정값 약 1.953 Hz
- DC에서 고주파 4-sample 반복 없음
- 1x 진폭 약 3750 uVpp, 2x 진폭 약 7500 uVpp
- 8채널 모두 허용오차 내 PASS
- raw frame status 상위 nibble이 매번 `0xC`
- 250 SPS에서 timestamp 간격이 약 4000 us이고 중복/역행 없음
- Internal TEST 종료 후 Normal EEG preset으로 정상 복원

## 10. 새 Codex 작업에 붙여 넣을 요청문

```text
이 저장소의 HANDOFF_INTERNAL_TEST_62_5HZ.md를 먼저 읽고 작업해줘.
ADS1299 Internal TEST 레지스터 readback은 CONFIG1=0x96, CONFIG2=0xD0,
CONFIG3=0xE8, CH1SET~CH8SET=0x65, MISC1=0x00으로 정상인데,
SLOW 0.977 Hz 신호가 모든 채널에서 62.500 Hz로 측정된다.
먼저 raw CSV와 RDATA status/frame을 계측해서 원인을 확정하고,
그 다음 펌웨어 또는 GUI를 수정하고 nRF54L15 빌드 및 테스트까지 완료해줘.
추정만으로 GUI 판정 허용범위를 넓혀 PASS 처리하지 말아줘.
```
