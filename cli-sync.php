<?php
/**
 * cli-sync.php — синхронизация брокеров из командной строки, без веб-сервера.
 *
 * Запуск:
 *   php cli-sync.php           — реальная синхронизация (T-Invest + Finam → portfolio.json)
 *   php cli-sync.php --mock    — демо-данные без сети (существующий portfolio.json не трогает)
 *   php cli-sync.php --help    — справка
 *
 * Это тонкая обёртка над sync.php: тот же пайплайн и NDJSON-стрим, общий
 * sync.lock (с кнопкой «Синхронизация» на дашборде не конфликтуют), та же
 * атомарная запись portfolio.json. Авторизация пропускается: CLI-запуск —
 * локальный доверенный контекст (доступ к shell уже означает доступ к settings.json).
 *
 * Пример для кронтаба (09:30 и 23:30 каждый день):
 *   30 9,23 * * * /Users/a.shkondin/Documents/Projects/WALLET/sync-cron.sh >/dev/null 2>&1
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("cli-sync.php: только из командной строки (php cli-sync.php)\n");
}

if (in_array('--help', $argv ?? [], true) || in_array('-h', $argv ?? [], true)) {
    echo "Использование:\n  php cli-sync.php [--mock]\n\n  --mock  детерминированные демо-данные без обращения к брокерам\n";
    exit(0);
}

// Проекту нужен PHP 7.4+ (типизированные свойства, стрелочные функции)
// и расширение curl — проверяем до require, чтобы вместо parse error было понятно
if (PHP_VERSION_ID < 70400) {
    fwrite(STDERR, "cli-sync.php: нужен PHP 7.4+ с расширением curl, запущен PHP " . PHP_VERSION . "\n"
        . "Проверьте доступные версии:  ls /usr/bin/php*\n");
    exit(1);
}
if (!extension_loaded('curl')) {
    fwrite(STDERR, "cli-sync.php: не хватает расширения curl (пакет php8.2-curl или php-curl)\n");
    exit(1);
}

require __DIR__ . '/sync.php';
