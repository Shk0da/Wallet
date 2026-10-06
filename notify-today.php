<?php
/**
 * notify-today.php — утренний пуш о сегодняшних платежах календаря (ntfy).
 *
 * Запуск:
 *   php notify-today.php                   — платежи на сегодня → пуш в ntfy
 *   php notify-today.php --print           — только показать сообщение, не отправлять
 *   php notify-today.php --date=2026-10-07 — считать «сегодня» другой датой (проверка)
 *   php notify-today.php --demo            — демо-данные вместо data.json (числа фейковые)
 *   php notify-today.php --help            — справка
 *
 * Настройки — settings.json → notify:
 *   "notify": {
 *     "ntfyUrl": "https://ntfy.sh",      // или свой self-hosted сервер
 *     "topic":   "wallet-a1b2c3d4e5",    // топик, на который подписан телефон в приложении ntfy
 *     "priority": 3,                     // 1..5, опционально
 *     "caFile":  "/path/to/ca-bundle.crt" // опционально: CA-бандл для сетей с TLS-инспектором
 *   }
 *
 * Логика «что происходит в этот день» — порт app.js (getDayTransactions +
 * isTransactionActiveOnDate): occurrences за дату плюс периодические операции,
 * активные в этот день и не представленные в occurrences. Даты за пределами
 * последнего occurrence генерируются по периоду с «прищемлением» 31-го числа
 * к последнему дню месяца — так же, как их показывает календарь.
 *
 * Как и cli-sync.php, запускается только из CLI (локальный доверенный контекст)
 * и работает без авторизации; в сеть уходит только текст уведомления.
 *
 * Пример для кронтаба (08:00 каждый день, на машине с data.json):
 *   0 8 * * * /usr/bin/php /var/www/wallet/notify-today.php >> /var/www/wallet/notify.log 2>&1
 */

declare(strict_types=1);
date_default_timezone_set('Europe/Moscow');

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("notify-today.php: только из командной строки (php notify-today.php)\n");
}

const SETTINGS_FILE = __DIR__ . '/settings.json';
const DATA_FILE     = __DIR__ . '/data.json';

const MONTHS_GENITIVE = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Демо-данные для --demo: покрывают все периоды и «прищемление» 31-го числа
const DEMO_DATA = [
    'transactions' => [
        ['id' => 'demo1', 'type' => 'income',  'amount' => 85000, 'name' => 'Зарплата',        'date' => '2026-01-05', 'period' => 'monthly'],
        ['id' => 'demo2', 'type' => 'income',  'amount' => 35000, 'name' => 'Аванс',           'date' => '2026-01-20', 'period' => 'monthly'],
        ['id' => 'demo3', 'type' => 'expense', 'amount' => 42000, 'name' => 'Ипотека',         'date' => '2026-01-31', 'period' => 'monthly'],
        ['id' => 'demo4', 'type' => 'expense', 'amount' => 1200,  'name' => 'Связь',           'date' => '2026-03-02', 'period' => 'monthly'],
        ['id' => 'demo5', 'type' => 'expense', 'amount' => 600,   'name' => 'Подписка кино',   'date' => '2026-01-06', 'period' => 'weekly'],
        ['id' => 'demo6', 'type' => 'expense', 'amount' => 15000, 'name' => 'Страховка ОСАГО', 'date' => '2026-10-14', 'period' => 'once'],
    ],
    'occurrences' => [],
];

function printHelp(): void {
    echo "Использование:\n"
        . "  php notify-today.php [--print] [--date=ГГГГ-ММ-ДД] [--demo]\n\n"
        . "  --print            показать сообщение, не отправляя в ntfy\n"
        . "  --date=ГГГГ-ММ-ДД  «сегодня» = указанная дата\n"
        . "  --demo             демо-данные вместо data.json\n\n"
        . "Настройки: settings.json → notify { ntfyUrl, topic, priority } — см. README.\n";
}

function fail(string $message): void {
    fwrite(STDERR, "notify-today.php: $message\n");
    exit(1);
}

// ---------- Разбор аргументов ----------

$options = ['print' => false, 'date' => null, 'demo' => false];
foreach (array_slice($GLOBALS['argv'] ?? [], 1) as $arg) {
    if ($arg === '--help' || $arg === '-h') {
        printHelp();
        exit(0);
    } elseif ($arg === '--print' || $arg === '--dry-run') {
        $options['print'] = true;
    } elseif ($arg === '--demo') {
        $options['demo'] = true;
    } elseif (strpos($arg, '--date=') === 0) {
        $options['date'] = substr($arg, 7);
    } else {
        fail("неизвестный аргумент: $arg (см. --help)");
    }
}

