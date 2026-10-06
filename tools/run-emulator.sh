#!/bin/bash
#
# tools/run-emulator.sh — запуск WALLET в Android-эмуляторе.
#
#   ./tools/run-emulator.sh               # Android 14 (API 34, arm64 — быстрый)
#   ./tools/run-emulator.sh --api 28      # Android 9 (старый Android; на Apple
#                                          #   Silicon x86_64-образ идёт через
#                                          #   Rosetta — загрузка медленнее)
#   ./tools/run-emulator.sh --headless    # без окна (только adb)
#   ./tools/run-emulator.sh --wipe        # пересоздать AVD с нуля
#   ./tools/run-emulator.sh --stop        # остановить работающий эмулятор
#
# Сам ставит недостающие компоненты SDK, создаёт AVD (в tools/android-avd,
# не в ~/.android), ждёт загрузки, устанавливает dist/wallet.apk и открывает
# приложение.
#
# Окно эмулятора — только в обычном Терминале. Внутри tclaude экрана нет:
# используйте --headless (проверено: arm64-образ под песочницей грузится,
# ~20 сек, приложение ставится и запускается; управлять — через adb:
# tools/android-sdk/platform-tools/adb).
#
# ВАЖНО: эмулятор на macOS пишет рантайм-файлы в $HOME/Library/Caches/
# TemporaryItems — скрипт подменяет HOME на tools/android-home, чтобы всё
# лежало в проекте (в песочнице tclaude настоящий ~/Library недоступен).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/tools/android-sdk"
AVDHOME="$ROOT/tools/android-avd"

API=34
EXTRA=""
WIPE=0
STOP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --api) API="$2"; shift 2 ;;
        --headless) EXTRA="$EXTRA -no-window"; shift ;;
        --wipe) WIPE=1; shift ;;
        --stop) STOP=1; shift ;;
        *) echo "Неизвестный флаг: $1" >&2; exit 1 ;;
    esac
done

# Образ: для 34 есть нативный arm64 (быстро на Apple Silicon), для 28 —
# только x86_64 (через Rosetta, работает, но медленнее)
ARCH="$(uname -m)"
case "$API" in
    34) if [ "$ARCH" = arm64 ]; then TAG="google_apis;arm64-v8a"; else TAG="google_apis;x86_64"; fi ;;
    28) TAG="google_apis;x86_64" ;;
    *) echo "Поддерживаются --api 34|28 (получено $API)" >&2; exit 1 ;;
esac
IMG="system-images;android-$API;$TAG"
AVD="wallet-api$API"

export ANDROID_AVD_HOME="$AVDHOME"
mkdir -p "$AVDHOME"

# Рантайм-файлы эмулятора (avd/running, jwk-каталоги) на macOS пишутся в
# $HOME/Library/Caches/TemporaryItems — подменяем HOME, чтобы не трогать
# ~/Library (в песочнице tclaude он недоступен для записи)
export ANDROID_EMULATOR_HOME="$ROOT/tools/android-home"
export ANDROID_USER_HOME="$ROOT/tools/android-home"
export ANDROID_SDK_ROOT="$SDK"
export HOME="$ANDROID_EMULATOR_HOME"
mkdir -p "$HOME"

# --stop: погасить работающий эмулятор (emu kill требует токен консоли —
# он в подменённом HOME, поэтому adb должен запускаться с тем же HOME)
if [ "$STOP" -eq 1 ]; then
    ADB="$SDK/platform-tools/adb"
    EMU="$("$ADB" devices 2>/dev/null | awk '/emulator-.*device[ \t]*$/ {print $1; exit}')"
    if [ -z "$EMU" ]; then
        echo "Работающих эмуляторов нет"
        exit 0
    fi
    echo "==> Останавливаю ${EMU}…"
    "$ADB" -s "$EMU" emu kill || { echo "Консоль не приняла команду — закройте окно эмулятора вручную" >&2; exit 1; }
    echo "Остановлен."
    exit 0
fi

# 1. Компоненты SDK (идемпотентно — установленное пропускается)
"$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" \
    "platform-tools" "emulator" "$IMG" > /dev/null

# 2. AVD
if [ "$WIPE" -eq 1 ]; then rm -rf "$AVDHOME/$AVD.avd" "$AVDHOME/$AVD.ini"; fi
if [ ! -d "$AVDHOME/$AVD.avd" ]; then
    echo "==> Создаю AVD $AVD ($IMG)"
    echo no | "$SDK/cmdline-tools/latest/bin/avdmanager" create avd \
        -n "$AVD" -k "$IMG" -d pixel_5 --force
fi

# 3. APK должен быть собран
APK="$ROOT/dist/wallet.apk"
[ -f "$APK" ] || { echo "Нет $APK — сначала ./tools/build-apk.sh" >&2; exit 1; }

ADB="$SDK/platform-tools/adb"

# 4. Эмулятор: если уже работает — переиспользуем (второй экземпляр на том
#    же AVD падает с FATAL «multiple emulators»)
LAUNCHED=0
RUNNING="$("$ADB" devices 2>/dev/null | awk '/emulator-.*device[ \t]*$/ {print $1; exit}')"
if [ -n "$RUNNING" ]; then
    echo "==> Эмулятор уже работает ($RUNNING) — использую его"
else
    # ${AVD} в скобках: многоточие «…» вплотную к $AVD в не-UTF8 локали
    # съедает байты в имя переменной («AVD<байты>: unbound variable»)
    echo "==> Запускаю эмулятор ${AVD}…"
    "$SDK/emulator/emulator" -avd "$AVD" -no-metrics -gpu auto $EXTRA \
        > "$ANDROID_EMULATOR_HOME/emulator.log" 2>&1 &
    EMU_PID=$!

    # 5. Ждём полную загрузку Android (первый запуск x86_64-образа на Apple
    #    Silicon может занять несколько минут)
    "$ADB" wait-for-device
    echo "==> Ждём загрузку Android…"
    BOOT=""
    for i in $(seq 1 240); do
        BOOT=$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
        [ "$BOOT" = "1" ] && break
        sleep 2
    done
    [ "$BOOT" = "1" ] || {
        echo "Android не загрузился за 8 минут — лог: $ANDROID_EMULATOR_HOME/emulator.log (или --wipe)" >&2
        exit 1
    }
    LAUNCHED=1
fi

# 6. Установка и запуск приложения
echo "==> Устанавливаю APK…"
"$ADB" install -r "$APK" >/dev/null
"$ADB" shell am start -n ru.wallet.app/.MainActivity >/dev/null
echo
if [ "$LAUNCHED" = "1" ]; then
    echo "Готово: WALLET запущен. Закрыть эмулятор — закрыть его окно, Ctrl+C"
    echo "или: ./tools/run-emulator.sh --stop"
    wait $EMU_PID
else
    echo "Готово: WALLET запущен на работающем эмуляторе $RUNNING."
    echo "Остановить: ./tools/run-emulator.sh --stop"
fi
