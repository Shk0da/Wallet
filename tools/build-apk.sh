#!/bin/bash
#
# tools/build-apk.sh — сборка автономного APK без Gradle.
#
#   ./tools/build-apk.sh
#
# Пайплайн: aapt2 compile/link → javac → d8 → zip → zipalign → apksigner.
# SDK скачивается при первом запуске в tools/android-sdk/ (dl.google.com).
# Кейстор генерится keytool'ом при первом запуске (tools/keystore.properties).
#
# Выход: dist/wallet.apk (+ verify и badging).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="$ROOT/tools/android-sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM_JAR="$SDK/platforms/android-34/android.jar"
RES="$ROOT/android/app/src/main/res"
JAVA_SRC="$ROOT/android/app/src/main/java"
MANIFEST="$ROOT/android/app/src/main/AndroidManifest.xml"
ASSETS="$ROOT/android/assets"
DIST="$ROOT/dist"

AAPT2="$BT/aapt2"
D8="$BT/d8"
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"

# ---------- 1. SDK (однократно) ----------
if [ ! -f "$PLATFORM_JAR" ] || [ ! -f "$AAPT2" ]; then
    echo "==> Качаю Android SDK (build-tools 34.0.0 + platform 34)..."
    CT="$SDK/cmdline-tools/latest"
    if [ ! -x "$CT/bin/sdkmanager" ]; then
        mkdir -p "$SDK/cmdline-tools"
        ZIP="$SDK/cmdline-tools.zip"
        curl -fSL --retry 3 -o "$ZIP" \
            "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
        rm -rf "$SDK/cmdline-tools/latest" "$SDK/cmdline-tools/cmdline-tools"
        unzip -q "$ZIP" -d "$SDK/cmdline-tools"
        mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
        rm -f "$ZIP"
    fi
    (yes || true) | "$CT/bin/sdkmanager" --sdk_root="$SDK" --licenses > /dev/null
    "$CT/bin/sdkmanager" --sdk_root="$SDK" "build-tools;34.0.0" "platforms;android-34" > /dev/null
fi

# ---------- 2. Иконки (однократно) ----------
if ! ls "$RES"/mipmap-xxxhdpi/ic_launcher.png > /dev/null 2>&1; then
    php "$ROOT/tools/gen-icons.php"
fi

# ---------- 3. Офлайн-бандл фронтенда ----------
"$ROOT/tools/build-www.sh"

# ---------- 4. Кейстор (однократно) ----------
KS_FILE="$ROOT/tools/wallet.keystore"
KS_PROPS="$ROOT/tools/keystore.properties"
if [ ! -f "$KS_FILE" ]; then
    echo "==> Генерирую подпись (tools/wallet.keystore)..."
    KS_PASS="$(openssl rand -hex 16)"
    keytool -genkeypair -keystore "$KS_FILE" -alias wallet -keyalg RSA -keysize 2048 \
        -validity 10950 -storepass "$KS_PASS" -keypass "$KS_PASS" \
        -dname "CN=WALLET, O=WALLET" >/dev/null 2>&1
    printf 'store.file=%s\nstore.pass=%s\nalias=wallet\n' "$KS_FILE" "$KS_PASS" > "$KS_PROPS"
fi
KS_PASS="$(sed -n 's/^store.pass=//p' "$KS_PROPS")"
KS_ALIAS="$(sed -n 's/^alias=//p' "$KS_PROPS")"

# ---------- 5. Компиляция ----------
WORK="$ROOT/android/build"
rm -rf "$WORK"
mkdir -p "$WORK/gen" "$WORK/classes" "$WORK/dex"

echo "==> aapt2 compile + link"
"$AAPT2" compile --dir "$RES" -o "$WORK/res.zip"
"$AAPT2" link -o "$WORK/base.apk" -I "$PLATFORM_JAR" \
    --manifest "$MANIFEST" --java "$WORK/gen" -A "$ASSETS" \
    --min-sdk-version 24 --target-sdk-version 34 \
    --version-code 1 --version-name 1.0 \
    --auto-add-overlay "$WORK/res.zip"

echo "==> javac"
find "$JAVA_SRC" "$WORK/gen" -name '*.java' | sort > "$WORK/sources.txt"
javac -source 1.8 -target 1.8 -encoding UTF-8 -Xlint:-options \
    -classpath "$PLATFORM_JAR" -d "$WORK/classes" @"$WORK/sources.txt"

echo "==> d8"
find "$WORK/classes" -name '*.class' | sort > "$WORK/classes.txt"
"$D8" --lib "$PLATFORM_JAR" --min-api 24 --output "$WORK/dex" @"$WORK/classes.txt"

# ---------- 6. Сборка и подпись ----------
echo "==> apk + zipalign + apksigner"
cp "$WORK/base.apk" "$WORK/unsigned.apk"
(cd "$WORK/dex" && zip -q "$WORK/unsigned.apk" classes.dex)

mkdir -p "$DIST"
"$ZIPALIGN" -f 4 "$WORK/unsigned.apk" "$WORK/aligned.apk"
"$APKSIGNER" sign --ks "$KS_FILE" --ks-pass "pass:$KS_PASS" \
    --ks-key-alias "$KS_ALIAS" --key-pass "pass:$KS_PASS" \
    --out "$DIST/wallet.apk" "$WORK/aligned.apk"

# ---------- 7. Проверка ----------
"$APKSIGNER" verify --print-certs "$DIST/wallet.apk" | head -4
echo "---"
"$AAPT2" dump badging "$DIST/wallet.apk" | grep -E '^(package|sdkVersion|targetSdkVersion|application-label|uses-permission|launchable)' || true
echo "---"
ls -lh "$DIST/wallet.apk" | awk '{print "OK: dist/wallet.apk", $5}'
