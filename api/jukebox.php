<?php
/*
 * Jukebox API: a shared song queue for the shop's background-music player (music.html),
 * filled by guests (request.html via QR) and staff. Songs are YouTube videos played through
 * the official embedded player; nothing is downloaded.
 *
 * Public
 *   GET  ?action=state[&dev=]            -> queue, now playing, player status (dev marks "my" songs)
 *   GET  ?action=search&q=               -> YouTube search (needs a YouTube Data API key in settings)
 *   POST ?action=add  {url|vid, name, room, dev[, next]}   guests are limited by the settings
 * Staff (X-Auth token from api/index.php login)
 *   POST ?action=cmd      {type: skip|pause|play|volume|remove|top|up|down|clear, id?, value?}
 *   POST ?action=settings {settings}
 * Player (staff token)
 *   POST ?action=report   {id, pos, dur, paused, volume}  heartbeat; returns state
 *   POST ?action=advance  {from, error?}                   current song ended or failed
 *   POST ?action=library  {hash, songs:[{p, t}]}          music files in the player PC's folder
 *
 * Songs are either YouTube videos (kind "yt", vid) or files in a folder on the shop PC (kind "local",
 * path relative to that folder). Local files never leave the PC: only their names are sent here so
 * guests can search and request them; music.html plays them straight from the disk.
 *
 * Files live in data/jukebox/ as .php files that exit immediately (see backup_config in lib.php),
 * because nginx on Plesk serves static files without reading .htaccess.
 */

require __DIR__ . '/lib.php';

define('JB_DIR', ROOT . '/data/jukebox');
define('JB_MAX_QUEUE', 100);
define('JB_HISTORY', 40);
define('JB_MAX_LIBRARY', 30000);
define('JB_DAILY_SEARCHES', 90); // free quota is 10,000 units/day and one search costs ~101
define('JB_GUARD', "<?php http_response_code(404); exit; ?>\n");

function jb_defaults()
{
    return array(
        'guestRequests' => true,
        'maxPerGuest' => 2,
        'maxMinutes' => 0, // 0 = no length limit
        'noRepeatMinutes' => 60,
        'interruptFallback' => true,
        'fallbackShuffle' => true,
        'fallbackSource' => 'both', // youtube | local | both
        'fallback' => '',
        'blockWords' => '',
        'apiKey' => ''
    );
}

/* ---------- storage ---------- */
function jb_file($name) { return JB_DIR . '/' . $name . '.php'; }

function jb_read($name, $default)
{
    $f = jb_file($name);
    if (!is_file($f)) return $default;
    $raw = (string)file_get_contents($f);
    $d = json_decode(substr($raw, strpos($raw, "\n") + 1), true);
    return is_array($d) ? $d : $default;
}

function jb_write($name, $data)
{
    private_dir(JB_DIR);
    write_atomic(jb_file($name), JB_GUARD . json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

$JB_LOCK = null;
function jb_lock()
{
    global $JB_LOCK;
    private_dir(JB_DIR);
    $JB_LOCK = fopen(JB_DIR . '/lock', 'c');
    if ($JB_LOCK) flock($JB_LOCK, LOCK_EX);
}

function jb_settings()
{
    return array_merge(jb_defaults(), jb_read('settings', array()));
}

function jb_state()
{
    return array_merge(array(
        'rev' => 0, 'now' => null, 'queue' => array(), 'history' => array(),
        'ctl' => array('paused' => false, 'volume' => 80), 'resume' => null, 'poolPos' => 0
    ), jb_read('state', array()));
}

function jb_save_state(&$st)
{
    $st['rev'] = (int)$st['rev'] + 1;
    jb_write('state', $st);
}

/* ---------- http ---------- */
function http_get($url)
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, array(
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_FOLLOWLOCATION => true, CURLOPT_USERAGENT => 'rabiangbua-jukebox/1.0'
        ));
        $body = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if (PHP_VERSION_ID < 80000) curl_close($ch); // no-op since 8.0, deprecated in 8.5
        return array($code, $body === false ? '' : $body);
    }
    $ctx = stream_context_create(array('http' => array('timeout' => 8, 'ignore_errors' => true, 'header' => "User-Agent: rabiangbua-jukebox/1.0\r\n")));
    $body = @file_get_contents($url, false, $ctx);
    $code = 0;
    if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s?/', $http_response_header[0], $m)) $code = (int)$m[1];
    return array($code, $body === false ? '' : $body);
}

