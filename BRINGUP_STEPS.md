# ADS1299 nRF54L15 Bring-up Steps

이 문서는 ADS1299 EVM/MMB0 대신 nRF54L15 또는 nRF54L19로 ADS1299를 제어하기 위한
실제 작업 순서입니다.

## 1. 먼저 배선표를 확정한다

ADS1299는 nRF 내부 ADC로 읽는 부품이 아니라 SPI ADC입니다.
따라서 아래 신호를 반드시 nRF GPIO/SPI 핀에 연결해야 합니다.

| ADS1299 pin/signal | nRF54 pin | direction from nRF | purpose |
|---|---:|---|---|
| SCLK | P1.08 예시 | output | SPI clock |
| DIN | P1.09 예시 | output | SPI MOSI |
| DOUT | P1.11 예시 | input | SPI MISO |
| CS | P1.12 예시 | output | SPI chip select |
| DRDY | P1.13 예시 | input | sample ready, active low |
| RESET | P1.14 예시 | output | ADS1299 reset, active low |
| START | P1.15 예시 | output | conversion start |
| GND | GND | - | common ground |
| DVDD | board dependent | - | digital I/O voltage reference |

주의:

- nRF GPIO 전압과 ADS1299 DVDD 전압이 맞아야 합니다.
- `spi00`는 nRF54L15 DK의 external flash에 이미 쓰이고 있으므로 ADS1299에는 `spi21` 예시를 사용했습니다.
- 실제 DK header에서 P1.08, P1.09, P1.11, P1.12, P1.13, P1.14, P1.15를 쓸 수 있는지 보드 실크/핀맵으로 확인하세요.

## 2. overlay에서 pin 번호를 바꾼다

파일:

```text
firmware/nrf54_ads1299_ble/boards/nrf54l15dk_nrf54l15_cpuapp.overlay
```

예를 들어 SCLK를 P1.08이 아니라 P1.03에 꽂았다면:

```dts
NRF_PSEL(SPIM_SCK, 1, 8)
```

를 이렇게 바꿉니다.

```dts
NRF_PSEL(SPIM_SCK, 1, 3)
```

GPIO도 같은 방식입니다.

```dts
drdy-gpios = <&gpio1 13 GPIO_ACTIVE_LOW>;
reset-gpios = <&gpio1 14 GPIO_ACTIVE_LOW>;
start-gpios = <&gpio1 15 GPIO_ACTIVE_HIGH>;
cs-gpios = <&gpio1 12 GPIO_ACTIVE_LOW>;
```

## 3. 첫 빌드

nRF Connect SDK terminal에서:

```powershell
cd "C:\Users\GC\OneDrive - 가천대학교\문서\애웅이\work\ads1299_nrf54_ble\firmware\nrf54_ads1299_ble"
west build -b nrf54l15dk/nrf54l15/cpuapp
```

빌드가 실패하면 먼저 아래를 봅니다.

- overlay 문법 오류
- pinctrl macro 오류
- board target 이름 오류
- `spi21`이 다른 peripheral과 충돌하는지

## 4. BLE만 먼저 확인한다

처음에는 ADS1299가 연결되지 않아도 BLE 광고가 보여야 합니다.

1. flash
2. Python GUI 실행
3. BLE 이름 `ADS1299_NRF54` 연결
4. GUI에서 `ADS1299 INIT` 전송

## 5. ADS1299 ID register를 읽는다

GUI에서:

```text
ADS1299 RREG ID
```

응답 예:

```text
REG ID 0x3E
```

여기서 ID가 `0x00`, `0xFF`, 응답 없음이면 대부분 아래 문제입니다.

- SCLK/MOSI/MISO/CS 배선 오류
- GND 공통 연결 누락
- ADS1299 DVDD/AVDD 전원 문제
- RESET이 계속 active 상태
- SPI mode 또는 clock 속도 문제

## 6. internal test signal부터 본다

실제 전극 전에 반드시 ADS1299 내부 test signal로 시작합니다.

GUI 설정:

```text
RATE=250
GAIN=24
MUX=TEST
TEST=ON
```

이 상태에서 주기적인 파형이 나오면 SPI read, register write, BLE, GUI plot 경로가 살아있는 것입니다.

## 7. 그 다음 실제 EEG 입력으로 넘어간다

실제 전극 연결 전에 확인:

- 배터리 구동 또는 절연 전원
- 입력 보호
- BIAS/RLD 전류 제한
- reference electrode 구성
- USB/외부 전원 직접 연결 금지

