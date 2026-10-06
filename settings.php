<?php
/**
 * Настройки сервера из модалки «⚙️ Настройки» (веб-режим): токены брокеров
 * и пароль доступа. APK хранит токены в localStorage и сюда не ходит —
 * там же авторизации нет.
 *
 * GET  → { success, passwordSet, tinkoff: {set, tail}, finam: {set, tail} }
 *        Значения токенов НЕ отдаются никогда — только «задан/не задан»
 *        и последние 4 символа для узнавания в placeholder.
 *        Исключение — GET ?export=tokens (тот же auth_require): полные токены
 *        для чекбокса «включать токены в бэкап» в backup.js.
 * POST → { tinkoffToken?, finamToken?, password? } — только переданные поля:
 *        токен: непустая строка = заменить, отсутствует/пустая = не трогать;
 *        пароль: строка = установить ('' = выключить), отсутствует = не трогать.
 *        При смене пароля все прежние сессии инвалидируются (токен = sha256
 *        от пароля), поэтому ответ содержит свежий token для cookie/заголовка.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require __DIR__ . '/auth.php';
auth_require();

const SETTINGS_FILE = __DIR__ . '/settings.json';

/** Дефолты те же, что создаёт sync.php при первом запуске. */
function settings_defaults(): array {
    return [
        'brokers' => [
            'tinkoff' => ['enabled' => true, 'apiKey' => ''],
            'finam'   => ['enabled' => true, 'apiKey' => '', 'accountId' => ''],
        ],
        'sync' => [
            'mock' => false,
            'insecureSsl' => true,
            'requestTimeoutSec' => 30,
            'bondsCacheTtlHours' => 24,
            'historyLimit' => 365,
        ],
        'auth' => ['password' => ''],
    ];
}

/** Чтение settings.json слиянием с дефолтами (как load_settings в sync.php). */
function settings_load(): array {
    $settings = settings_defaults();
    if (is_file(SETTINGS_FILE)) {
        $decoded = json_decode((string)file_get_contents(SETTINGS_FILE), true);
        if (is_array($decoded)) {
            foreach ($settings as $section => $values) {
                if (isset($decoded[$section]) && is_array($decoded[$section])) {
                    $settings[$section] = array_merge($values, $decoded[$section]);
                }
            }
            // неизвестные секции не теряем при перезаписи
            foreach ($decoded as $section => $values) {
                if (!isset($settings[$section])) $settings[$section] = $values;
            }
        }
    }
    return $settings;
}

/** Атомарная запись: tmp + rename под flock (как api.php). */
function settings_save(array $settings): bool {
    $json = json_encode($settings, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    if ($json === false) return false;
    $tmp = SETTINGS_FILE . '.tmp';
    $fp = fopen($tmp, 'c');
    if ($fp === false) return false;
    flock($fp, LOCK_EX);
    ftruncate($fp, 0);
    fwrite($fp, $json);
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return rename($tmp, SETTINGS_FILE);
}

/** «…abcd» — узнаваемый хвост токена для placeholder (не секрет). */
function token_tail(string $token): string {
    return $token === '' ? '' : '…' . substr($token, -4);
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $s = settings_load();
    $t = $s['brokers']['tinkoff']['apiKey'] ?? '';
    $f = $s['brokers']['finam']['apiKey'] ?? '';

    // Полные токены — только явному запросу экспорта бэкапа (авторизация уже пройдена)
    if (($_GET['export'] ?? '') === 'tokens') {
        echo json_encode([
            'success' => true,
            'tinkoffToken' => $t,
            'finamToken' => $f,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode([
        'success' => true,
        'passwordSet' => auth_enabled(),
        'tinkoff' => ['set' => $t !== '', 'tail' => token_tail($t)],
        'finam'   => ['set' => $f !== '', 'tail' => token_tail($f)],
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Неверный формат JSON'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $s = settings_load();
    $changed = false;

    foreach (['tinkoff', 'finam'] as $broker) {
        $key = $broker . 'Token';
        if (isset($input[$key]) && is_string($input[$key]) && $input[$key] !== '') {
            $s['brokers'][$broker]['apiKey'] = $input[$key];
            $changed = true;
        }
    }

    $newPassword = null;
    if (array_key_exists('password', $input) && is_string($input['password'])) {
        $newPassword = $input['password'];
        $s['auth']['password'] = $newPassword;
        $changed = true;
    }

    if (!$changed) {
        echo json_encode(['success' => true, 'message' => 'Нет изменений'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (!settings_save($s)) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Не удалось записать settings.json (права на каталог?)'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $resp = ['success' => true, 'message' => 'Настройки сохранены'];
    if ($newPassword !== null && $newPassword !== '') {
        // Смена пароля убила текущую сессию — выдаём свежий токен и cookie
        $token = auth_token($newPassword);
        $resp['token'] = $token;
        setcookie(AUTH_COOKIE, $token, time() + AUTH_TTL_DAYS * 86400, '', '', false, true);
    }
    echo json_encode($resp, JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(405);
echo json_encode(['success' => false, 'error' => 'Метод не поддерживается'], JSON_UNESCAPED_UNICODE);
