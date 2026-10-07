#!/bin/bash
#
# tools/build-www.sh — сборка офлайн-бандла фронтенда в android/assets/www/.
#
#   ./tools/build-www.sh
#
# Что делает:
#   * копирует index.html и JS (auth.js остаётся: в APK он проверяет
#     локальный пароль на вход, без серверного login.php);
#   * standalone.js и sync-client.js встают первыми скриптами;
#   * шрифты лежат в репозитории (fonts/, fonts.css + woff2) и копируются в
#     www/fonts/ — внешних запросов из APK нет. Если каталога нет — бутстрап
#     с CDN Т-Банка с сохранением в fonts/ (дальше сборка офлайн); не вышло —
#     вырезает <link> (в font-family уже есть системный фолбэк);
#   * убирает ?v=-суффиксы у статики;
#   * контроль: в www не остаётся ни одного http(s):// URL (кроме SVG-namespace).
#
# Выход: android/assets/www/ — используется tools/build-apk.sh (-A android/assets).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/android/assets/www"
FONTS_URL="https://cdn.tbank.ru/core/design-tokens/v1/web/fonts/2.0.0/fonts.css"

# ---------- curl: обычный → корпоративный CA → -k (последнее средство) ----------
fetch() { # fetch <url> <выходной файл>
    local url="$1" out="$2"
    if curl -fsSL --max-time 30 -o "$out" "$url" 2>/dev/null; then return 0; fi
    if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && \
       curl -fsSL --max-time 30 --cacert "$NODE_EXTRA_CA_CERTS" -o "$out" "$url" 2>/dev/null; then return 0; fi
    echo "  (TLS-инспектор: качаю без проверки цепочки)" >&2
    curl -fsSL --max-time 30 -k -o "$out" "$url"
}

rm -rf "$OUT"
mkdir -p "$OUT/fonts"

# ---------- Шрифты ----------
FONTS_OK=1
if [ -f "$ROOT/fonts/fonts.css" ] && grep -q '@font-face' "$ROOT/fonts/fonts.css" && \
   ls "$ROOT/fonts/"*.woff2 >/dev/null 2>&1; then
    cp "$ROOT/fonts/"* "$OUT/fonts/"
    echo "  шрифты — из репозитория (fonts/)"
elif fetch "$FONTS_URL" "$OUT/fonts/fonts.css" 2>/dev/null && \
   grep -q '@font-face' "$OUT/fonts/fonts.css"; then
    BASE_URL="${FONTS_URL%/*}"
    while IFS= read -r font; do
        [ -n "$font" ] || continue
        if fetch "$BASE_URL/$font" "$OUT/fonts/$font" && \
           [ "$(head -c 4 "$OUT/fonts/$font")" = "wOF2" ]; then
            echo "  шрифт $font — ок"
        else
            echo "ПРЕДУПРЕЖДЕНИЕ: $font не скачался — шрифты отключаю (системный фолбэк)" >&2
            FONTS_OK=0
            break
        fi
    done < <(grep -o "url('[^']*')" "$OUT/fonts/fonts.css" | sed "s/^url('//; s/')$//" | sort -u)
    if [ "$FONTS_OK" -eq 1 ]; then
        # бутстрап: сохраняем в репозиторий, чтобы следующие сборки шли офлайн
        mkdir -p "$ROOT/fonts" && cp "$OUT/fonts/"* "$ROOT/fonts/"
        echo "  шрифты сохранены в fonts/ — дальше без сети"
    fi
else
    echo "ПРЕДУПРЕЖДЕНИЕ: fonts.css недоступен — шрифты отключаю (системный фолбэк)" >&2
    FONTS_OK=0
fi
if [ "$FONTS_OK" -ne 1 ]; then rm -rf "$OUT/fonts"; fi

# ---------- index.html ----------
# auth.js остаётся: в APK он же закрывает вход локальным паролем (login.php
# там нет — ветка window.WALLET_STANDALONE проверяет пароль на месте)
sed -e 's/?v=[0-9][0-9]*//g' \
    "$ROOT/index.html" > "$OUT/index.html"

# standalone.js — ПЕРВЫМ скриптом, до auth.js: init() в auth.js синхронно
# читает window.WALLET_STANDALONE и решает, запирать ли вход; если флаг ещё
# не установлен, уходит в веб-ветку — и лок на холодном старте не показывается.
# sync-client.js — перед app.js, как и раньше.
sed -i '' 's|<script src="auth.js"></script>|<script src="standalone.js"></script>\n    <script src="auth.js"></script>|' "$OUT/index.html"
sed -i '' 's|<script src="app.js"></script>|<script src="sync-client.js"></script>\n    <script src="app.js"></script>|' "$OUT/index.html"

# index.html ссылается на fonts/fonts.css локально; не собрались шрифты —
# вырезаем линк целиком (системный фолбэк из font-family)
if [ "$FONTS_OK" -ne 1 ]; then
    sed -i '' '/fonts\/fonts\.css/d' "$OUT/index.html"
fi

grep -q 'standalone.js' "$OUT/index.html" || { echo "ОШИБКА: standalone.js не вставлен" >&2; exit 1; }
grep -q 'auth\.js' "$OUT/index.html" || { echo "ОШИБКА: auth.js не подключён (локальный пароль)" >&2; exit 1; }
# standalone.js обязан идти РАНЬШЕ auth.js (см. выше) — иначе пароль на вход
# в APK молча перестаёт спрашиваться
awk '/src="standalone\.js"/{s=NR} /src="auth\.js"/{a=NR} END{exit !(s>0 && a>s)}' "$OUT/index.html" \
    || { echo "ОШИБКА: standalone.js должен подключаться раньше auth.js" >&2; exit 1; }

# ---------- JS ----------
for f in standalone.js sync-client.js auth.js app.js backup.js settings.js charts.js forecast.js dashboard.js; do
    [ -f "$ROOT/$f" ] || { echo "ОШИБКА: нет $f" >&2; exit 1; }
    cp "$ROOT/$f" "$OUT/"
done

# ---------- Контроль автономности: внешних URL быть не должно ----------
# Разрешены только рантайм-эндпоинты брокеров (это сама синхронизация, а не
# подгрузка ресурсов) и SVG-namespace.
API_HOSTS='invest-public-api\.tbank\.ru|api\.finam\.ru'
LEAKS=$(grep -R -o 'https\?://[^"'"'"' <>)]*' "$OUT" | grep -v 'www.w3.org' | grep -Ev "$API_HOSTS" || true)
if [ -n "$LEAKS" ]; then
    echo "ОШИБКА: внешние URL в бандле:" >&2
    echo "$LEAKS" >&2
    exit 1
fi

echo "OK: $OUT ($(find "$OUT" -type f | wc -l | tr -d ' ') файлов, внешних URL нет)"
