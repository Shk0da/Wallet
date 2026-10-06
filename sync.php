<?php
/**
 * sync.php — Синхронизация данных с брокерских счетов (T-Invest + Finam)
 *
 * Порт логики portfolio-scanner.kts на PHP 7.4+ (curl + json_decode).
 * Запускается кнопкой «Синхронизация» на дашборде.
 *
 * Протокол: NDJSON-стрим (одно JSON-событие на строку):
 *   {"event":"start","brokers":{"tinkoff":true,"finam":false}}
 *   {"event":"log","broker":"tcs|finam|system","message":"...","progress":0.42}
 *   {"event":"broker_status","broker":"tinkoff|finam","status":"running|ok|error|skipped","error":null}
 *   {"event":"done","saved":true,"totalMs":1234,"portfolio":{...итоги}}
 *   {"event":"busy"}      — синхронизация уже идёт
 *   {"event":"error","message":"..."}
 *
 * Результат пишет в portfolio.json (единый источник правды для дашборда).
 * Токены читаются из settings.json и НИКОГДА не попадают в ответ или portfolio.json.
 *
 * Mock-режим: POST {"mock":true} или ?mock=1 — без сети, детерминированные данные.
 */

declare(strict_types=1);
date_default_timezone_set('Europe/Moscow');
set_time_limit(300);
ignore_user_abort(false);

const SETTINGS_FILE   = __DIR__ . '/settings.json';
const PORTFOLIO_FILE  = __DIR__ . '/portfolio.json';
const BONDS_CACHE     = __DIR__ . '/bonds-cache.json';
const LOCK_FILE       = __DIR__ . '/sync.lock';

const TCS_BASE   = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.';
const FINAM_BASE = 'https://api.finam.ru';

// ---------- Заголовки стрима ----------
header('Content-Type: application/x-ndjson; charset=utf-8');
header('Cache-Control: no-cache, no-store');
header('X-Accel-Buffering: no'); // Herd/nginx: отключить буферизацию fastcgi
while (ob_get_level() > 0) { ob_end_flush(); }

function emit(array $event): void {
    echo json_encode($event, JSON_UNESCAPED_UNICODE), "\n";
    flush();
}

function fail(string $message): void {
    emit(['event' => 'error', 'message' => $message]);
    exit;
}

// str_starts_with — PHP 8.0; для 7.4 — полифилл (на 8.x используется нативная)
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool {
        return $needle === '' || strpos($haystack, $needle) === 0;
    }
}

// ---------- Настройки ----------