function yt_api($path, $params, $key)
{
    $params['key'] = $key;
    list($code, $body) = http_get('https://www.googleapis.com/youtube/v3/' . $path . '?' . http_build_query($params));
    $d = json_decode($body, true);
    if ($code !== 200 || !is_array($d)) {
        $reason = isset($d['error']['errors'][0]['reason']) ? $d['error']['errors'][0]['reason'] : ('HTTP ' . $code);
        if ($reason === 'quotaExceeded' || $reason === 'dailyLimitExceeded') fail('โควตาค้นหา YouTube วันนี้หมดแล้ว — วางลิงก์ YouTube แทนได้', 429);
        if ($reason === 'keyInvalid' || $reason === 'badRequest' || $code === 400 || $code === 403) fail('YouTube API key ใช้ไม่ได้ (' . $reason . ')', 502);
        fail('ติดต่อ YouTube ไม่ได้ (' . $reason . ')', 502);
    }
    return $d;
}

/* ISO 8601 duration (PT1H2M3S) -> seconds */
function iso_dur($s)
{
    if (!preg_match('/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/', (string)$s, $m)) return 0;
    $m = array_pad($m, 5, 0);
    return (int)$m[1] * 86400 + (int)$m[2] * 3600 + (int)$m[3] * 60 + (int)$m[4];
}

/* ---------- cache ---------- */
function cache_get($key, $ttl)
{
    $f = JB_DIR . '/cache/' . sha1($key) . '.php';
    if (!is_file($f) || filemtime($f) < time() - $ttl) return null;
    $raw = (string)file_get_contents($f);
    $d = json_decode(substr($raw, strpos($raw, "\n") + 1), true);
    return is_array($d) ? $d : null;
}

function cache_put($key, $data)
{
    private_dir(JB_DIR . '/cache');
    file_put_contents(JB_DIR . '/cache/' . sha1($key) . '.php', JB_GUARD . json_encode($data, JSON_UNESCAPED_UNICODE), LOCK_EX);
    if (mt_rand(1, 50) === 1) { // tidy old entries now and then
        foreach ((glob(JB_DIR . '/cache/*.php') ?: array()) as $old) if (filemtime($old) < time() - 30 * 86400) @unlink($old);
    }
}

/* ---------- rate limits ---------- */
/* $who: client_id() for per-IP limits, or the guest's device id. Guests on the shop Wi-Fi share one IP,
   so per-IP limits are loose and the tight ones are per device. */
function limit_hit($kind, $max, $window, $who)
{
    $now = time();
    $d = jb_read('limits', array('events' => array(), 'day' => '', 'searches' => 0));
    if (!isset($d['events']) || !is_array($d['events'])) $d['events'] = array();
    $ip = substr((string)$who, 0, 40);
    $n = 0;
    $keep = array();
    foreach ($d['events'] as $e) {
        if ($e['t'] < $now - 3600) continue;
        $keep[] = $e;
        if ($e['k'] === $kind && $e['ip'] === $ip && $e['t'] > $now - $window) $n++;
    }
    if ($n >= $max) return true;
    $keep[] = array('k' => $kind, 'ip' => $ip, 't' => $now);
    $d['events'] = $keep;
    jb_write('limits', $d);
    return false;
}

function daily_search_ok()
{
    $d = jb_read('limits', array('events' => array(), 'day' => '', 'searches' => 0));
    $today = date('Ymd');
    if ($d['day'] !== $today) { $d['day'] = $today; $d['searches'] = 0; }
    if ($d['searches'] >= JB_DAILY_SEARCHES) return false;
    $d['searches']++;
    jb_write('limits', $d);
    return true;
}

/* ---------- youtube lookups ---------- */
function parse_vid($s)
{
    $s = trim((string)$s);
    if (preg_match('/^[A-Za-z0-9_-]{11}$/', $s)) return $s;
    if (preg_match('~(?:youtu\.be/|[?&]v=|/embed/|/shorts/|/live/)([A-Za-z0-9_-]{11})~', $s, $m)) return $m[1];
    return '';
}

function parse_list($s)
{
    return preg_match('~[?&]list=([A-Za-z0-9_-]{10,64})~', (string)$s, $m) ? $m[1] : '';
}

