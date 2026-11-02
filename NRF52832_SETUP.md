# nRF52832 DK + ADS1299

Target: nRF52 DK (PCA10040), nRF52832 QFAA, NCS v2.9.3.
Firmware: `2026-11-02-nrf52-port-v1`. BLE name: `ADS1299_NRF52`.

## 다른 Windows PC에서 시작

1. Git, VS Code와 Nordic의 nRF Connect for VS Code 확장, nRF Connect SDK
   **v2.9.3 및 해당 SDK용 toolchain**, SEGGER J-Link를 설치합니다.
2. PowerShell에서 소스를 받습니다. 짧은 영문 경로를 권장합니다.

```powershell
git clone https://github.com/aewoonge-creator/ads1299-nrf54-ble-eeg.git C:\ncs\ads1299_nrf52832_ble
cd C:\ncs\ads1299_nrf52832_ble
```

이미 받은 저장소라면 해당 폴더에서 `git pull --ff-only`로 업데이트합니다.
로컬 수정 때문에 실패하면 수정 내용을 보존하고 먼저 차이를 확인합니다.

3. VS Code에서 `C:\ncs\ads1299_nrf52832_ble` 폴더를 열고 nRF Connect 확장의
   기존 애플리케이션 열기로 `firmware\nrf54_ads1299_ble`를 선택합니다.
   경로 이름에 nrf54가 있지만 nRF52832도 지원하는 공용 소스입니다.
4. 새 빌드 구성에서 SDK v2.9.3, 보드 **`nrf52dk/nrf52832`**, 새 빌드 디렉터리를
   선택하고 **Sysbuild는 끈 상태**로 Build 합니다. 보드 전용 overlay와 conf는
   자동 적용됩니다. 다른 보드용 빌드 디렉터리는 재사용하지 않습니다.
5. nRF52 DK를 USB로 연결하고 해당 빌드 구성의 Flash를 실행합니다.
   다른 보드도 연결되어 있다면 대상 디버거를 확인합니다.

PowerShell 빌드 스크립트를 사용할 때 기본 경로는 이 PC의 SDK/toolchain 경로입니다.
다른 PC에서는 실제 설치 경로로 아래 값을 바꿔 실행하세요.

```powershell
.\tools\build_firmware.ps1 -Board nrf52dk/nrf52832 -Sdk 'C:\ncs\v2.9.3' -Toolchain 'C:\ncs\toolchains\실제-toolchain-폴더'
```

소스 수정 없이 바로 플래시하려면 아래 HEX를 받아 nRF Connect for Desktop의
Programmer에서 nRF52 DK를 선택하여 기록할 수 있습니다. 이 경우 SDK 빌드는 필요 없습니다.

- [nRF52832 HEX 직접 다운로드](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/firmware/ads1299-nrf52832-2026-11-02-nrf52-port-v1.hex)
- [빌드 정보와 SHA256](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/firmware/manifest-nrf52832.json)

접근 보호 오류가 있을 때만 복구/erase 필요 여부를 확인합니다. 복구는 기존 프로그램을
삭제하므로 일반 플래시 전에 무조건 실행하지 않습니다.

현재 사용 중인 ADS 보드는 연결 시 전원 강하가 관찰되었습니다. 원인 해결 전에는
ADS를 분리하고 nRF 단독으로 빌드/플래시/버전 확인까지만 진행하세요.

## 실기 확인 상태

2026-11-02에 디버거 `1050393707`의 `NRF52832_xxAA_REV3`에서 보호 해제,
HEX 기록 및 verify, 재부팅을 완료했습니다. RTT로
`FW VERSION 2026-11-02-nrf52-port-v1` 응답을 확인했습니다.
이 결과는 ADS1299 통신, 실제 BLE 수신 또는 EEG 측정 검증을 의미하지 않습니다.

## 배선

전원을 끄고 아래대로 변경합니다. nRF54L15의 P0.00/P0.01은 이 보드의 SPI 핀이
아닙니다. nRF52 DK에서는 저주파 크리스털 핀과 겹치므로 이전 번호대로 연결하지 않습니다.

| ADS1299EEG-FE | 신호 | nRF52 DK 핀 | Arduino 표기 | Logic 8 |
| --- | --- | --- | --- | --- |
| J3-3 | SCLK | P0.25 | D13 | D2 |
| J3-11 | DIN / MOSI | P0.23 | D11 | D3 |
| J3-13 | DOUT / MISO | P0.24 | D12 | D4 |
| J3-7 | CS | P0.22 | D10 | D1 |
| J3-8 | RESETB | P0.27 | D15 | 선택 |
| J3-15 | DRDYB | P0.26 | D14 | D0 |
| GND | 공통 접지 | GND | GND | GND |

표의 Arduino D번호와 Logic 8 D번호는 서로 다른 장치의 표기입니다.
START/STOP은 SPI 명령으로 제어합니다. ADS1299 START 입력은 LOW여야 하며,
J3-12는 START가 아니라 GPIO2입니다. START를 nRF에 연결하지 않습니다.

