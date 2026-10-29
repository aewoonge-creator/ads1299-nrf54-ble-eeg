# 다른 Windows 노트북에서 v6 프로젝트 사용하기

현재 펌웨어는 `2026-10-16-drdy-p111-v6`입니다. 웹 GUI v9와 펌웨어 v6는 별도 버전입니다.
소스의 기준은 이 GitHub 저장소이며, 예전 `C:\ncs\ads1299_nrf54_ble` 복사본은 사용하지 않습니다.

## 1. Git으로 프로젝트 받기 (권장)

Git for Windows를 설치한 뒤 PowerShell에서 실행합니다. 아래 목적지 폴더가 이미 있다면
덮어쓰지 말고 다른 빈 경로를 선택하세요.

```powershell
git clone https://github.com/aewoonge-creator/ads1299-nrf54-ble-eeg.git C:\work\ads1299-nrf54-ble-eeg
Set-Location C:\work\ads1299-nrf54-ble-eeg
git rev-parse HEAD
```

이후 업데이트는 해당 저장소에서 `git status`로 로컬 수정 여부를 먼저 확인하고
`git pull --ff-only`로 받습니다. 충돌이 나면 수정 파일을 지우거나 강제 reset하지 마세요.
특정 실험의 재현에는 당시 `git rev-parse HEAD` 결과를 CSV와 함께 기록합니다.

## 2. 노트북에 빌드 환경 설치

- VS Code와 Nordic nRF Connect 확장, Git을 설치합니다.
- nRF Connect SDK **v2.9.3** 및 해당 SDK의 toolchain을 설치합니다.
- SDK나 toolchain은 이 소스 저장소에 포함되지 않습니다. 프로젝트만 복사해도 설치가 필요합니다.
- 디버거 드라이버/SEGGER J-Link 및 nRF Connect for Desktop Programmer도 준비합니다.
- 이 문서의 대상은 **nRF54L15 DK / PCA10156**입니다.

## 3. 저장소 소스로 빌드

저장소 루트에서 실행합니다. 아래 두 경로는 노트북에 실제 설치된 위치로 바꿉니다.
toolchain 폴더에는 `environment.json`이 있어야 합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\build_firmware.ps1 -Sdk C:\ncs\v2.9.3 -Toolchain C:\ncs\toolchains\b620d30767 -OutputDirectory C:\work\ads1299-v6-output
```

이 스크립트는 **이 저장소의** `firmware/nrf54_ads1299_ble`를 임시 빌드 위치로 복사합니다.
보드 대상은 `nrf54l15dk/nrf54l15/cpuapp`, `--no-sysbuild`이며 자동 플래시하지 않습니다.
SDK 설치 위치를 소스 저장소로 착각하지 마세요. 실패 시 완료 메시지 없이 나온 HEX를 쓰지 않습니다.

출력:

- `ads1299-nrf54l15-2026-10-16-drdy-p111-v6.hex`
- `manifest.json`: 버전, 대상 보드, 소스 SHA256, HEX SHA256

VS Code의 nRF Connect에서 프로젝트를 추가할 때는 **클론한 저장소 안의**
`firmware/nrf54_ads1299_ble`를 Open an existing application으로 선택합니다.
SDK/toolchain v2.9.3, 위 보드 대상 및 sysbuild 비활성화를 확인합니다.
다른 PC의 `build` 폴더는 재사용하지 말고 새 build configuration을 만듭니다.
확장 버전에 따라 UI가 다르면 위 PowerShell 빌드를 기준으로 사용하세요.

## 4. 플래시 및 버전 확인

전극을 사람에게서 분리하고 녹화/BLE 연결을 종료한 뒤, DK의 디버거 USB를 노트북에 연결합니다.
Programmer에서 대상 DK를 확인하고 위에서 만든 HEX를 선택해 기록합니다.
이미 v6가 설치돼 있다면 노트북이 바뀌었다는 이유만으로 재플래시할 필요는 없습니다.

빌드 없이 재설치만 하려면 저장소의 `docs/firmware/`에 있는 HEX와 manifest를 사용해도 됩니다.
플래시 전 HEX 해시는 다음처럼 확인하고 해당 manifest의 `sha256`과 대조합니다.

```powershell
Get-FileHash .\docs\firmware\ads1299-nrf54l15-2026-10-16-drdy-p111-v6.hex -Algorithm SHA256
```

GUI에서 BLE 재연결 후 보드 버전 `2026-10-16-drdy-p111-v6`를 확인합니다.
`AUTO RESET_PROBE` 같은 구형 자동 진단 로그가 없어야 합니다.
벤치 Internal TEST/readback 확인과 인체 EEG 품질 확인은 별개입니다.
세부 업데이트 절차는 [FIRMWARE_UPDATE.md](FIRMWARE_UPDATE.md)를 참고하세요.

## 5. USB로 옮겨도 되나요?

가능합니다. GitHub의 Code → Download ZIP 또는 저장소의 **소스 ZIP**을 USB에 담아
노트북 로컬 디스크의 짧은 영문 경로에 압축 해제하세요. 그다음 2~4단계를 따릅니다.
소스 ZIP에는 Git 이력이 없어 `git pull`은 사용할 수 없습니다. 업데이트를 계속 받을 계획이면 clone이 낫습니다.
다른 PC의 `build`, SDK, toolchain 폴더를 통째로 복사해서 재사용하는 방식은 피하세요.

## 배선 및 반드시 포함되는 파일

| nRF54L15 | ADS1299EEG-FE | 기능 |
|---|---|---|
| P0.00 | J3-3 | SCLK |
| P0.01 | J3-11 | MOSI |
| P0.02 | J3-13 | MISO |
| P0.03 | J3-7 | CS |
| P0.04 | J3-8 | RESET |
| **P1.11** | **J3-15** | DRDY |

P0.05/P0.06은 사용하지 않습니다. J3-12는 START가 아니며 연결하지 않습니다.
START/STOP은 SPI 명령입니다. 전원과 아날로그 전극 배선은 [README](README.md)를 별도로 확인하세요.

`firmware/nrf54_ads1299_ble` 아래의 `src/main.c`, `src/ads1299.c`, `src/ads1299.h`,
`boards/nrf54l15dk_nrf54l15_cpuapp.overlay`, `prj.conf`, `CMakeLists.txt`, `dts/bindings/`가
모두 필요합니다. `main.c`만 복사하는 것은 프로젝트 이동이 아닙니다.