function loadSettings(): array {
    $defaults = [
        'brokers' => [
            'tinkoff' => ['enabled' => true, 'apiKey' => ''],
            'finam'   => ['enabled' => true, 'apiKey' => '', 'accountId' => ''],
        ],
        'auth' => [
            'password' => '',   // пароль дашборда; пустой = авторизация выключена
        ],
        'sync' => [
            'mock' => false,
            'insecureSsl' => true,       // паритет с portfolio-scanner.kts (российские CA)
            'requestTimeoutSec' => 30,
            'bondsCacheTtlHours' => 24,
            'historyLimit' => 365,
        ],
    ];
    if (!is_file(SETTINGS_FILE)) {
        // Автоматически создаём шаблон, чтобы пользователю осталось вписать токены
        @file_put_contents(SETTINGS_FILE, json_encode($defaults, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        return $defaults;
    }
    $raw = file_get_contents(SETTINGS_FILE);
    $settings = json_decode((string)$raw, true);
    if (!is_array($settings)) fail('settings.json повреждён (неверный JSON)');
    // Слияние с дефолтами, чтобы отсутствующие ключи не ломали синк
    foreach ($defaults as $section => $values) {
        if (!isset($settings[$section]) || !is_array($settings[$section])) $settings[$section] = $values;
        $settings[$section] = array_merge($values, $settings[$section]);
    }
    return $settings;
}

// ---------- HTTP ----------

/** Базовый вызов через curl. Возвращает [httpCode, body] или бросает исключение. */
function httpCall(string $method, string $url, ?string $body, array $headers, float $timeoutSec, bool $insecure): array {
    $ch = curl_init($url);
    if ($ch === false) throw new RuntimeException('curl init failed');
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => (int)max(5, $timeoutSec),
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_HTTPHEADER => $headers,
    ];
    if ($body !== null) $opts[CURLOPT_POSTFIELDS] = $body;
    if ($insecure) {
        // Российские CA: доверять всем (как в portfolio-scanner.kts). Отключается в settings.json.
        $opts += [CURLOPT_SSL_VERIFYPEER => false, CURLOPT_SSL_VERIFYHOST => 0];
    }
    curl_setopt_array($ch, $opts);
    $respBody = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($respBody === false) throw new RuntimeException('network: ' . ($err !== '' ? $err : 'unknown curl error'));
    return [$code, (string)$respBody];
}

/** Разбор Quotation T-Invest {units, nano} и Finam {units, nanos} → float */
function qv($q, float $default = 0.0): float {
    if (!is_array($q)) return is_numeric($q) ? (float)$q : $default;
    $units = isset($q['units']) ? (float)$q['units'] : 0.0;
    $nano = 0;
    if (isset($q['nano'])) $nano = (int)$q['nano'];
    elseif (isset($q['nanos'])) $nano = (int)$q['nanos'];
    return $units + $nano / 1e9;
}

/** Разбор обёртки Finam {value:"123.45"} → float */
function vv($v, float $default = 0.0): float {
    if (is_array($v)) return isset($v['value']) ? (float)$v['value'] : $default;
    return is_numeric($v) ? (float)$v : (is_string($v) && $v !== '' ? (float)$v : $default);
}

function dayPart(?string $iso): string {
    return $iso === null ? '' : explode('T', $iso)[0];
}

/** Тикер из Finam-символа "SU26238RMFS4@TQOB" → "SU26238RMFS4" */
function tickerFromSymbol(string $symbol): string {
    return explode('@', $symbol)[0];
}

/** Базовый тикер: T-Invest помечает внебиржевые площадки суффиксом "@" (TMON@ → TMON).
 *  Один инструмент на разных площадках имеет РАЗНЫЕ figi — для слияния сравниваем базовый тикер. */
function baseTicker(string $ticker): string {
    return explode('@', $ticker)[0];
}

// ---------- Прогресс ----------

final class Progress {
    /** @var array<string,float> вес шага в условных единицах */
    private array $steps;
    /** @var array<string,true> завершённые шаги (finish идемпотентен) */
    private array $finished = [];
    private float $total;
    private float $done = 0.0;

    public function __construct(array $steps) {
        $this->steps = $steps;
        $this->total = max(1.0, array_sum($steps));
    }

    /** Частичный прогресс внутри шага (0..1) + сообщение */
    public function step(string $key, float $fraction, string $message, string $broker = 'system'): void {
        $w = $this->steps[$key] ?? 0.0;
        $f = max(0.0, min(1.0, $fraction));
        $p = ($this->done + $w * $f) / $this->total;
        emit(['event' => 'log', 'broker' => $broker, 'message' => $message, 'progress' => round($p, 4)]);
    }

    /** Завершить шаг; повторный вызов с тем же ключом игнорируется */
    public function finish(string $key, string $message = '', string $broker = 'system'): void {
        if (isset($this->finished[$key])) return;
        $this->finished[$key] = true;
        $this->done += $this->steps[$key] ?? 0.0;
        $this->step($key, 0.0, $message, $broker);
    }
}

// ---------- Клиент T-Invest ----------

final class TcsClient {
    private float $lastCall = 0.0;
    private string $apiKey;
    private float $timeout;
    private bool $insecure;

    public function __construct(string $apiKey, float $timeout, bool $insecure) {
        $this->apiKey = $apiKey;
        $this->timeout = $timeout;
        $this->insecure = $insecure;
    }

    /** POST к gRPC-gateway. Возвращает декодированный JSON или null после исчерпания ретраев. */
    public function post(string $method, array $body, int $retries = 3): ?array {
        $url = TCS_BASE . $method;
        for ($attempt = 1; $attempt <= $retries; $attempt++) {
            try {
                // pacing 150 мс между последовательными вызовами (защита от 429)
                $sleep = 150000 - (int)((microtime(true) - $this->lastCall) * 1e6);
                if ($sleep > 0) usleep($sleep);
                $this->lastCall = microtime(true);

                [$code, $respBody] = httpCall('POST', $url, json_encode($body, JSON_UNESCAPED_UNICODE), [
                    'Authorization: Bearer ' . $this->apiKey,
                    'Content-Type: application/json',
                ], $this->timeout, $this->insecure);

                if ($code === 429) {
                    if ($attempt < $retries) { sleep(3); continue; }
                    return null;
                }
                if ($code !== 200) {
                    if ($attempt < $retries) { usleep(2000000); continue; }
                    return null;
                }
                $data = json_decode($respBody, true);
                return is_array($data) ? $data : null;
            } catch (RuntimeException $e) {
                if ($attempt < $retries) { usleep(2000000); continue; }
                return null;
            }
        }
        return null;
    }

    /** @return array{id,name,status,type}[] */
    public function getAccounts(): array {
        $data = $this->post('UsersService/GetAccounts', ['status' => 'ACCOUNT_STATUS_OPEN']);
        $out = [];
        foreach (($data['accounts'] ?? []) as $a) {
            if (!is_array($a)) continue;
            $out[] = [
                'id' => (string)($a['id'] ?? ''),
                'name' => (string)($a['name'] ?? ''),
                'status' => (string)($a['status'] ?? ''),
                'type' => (string)($a['type'] ?? ''),
            ];
        }
        return $out;
    }

    /** Позиции портфеля: figi, instrumentType, quantity, avg/cur price, ticker, classCode */
    public function getPositions(string $accountId): array {
        $data = $this->post('OperationsService/GetPortfolio', ['accountId' => $accountId, 'currency' => 'RUB']);
        $out = [];
        foreach (($data['positions'] ?? []) as $p) {
            if (!is_array($p)) continue;
            $out[] = [
                'figi' => (string)($p['figi'] ?? ''),
                'instrumentType' => (string)($p['instrumentType'] ?? ''),
                'quantity' => qv($p['quantity'] ?? null),
                'avgPrice' => isset($p['averagePositionPrice']) ? qv($p['averagePositionPrice']) : null,
                'curPrice' => isset($p['currentPrice']) ? qv($p['currentPrice']) : null,
                'ticker' => (string)($p['ticker'] ?? ''),
                'classCode' => (string)($p['classCode'] ?? ''),
            ];
        }
        return $out;
    }

    /** Свободные рубли счёта: Σ money[rub] − заблокированное ГО (GetWithdrawLimits) */
    public function getCash(string $accountId): float {
        $data = $this->post('OperationsService/GetWithdrawLimits', ['accountId' => $accountId]);
        if ($data === null) return 0.0;
        $total = 0.0;
        foreach (($data['money'] ?? []) as $m) {
            if (!is_array($m)) continue;
            if (strtolower((string)($m['currency'] ?? '')) === 'rub') $total += qv($m);
        }
        // blockedGuarantee приоритетнее blocked (как в kts)
        foreach (['blockedGuarantee', 'blocked'] as $key) {
            $blocked = 0.0;
            foreach (($data[$key] ?? []) as $m) {
                if (!is_array($m)) continue;
                if (strtolower((string)($m['currency'] ?? '')) === 'rub') $blocked += qv($m);
            }
            if ($blocked > 0) { $total -= $blocked; break; }
        }
        return $total;
    }

    /** Реестр облигаций: ticker/name/figi/nominal/sector/couponPerYear/maturityDate */
    public function getAllBonds(): array {
        for ($attempt = 1; $attempt <= 3; $attempt++) {
            try {
                $sleep = 150000 - (int)((microtime(true) - $this->lastCall) * 1e6);
                if ($sleep > 0) usleep($sleep);
                $this->lastCall = microtime(true);
                [$code, $respBody] = httpCall('POST', TCS_BASE . 'InstrumentsService/Bonds',
                    json_encode(['instrumentStatus' => 'INSTRUMENT_STATUS_BASE']),
                    ['Authorization: Bearer ' . $this->apiKey, 'Content-Type: application/json'],
                    max($this->timeout, 60.0), // реестр тяжёлый (мегабайты)
                    $this->insecure);
                if ($code === 429) { sleep(5); continue; }
                if ($code !== 200) throw new RuntimeException('HTTP ' . $code);
                $data = json_decode($respBody, true);
                $out = [];
                foreach (($data['instruments'] ?? []) as $b) {
                    if (!is_array($b)) continue;
                    $out[] = [
                        'ticker' => (string)($b['ticker'] ?? ''),
                        'name' => (string)($b['name'] ?? ''),
                        'figi' => (string)($b['figi'] ?? ''),
                        'nominal' => isset($b['nominal']) ? qv($b['nominal'], 1000.0) : 1000.0,
                        'sector' => (string)($b['sector'] ?? ''),
                        'couponPerYear' => (int)($b['couponQuantityPerYear'] ?? 0),
                        'maturityDate' => dayPart((string)($b['maturityDate'] ?? '')),
                    ];
                }
                return $out;
            } catch (RuntimeException $e) {
                if ($attempt === 3) throw new RuntimeException('getAllBonds: попытки исчерпаны');
                sleep(3);
            }
        }
        return [];
    }

    /** Будущие купоны по облигации */
    public function getCoupons(string $figi): array {
        $data = $this->post('InstrumentsService/GetBondCoupons', ['figi' => $figi]);
        $out = [];
        foreach (($data['events'] ?? []) as $e) {
            if (!is_array($e)) continue;
            $out[] = [
                'date' => dayPart((string)($e['couponDate'] ?? '')),
                'amountPerUnit' => isset($e['payOneBond']) ? qv($e['payOneBond']) : 0.0,
                'type' => 'coupon',
                'currency' => strtolower((string)($e['currency'] ?? 'rub')),
            ];
        }
        return $out;
    }

    /** Дивиденды по акции/ETF (dividendNet либо dividendAmount, paymentDate либо recordDate) */
    public function getDividends(string $figi): array {
        $data = $this->post('InstrumentsService/GetDividends', ['instrumentId' => $figi], 2);
        $out = [];
        foreach (($data['dividends'] ?? []) as $d) {
            if (!is_array($d)) continue;
            $amount = isset($d['dividendNet']) ? qv($d['dividendNet']) : (isset($d['dividendAmount']) ? qv($d['dividendAmount']) : 0.0);
            if ($amount <= 0) continue;
            $date = dayPart((string)($d['paymentDate'] ?? ''));
            if ($date === '') $date = dayPart((string)($d['recordDate'] ?? ''));
            $out[] = [
                'date' => $date,
                'amountPerUnit' => $amount,
                'type' => 'dividend',
                'currency' => strtolower((string)($d['currency'] ?? 'rub')),
            ];
        }
        return $out;
    }

    /** Поиск инструмента по тикеру для названия акции/ETF */
    public function findInstrument(string $query, string $kind, string $classCode): ?array {
        $body = ['query' => $query];
        if ($kind !== '') $body['instrumentKind'] = $kind;
        $data = $this->post('InstrumentsService/FindInstrument', $body, 2);
        $want = str_replace('instrument_type_', '', strtolower($kind));
        foreach (($data['instruments'] ?? []) as $i) {
            if (!is_array($i)) continue;
            if ($kind !== '' && strtolower((string)($i['instrumentType'] ?? '')) !== $want) continue;
            if ((string)($i['ticker'] ?? '') !== $query) continue;
            if ($classCode !== '' && (string)($i['classCode'] ?? '') !== $classCode) continue;
            return ['name' => (string)($i['name'] ?? ''), 'ticker' => (string)($i['ticker'] ?? '')];
        }
        return null;
    }
}

// ---------- Клиент Finam ----------

final class FinamClient {
    private string $token = '';
    private string $secret;
    private float $timeout;
    private bool $insecure;

    public function __construct(string $secret, float $timeout, bool $insecure) {
        $this->secret = $secret;
        $this->timeout = $timeout;
        $this->insecure = $insecure;
    }

    /** Хвост ошибки из тела ответа Finam: там JSON с message («Api token could
     *  not be verified» и т.п.) — без него «HTTP 401» не говорит ничего. */
    private static function errTail(string $body): string {
        $d = json_decode($body, true);
        $msg = is_array($d) && isset($d['message']) && is_string($d['message']) ? $d['message'] : '';
        if ($msg === '') $msg = trim(preg_replace('/\s+/', ' ', (string)$body) ?? '');
        if ($msg !== '') $msg = ' — ' . mb_substr($msg, 0, 140);
        return $msg;
    }

    public function authenticate(): void {
        [$code, $body] = httpCall('POST', FINAM_BASE . '/v1/sessions',
            json_encode(['secret' => $this->secret]),
            ['Content-Type: application/json'], $this->timeout, $this->insecure);
        if ($code !== 200) throw new RuntimeException('Finam auth: HTTP ' . $code . self::errTail($body));
        $data = json_decode($body, true);
        $token = (string)($data['token'] ?? '');
        if ($token === '') throw new RuntimeException('Finam auth: токен не получен');
        $this->token = $token;
    }

    /** @return string[] id счетов */
    public function getAccountIds(): array {
        [$code, $body] = httpCall('POST', FINAM_BASE . '/v1/sessions/details',
            json_encode(['token' => $this->token]),
            ['Content-Type: application/json'], $this->timeout, $this->insecure);
        if ($code !== 200) throw new RuntimeException('Finam details: HTTP ' . $code . self::errTail($body));
        $data = json_decode($body, true);
        return array_values(array_filter(array_map(
            static fn($id): string => is_string($id) ? $id : '',
            (array)($data['account_ids'] ?? [])
        )));
    }

    /** Счёт: equity, cash, позиции (цены облигаций в % от номинала) */
    public function getAccount(string $accountId): array {
        [$code, $body] = httpCall('GET', FINAM_BASE . '/v1/accounts/' . rawurlencode($accountId), null,
            ['Authorization: Bearer ' . $this->token], $this->timeout, $this->insecure);
        if ($code !== 200) throw new RuntimeException('Finam account: HTTP ' . $code . self::errTail($body));
        $data = json_decode($body, true);
        $positions = [];
        foreach (($data['positions'] ?? []) as $p) {
            if (!is_array($p)) continue;
            $positions[] = [
                'symbol' => (string)($p['symbol'] ?? ''),
                'quantity' => vv($p['quantity'] ?? null),
                'averagePrice' => vv($p['average_price'] ?? null),
                'currentPrice' => vv($p['current_price'] ?? null),
            ];
        }
        return [
            'equity' => vv($data['equity'] ?? null),
            'cash' => qv($data['cash'] ?? null),
            'positions' => $positions,
        ];
    }

    /** Будущие дивиденды по символу; ошибки не фатальны */
    public function getFutureDividends(string $symbol): array {
        try {
            [$code, $body] = httpCall('GET',
                FINAM_BASE . '/v1/future-dividends?symbol=' . rawurlencode($symbol) . '&sort_direction=asc&limit=50',
                null, ['Authorization: Bearer ' . $this->token], $this->timeout, $this->insecure);
            if ($code !== 200) return [];
            $data = json_decode($body, true);
            $out = [];
            foreach (($data['events'] ?? []) as $e) {
                if (!is_array($e)) continue;
                $amount = isset($e['dividend_amount']) ? qv($e['dividend_amount']) : (isset($e['amount']) ? qv($e['amount']) : 0.0);
                $date = dayPart((string)($e['dividend_date'] ?? ''));
                if ($date === '') $date = dayPart((string)($e['date'] ?? ''));
                if ($date === '' || $amount <= 0) continue;
                $out[] = [
                    'date' => $date,
                    'amountPerUnit' => $amount,
                    'type' => 'dividend',
                    'currency' => strtolower((string)($e['currency'] ?? 'rub')),
                ];
            }
            return $out;
        } catch (RuntimeException $e) {
            return [];
        }
    }
}

// ---------- Справочник облигаций ----------

/** Индексы реестра: точное совпадение по тикеру и figi */
function buildBondLookup(array $bonds): array {
    $byTicker = [];
    $byFigi = [];
    foreach ($bonds as $b) {
        if ($b['ticker'] !== '') $byTicker[$b['ticker']] = $b;
        if ($b['figi'] !== '') $byFigi[$b['figi']] = $b;
    }
    return ['ticker' => $byTicker, 'figi' => $byFigi, 'all' => $bonds];
}

/** Поиск облигации по тикеру/figi: точное совпадение, затем префикс (как findBondByTicker в kts) */
function findBond(array $lookup, string $key): ?array {
    if ($key === '') return null;
    if (isset($lookup['ticker'][$key])) return $lookup['ticker'][$key];
    if (isset($lookup['figi'][$key])) return $lookup['figi'][$key];
    foreach ($lookup['all'] as $b) {
        if ($b['ticker'] === '') continue;
        if (str_starts_with($key, $b['ticker']) || str_starts_with($b['ticker'], $key)) return $b;
    }
    return null;
}

/** Finam-символ похож на облигацию? (длинный буквенно-цифровой тикер) */
function isBondSymbol(string $ticker): bool {
    return strlen($ticker) >= 10 && ctype_alnum($ticker);
}

/**
 * Конвертация и слияние позиции Finam в общий список holdings.
 * Цены облигаций приходят в % от номинала → ₽ через nominal/100 (как в kts).
 */
function mergeFinamPosition(array &$holdings, array $pos, ?array $bond): void {
    $ticker = tickerFromSymbol($pos['symbol']);
    $nominal = $bond['nominal'] ?? 1000.0;
    $avgPriceRub = $pos['averagePrice'] * $nominal / 100.0;
    $curPriceRub = $pos['currentPrice'] * $nominal / 100.0;
    $key = ($bond['figi'] ?? '') !== '' ? $bond['figi'] : $ticker;

    // figi-ключ не найден — пробуем слить по базовому тикеру и типу (один инструмент = разные figi на разных площадках)
    if (!isset($holdings[$key])) {
        foreach ($holdings as $k => $h) {
            if (baseTicker($h['ticker']) === $ticker && $h['instrumentType'] === ($bond !== null || isBondSymbol($ticker) ? 'bond' : 'share')) {
                $key = $k;
                break;
            }
        }
    }

    if (isset($holdings[$key])) {
        $h = $holdings[$key];
        $newQty = $h['quantity'] + $pos['quantity'];
        $h['avgPrice'] = $newQty > 0
            ? ($h['quantity'] * $h['avgPrice'] + $pos['quantity'] * $avgPriceRub) / $newQty
            : $h['avgPrice'];
        $h['quantity'] = $newQty;
        $h['brokerQty']['finam'] = ($h['brokerQty']['finam'] ?? 0) + $pos['quantity'];
        $h['sources'][] = 'finam';
        $h['sources'] = array_values(array_unique($h['sources']));
        $holdings[$key] = $h;
        return;
    }
    $holdings[$key] = [
        'figi' => $bond['figi'] ?? '',
        'ticker' => $ticker,
        'name' => $bond['name'] ?? $ticker,
        'instrumentType' => $bond !== null ? 'bond' : (isBondSymbol($ticker) ? 'bond' : 'share'),
        'quantity' => $pos['quantity'],
        'avgPrice' => $avgPriceRub,
        'curPrice' => $curPriceRub,
        'nominal' => $nominal,
        'sector' => $bond['sector'] ?? '',
        'couponPerYear' => $bond['couponPerYear'] ?? 0,
        'maturityDate' => $bond['maturityDate'] ?? '',
        'sources' => ['finam'],
        'brokerQty' => ['tinkoff' => 0, 'finam' => $pos['quantity']],
        'payments' => [],
    ];
}

// ---------- Итоги ----------

/**
 * Считает итоговую структуру holdings/totals для portfolio.json.
 * @param array $holdings ключ → holding (внутренние поля brokerQty удаляются)
 */
function computeTotals(array $holdings, array $accounts): array {
    $today = (new DateTimeImmutable('today'))->format('Y-m-d');
    $in12m = (new DateTimeImmutable('+12 months'))->format('Y-m-d');
    $month0 = new DateTimeImmutable('first day of this month');

    // Только ликвидные позиции с ненулевым количеством, по убыванию стоимости
    $list = array_values(array_filter($holdings, static fn($h) => $h['quantity'] > 0 && $h['instrumentType'] !== 'futures'));
    usort($list, static fn($a, $b) => $b['quantity'] * $b['curPrice'] <=> $a['quantity'] * $a['curPrice']);

    $value = 0.0; $cost = 0.0; $payingValue = 0.0; $payments12m = 0.0;
    $byMonth = [];  // "YYYY-MM" => {coupons, dividends, total}
    $byType = [];   // тип => стоимость
    $byBroker = [
        'tinkoff' => ['value' => 0.0, 'cost' => 0.0, 'cash' => 0.0, 'paymentsNext12m' => 0.0],
        'finam'   => ['value' => 0.0, 'cost' => 0.0, 'cash' => 0.0, 'paymentsNext12m' => 0.0],
    ];

    foreach ($list as &$h) {
        $h['value'] = round($h['quantity'] * $h['curPrice'], 2);
        $h['cost'] = round($h['quantity'] * $h['avgPrice'], 2);
        $h['pnl'] = round($h['value'] - $h['cost'], 2);
        $h['pnlPct'] = $h['cost'] > 0 ? round($h['pnl'] / $h['cost'] * 100, 2) : null;
        $value += $h['value'];
        $cost += $h['cost'];
        $byType[$h['instrumentType']] = ($byType[$h['instrumentType']] ?? 0) + $h['value'];

        $hPayments12m = 0.0;
        $hasFuturePayments = false;
        foreach ($h['payments'] as $p) {
            if ($p['currency'] !== 'rub' || $p['date'] < $today) continue;
            $hasFuturePayments = true;
            if ($p['date'] > $in12m) continue;
            $total = $p['amountPerUnit'] * $h['quantity'];
            $hPayments12m += $total;
            $mk = substr($p['date'], 0, 7);
            if (!isset($byMonth[$mk])) $byMonth[$mk] = ['coupons' => 0.0, 'dividends' => 0.0, 'total' => 0.0];
            $kind = $p['type'] === 'coupon' ? 'coupons' : 'dividends';
            $byMonth[$mk][$kind] += $total;
            $byMonth[$mk]['total'] += $total;
        }
        $payments12m += $hPayments12m;
        if ($hasFuturePayments) $payingValue += $h['value'];

        // Разнесение по брокерам пропорционально количеству у каждого
        foreach (['tinkoff', 'finam'] as $b) {
            $qty = $h['brokerQty'][$b] ?? 0.0;
            if ($qty <= 0) continue;
            $byBroker[$b]['value'] += $qty * $h['curPrice'];
            $byBroker[$b]['cost'] += $qty * $h['avgPrice'];
            if ($h['quantity'] > 0) $byBroker[$b]['paymentsNext12m'] += $hPayments12m * $qty / $h['quantity'];
        }

        $h['paymentsNext12m'] = round($hPayments12m, 2);
        unset($h['brokerQty']); // внутреннее поле — наружу не отдаём
    }
    unset($h);

    foreach ($accounts as $acc) {
        if (isset($byBroker[$acc['broker']])) $byBroker[$acc['broker']]['cash'] += $acc['cash'];
    }
    foreach ($byBroker as $b => &$bb) {
        $bb['paymentsNext12m'] = round($bb['paymentsNext12m'], 2);
        $bb['yieldPct'] = $bb['value'] > 0 ? round($bb['paymentsNext12m'] / $bb['value'] * 100, 2) : 0.0;
    }
    unset($bb);

    // 12 календарных месяцев (включая текущий), нулевые месяцы тоже — для ровного графика
    $paymentsByMonth = [];
    for ($i = 0; $i < 12; $i++) {
        $mk = $month0->modify("+$i months")->format('Y-m');
        $row = $byMonth[$mk] ?? ['coupons' => 0.0, 'dividends' => 0.0, 'total' => 0.0];
        $paymentsByMonth[] = [
            'month' => $mk,
            'coupons' => round($row['coupons'], 2),
            'dividends' => round($row['dividends'], 2),
            'total' => round($row['total'], 2),
        ];
    }

    $pnl = $value - $cost;
    $cash = array_sum(array_map(static fn($a) => $a['cash'], $accounts));

    return [
        'holdings' => $list,
        'totals' => [
            'value' => round($value, 2),
            'cost' => round($cost, 2),
            'pnl' => round($pnl, 2),
            'pnlPct' => $cost > 0 ? round($pnl / $cost * 100, 2) : null,
            'cash' => round($cash, 2),
            'payingValue' => round($payingValue, 2),
            'paymentsNext12m' => round($payments12m, 2),
            'passiveYieldPct' => $value > 0 ? round($payments12m / $value * 100, 2) : 0.0,
            'paymentsByMonth' => $paymentsByMonth,
            'byBroker' => $byBroker,
            'byType' => array_map(static fn($v) => round($v, 2), $byType),
        ],
    ];
}

/** Атомарная запись JSON под блокировкой */
function atomicWrite(string $path, array $data): bool {
    $tmp = $path . '.tmp';
    $fp = fopen($tmp, 'c');
    if ($fp === false) return false;
    flock($fp, LOCK_EX);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return rename($tmp, $path);
}

// ---------- Mock-данные (детерминированные, без сети) ----------

function buildMockPortfolio(): array {
    $today = new DateTimeImmutable('today');
    $t = $today->format('Y-m-d');

    // Регулярные выплаты: каждые 12/perYear месяцев, 14-го числа
    $mkPayments = static function (int $perYear, float $amount, string $type) use ($today): array {
        $out = [];
        $step = max(1, (int)(12 / $perYear));
        for ($m = 0; $m < 12; $m += $step) {
            $d = $today->modify("+$m months")->format('Y-m-14');
            if ($d < $today->format('Y-m-d')) $d = $today->modify('+' . ($m + $step) . ' months')->format('Y-m-14');
            if (substr($d, 0, 7) > $today->modify('+11 months')->format('Y-m')) continue;
            $out[] = ['date' => $d, 'amountPerUnit' => $amount, 'type' => $type, 'currency' => 'rub'];
        }
        return $out;
    };

    $holdings = [
        ['figi' => 'BBG00RPRPXV0', 'ticker' => 'SU26238RMFS4', 'name' => 'ОФЗ 26238', 'instrumentType' => 'bond',
         'quantity' => 400, 'avgPrice' => 542.3, 'curPrice' => 568.9, 'nominal' => 1000.0, 'sector' => 'government',
         'couponPerYear' => 2, 'maturityDate' => '2041-05-15', 'sources' => ['tinkoff', 'finam'],
         'brokerQty' => ['tinkoff' => 250, 'finam' => 150], 'payments' => $mkPayments(2, 31.12, 'coupon')],
        ['figi' => 'BBG00YXY1W39', 'ticker' => 'RU000A105SD9', 'name' => 'Сбербанк-002Р-01D', 'instrumentType' => 'bond',
         'quantity' => 150, 'avgPrice' => 963.0, 'curPrice' => 991.5, 'nominal' => 1000.0, 'sector' => 'bank',
         'couponPerYear' => 4, 'maturityDate' => '2027-11-10', 'sources' => ['tinkoff'],
         'brokerQty' => ['tinkoff' => 150, 'finam' => 0], 'payments' => $mkPayments(4, 24.8, 'coupon')],
        ['figi' => 'BBG004730N88', 'ticker' => 'SBER', 'name' => 'Сбербанк, ао', 'instrumentType' => 'share',
         'quantity' => 900, 'avgPrice' => 246.1, 'curPrice' => 318.4, 'nominal' => 0.0, 'sector' => 'financial',
         'couponPerYear' => 0, 'maturityDate' => '', 'sources' => ['tinkoff'],
         'brokerQty' => ['tinkoff' => 900, 'finam' => 0], 'payments' => $mkPayments(1, 33.3, 'dividend')],
        ['figi' => 'BBG00475K6C3', 'ticker' => 'GAZP', 'name' => 'Газпром, ао', 'instrumentType' => 'share',
         'quantity' => 1200, 'avgPrice' => 128.5, 'curPrice' => 142.7, 'nominal' => 0.0, 'sector' => 'energy',
         'couponPerYear' => 0, 'maturityDate' => '', 'sources' => ['tinkoff', 'finam'],
         'brokerQty' => ['tinkoff' => 700, 'finam' => 500], 'payments' => $mkPayments(1, 8.97, 'dividend')],
        ['figi' => 'BBG00B3X0GQ1', 'ticker' => 'LKOH', 'name' => 'ЛУКОЙЛ, ао', 'instrumentType' => 'share',
         'quantity' => 60, 'avgPrice' => 6890.0, 'curPrice' => 7245.0, 'nominal' => 0.0, 'sector' => 'energy',
         'couponPerYear' => 0, 'maturityDate' => '', 'sources' => ['finam'],
         'brokerQty' => ['tinkoff' => 0, 'finam' => 60], 'payments' => $mkPayments(1, 84.0, 'dividend')],
        ['figi' => 'BBG004HV8V33', 'ticker' => 'LQDT', 'name' => 'LQDT Ликвидность', 'instrumentType' => 'etf',
         'quantity' => 3000, 'avgPrice' => 1.42, 'curPrice' => 1.51, 'nominal' => 0.0, 'sector' => '',
         'couponPerYear' => 0, 'maturityDate' => '', 'sources' => ['tinkoff'],
         'brokerQty' => ['tinkoff' => 3000, 'finam' => 0], 'payments' => []],
        ['figi' => 'BBG00T6KXWX8', 'ticker' => 'TMOS', 'name' => 'Т-Капитал Индекс МосБиржи', 'instrumentType' => 'etf',
         'quantity' => 850, 'avgPrice' => 7.24, 'curPrice' => 7.86, 'nominal' => 0.0, 'sector' => '',
         'couponPerYear' => 0, 'maturityDate' => '', 'sources' => ['finam'],
         'brokerQty' => ['tinkoff' => 0, 'finam' => 850], 'payments' => []],
    ];

    $rawAccounts = [
        ['broker' => 'tinkoff', 'id' => '2000123456', 'name' => 'Брокерский счёт', 'type' => 'ACCOUNT_TYPE_TINKOFF',
         'cash' => 42000.0, 'positionsCount' => 5],
        ['broker' => 'tinkoff', 'id' => '2000123457', 'name' => 'ИИС', 'type' => 'ACCOUNT_TYPE_TINKOFF_IIS',
         'cash' => 8500.0, 'positionsCount' => 2],
        ['broker' => 'finam', 'id' => 'FAB00012345', 'name' => 'Finam Брокерский', 'type' => '',
         'cash' => 12300.0, 'positionsCount' => 3],
    ];

    $result = computeTotals($holdings, $rawAccounts);
    // equity счетов распределяем по брокерам (для мока достаточно)
    $tcsTotal = $result['totals']['byBroker']['tinkoff']['value'] + 42000.0 + 8500.0;
    $finamTotal = $result['totals']['byBroker']['finam']['value'] + 12300.0;
    $result['accounts'] = [
        ['broker' => 'tinkoff', 'id' => '2000123456', 'name' => 'Брокерский счёт', 'type' => 'ACCOUNT_TYPE_TINKOFF',
         'equity' => round($tcsTotal * 0.78, 2), 'cash' => 42000.0, 'futuresValue' => 0, 'positionsCount' => 5],
        ['broker' => 'tinkoff', 'id' => '2000123457', 'name' => 'ИИС', 'type' => 'ACCOUNT_TYPE_TINKOFF_IIS',
         'equity' => round($tcsTotal * 0.22, 2), 'cash' => 8500.0, 'futuresValue' => 0, 'positionsCount' => 2],
        ['broker' => 'finam', 'id' => 'FAB00012345', 'name' => 'Finam Брокерский', 'type' => '',
         'equity' => round($finamTotal, 2), 'cash' => 12300.0, 'futuresValue' => 0, 'positionsCount' => 3],
    ];

    // История за 90 дней: детерминированная волатильность
    $history = [];
    $v0 = $result['totals']['value'];
    $c0 = $result['totals']['cost'];
    for ($i = 90; $i >= 1; $i--) {
        $d = $today->modify("-$i days")->format('Y-m-d');
        $wave = sin($i / 7) * 0.006 + sin($i / 23 + 1.3) * 0.011;
        $growth = ($i / 90) * 0.055; // от −5,5% к 0
        $history[] = [
            'date' => $d,
            'value' => round($v0 * (1 - $growth + $wave), 2),
            'cost' => round($c0 * (1 - $growth * 0.6), 2),
            'pnl' => round($v0 * (1 - $growth + $wave) - $c0 * (1 - $growth * 0.6), 2),
            'cash' => round($result['totals']['cash'] * (1 - $growth), 2),
        ];
    }

    $result['meta'] = [
        'version' => 1,
        'generatedAt' => date('c'),
        'mock' => true,
        'durationMs' => 0,
        'brokers' => [
            'tinkoff' => ['configured' => true, 'status' => 'ok', 'error' => null, 'accounts' => 2, 'durationMs' => 0],
            'finam' => ['configured' => true, 'status' => 'ok', 'error' => null, 'accounts' => 1, 'durationMs' => 0],
        ],
    ];
    $result['history'] = $history;
    return $result;
}

// ---------- Точка входа ----------

$startedAt = microtime(true);

// Авторизация: пароль в settings.json → auth.password (пустой = выключена).
// CLI-запуск (cli-sync.php) — локальный доверенный контекст: доступ к shell
// уже означает доступ к settings.json, пароль не спрашиваем.
if (PHP_SAPI !== 'cli') {
    require __DIR__ . '/auth.php';
    auth_require();
}

$lockFp = fopen(LOCK_FILE, 'c');
if ($lockFp === false) fail('Не удалось создать sync.lock');
if (!flock($lockFp, LOCK_EX | LOCK_NB)) {
    emit(['event' => 'busy']);
    exit;
}

// Параметры: POST JSON-тело и/или query. mock допустим из обоих источников.
// В CLI ключа REQUEST_METHOD нет — ?? '', чтобы не словить Notice на 7.4
$input = [];
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $raw = file_get_contents('php://input');
    if (is_string($raw) && $raw !== '') {
        $decoded = json_decode($raw, true);
        if (is_array($decoded)) $input = $decoded;
    }
}