/* title/channel/duration of one video, or fail() with a message guests can read */
function video_meta($vid, $key)
{
    $c = cache_get('meta:' . $vid, 30 * 86400);
    if ($c) return $c;
    if ($key !== '') {
        $d = yt_api('videos', array('part' => 'snippet,contentDetails,status', 'id' => $vid), $key);
        if (empty($d['items'])) fail('ไม่พบวิดีโอนี้ใน YouTube', 404);
        $v = $d['items'][0];
        if (empty($v['status']['embeddable'])) fail('เจ้าของวิดีโอไม่อนุญาตให้เปิดนอก YouTube — ลองเลือกเวอร์ชันอื่น');
        $blocked = isset($v['contentDetails']['regionRestriction']['blocked']) ? $v['contentDetails']['regionRestriction']['blocked'] : array();
        if (in_array('TH', $blocked, true)) fail('วิดีโอนี้เปิดในประเทศไทยไม่ได้');
        $meta = array('title' => $v['snippet']['title'], 'channel' => $v['snippet']['channelTitle'], 'dur' => iso_dur($v['contentDetails']['duration']));
    } else {
        // oEmbed needs no key; it answers 401 when embedding is disabled
        list($code, $body) = http_get('https://www.youtube.com/oembed?format=json&url=' . rawurlencode('https://www.youtube.com/watch?v=' . $vid));
        if ($code === 401 || $code === 403) fail('เจ้าของวิดีโอไม่อนุญาตให้เปิดนอก YouTube — ลองเลือกเวอร์ชันอื่น');
        if ($code === 404 || $code === 400) fail('ไม่พบวิดีโอนี้ใน YouTube', 404);
        $d = json_decode($body, true);
        if ($code !== 200 || !is_array($d)) fail('ติดต่อ YouTube ไม่ได้ ลองใหม่อีกครั้ง', 502);
        $meta = array('title' => (string)$d['title'], 'channel' => isset($d['author_name']) ? (string)$d['author_name'] : '', 'dur' => 0);
    }
    cache_put('meta:' . $vid, $meta);
    return $meta;
}

function yt_search($q, $key, $musicOnly)
{
    $ck = 'search:' . ($musicOnly ? 'm:' : 'a:') . mb_strtolower($q, 'UTF-8');
    $c = cache_get($ck, 3 * 86400);
    if ($c) return $c;
    if (!daily_search_ok()) fail('ค้นหาครบจำนวนต่อวันแล้ว — วางลิงก์ YouTube แทนได้', 429);
    $p = array('part' => 'snippet', 'type' => 'video', 'videoEmbeddable' => 'true', 'maxResults' => 15,
        'regionCode' => 'TH', 'relevanceLanguage' => 'th', 'safeSearch' => 'moderate', 'q' => $q);
    if ($musicOnly) $p['videoCategoryId'] = '10';
    $s = yt_api('search', $p, $key);
    $ids = array();
    foreach ($s['items'] as $it) if (isset($it['id']['videoId'])) $ids[] = $it['id']['videoId'];
    $out = array();
    if ($ids) {
        $d = yt_api('videos', array('part' => 'snippet,contentDetails,status', 'id' => implode(',', $ids)), $key);
        foreach ($d['items'] as $v) {
            if (empty($v['status']['embeddable'])) continue;
            $blocked = isset($v['contentDetails']['regionRestriction']['blocked']) ? $v['contentDetails']['regionRestriction']['blocked'] : array();
            if (in_array('TH', $blocked, true)) continue;
            $meta = array('title' => $v['snippet']['title'], 'channel' => $v['snippet']['channelTitle'], 'dur' => iso_dur($v['contentDetails']['duration']));
            cache_put('meta:' . $v['id'], $meta);
            $out[] = array_merge(array('vid' => $v['id']), $meta);
        }
    }
    cache_put($ck, $out);
    return $out;
}

/* fallback list: one YouTube link per line (videos or playlists) -> [{vid,title,dur}] */
function build_pool($text, $key, &$warn)
{
    $pool = array();
    $seen = array();
    foreach (preg_split('/\r?\n/', (string)$text) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        $list = parse_list($line);
        $vid = parse_vid($line);
        if ($list !== '' && $vid === '') {
            if ($key === '') { $warn[] = 'เพลย์ลิสต์ต้องใช้ YouTube API key: ' . $line; continue; }
            $token = '';
            for ($page = 0; $page < 6; $page++) { // up to 300 songs per playlist
                $p = array('part' => 'snippet,contentDetails', 'playlistId' => $list, 'maxResults' => 50);
                if ($token !== '') $p['pageToken'] = $token;
                $d = yt_api('playlistItems', $p, $key);
                foreach ($d['items'] as $it) {
                    $v = isset($it['contentDetails']['videoId']) ? $it['contentDetails']['videoId'] : '';
                    if ($v === '' || isset($seen[$v])) continue;
                    $t = $it['snippet']['title'];
                    if ($t === 'Private video' || $t === 'Deleted video') continue;
                    $seen[$v] = 1;
                    $pool[] = array('vid' => $v, 'title' => $t, 'dur' => 0);
                }
                if (empty($d['nextPageToken'])) break;
                $token = $d['nextPageToken'];
            }
        } elseif ($vid !== '') {
            if (isset($seen[$vid])) continue;
            $seen[$vid] = 1;
            $meta = array('title' => 'YouTube ' . $vid, 'dur' => 0);
            $c = cache_get('meta:' . $vid, 30 * 86400);
            if ($c) $meta = $c;
            else {
                list($code, $body) = http_get('https://www.youtube.com/oembed?format=json&url=' . rawurlencode('https://www.youtube.com/watch?v=' . $vid));
                $d = json_decode($body, true);
                if ($code === 401 || $code === 403) { $warn[] = 'วิดีโอนี้เปิดนอก YouTube ไม่ได้: ' . $line; continue; }
                if ($code === 200 && is_array($d)) $meta = array('title' => (string)$d['title'], 'channel' => isset($d['author_name']) ? $d['author_name'] : '', 'dur' => 0);
            }
            $pool[] = array('vid' => $vid, 'title' => $meta['title'], 'dur' => (int)$meta['dur']);
        } else {
            $warn[] = 'อ่านลิงก์ไม่ออก: ' . $line;
        }
    }
    return $pool;
}

