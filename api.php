<?php
/**
 * API для работы с данными финансового календаря
 * Поддерживает GET (получение) и POST (сохранение) запросы
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Обработка preflight запроса
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

// Авторизация: пароль в settings.json → auth.password (пустой = выключена)
require __DIR__ . '/auth.php';
auth_require();

$dataFile = __DIR__ . '/data.json';

// GET - получение данных
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (file_exists($dataFile)) {
        $content = file_get_contents($dataFile);
        $data = json_decode($content, true);
        
        if (json_last_error() === JSON_ERROR_NONE) {
            echo json_encode([
                'success' => true,
                'data' => $data
            ], JSON_UNESCAPED_UNICODE);
        } else {
            echo json_encode([
                'success' => false,
                'error' => 'Ошибка чтения данных: неверный формат JSON'
            ], JSON_UNESCAPED_UNICODE);
        }
    } else {
        // Файл не существует - возвращаем пустые данные
        echo json_encode([
            'success' => true,
            'data' => [
                'transactions' => [],
                'categories' => [],
                'occurrences' => []
            ]
        ], JSON_UNESCAPED_UNICODE);
    }
    exit();
}

// POST - сохранение данных
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = file_get_contents('php://input');
    $data = json_decode($input, true);
    
    if (json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(400);
        echo json_encode([
            'success' => false,
            'error' => 'Неверный формат JSON'
        ], JSON_UNESCAPED_UNICODE);
        exit();
    }
    
    // Валидация данных
    $validatedData = [
        'transactions' => isset($data['transactions']) && is_array($data['transactions']) ? $data['transactions'] : [],
        'categories' => isset($data['categories']) && is_array($data['categories']) ? $data['categories'] : [],
        'occurrences' => isset($data['occurrences']) && is_array($data['occurrences']) ? $data['occurrences'] : []
    ];

    // Необязательный конфиг инвестиций (распределение по брокерам, прогноз)
    if (isset($data['investmentConfig']) && is_array($data['investmentConfig'])) {
        $validatedData['investmentConfig'] = $data['investmentConfig'];
    }

    // Атомарная запись: tmp + rename под блокировкой
    // (параллельные сохранения не портят файл, читатель никогда не видит половину JSON)
    $tmpFile = $dataFile . '.tmp';
    $json = json_encode($validatedData, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    $written = false;
    if ($json !== false) {
        $fp = fopen($tmpFile, 'c');
        if ($fp !== false) {
            flock($fp, LOCK_EX);
            ftruncate($fp, 0);
            fwrite($fp, $json);
            fflush($fp);
            flock($fp, LOCK_UN);
            fclose($fp);
            $written = rename($tmpFile, $dataFile);
        }
    }

    // Сохранение в файл
    if ($written) {
        echo json_encode([
            'success' => true,
            'message' => 'Данные успешно сохранены'
        ], JSON_UNESCAPED_UNICODE);
    } else {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Ошибка записи данных'
        ], JSON_UNESCAPED_UNICODE);
    }
    exit();
}

// Метод не поддерживается
http_response_code(405);
echo json_encode([
    'success' => false,
    'error' => 'Метод не поддерживается'
], JSON_UNESCAPED_UNICODE);
