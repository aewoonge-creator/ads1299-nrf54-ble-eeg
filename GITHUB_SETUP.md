# GitHub Setup

## Option A: GitHub Desktop

1. GitHub에서 새 repository를 만듭니다.
2. Repository 이름 예시: `ads1299-nrf54-ble-eeg`
3. 이 폴더를 GitHub Desktop에서 local repository로 추가합니다.
4. Commit 후 Publish/Push 합니다.

## Option B: Git CLI

```powershell
cd "C:\Users\GC\OneDrive - 가천대학교\문서\애웅이\work\ads1299_nrf54_ble"
git init
git add .
git commit -m "Initial ADS1299 nRF54 BLE EEG project"
git branch -M main
git remote add origin https://github.com/YOUR_ID/ads1299-nrf54-ble-eeg.git
git push -u origin main
```

`YOUR_ID`와 repository 이름은 본인 GitHub에 맞게 바꿔야 합니다.

## Build Firmware

nRF Connect SDK 환경에서:

```powershell
cd "C:\Users\GC\OneDrive - 가천대학교\문서\애웅이\work\ads1299_nrf54_ble\firmware\nrf54_ads1299_ble"
west build -b nrf54l15dk/nrf54l15/cpuapp
west flash
```

보드 이름은 설치된 nRF Connect SDK 버전과 실제 보드에 따라 달라질 수 있습니다.

## Run PC GUI

```powershell
cd "C:\Users\GC\OneDrive - 가천대학교\문서\애웅이\work\ads1299_nrf54_ble\pc_gui"
python -m pip install -r requirements.txt
python .\ads1299_ble_gui.py
```

