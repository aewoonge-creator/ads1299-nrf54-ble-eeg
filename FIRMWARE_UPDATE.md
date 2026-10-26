# nRF54L15 DK 펌웨어 업데이트

웹 GUI 업데이트와 보드 펌웨어 업데이트는 별개입니다. `AUTO SPI PROBE`,
`AUTO BITBANG PROBE`, `AUTO RESET_PROBE`가 반복되는 구형 보드는 USB 업데이트가 필요합니다.
이번에 데스크톱에 연결된 보드는 업데이트를 완료했습니다. 아래는 재설치 또는 다른 보드용 절차입니다.

## 대상과 파일

- 대상: nRF54L15 DK (PCA10156), `nrf54l15dk/nrf54l15/cpuapp` 전용.
- 버전: `2026-10-16-drdy-p111-v6`.
- [HEX 다운로드](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/firmware/ads1299-nrf54l15-2026-10-16-drdy-p111-v6.hex)
- [빌드 정보와 SHA256](docs/firmware/manifest.json)
- DRDY는 ADS1299EEG-FE J3-15에서 nRF P1.11로 연결합니다. START/STOP은 SPI 명령을 사용합니다.
  J3-12는 START가 아닙니다. 전체 배선은 [README](README.md)를 확인하세요.

## 업데이트 순서

1. 녹화를 종료하고 저장합니다. 전극을 사람에게서 분리하고, 노트북의 BLE 연결을 끊습니다.
2. 보드를 USB 디버그/프로그래밍 포트로 PC에 연결합니다. USB가 데스크톱에 연결됐다면 이 작업은 데스크톱에서 합니다.
3. nRF Connect for Desktop의 Programmer에서 해당 nRF54L15 DK를 선택하고, 위 HEX를 Add file로 추가해 보드에 씁니다. 기존 보드 프로그램이 교체됩니다. 다른 모델에는 쓰지 마세요.
4. 보드를 재시작한 뒤 노트북에서 [GUI v9](https://aewoonge-creator.github.io/ads1299-nrf54-ble-eeg/?v=2026-10-26-firmware-check-v9)를 새로 열고 BLE로 다시 연결합니다.
5. 보드 펌웨어가 `2026-10-16-drdy-p111-v6`로 표시되는지 확인하고, 측정 설정을 확인한 뒤 Start를 누릅니다. 자동 RESET 로그가 다시 나오면 다른 장치나 구형 펌웨어에 연결된 것입니다.

Programmer 사용법: [Nordic 공식 프로그래밍 절차](https://docs.nordicsemi.com/r/bundle/nrf-connect-for-desktop/page/app/pc-nrfconnect-programmer/programming_dk.html/general-programming-procedure).

## 로컬 빌드 및 검증

`tools/build_firmware.ps1`은 저장소의 소스를 임시 ASCII 경로로 복사해 NCS v2.9.3으로 빌드합니다.
빌드만 하며 자동 플래시하지 않습니다. 예전 별도 SDK 작업 폴더의 소스를 사용하지 않습니다.
`docs/firmware/manifest.json`에서 소스 해시와 결과 HEX 해시를 확인할 수 있습니다.

`tools/inspect_board.py`는 RTT로 보드 버전을 조회합니다.
`tools/validate_rtt_stream.py --check-readback`은 전극 분리 상태의 내부 TEST/SHORT 테스트용이며,
8채널 레지스터를 읽고 4초 대기 후 다시 비교합니다. 실제 BLE 전달을 검증하지는 않습니다.