$settings = loadSettings();
// CLI (cli-sync.php): --mock (или просто mock) аргументом; далее POST-тело, ?mock=1, sync.mock
$cliMock = PHP_SAPI === 'cli' && (in_array('--mock', $argv ?? [], true) || in_array('mock', $argv ?? [], true));
$mock = $cliMock || (bool)($input['mock'] ?? false) || isset($_GET['mock']) || (bool)($settings['sync']['mock'] ?? false);

// ---------- MOCK ----------
if ($mock) {
    emit(['event' => 'start', 'mock' => true, 'version' => 1,
        'brokers' => ['tinkoff' => true, 'finam' => true]]);
    $mockSteps = [
        ['settings', 'system', 'Чтение settings.json…'],
        ['finam_auth', 'finam', 'Авторизация в Finam API…'],
        ['finam_accounts', 'finam', 'Получение счетов Finam…'],
        ['tcs_accounts', 'tcs', 'Получение счетов T-Invest…'],
        ['tcs_portfolios', 'tcs', 'Загрузка портфелей T-Invest…'],
        ['bonds', 'tcs', 'Загрузка справочника облигаций…'],
        ['payments', 'tcs', 'Купоны и дивиденды по позициям…'],
        ['finalize', 'system', 'Расчёт итогов…'],
        ['write', 'system', 'Сохранение portfolio.json…'],
    ];
    foreach ($mockSteps as $i => [, $broker, $msg]) {
        emit(['event' => 'log', 'broker' => $broker, 'message' => $msg, 'progress' => round($i / count($mockSteps), 4)]);
        usleep(130000);
    }
    $portfolio = buildMockPortfolio();
    $saved = false;
    // Мок не перезаписывает реальные данные: пишет только при первом запуске (демо)
    if (!is_file(PORTFOLIO_FILE)) {
        $saved = atomicWrite(PORTFOLIO_FILE, $portfolio);
    }
    emit(['event' => 'broker_status', 'broker' => 'tinkoff', 'status' => 'ok', 'error' => null]);
    emit(['event' => 'broker_status', 'broker' => 'finam', 'status' => 'ok', 'error' => null]);
    emit(['event' => 'done', 'mock' => true, 'saved' => $saved,
        'totalMs' => (int)((microtime(true) - $startedAt) * 1000),
        'portfolio' => [
            'value' => $portfolio['totals']['value'],
            'cost' => $portfolio['totals']['cost'],
            'pnl' => $portfolio['totals']['pnl'],
            'holdings' => count($portfolio['holdings']),
            'paymentsNext12m' => $portfolio['totals']['paymentsNext12m'],
        ]]);
    flock($lockFp, LOCK_UN);
    exit;
}