/* ---------- local library ---------- */
function lib_meta() { return jb_read('libmeta', array('hash' => '', 'count' => 0)); }
function lib_songs() { $l = jb_read('library', array()); return isset($l['songs']) ? $l['songs'] : array(); }

function lib_find($path)
{
    foreach (lib_songs() as $x) if ($x['p'] === $path) return $x;
    return null;
}

/* every word of the query must appear in the file path ("artist - title.mp3", folder names) */
function lib_search($q)
{
    $words = preg_split('/\s+/u', mb_strtolower($q, 'UTF-8'), -1, PREG_SPLIT_NO_EMPTY);
    $out = array();
    foreach (lib_songs() as $x) {
        $hay = mb_strtolower($x['p'] . ' ' . $x['t'], 'UTF-8');
        $ok = true;
        foreach ($words as $w) if (mb_strpos($hay, $w) === false) { $ok = false; break; }
        if (!$ok) continue;
        $out[] = array('kind' => 'local', 'path' => $x['p'], 'title' => $x['t'], 'dur' => 0);
        if (count($out) >= 40) break;
    }
    return $out;
}

function ikey($it)
{
    return (isset($it['kind']) && $it['kind'] === 'local') ? 'L:' . $it['path'] : 'Y:' . $it['vid'];
}

/* songs the player may pick when nobody has requested anything */
function fallback_candidates($set)
{
    $c = array();
    if ($set['fallbackSource'] !== 'local') {
        foreach (jb_read('pool', array()) as $x) $c[] = array('kind' => 'yt', 'vid' => $x['vid'], 'path' => '', 'title' => $x['title'], 'dur' => (int)$x['dur']);
    }
    if ($set['fallbackSource'] !== 'youtube' && player_has_folder()) {
        foreach (lib_songs() as $x) $c[] = array('kind' => 'local', 'vid' => '', 'path' => $x['p'], 'title' => $x['t'], 'dur' => 0);
    }
    return $c;
}

/* the player reports whether it can read the folder (Chrome asks again after a restart until "allow on every visit") */
function player_has_folder()
{
    $p = jb_read('player', array());
    return !isset($p['local']) || $p['local'] || $p['seen'] < time() - 60;
}

function fallback_count($set)
{
    $n = 0;
    if ($set['fallbackSource'] !== 'local') $n += count(jb_read('pool', array()));
    if ($set['fallbackSource'] !== 'youtube' && player_has_folder()) $n += (int)lib_meta()['count'];
    return $n;
}

/* ---------- queue logic ---------- */
function new_item($vid, $meta, $src, $name, $room, $dev)
{
    return array(
        'id' => substr(bin2hex(random_bytes(6)), 0, 10), 'vid' => $vid,
        'kind' => isset($meta['kind']) ? $meta['kind'] : 'yt', 'path' => isset($meta['path']) ? (string)$meta['path'] : '',
        'title' => (string)$meta['title'], 'channel' => isset($meta['channel']) ? (string)$meta['channel'] : '',
        'dur' => isset($meta['dur']) ? (int)$meta['dur'] : 0, 'src' => $src,
        'by' => $name, 'room' => $room, 'dev' => $dev, 'at' => time(), 'start' => 0
    );
}

function push_history(&$st, $item, $note)
{
    if (!$item) return;
    array_unshift($st['history'], array('vid' => $item['vid'], 'key' => ikey($item),
        'kind' => isset($item['kind']) ? $item['kind'] : 'yt', 'title' => $item['title'], 'by' => $item['by'],
        'room' => $item['room'], 'src' => $item['src'], 'at' => time(), 'note' => $note));
    $st['history'] = array_slice($st['history'], 0, JB_HISTORY);
}

