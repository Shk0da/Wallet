<?php
/**
 * Общая авторизация дашборда.
 * Пароль хранится в settings.json → auth.password.
 * Пустой (или отсутствующий) пароль = авторизация выключена — все эндпоинты открыты.
 *
 * Схема stateless: сессия = sha256('wallet-auth-v1|' + пароль). Передаётся двумя
 * равнозначными способами — cookie wallet_auth (HttpOnly, 30 дней) или заголовок
 * X-Wallet-Auth (запасной путь для браузеров, которые режут cookie: приватный
 * режим, блокировки и т.п.). Смена пароля в settings.json мгновенно
 * инвалидирует все сессии. Токены брокеров и сам пароль никогда не покидают сервер.
 */

const AUTH_COOKIE = 'wallet_auth';
const AUTH_TTL_DAYS = 30;

function auth_password(): string {
    $raw = @file_get_contents(__DIR__ . '/settings.json');
    if (!is_string($raw) || $raw === '') return '';
    $s = json_decode($raw, true);
    if (!is_array($s)) return '';
    $auth = $s['auth'] ?? null;
    if (!is_array($auth)) return '';
    return isset($auth['password']) && is_string($auth['password']) ? $auth['password'] : '';
}

function auth_enabled(): bool {
    return auth_password() !== '';
}

function auth_token(string $password): string {
    return hash('sha256', 'wallet-auth-v1|' . $password);
}

/** true — доступ разрешён (в т.ч. когда авторизация выключена). */
function auth_check(): bool {
    if (!auth_enabled()) return true;
    $expected = auth_token(auth_password());
    $cookie = $_COOKIE[AUTH_COOKIE] ?? '';
    if (is_string($cookie) && $cookie !== '' && hash_equals($expected, $cookie)) return true;
    $header = $_SERVER['HTTP_X_WALLET_AUTH'] ?? '';
    return is_string($header) && $header !== '' && hash_equals($expected, $header);
}

function auth_send_401(): void {
    http_response_code(401);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'authRequired' => true, 'error' => 'Требуется авторизация'], JSON_UNESCAPED_UNICODE);
    exit;
}

/** Guard для защищённых эндпоинтов (api.php, sync.php, portfolio.php). */
function auth_require(): void {
    if (!auth_check()) auth_send_401();
}
