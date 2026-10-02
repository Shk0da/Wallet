<?php
/**
 * Вход/выход для авторизации дашборда.
 * GET                          → {authRequired, authenticated} — статус для фронтенда
 * POST {password}              → вход: cookie wallet_auth (HttpOnly, SameSite=Lax, 30 дней)
 *                                + token в ответе (запасной путь через заголовок X-Wallet-Auth
 *                                для браузеров, которые не сохраняют cookie)
 * POST {action: "logout"}      → выход, гасит cookie
 */

require __DIR__ . '/auth.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode(['success' => true, 'authRequired' => auth_enabled(), 'authenticated' => auth_check()]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Метод не поддерживается'], JSON_UNESCAPED_UNICODE);
    exit;
}

$input = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($input)) $input = [];

// --- Выход ---
if (($input['action'] ?? '') === 'logout') {
    setcookie(AUTH_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
    echo json_encode(['success' => true, 'authenticated' => false]);
    exit;
}

// --- Авторизация выключена: пароль не нужен ---
if (!auth_enabled()) {
    echo json_encode(['success' => true, 'authRequired' => false, 'authenticated' => true]);
    exit;
}

$password = (string)($input['password'] ?? '');
if ($password === '' || !hash_equals(auth_password(), $password)) {
    usleep(500000); // замедляем перебор
    http_response_code(401);
    echo json_encode(['success' => false, 'error' => 'Неверный пароль'], JSON_UNESCAPED_UNICODE);
    exit;
}

$token = auth_token($password);
setcookie(AUTH_COOKIE, $token, [
    'expires'  => time() + AUTH_TTL_DAYS * 86400,
    'path'     => '/',
    'httponly' => true,
    'samesite' => 'Lax',
    // secure => false: приложение живёт на localhost и может быть без https
]);
echo json_encode(['success' => true, 'authRequired' => true, 'authenticated' => true, 'token' => $token]);