/* Move to the next song: queue first, then an interrupted fallback song, then the fallback pool. */
function advance(&$st, $set, $note)
{
    push_history($st, $st['now'], $note);
    $next = null;
    if ($st['queue']) {
        $next = array_shift($st['queue']);
    } elseif ($st['resume']) {
        $next = $st['resume'];
        $st['resume'] = null;
    } else {
        $pool = fallback_candidates($set);
        if ($pool) {
            if ($set['fallbackShuffle'] && count($pool) > 1) {
                $recent = array();
                foreach (array_slice($st['history'], 0, min(30, (int)floor(count($pool) / 2))) as $h) {
                    $recent[isset($h['key']) ? $h['key'] : 'Y:' . $h['vid']] = 1;
                }
                $pick = null;
                for ($try = 0; $try < 40 && !$pick; $try++) {
                    $c = $pool[mt_rand(0, count($pool) - 1)];
                    if (!isset($recent[ikey($c)])) $pick = $c;
                }
                if (!$pick) $pick = $pool[mt_rand(0, count($pool) - 1)];
            } else {
                $i = ((int)$st['poolPos']) % count($pool);
                $pick = $pool[$i];
                $st['poolPos'] = $i + 1;
            }
            $next = new_item($pick['vid'], $pick, 'fallback', '', '', '');
        }
    }
    if ($next) $next['startedAt'] = time();
    $st['now'] = $next;
}

/* fallback song is playing and a request arrives: remember where it was, start the request now */
function interrupt_fallback(&$st)
{
    $p = jb_read('player', array());
    if (isset($p['id']) && $p['id'] === $st['now']['id'] && (int)$p['pos'] > 20) {
        $r = $st['now'];
        $r['start'] = (int)$p['pos'];
        $r['id'] = substr(bin2hex(random_bytes(6)), 0, 10);
        $st['resume'] = $r;
    }
    advance($st, jb_settings(), 'interrupted');
}

function find_index($queue, $id)
{
    foreach ($queue as $i => $it) if ($it['id'] === $id) return $i;
    return -1;
}

function clean_text($s, $max)
{
    $s = (string)preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string)$s); // '' for invalid UTF-8
    $s = trim((string)preg_replace('/\s+/u', ' ', $s));
    return function_exists('mb_substr') ? mb_substr($s, 0, $max, 'UTF-8') : substr($s, 0, $max);
}

function public_state($st, $set, $staff)
{
    $dev = isset($_GET['dev']) ? substr((string)$_GET['dev'], 0, 40) : '';
    $strip = function ($it) use ($dev) {
        if (!$it) return null;
        $mine = $dev !== '' && $it['dev'] === $dev;
        unset($it['dev']);
        $it['mine'] = $mine;
        return $it;
    };
    $p = jb_read('player', array());
    $online = isset($p['seen']) && $p['seen'] > time() - 20;
    $lm = lib_meta();
    $out = array(
        'ok' => true, 'rev' => $st['rev'], 'time' => time(),
        'now' => $strip($st['now']),
        'queue' => array_map($strip, $st['queue']),
        'history' => array_slice(array_map(function ($h) {
            $kind = isset($h['kind']) ? $h['kind'] : 'yt';
            $path = $kind === 'local' && isset($h['key']) && substr($h['key'], 0, 2) === 'L:' ? substr($h['key'], 2) : '';
            return array('vid' => $h['vid'], 'kind' => $kind, 'path' => $path, 'title' => $h['title'], 'by' => $h['by'], 'src' => $h['src'],
                'at' => isset($h['at']) ? (int)$h['at'] : 0);
        }, $st['history']), 0, 10),
        'player' => array(
            'online' => $online,
            'pos' => isset($p['pos']) ? (int)$p['pos'] : 0,
            'dur' => isset($p['dur']) ? (int)$p['dur'] : 0,
            'id' => isset($p['id']) ? $p['id'] : '',
            'paused' => (bool)$st['ctl']['paused'],
            'volume' => (int)$st['ctl']['volume']
        ),
        'rules' => array(
            'guestRequests' => (bool)$set['guestRequests'], 'maxPerGuest' => (int)$set['maxPerGuest'],
            'maxMinutes' => (int)$set['maxMinutes'], 'canSearch' => $set['apiKey'] !== '',
            'hasFallback' => fallback_count($set) > 0,
            'hasLibrary' => (int)$lm['count'] > 0 && player_has_folder(),
            'libCount' => player_has_folder() ? (int)$lm['count'] : 0,
            'noRepeatMinutes' => (int)$set['noRepeatMinutes']
        ),
        'staff' => $staff
    );
    if ($staff) {
        $s = $set;
        unset($s['apiKey']);
        $s['hasKey'] = $set['apiKey'] !== '';
        $s['poolCount'] = count(jb_read('pool', array()));
        $s['libraryCount'] = (int)$lm['count'];
        $s['libraryHash'] = $lm['hash'];
        $s['libraryAt'] = isset($lm['at']) ? (int)$lm['at'] : 0;
        $s['playerFolder'] = player_has_folder();
        $lim = jb_read('limits', array('day' => '', 'searches' => 0));
        $s['searchesToday'] = $lim['day'] === date('Ymd') ? (int)$lim['searches'] : 0;
        $s['searchesMax'] = JB_DAILY_SEARCHES;
        $out['settings'] = $s;
        $out['resume'] = $st['resume'] ? array('title' => $st['resume']['title'], 'start' => $st['resume']['start']) : null;
    }
    return $out;
}