// Проекту нужен PHP 7.4+ и curl — как в cli-sync.php
if (PHP_VERSION_ID < 70400) {
    fwrite(STDERR, "notify-today.php: нужен PHP 7.4+ с расширением curl, запущен PHP " . PHP_VERSION . "\n"
        . "Проверьте доступные версии:  ls /usr/bin/php*\n");
    exit(1);
}
if (!extension_loaded('curl')) {
    fail('не хватает расширения curl (пакет php8.2-curl или php-curl)');
}

// ---------- Данные ----------

function loadJson(string $file): array {
    if (!is_file($file)) fail("не найден $file");
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) fail("$file повреждён (неверный JSON)");
    return $data;
}

if ($options['demo']) {
    $data = DEMO_DATA;
} else {
    $data = loadJson(DATA_FILE);
}
$transactions = is_array($data['transactions'] ?? null) ? $data['transactions'] : [];
$occurrences  = is_array($data['occurrences']  ?? null) ? $data['occurrences']  : [];

$dateStr = $options['date'] ?? date('Y-m-d');
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateStr)
    || !checkdate((int)substr($dateStr, 5, 2), (int)substr($dateStr, 8, 2), (int)substr($dateStr, 0, 4))) {
    fail("некорректная дата: $dateStr (формат ГГГГ-ММ-ДД)");
}

// ---------- Что происходит в этот день (порт app.js) ----------

function ymdParts(string $ymd): array {
    return array_map('intval', explode('-', $ymd));
}

function daysInMonth(int $year, int $month): int {
    return (int)date('t', mktime(0, 0, 0, $month, 1, $year));
}

// Активна ли серия в дату $dateStr.
// $clamp = false — «жёсткое» совпадение дня, как isTransactionActiveOnDate (прошлые даты);
// $clamp = true  — 31-е число прищемляется к последнему дню месяца, как getNextOccurrenceDate
// (генерация будущих вхождений: старт 31 января → 28 февраля → 31 марта → 30 апреля…).
function txFiresOn(array $t, string $dateStr, bool $clamp): bool {
    $start = (string)($t['date'] ?? '');
    if ($start === '' || $start > $dateStr) return false;
    if (!empty($t['endDate']) && (string)$t['endDate'] < $dateStr) return false;

    $period = $t['period'] ?? 'once';
    if ($period === 'once')  return $start === $dateStr;
    if ($period === 'daily') return true;

    [$y, $m, $d]    = ymdParts($dateStr);
    [, $sm, $sd]    = ymdParts($start);

    if ($period === 'weekly' || $period === 'biweekly') {
        $step = $period === 'biweekly' ? 14 : 7;
        try {
            $days = (new DateTime($start))->diff(new DateTime($dateStr))->days;
        } catch (Exception $e) {
            return false; // кривая дата в данных — серия просто не срабатывает
        }
        return $days % $step === 0;
    }

    if ($period === 'monthly') {
        return $clamp ? $d === min($sd, daysInMonth($y, $m)) : $d === $sd;
    }
    if ($period === 'yearly') {
        if ($m !== $sm) return false;
        return $clamp ? $d === min($sd, daysInMonth($y, $m)) : $d === $sd;
    }

    return false;
}