// ---------- Реальная синхронизация ----------

$tcsCfg = $settings['brokers']['tinkoff'];
$finamCfg = $settings['brokers']['finam'];
$syncCfg = $settings['sync'];

$tcsEnabled = ($tcsCfg['enabled'] ?? true) && trim((string)($tcsCfg['apiKey'] ?? '')) !== '';
$finamEnabled = ($finamCfg['enabled'] ?? true) && trim((string)($finamCfg['apiKey'] ?? '')) !== '';

// Шаги прогресса; шаги выключенных брокеров исключаются (веса автоматически нормируются)
$steps = [
    'settings' => 2,
    'finam_auth' => 7, 'finam_accounts' => 8,
    'tcs_accounts' => 5, 'tcs_portfolios' => 15,
    'bonds' => 20, 'payments' => 32,
    'finalize' => 3, 'write' => 8,
];
if (!$tcsEnabled) unset($steps['tcs_accounts'], $steps['tcs_portfolios']);
if (!$finamEnabled) unset($steps['finam_auth'], $steps['finam_accounts']);
if (!$tcsEnabled && !$finamEnabled) unset($steps['bonds'], $steps['payments'], $steps['finalize'], $steps['write']);

$progress = new Progress($steps);
emit(['event' => 'start', 'version' => 1, 'brokers' => ['tinkoff' => $tcsEnabled, 'finam' => $finamEnabled]]);
$progress->finish('settings', 'Настройки загружены');
emit(['event' => 'broker_status', 'broker' => 'tinkoff', 'status' => $tcsEnabled ? 'running' : 'skipped', 'error' => $tcsEnabled ? null : 'Токен не задан в settings.json']);
emit(['event' => 'broker_status', 'broker' => 'finam', 'status' => $finamEnabled ? 'running' : 'skipped', 'error' => $finamEnabled ? null : 'Токен не задан в settings.json']);