기존 EVM 전원 요구(J4-10의 5V, J4-9의 디지털 전원)는 유지됩니다. nRF52 DK의
VDD를 3.3V로 단정하지 말고 실제 전압과 EVM 점퍼를 확인하세요. ADC DVDD와 nRF
GPIO 전압을 맞추고, 5V를 GPIO 또는 VDD 핀에 연결하지 마세요. 사람에 연결한 전극은
USB/로직 분석기 벤치 확인 중 분리합니다. 이 이식으로 인체 측정 절연이 확보되지는 않습니다.

## 빌드

저장소 루트 PowerShell에서 실행합니다.

```powershell
.\tools\build_firmware.ps1 -Board nrf52dk/nrf52832
```

SDK와 toolchain 경로는 `-Sdk`, `-Toolchain`으로 지정할 수 있습니다.
스크립트는 ASCII 임시 경로에서 빌드하고 HEX와 보드별 소스 해시 manifest를
`docs/firmware`에 만듭니다. 자동 플래시하지 않습니다.
VS Code에서도 앱 `firmware/nrf54_ads1299_ble`, 보드 `nrf52dk/nrf52832`를 선택합니다.
이전 nRF54 빌드 폴더를 재사용하지 말고 새 빌드 구성을 만드세요.

기존 보드 빌드: `tools/build_firmware.ps1 -Board nrf54l15dk/nrf54l15/cpuapp`.
두 보드는 같은 C 소스와 서로 다른 overlay/config를 사용합니다.

## 플래시와 확인

1. nRF Connect for Desktop Programmer에서 nRF52 DK를 선택합니다.
2. `ads1299-nrf52832-2026-11-02-nrf52-port-v1.hex`를 선택하고 기록합니다.
   기존 보드 프로그램이 교체됩니다. nRF54용 HEX는 사용하지 않습니다.
3. 웹 GUI에서 `ADS1299_NRF52`에 연결하고 VERSION 응답을 확인합니다.
4. Init, Read ID로 `0x3E`를 확인한 뒤 Read Regs로 실제 레지스터를 확인합니다.
5. 전극 없이 250 SPS / 8채널 Internal Test를 확인하고 60초 CSV를 저장합니다.
6. Internal Test를 종료하고 Input Short를 확인합니다. 그다음 실제 전극 설정으로 전환합니다.
7. 사용할 각 SPS와 채널 조합에서 다시 확인합니다. 1000 SPS 사용 전에는 1000 SPS
   CSV의 실제 시간 간격과 장시간 BLE 수신을 별도 검증합니다.

## 유지한 동작과 변경점

- 기존 GUI, raw signed 24-bit counts, 채널별 Gain/readback/CSV metadata를 유지합니다.
- nRF52832는 SPIM2, 1MHz, SPI mode 1을 사용합니다. RREG/WREG/RDATA 명령 구간에
  decode 대기를 두고 수동 CS를 유지합니다. nRF52832 PAN 58 우회도 활성화합니다.
- nRF54L15는 기존 bit-bang 경로를 유지합니다. nRF52832의 BITBANG PROBE는
  SPIM 핀 소유권 충돌을 막기 위해 `ENOTSUP`을 반환합니다. SPI PROBE는 사용 가능합니다.
- BLE 광고의 이름은 scan response로 이동해 legacy advertising 31-byte 한도를 지킵니다.
- DRDY가 준비됐을 때 실제 ADC를 읽습니다. `t_us`는 실제 읽기 시각이며 명목 SPS로
  시간을 생성하거나 빠진 샘플을 채우지 않습니다.

현재 수집/전송 루프는 BLE가 밀리면 변환을 놓칠 수 있습니다. DRDY 에지 계수나
sample sequence는 아직 없으므로 CSV 수신률만으로 무손실을 증명할 수 없습니다.
모든 ADS1299 SPS를 설정할 수 있다는 것이 8채널 BLE 무손실 대역폭 보장을 뜻하지 않습니다.
250/1000 SPS 각각에 대해 Logic 8 DRDY 주기(4ms/1ms), SPI 프레임,
CSV `(N-1)/(마지막 t_us-첫 t_us)`를 함께 확인해야 합니다.

RTT 벤치 도구 기본 칩은 `NRF52832_XXAA`입니다. 이전 nRF54에는
`--device NRF54L15_M33`을 전달합니다. `validate_rtt_stream.py --rate 1000`으로
1000 SPS를 확인할 수 있지만 RTT 성공은 BLE 성공을 대신하지 않습니다.

공식 참고: [Zephyr nRF52 DK](https://docs.zephyrproject.org/latest/boards/nordic/nrf52dk/doc/index.html),
[TI ADS1299 datasheet](https://www.ti.com/lit/ds/symlink/ads1299.pdf).