/* ---------- actions ---------- */
$action = isset($_GET['action']) ? $_GET['action'] : '';
$staff = auth_ok();

switch ($action) {
    case 'state':
        out(public_state(jb_state(), jb_settings(), $staff));

    case 'search':
        $set = jb_settings();
        if (!$staff && !$set['guestRequests']) fail('ตอนนี้ปิดรับขอเพลงชั่วคราว', 403);
        $q = clean_text(isset($_GET['q']) ? $_GET['q'] : '', 80);
        if (pw_len($q) < 2) fail('พิมพ์ชื่อเพลงอย่างน้อย 2 ตัว');
        if (isset($_GET['src']) && $_GET['src'] === 'local') out(array('ok' => true, 'results' => lib_search($q)));
        if ($set['apiKey'] === '') fail('ยังไม่ได้ตั้ง YouTube API key — วางลิงก์ YouTube แทนได้', 400);
        $dev = preg_replace('/[^A-Za-z0-9_-]/', '', substr(isset($_GET['dev']) ? (string)$_GET['dev'] : '', 0, 40));
        if (!$staff && ($dev === '' || limit_hit('search-dev', 10, 600, $dev) || limit_hit('search-ip', 80, 600, client_id()))) {
            fail('ค้นหาถี่เกินไป รอสักครู่', 429);
        }
        $res = yt_search($q, $set['apiKey'], !$staff);
        if (!$staff && $set['maxMinutes'] > 0) {
            $max = $set['maxMinutes'] * 60;
            foreach ($res as &$r) $r['tooLong'] = $r['dur'] > $max;
            unset($r);
        }
        out(array('ok' => true, 'results' => $res));

    case 'songs':
        // browse the shop's own songs page by page (the list is already sorted by the player)
        $set = jb_settings();
        if (!$staff && !$set['guestRequests']) fail('ตอนนี้ปิดรับขอเพลงชั่วคราว', 403);
        $all = player_has_folder() ? lib_songs() : array();
        $offset = max(0, isset($_GET['offset']) ? (int)$_GET['offset'] : 0);
        $limit = max(1, min(200, isset($_GET['limit']) ? (int)$_GET['limit'] : 60));
        $page = array();
        foreach (array_slice($all, $offset, $limit) as $x) {
            $slash = strrpos($x['p'], '/');
            $page[] = array('kind' => 'local', 'path' => $x['p'], 'title' => $x['t'], 'dur' => 0,
                'folder' => $slash === false ? '' : substr($x['p'], 0, $slash));
        }
        out(array('ok' => true, 'total' => count($all), 'offset' => $offset, 'songs' => $page));

    case 'add':
        require_post();
        $b = body_json();
        $set = jb_settings();
        if (!$staff && !$set['guestRequests']) fail('ตอนนี้ปิดรับขอเพลงชั่วคราว', 403);
        $path = isset($b['path']) ? (string)$b['path'] : '';
        $vid = $path === '' ? parse_vid(isset($b['vid']) ? $b['vid'] : (isset($b['url']) ? $b['url'] : '')) : '';
        if ($path === '' && $vid === '') fail('ไม่ใช่ลิงก์ YouTube ที่ถูกต้อง');
        $name = clean_text(isset($b['name']) ? $b['name'] : '', 20);
        $room = clean_text(isset($b['room']) ? $b['room'] : '', 16);
        $dev = preg_replace('/[^A-Za-z0-9_-]/', '', substr((string)(isset($b['dev']) ? $b['dev'] : ''), 0, 40));
        if (!$staff && $name === '') fail('ใส่ชื่อของคุณก่อน');
        if (!$staff && $dev === '') fail('bad device');
        if (!$staff && (limit_hit('add-dev', 6, 600, $dev) || limit_hit('add-ip', 60, 600, client_id()))) fail('ขอเพลงถี่เกินไป รอสักครู่', 429);
        if ($path !== '') {
            $song = lib_find($path);
            if (!$song) fail('ไม่พบเพลงนี้ในเครื่องของร้านแล้ว', 404);
            $meta = array('kind' => 'local', 'path' => $song['p'], 'title' => $song['t'], 'channel' => '', 'dur' => 0);
        } else {
            $meta = video_meta($vid, $set['apiKey']); // network call outside the lock
            $meta['kind'] = 'yt';
        }
        $key = ikey(array('kind' => $meta['kind'], 'path' => $path, 'vid' => $vid));

        jb_lock();
        $st = jb_state();
        if (count($st['queue']) >= JB_MAX_QUEUE) fail('คิวเต็มแล้ว');
        if (($st['now'] && ikey($st['now']) === $key && $st['now']['src'] !== 'fallback')) fail('เพลงนี้กำลังเล่นอยู่');
        foreach ($st['queue'] as $q) if (ikey($q) === $key) fail('เพลงนี้อยู่ในคิวแล้ว');
        if (!$staff) {
            $mine = 0;
            foreach ($st['queue'] as $q) if ($q['dev'] === $dev) $mine++;
            if ($set['maxPerGuest'] > 0 && $mine >= $set['maxPerGuest']) fail('ขอได้ครั้งละ ' . $set['maxPerGuest'] . ' เพลง — รอเพลงของคุณเล่นก่อน');
            if ($set['maxMinutes'] > 0 && $meta['dur'] > $set['maxMinutes'] * 60) fail('เพลงยาวเกิน ' . $set['maxMinutes'] . ' นาที');
            if ($set['noRepeatMinutes'] > 0) {
                foreach ($st['history'] as $h) {
                    if ((isset($h['key']) ? $h['key'] : 'Y:' . $h['vid']) === $key && $h['src'] !== 'fallback' && $h['at'] > time() - $set['noRepeatMinutes'] * 60) fail('เพลงนี้เพิ่งเล่นไป ลองเพลงอื่นก่อน');
                }
            }
            foreach (preg_split('/\s*,\s*/', mb_strtolower($set['blockWords'], 'UTF-8')) as $w) {
                if ($w !== '' && mb_strpos(mb_strtolower($meta['title'], 'UTF-8'), $w) !== false) fail('ขอเพลงนี้ไม่ได้');
            }
        }
        $item = new_item($vid, $meta, $staff ? 'staff' : 'guest', $name !== '' ? $name : 'พนักงาน', $room, $dev);
        if ($staff && !empty($b['next'])) array_unshift($st['queue'], $item);
        else $st['queue'][] = $item;

        if (!$st['now']) advance($st, $set, '');
        elseif ($st['now']['src'] === 'fallback' && $set['interruptFallback']) interrupt_fallback($st);
        jb_save_state($st);
        $pos = find_index($st['queue'], $item['id']);
        out(array('ok' => true, 'position' => $pos + 1, 'playing' => $pos < 0, 'title' => $item['title']));

    case 'cmd':
        require_post();
        require_auth();
        $b = body_json();
        $type = isset($b['type']) ? (string)$b['type'] : '';
        $id = isset($b['id']) ? (string)$b['id'] : '';
        jb_lock();
        $st = jb_state();
        $i = $id !== '' ? find_index($st['queue'], $id) : -1;
        switch ($type) {
            case 'skip': if ($st['now']) advance($st, jb_settings(), 'skipped'); break;
            case 'pause': $st['ctl']['paused'] = true; break;
            case 'play': $st['ctl']['paused'] = false; break;
            case 'volume': $st['ctl']['volume'] = max(0, min(100, (int)(isset($b['value']) ? $b['value'] : 80))); break;
            case 'remove': if ($i >= 0) array_splice($st['queue'], $i, 1); break;
            case 'top':
            case 'up':
            case 'down':
                if ($i < 0) break;
                $it = array_splice($st['queue'], $i, 1);
                $to = $type === 'top' ? 0 : ($type === 'up' ? max(0, $i - 1) : min(count($st['queue']), $i + 1));
                array_splice($st['queue'], $to, 0, $it);
                break;
            case 'clear': $st['queue'] = array(); $st['resume'] = null; break;
            default: fail('unknown command');
        }
        jb_save_state($st);
        out(public_state($st, jb_settings(), true));

    case 'settings':
        require_post();
        require_auth();
        $b = body_json();
        $in = isset($b['settings']) && is_array($b['settings']) ? $b['settings'] : array();
        $old = jb_settings();
        $set = $old;
        foreach (array('guestRequests', 'interruptFallback', 'fallbackShuffle') as $k) if (isset($in[$k])) $set[$k] = (bool)$in[$k];
        foreach (array('maxPerGuest' => 20, 'maxMinutes' => 600, 'noRepeatMinutes' => 1440) as $k => $max) {
            if (isset($in[$k])) $set[$k] = max(0, min($max, (int)$in[$k]));
        }
        if (isset($in['blockWords'])) $set['blockWords'] = clean_text($in['blockWords'], 500);
        if (isset($in['fallbackSource']) && in_array($in['fallbackSource'], array('youtube', 'local', 'both'), true)) $set['fallbackSource'] = $in['fallbackSource'];
        if (isset($in['fallback'])) $set['fallback'] = substr(str_replace("\r", '', (string)$in['fallback']), 0, 20000);
        if (isset($in['apiKey']) && $in['apiKey'] !== '') {
            $k = trim((string)$in['apiKey']);
            if (!preg_match('/^[A-Za-z0-9_-]{20,60}$/', $k)) fail('รูปแบบ API key ไม่ถูกต้อง');
            yt_api('videos', array('part' => 'id', 'id' => 'dQw4w9WgXcQ'), $k); // fails with a readable error if the key is bad
            $set['apiKey'] = $k;
        }
        if (!empty($in['removeKey'])) $set['apiKey'] = '';
        $warn = array();
        $rebuild = $set['fallback'] !== $old['fallback'] || !empty($in['rebuildPool']) || ($set['apiKey'] !== $old['apiKey'] && $set['apiKey'] !== '');
        $pool = $rebuild ? build_pool($set['fallback'], $set['apiKey'], $warn) : null;
        jb_lock();
        jb_write('settings', $set);
        $st = jb_state();
        if ($pool !== null) {
            jb_write('pool', $pool);
            $st['poolPos'] = 0;
        }
        if (!$st['now'] && fallback_count($set) > 0) advance($st, $set, '');
        if ($pool !== null || $st['now']) jb_save_state($st);
        $res = public_state($st, $set, true);
        $res['warnings'] = $warn;
        out($res);

    case 'report':
        require_post();
        require_auth();
        $b = body_json();
        $id = isset($b['id']) ? (string)$b['id'] : '';
        $p = array('seen' => time(), 'id' => $id, 'pos' => max(0, (int)(isset($b['pos']) ? $b['pos'] : 0)),
            'dur' => max(0, (int)(isset($b['dur']) ? $b['dur'] : 0)), 'local' => !empty($b['local']));
        jb_write('player', $p);
        $st = jb_state();
        $set = jb_settings();
        // without an API key guest durations are unknown until the player reports them
        if ($st['now'] && $st['now']['id'] === $id && $st['now']['src'] === 'guest' && substr(ikey($st['now']), 0, 2) === 'Y:' && $set['maxMinutes'] > 0 &&
            $p['dur'] > $set['maxMinutes'] * 60 + 30) {
            jb_lock();
            $st = jb_state();
            if ($st['now'] && $st['now']['id'] === $id) { advance($st, $set, 'too long'); jb_save_state($st); }
        }
        out(public_state($st, $set, true));

    case 'library':
        require_post();
        require_auth();
        $b = body_json();
        $songs = array();
        $seen = array();
        foreach ((isset($b['songs']) && is_array($b['songs']) ? $b['songs'] : array()) as $x) {
            if (!is_array($x) || !isset($x['p']) || !is_string($x['p'])) continue;
            // the path must stay byte-exact: the player looks the file up by it
            $path = $x['p'];
            if ($path === '' || strlen($path) > 600 || !preg_match('//u', $path) || preg_match('/[\x00-\x1F\x7F]/', $path) || isset($seen[$path])) continue;
            $seen[$path] = 1;
            $t = clean_text(isset($x['t']) ? $x['t'] : $path, 200);
            $songs[] = array('p' => $path, 't' => $t !== '' ? $t : $path);
            if (count($songs) >= JB_MAX_LIBRARY) break;
        }
        $hash = preg_replace('/[^A-Za-z0-9]/', '', substr(isset($b['hash']) ? (string)$b['hash'] : '', 0, 40));
        jb_write('library', array('songs' => $songs));
        jb_write('libmeta', array('hash' => $hash, 'count' => count($songs), 'at' => time()));
        out(array('ok' => true, 'count' => count($songs)));

    case 'advance':
        require_post();
        require_auth();
        $b = body_json();
        $from = isset($b['from']) ? (string)$b['from'] : '';
        $err = isset($b['error']) ? (int)$b['error'] : 0;
        jb_lock();
        $st = jb_state();
        $set = jb_settings();
        $curId = $st['now'] ? $st['now']['id'] : '';
        if ($curId === $from) { // ignore stale calls (song already changed by staff or another tab)
            if ($err && $st['now'] && $st['now']['src'] === 'fallback' && substr(ikey($st['now']), 0, 2) === 'Y:') {
                // drop broken fallback songs so they are not picked again
                $bad = $st['now']['vid'];
                jb_write('pool', array_values(array_filter(jb_read('pool', array()), function ($x) use ($bad) { return $x['vid'] !== $bad; })));
            }
            if ($st['now'] || $st['queue'] || $st['resume'] || fallback_count($set) > 0) {
                advance($st, $set, $err ? 'error ' . $err : '');
                jb_save_state($st);
            }
        }
        out(public_state($st, $set, true));

    default:
        fail('unknown action', 404);
}