// Оба брокера не настроены — говорить нечего
if (!$tcsEnabled && !$finamEnabled) {
    emit(['event' => 'done', 'saved' => false, 'totalMs' => (int)((microtime(true) - $startedAt) * 1000),
        'message' => 'Нет настроенных брокеров — заполните apiKey в settings.json']);
    flock($lockFp, LOCK_UN);
    exit;
}

$timeout = (float)($syncCfg['requestTimeoutSec'] ?? 30);
$insecure = (bool)($syncCfg['insecureSsl'] ?? true);
$today = (new DateTimeImmutable('today'))->format('Y-m-d');

$brokerMeta = [
    'tinkoff' => ['configured' => $tcsEnabled, 'status' => 'skipped', 'error' => null, 'accounts' => 0, 'durationMs' => 0],
    'finam' => ['configured' => $finamEnabled, 'status' => 'skipped', 'error' => null, 'accounts' => 0, 'durationMs' => 0],
];
$accounts = [];                 // список счетов для portfolio.json
$holdings = [];                 // ключ → объединённая позиция
$holdingsByBase = [];           // базовый тикер → ключ в $holdings (слияние площадок: TMON@ + TMON)
$finamRawPositions = [];        // [позиция, ...] — конвертируются после загрузки реестра облигаций
$finamPositionsByTicker = [];   // тикер → полный символ Finam (для future-dividends)
$tcsClient = null;
$finamClient = null;
$bonds = [];
$bondLookup = ['ticker' => [], 'figi' => [], 'all' => []];