function dayItems(array $transactions, array $occurrences, string $dateStr): array {
    $items = [];
    $byId = [];
    foreach ($transactions as $t) {
        if (!empty($t['id'])) $byId[$t['id']] = $t;
    }

    // Знаковый размер операции: доход +, расход −
    $signed = function (array $t): float {
        $a = (float)($t['amount'] ?? 0);
        return ($t['type'] ?? 'expense') === 'income' ? $a : -$a;
    };
    $push = function (array $t, float $amount) use (&$items, $byId): void {
        $src = !empty($t['transactionId']) ? ($byId[$t['transactionId']] ?? []) : $t;
        $items[] = ['name' => $src['name'] ?? 'Операция', 'amount' => $amount];
    };

    if ($occurrences !== []) {
        $lastOcc = max(array_column($occurrences, 'date'));

        if ($dateStr <= $lastOcc) {
            // Фактические вхождения за дату + новые серии, не попавшие в occurrences
            foreach ($occurrences as $occ) {
                if (($occ['date'] ?? '') === $dateStr) $push($occ, (float)($occ['amount'] ?? 0));
            }
            foreach ($transactions as $t) {
                if (($t['period'] ?? 'once') === 'once' || !txFiresOn($t, $dateStr, false)) continue;
                $dup = false;
                foreach ($occurrences as $occ) {
                    if (($occ['transactionId'] ?? null) === ($t['id'] ?? null) && ($occ['date'] ?? '') === $dateStr) {
                        $dup = true;
                        break;
                    }
                }
                if (!$dup) $push($t, $signed($t));
            }
        } else {
            // Будущая дата: генерация по периоду (+ однократные попаданием в дату)
            foreach ($transactions as $t) {
                if (($t['period'] ?? 'once') !== 'once') {
                    if (txFiresOn($t, $dateStr, true)) $push($t, $signed($t));
                } elseif ($t['date'] === $dateStr) {
                    $push($t, $signed($t));
                }
            }
        }
    } else {
        // Совсем без occurrences — всё решает период
        foreach ($transactions as $t) {
            if (txFiresOn($t, $dateStr, false)) $push($t, $signed($t));
        }
    }

    usort($items, function (array $a, array $b): int {
        return $b['amount'] <=> $a['amount'];
    });
    return $items;
}

// ---------- Сообщение ----------

function fmtAmount(float $value): string {
    return ($value >= 0 ? '+' : '−') . number_format(abs($value), 0, ',', ' ') . ' ₽';
}

$items = dayItems($transactions, $occurrences, $dateStr);

[, $month, $day] = ymdParts($dateStr);
$dateHuman = $day . ' ' . MONTHS_GENITIVE[$month - 1];

if ($items === []) {
    echo "Платежей на $dateHuman нет — пуш не отправляем.\n";
    exit(0);
}

$title = $dateStr === date('Y-m-d') ? "Сегодня, $dateHuman" : "Платежи на $dateHuman";
$title = '📅 ' . $title;

$lines = [];
foreach ($items as $item) {
    $lines[] = ($item['amount'] >= 0 ? '🟢 ' : '🔴 ') . $item['name'] . ': ' . fmtAmount($item['amount']);
}
$total = array_sum(array_column($items, 'amount'));
$message = implode("\n", $lines) . "\n\nИтог дня: " . fmtAmount($total);

if ($options['print']) {
    echo $title, "\n\n", $message, "\n";
    exit(0);
}

// ---------- Отправка в ntfy ----------

$settings = loadJson(SETTINGS_FILE);
$notify = is_array($settings['notify'] ?? null) ? $settings['notify'] : [];

$topic    = trim((string)($notify['topic'] ?? ''));
$ntfyUrl  = rtrim(trim((string)($notify['ntfyUrl'] ?? 'https://ntfy.sh')), '/');
$priority = (int)($notify['priority'] ?? 3);
$caFile   = trim((string)($notify['caFile'] ?? ''));

if ($topic === '') {
    $suggest = 'wallet-' . bin2hex(random_bytes(5));
    fail("не задан settings.json → notify.topic. Добавьте секцию notify и подпишитесь на топик в приложении ntfy:\n"
        . "  \"notify\": { \"ntfyUrl\": \"$ntfyUrl\", \"topic\": \"$suggest\" }");
}
if ($priority < 1 || $priority > 5) {
    fail('notify.priority должен быть целым 1..5, задано: ' . json_encode($notify['priority'] ?? null));
}

$payload = json_encode([
    'topic'    => $topic,
    'title'    => $title,
    'message'  => $message,
    'priority' => $priority,
], JSON_UNESCAPED_UNICODE);

$ch = curl_init($ntfyUrl);
$curlOptions = [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT        => 20,
];
if ($caFile !== '') {
    if (!is_file($caFile)) fail("notify.caFile не найден: $caFile");
    $curlOptions[CURLOPT_CAINFO] = $caFile;
}
curl_setopt_array($ch, $curlOptions);
$response = curl_exec($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

if ($response === false) {
    fail("ntfy недоступен ($ntfyUrl): $curlErr");
}
if ($httpCode !== 200) {
    fail("ntfy ответил HTTP $httpCode: " . substr(trim((string)$response), 0, 300));
}

echo "Отправлено в $topic: " . count($items) . ' опер. на ' . $dateHuman . ', итог ' . fmtAmount($total) . "\n";
