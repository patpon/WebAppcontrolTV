<?php
/*
 * Admin API for self-hosted deployments (PHP shared hosting, PHP 7.2+).
 *
 * The TV screens only ever read the static file data/config.json; this API is
 * used by admin.html to save it and to upload media. Auth is a password set on
 * first use (stored hashed in api/secret.php, never committed) that yields a
 * signed token.
 *
 *   GET  ?action=status                 -> { setup, maxUpload, writable }
 *   POST ?action=setup     {password}   -> { token }   (only while no password exists)
 *   POST ?action=login     {password}   -> { token }
 *   POST ?action=password  {old, new}   -> { token }   (auth)
 *   GET  ?action=whoami                 -> { ok }      (auth)
 *   GET  ?action=config                 -> data/config.json (fresh, uncached)
 *   POST ?action=save      {config, deletes[]}         (auth)
 *   POST ?action=upload    multipart: path, uploadId, index, total, chunk   (auth)
 */

require __DIR__ . '/lib.php';

/* ---------- actions ---------- */
$action = isset($_GET['action']) ? $_GET['action'] : '';

switch ($action) {
    case 'status':
        out(array(
            'ok' => true,
            'setup' => secret() !== null,
            'maxUpload' => min(ini_bytes(ini_get('upload_max_filesize')), ini_bytes(ini_get('post_max_size'))),
            'writable' => is_writable(ROOT . '/data') && is_writable(MEDIA_DIR) && is_writable(__DIR__),
            'php' => PHP_VERSION
        ));

    case 'setup':
        require_post();
        if (secret()) fail('ตั้งรหัสผ่านไปแล้ว', 409);
        $b = body_json();
        $pw = isset($b['password']) ? (string)$b['password'] : '';
        if (pw_len($pw) < MIN_PASSWORD) fail('รหัสผ่านต้องยาวอย่างน้อย ' . MIN_PASSWORD . ' ตัว');
        out(array('ok' => true, 'token' => make_token(write_secret($pw))));

    case 'login':
        require_post();
        $b = body_json();
        check_password(isset($b['password']) ? $b['password'] : '');
        out(array('ok' => true, 'token' => make_token(secret())));

    case 'password':
        require_post();
        require_auth();
        $b = body_json();
        check_password(isset($b['old']) ? $b['old'] : '');
        $new = isset($b['new']) ? (string)$b['new'] : '';
        if (pw_len($new) < MIN_PASSWORD) fail('รหัสผ่านใหม่ต้องยาวอย่างน้อย ' . MIN_PASSWORD . ' ตัว');
        // new key = every other logged-in device is signed out
        out(array('ok' => true, 'token' => make_token(write_secret($new))));

    case 'whoami':
        require_auth();
        out(array('ok' => true));

    case 'config':
        if (!is_file(CONFIG_FILE)) fail('config.json not found', 404);
        readfile(CONFIG_FILE);
        exit;

    case 'save':
        require_post();
        require_auth();
        $b = body_json();
        $cfg = isset($b['config']) ? $b['config'] : null;
        if (!is_array($cfg) || !isset($cfg['rooms']) || !isset($cfg['playlists'])) fail('invalid config');
        backup_config();
        write_atomic(CONFIG_FILE, json_encode($cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
        $deleted = 0;
        if (isset($b['deletes']) && is_array($b['deletes'])) {
            foreach ($b['deletes'] as $p) {
                if (is_string($p) && preg_match(MEDIA_RE, $p) && is_file(ROOT . '/' . $p) && @unlink(ROOT . '/' . $p)) $deleted++;
            }
        }
        out(array('ok' => true, 'deleted' => $deleted));

    case 'upload':
        require_post();
        require_auth();
        $path = isset($_POST['path']) ? (string)$_POST['path'] : '';
        $id = isset($_POST['uploadId']) ? (string)$_POST['uploadId'] : '';
        $index = isset($_POST['index']) ? (int)$_POST['index'] : -1;
        $total = isset($_POST['total']) ? (int)$_POST['total'] : 0;
        if (!preg_match(MEDIA_RE, $path)) fail('ชื่อไฟล์ไม่ถูกต้อง');
        if (!preg_match('/^[a-z0-9]{6,40}$/', $id) || $index < 0 || $total < 1 || $index >= $total) fail('bad chunk');
        if (!isset($_FILES['chunk']) || $_FILES['chunk']['error'] !== UPLOAD_ERR_OK) {
            $err = isset($_FILES['chunk']) ? $_FILES['chunk']['error'] : -1;
            fail($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE ? 'ไฟล์ส่วนนี้ใหญ่เกินที่ Host อนุญาต' : 'อัปโหลดไม่สำเร็จ (code ' . $err . ')');
        }
        private_dir(TMP_DIR);
        $part = TMP_DIR . '/' . $id . '.part';
        $in = fopen($_FILES['chunk']['tmp_name'], 'rb');
        $outF = fopen($part, $index === 0 ? 'wb' : 'ab');
        if (!$in || !$outF) fail('cannot write upload', 500);
        stream_copy_to_stream($in, $outF);
        fclose($in);
        fclose($outF);
        if ($index < $total - 1) out(array('ok' => true, 'received' => $index + 1));

        // last chunk: check the real file type matches the extension, then publish it
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $mime = function_exists('mime_content_type') ? (string)mime_content_type($part) : '';
        $isVideo = in_array($ext, array('mp4', 'webm'), true);
        if ($mime !== '' && strpos($mime, $isVideo ? 'video/' : 'image/') !== 0 && $mime !== 'application/octet-stream') {
            @unlink($part);
            fail('ชนิดไฟล์ไม่ตรงกับนามสกุล (' . $mime . ')');
        }
        if (!is_dir(MEDIA_DIR)) @mkdir(MEDIA_DIR, 0755, true);
        if (!@rename($part, ROOT . '/' . $path)) { @unlink($part); fail('cannot save media', 500); }
        @chmod(ROOT . '/' . $path, 0644);
        // tidy abandoned uploads older than a day
        foreach ((glob(TMP_DIR . '/*.part') ?: array()) as $old) if (filemtime($old) < time() - 86400) @unlink($old);
        out(array('ok' => true, 'path' => $path, 'size' => filesize(ROOT . '/' . $path)));

    default:
        fail('unknown action', 404);
}