// ---------- Этап 1: Finam (auth + счета + сырые позиции) ----------
if ($finamEnabled) {
    $t0 = microtime(true);
    try {
        $finamClient = new FinamClient((string)$finamCfg['apiKey'], $timeout, $insecure);
        $progress->step('finam_auth', 0.5, 'Авторизация в Finam API…', 'finam');
        $finamClient->authenticate();
        $progress->finish('finam_auth', 'Finam: авторизация OK', 'finam');

        $progress->step('finam_accounts', 0.3, 'Получение счетов Finam…', 'finam');
        $ids = $finamClient->getAccountIds();
        $filterId = trim((string)($finamCfg['accountId'] ?? ''));
        if ($filterId !== '') {
            $ids = array_values(array_filter($ids, static fn($id) => $id === $filterId));
        }
        $brokerMeta['finam']['accounts'] = count($ids);
        if ($ids === []) throw new RuntimeException('Finam: счета не найдены');

        $ai = 0;
        foreach ($ids as $id) {
            $ai++;
            $progress->step('finam_accounts', 0.3 + 0.7 * $ai / count($ids), "Счёт Finam $id: позиции…", 'finam');
            $acc = $finamClient->getAccount($id);
            $accounts[] = [
                'broker' => 'finam', 'id' => $id, 'name' => 'Finam ' . substr($id, -4), 'type' => '',
                'equity' => round($acc['equity'], 2), 'cash' => round($acc['cash'], 2),
                'futuresValue' => 0, 'positionsCount' => count($acc['positions']),
            ];
            foreach ($acc['positions'] as $pos) {
                if ($pos['quantity'] <= 0) continue;
                $finamRawPositions[] = $pos;
                $finamPositionsByTicker[tickerFromSymbol($pos['symbol'])] = $pos['symbol'];
            }
        }
        $progress->finish('finam_accounts', 'Finam: счетов ' . count($ids), 'finam');
        $brokerMeta['finam']['status'] = 'ok';
    } catch (Throwable $e) {
        $brokerMeta['finam']['status'] = 'error';
        $brokerMeta['finam']['error'] = mb_substr($e->getMessage(), 0, 200);
        $finamClient = null;
        $accounts = array_values(array_filter($accounts, static fn($a) => $a['broker'] !== 'finam'));
        emit(['event' => 'broker_status', 'broker' => 'finam', 'status' => 'error', 'error' => $brokerMeta['finam']['error']]);
        $progress->finish('finam_auth', 'Finam: ошибка — ' . $brokerMeta['finam']['error'], 'finam');
        $progress->finish('finam_accounts', '', 'finam');
    }
    $brokerMeta['finam']['durationMs'] = (int)((microtime(true) - $t0) * 1000);
}

