<?php
// Minimal echo origin for the WAF verification. It reports what reached PHP-FPM:
// the request shape, the WAF headers inserted by Count rules, and the effective
// php.ini mitigations. It never executes or stores request content.

declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store');

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/**
 * Headers added by AWS WAF Count actions (custom request handling).
 * WAF prefixes every inserted header name with "x-amzn-waf-".
 */
function wafHeaders(): array
{
    $result = [];
    foreach ($_SERVER as $key => $value) {
        if (str_starts_with($key, 'HTTP_X_AMZN_WAF_')) {
            $name = strtolower(str_replace('_', '-', substr($key, 5)));
            $result[$name] = $value;
        }
    }
    ksort($result);
    return $result;
}

/** Encode as a JSON object even when empty (json_encode([]) would give "[]"). */
function asObject(array $values): object
{
    return (object) $values;
}

function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES) . "\n";
}

if ($path === '/health') {
    respond(200, ['status' => 'ok']);
    return;
}

if ($path === '/info') {
    respond(200, [
        'phpVersion' => PHP_VERSION,
        'sapi' => PHP_SAPI,
        'ini' => [
            'session.upload_progress.enabled' => ini_get('session.upload_progress.enabled'),
            'memory_limit' => ini_get('memory_limit'),
            'post_max_size' => ini_get('post_max_size'),
            'upload_max_filesize' => ini_get('upload_max_filesize'),
        ],
        'workerPid' => getmypid(),
    ]);
    return;
}

if ($method === 'POST') {
    // Mirror a typical upload handler: a session plus $_POST / $_FILES parsing.
    // Upload progress tracking is disabled in php.ini, so the session never records it.
    session_start();
    $files = [];
    foreach ($_FILES as $field => $file) {
        $files[] = ['field' => $field, 'size' => $file['size'] ?? null, 'error' => $file['error'] ?? null];
    }
    respond(200, [
        'result' => 'reached-origin',
        'method' => $method,
        'path' => $path,
        'contentType' => $_SERVER['CONTENT_TYPE'] ?? null,
        'contentLength' => isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : null,
        'postFieldCount' => count($_POST),
        'files' => $files,
        'wafHeaders' => asObject(wafHeaders()),
        'phpVersion' => PHP_VERSION,
        'workerPid' => getmypid(),
    ]);
    session_write_close();
    return;
}

respond(200, [
    'result' => 'reached-origin',
    'method' => $method,
    'path' => $path,
    'wafHeaders' => asObject(wafHeaders()),
]);
