<?php
/**
 * Авторизованный прокси на portfolio.json.
 * Сам файл закрыт от прямого веб-доступа в .htaccess (Apache/Herd);
 * дашборд читает его только через этот эндпоинт.
 */

require __DIR__ . '/auth.php';
auth_require();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$file = __DIR__ . '/portfolio.json';
if (!is_file($file)) {
    http_response_code(404);
    echo json_encode(['error' => 'portfolio.json ещё не создан'], JSON_UNESCAPED_UNICODE);
    exit;
}
readfile($file);