// ---------- Этап 2: T-Invest (счета + портфели + кэш) ----------
if ($tcsEnabled) {
    $t0 = microtime(true);
    try {
        $tcsClient = new TcsClient((string)$tcsCfg['apiKey'], $timeout, $insecure);

        $progress->step('tcs_accounts', 0.5, 'Получение счетов T-Invest…', 'tcs');
        $tcsAccounts = $tcsClient->getAccounts();
        if ($tcsAccounts === []) throw new RuntimeException('GetAccounts: пусто или ошибка API');
        $brokerMeta['tinkoff']['accounts'] = count($tcsAccounts);
        $progress->finish('tcs_accounts', 'T-Invest: счетов ' . count($tcsAccounts), 'tcs');

        $nameCache = [];
        $ai = 0;
        foreach ($tcsAccounts as $acc) {
            $ai++;
            $progress->step('tcs_portfolios', $ai / count($tcsAccounts), "Счёт «{$acc['name']}»: портфель…", 'tcs');
            $positions = $tcsClient->getPositions($acc['id']);

            $accountEquity = 0.0; $futuresValue = 0.0;
            foreach ($positions as $p) {
                $v = $p['quantity'] * ($p['curPrice'] ?? 0.0);
                if (strcasecmp($p['instrumentType'], 'futures') === 0) $futuresValue += $v;
                else $accountEquity += $v;
            }
            $accounts[] = [
                'broker' => 'tinkoff', 'id' => $acc['id'], 'name' => $acc['name'], 'type' => $acc['type'],
                'equity' => round($accountEquity, 2), 'cash' => round($tcsClient->getCash($acc['id']), 2),
                'futuresValue' => round($futuresValue, 2), 'positionsCount' => count($positions),
            ];

            // В holdings идут только ценные бумаги (bond/share/etf); метаданные облигаций — после реестра
            foreach ($positions as $p) {
                if (!in_array($p['instrumentType'], ['bond', 'share', 'etf'], true) || $p['quantity'] <= 0) continue;

                if ($p['instrumentType'] === 'bond') {
                    $ticker = $p['ticker'] !== '' ? $p['ticker'] : $p['figi'];
                    $name = $ticker;
                    $nominal = 1000.0; $sector = ''; $couponPerYear = 0; $maturity = '';
                } else {
                    $kind = $p['instrumentType'] === 'share' ? 'INSTRUMENT_TYPE_SHARE' : 'INSTRUMENT_TYPE_ETF';
                    if ($p['ticker'] !== '' && !isset($nameCache[$p['ticker']])) {
                        $info = $tcsClient->findInstrument($p['ticker'], $kind, $p['classCode']);
                        $nameCache[$p['ticker']] = $info['name'] ?? $p['ticker'];
                    }
                    $ticker = $p['ticker'] !== '' ? $p['ticker'] : $p['figi'];
                    $name = $nameCache[$p['ticker']] ?? $ticker;
                    $nominal = 0.0; $sector = ''; $couponPerYear = 0; $maturity = '';
                }

                $avgPriceRub = $p['avgPrice'] ?? 0.0;
                $curPriceRub = $p['curPrice'] ?? 0.0;
                $ticker = baseTicker($ticker); // на хранение — тикер без суффикса площадки

                // Один инструмент на разных площадках = разные figi (TMON@ и TMON):
                // сначала figi, затем фолбэк по базовому тикеру и типу инструмента.
                $base = baseTicker($ticker);
                $key = $p['figi'];
                if (!isset($holdings[$key])) {
                    foreach ($holdingsByBase as $bk => $hk) {
                        if ($bk === $base && ($holdings[$hk]['instrumentType'] ?? '') === $p['instrumentType']) {
                            $key = $hk;
                            break;
                        }
                    }
                }

                if (isset($holdings[$key])) {
                    $h = $holdings[$key];
                    $newQty = $h['quantity'] + $p['quantity'];
                    if ($newQty > 0 && $avgPriceRub > 0) {
                        $h['avgPrice'] = ($h['quantity'] * $h['avgPrice'] + $p['quantity'] * $avgPriceRub) / $newQty;
                    }
                    $h['quantity'] = $newQty;
                    $h['brokerQty']['tinkoff'] = ($h['brokerQty']['tinkoff'] ?? 0) + $p['quantity'];
                    $h['sources'][] = 'tcs';
                    $h['sources'] = array_values(array_unique($h['sources']));
                    $holdings[$key] = $h;
                    $holdingsByBase[$base] = $key;
                } else {
                    $holdingsByBase[$base] = $key;
                    $holdings[$key] = [
                        'figi' => $p['figi'], 'ticker' => $ticker, 'name' => $name,
                        'instrumentType' => $p['instrumentType'],
                        'quantity' => $p['quantity'], 'avgPrice' => $avgPriceRub, 'curPrice' => $curPriceRub,
                        'nominal' => $nominal, 'sector' => $sector, 'couponPerYear' => $couponPerYear,
                        'maturityDate' => $maturity,
                        'sources' => ['tcs'], 'brokerQty' => ['tinkoff' => $p['quantity'], 'finam' => 0],
                        'payments' => [],
                    ];
                }
            }
        }
        $progress->finish('tcs_portfolios', 'T-Invest: портфели загружены', 'tcs');
        $brokerMeta['tinkoff']['status'] = 'ok';
    } catch (Throwable $e) {
        $brokerMeta['tinkoff']['status'] = 'error';
        $brokerMeta['tinkoff']['error'] = mb_substr($e->getMessage(), 0, 200);
        $tcsClient = null;
        $accounts = array_values(array_filter($accounts, static fn($a) => $a['broker'] !== 'tinkoff'));
        emit(['event' => 'broker_status', 'broker' => 'tinkoff', 'status' => 'error', 'error' => $brokerMeta['tinkoff']['error']]);
        $progress->finish('tcs_accounts', 'T-Invest: ошибка — ' . $brokerMeta['tinkoff']['error'], 'tcs');
        $progress->finish('tcs_portfolios', '', 'tcs');
    }
    $brokerMeta['tinkoff']['durationMs'] = (int)((microtime(true) - $t0) * 1000);
}

// ---------- Этап 3: реестр облигаций (T-Invest или кэш) ----------
$cachedBonds = null;
if (is_file(BONDS_CACHE)) {
    $cachedBonds = json_decode((string)file_get_contents(BONDS_CACHE), true);
    if (!is_array($cachedBonds) || !isset($cachedBonds['bonds'])) $cachedBonds = null;
}
$ttl = (int)($syncCfg['bondsCacheTtlHours'] ?? 24) * 3600;

if ($tcsClient !== null) {
    $progress->step('bonds', 0.15, 'Справочник облигаций T-Invest…', 'tcs');
    $cacheFresh = $cachedBonds !== null && (time() - strtotime((string)$cachedBonds['cachedAt'])) < $ttl;
    if ($cacheFresh) {
        $bonds = $cachedBonds['bonds'];
        $progress->finish('bonds', 'Справочник облигаций: из кэша (' . count($bonds) . ')', 'tcs');
    } else {
        $progress->step('bonds', 0.4, 'Загрузка справочника облигаций (может занять минуту)…', 'tcs');
        try {
            $bonds = $tcsClient->getAllBonds();
            @file_put_contents(BONDS_CACHE, json_encode(['cachedAt' => date('c'), 'bonds' => $bonds], JSON_UNESCAPED_UNICODE));
            $progress->finish('bonds', 'Справочник облигаций: ' . count($bonds) . ' шт (обновлён)', 'tcs');
        } catch (Throwable $e) {
            // Протухший кэш лучше, чем ничего: номиналы нужны для конвертации Finam
            if ($cachedBonds !== null) {
                $bonds = $cachedBonds['bonds'];
                $progress->finish('bonds', 'Справочник: обновление не удалось, используется кэш (' . count($bonds) . ')', 'tcs');
            } else {
                $progress->finish('bonds', 'Справочник облигаций недоступен: ' . mb_substr($e->getMessage(), 0, 120), 'tcs');
            }
        }
    }
} elseif ($cachedBonds !== null) {
    // Finam-only режим: номиналы облигаций берём из кэша
    $bonds = $cachedBonds['bonds'];
    $progress->finish('bonds', 'Справочник облигаций: из кэша (' . count($bonds) . ')', 'system');
} else {
    $progress->finish('bonds', 'Справочник облигаций недоступен (номинал по умолчанию 1000 ₽)', 'system');
}

// ---------- Этап 4: конвертация Finam-позиций + обогащение облигаций ----------
$progress->finish('finalize', 'Слияние позиций и расчёт итогов…');

$bondLookup = buildBondLookup($bonds);
foreach ($finamRawPositions as $pos) {
    mergeFinamPosition($holdings, $pos, findBond($bondLookup, tickerFromSymbol($pos['symbol'])));
}
foreach ($holdings as &$h) {
    if ($h['instrumentType'] !== 'bond') continue;
    $bond = findBond($bondLookup, $h['ticker'] !== '' ? $h['ticker'] : $h['figi']);
    if ($bond === null) continue;
    if ($bond['ticker'] !== '') $h['ticker'] = $bond['ticker'];
    if ($bond['name'] !== '') $h['name'] = $bond['name'];
    $h['nominal'] = $bond['nominal'];
    $h['sector'] = $bond['sector'];
    $h['couponPerYear'] = $bond['couponPerYear'];
    $h['maturityDate'] = $bond['maturityDate'];
}
unset($h);

// ---------- Этап 5: платежи (купоны + дивиденды) ----------
$anyOk = ($brokerMeta['tinkoff']['status'] === 'ok') || ($brokerMeta['finam']['status'] === 'ok');
if ($anyOk && $holdings !== []) {
    $keys = array_keys($holdings);
    $n = count($keys);
    foreach ($keys as $i => $key) {
        $h = $holdings[$key];
        $progress->step('payments', ($i + 1) / $n, 'Выплаты: ' . ($h['ticker'] ?: mb_substr($h['name'], 0, 20)), 'tcs');
        $payments = [];

        if ($tcsClient !== null && $h['figi'] !== '') {
            if ($h['instrumentType'] === 'bond') {
                foreach ($tcsClient->getCoupons($h['figi']) as $c) {
                    if ($c['currency'] === 'rub' && $c['date'] >= $today) $payments[] = $c;
                }
            } elseif (in_array($h['instrumentType'], ['share', 'etf'], true)) {
                foreach ($tcsClient->getDividends($h['figi']) as $d) {
                    if ($d['currency'] === 'rub' && $d['date'] >= $today) $payments[] = $d;
                }
            }
        }

        // Fallback: Finam future-dividends для позиций без выплат (нужен полный символ с «@»)
        if ($payments === [] && $finamClient !== null) {
            $symbol = $finamPositionsByTicker[$h['ticker']] ?? null;
            if ($symbol !== null) {
                foreach ($finamClient->getFutureDividends($symbol) as $d) {
                    if ($d['currency'] === 'rub' && $d['date'] >= $today) $payments[] = $d;
                }
            }
        }

        usort($payments, static fn($a, $b) => $a['date'] <=> $b['date']);
        foreach ($payments as &$p) $p['amountPerUnit'] = round((float)$p['amountPerUnit'], 4);
        unset($p);
        $h['payments'] = $payments;
        $holdings[$key] = $h;
    }
    $progress->finish('payments', 'Выплаты загружены', 'system');
} else {
    $progress->finish('payments', $holdings === [] ? 'Нет позиций' : 'Пропущено (нет связи с брокерами)', 'system');
}

// Все включённые брокеры упали — не перезаписываем последний хороший portfolio.json
if (!$anyOk) {
    emit(['event' => 'done', 'saved' => false,
        'totalMs' => (int)((microtime(true) - $startedAt) * 1000),
        'brokers' => $brokerMeta,
        'message' => 'Все брокеры недоступны — сохранены прежние данные']);
    flock($lockFp, LOCK_UN);
    exit;
}

// ---------- Этап 6: итоги + история + запись ----------
$result = computeTotals($holdings, $accounts);
$totalMs = (int)((microtime(true) - $startedAt) * 1000);

$portfolio = [
    'meta' => [
        'version' => 1,
        'generatedAt' => date('c'),
        'durationMs' => $totalMs,
        'brokers' => $brokerMeta,
    ],
    'accounts' => $accounts,
    'holdings' => $result['holdings'],
    'totals' => $result['totals'],
    'history' => [],
];

// История: один снапшот на день; мок-история не смешивается с реальной
$prev = is_file(PORTFOLIO_FILE) ? json_decode((string)file_get_contents(PORTFOLIO_FILE), true) : null;
$history = (is_array($prev) && empty($prev['meta']['mock']) && isset($prev['history']) && is_array($prev['history']))
    ? $prev['history'] : [];
$history = array_values(array_filter($history, static fn($e) => is_array($e) && ($e['date'] ?? '') !== $today));
$history[] = [
    'date' => $today,
    'value' => $portfolio['totals']['value'],
    'cost' => $portfolio['totals']['cost'],
    'pnl' => $portfolio['totals']['pnl'],
    'cash' => $portfolio['totals']['cash'],
];
usort($history, static fn($a, $b) => $a['date'] <=> $b['date']);
$limit = (int)($syncCfg['historyLimit'] ?? 365);
if (count($history) > $limit) $history = array_slice($history, -$limit);
$portfolio['history'] = $history;

$progress->finish('write', 'Сохранение portfolio.json…');
$saved = atomicWrite(PORTFOLIO_FILE, $portfolio);

emit(['event' => 'broker_status', 'broker' => 'tinkoff', 'status' => $brokerMeta['tinkoff']['status'], 'error' => $brokerMeta['tinkoff']['error']]);
emit(['event' => 'broker_status', 'broker' => 'finam', 'status' => $brokerMeta['finam']['status'], 'error' => $brokerMeta['finam']['error']]);
emit(['event' => 'done', 'saved' => $saved, 'totalMs' => $totalMs, 'brokers' => $brokerMeta,
    'portfolio' => [
        'value' => $portfolio['totals']['value'],
        'cost' => $portfolio['totals']['cost'],
        'pnl' => $portfolio['totals']['pnl'],
        'holdings' => count($portfolio['holdings']),
        'paymentsNext12m' => $portfolio['totals']['paymentsNext12m'],
    ]]);

flock($lockFp, LOCK_UN);
