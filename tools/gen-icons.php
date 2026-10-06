<?php
/**
 * tools/gen-icons.php — генерация иконок APK (PNG через GD).
 *
 *   php tools/gen-icons.php
 *
 * Силуэт головы шакала анфас (острые уши, лохматые щёки, вытянутая морда),
 * глаза — знаки «₽»: «шакал с рублями в глазах». Знак рисуется как «P»
 * (Arial Bold) + две перекладины, чтобы не зависеть от того, есть ли в шрифте
 * символ U+20BD. Цвета — дизайн-токены T-Bank: жёлтый #FFDD2D (фон),
 * тёмный #333333 (шерсть).
 *
 * Создаёт в android/app/src/main/res/:
 *   mipmap-{mdpi..xxxhdpi}/ic_launcher.png        — legacy, жёлтый квадрат 48..192
 *   mipmap-{mdpi..xxxhdpi}/ic_launcher_round.png  — legacy, жёлтый круг
 *   mipmap-{mdpi..xxxhdpi}/ic_launcher_fg.png     — adaptive foreground (108dp:
 *                                                   108/162/216/324/432), шакал
 *                                                   в безопасной зоне (66/108)
 * Adaptive-обвязка (mipmap-anydpi-v26/*.xml) лежит в репозитории статично.
 */

$root = dirname(__DIR__);
$res  = $root . '/android/app/src/main/res';

const YELLOW_R = 0xFF, YELLOW_G = 0xDD, YELLOW_B = 0x2D;
const DARK_R   = 0x33, DARK_G   = 0x33, DARK_B   = 0x33;

// ---------- Шрифт ----------

function pickFont(): string {
    $candidates = [
        '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/SFNS.ttf',
    ];
    foreach ($candidates as $f) {
        if (is_file($f)) return $f;
    }
    fwrite(STDERR, "gen-icons.php: не найден подходящий TTF-шрифт\n");
    exit(1);
}
$FONT = pickFont();

// ---------- Знак «₽»: P + две перекладины ----------

// Рисует знак так, чтобы центр композиции (P с перекладинами) попал в ($cx, $cy),
// высота буквы (cap height) = $capH.
function drawRub($im, float $cx, float $cy, float $capH, array $color, string $font): void {
    // Подбираем размер шрифта под нужную высоту буквы
    $probe   = imagettfbbox(100, 0, $font, 'P');
    $capH100 = $probe[1] - $probe[7];
    $size    = 100 * $capH / $capH100;

    $bbox = imagettfbbox($size, 0, $font, 'P');
    $gw   = $bbox[2] - $bbox[0];        // ширина буквы
    $capH = $bbox[1] - $bbox[7];

    // Композиция: перекладины чуть шире буквы слева и до её правого края
    $totalW = $gw * 1.12;
    $left   = (int) round($cx - $totalW / 2);
    $baseY  = (int) round($cy + $capH / 2);
    $capTop = $baseY + $bbox[7];        // bbox[7] < 0

    $c = imagecolorallocate($im, $color[0], $color[1], $color[2]);
    imagettftext($im, $size, 0, $left - $bbox[0], $baseY, $c, $font, 'P');

    // Перекладины: ниже чаши, пересекают ножку, выходят влево и вправо
    $barH  = (int) max(1, round($capH * 0.11));
    $barX0 = (int) round($left - $gw * 0.12);
    $barX1 = (int) round($left + $gw * 1.00);
    $bar1Y = (int) round($capTop + $capH * 0.60);
    $bar2Y = (int) round($capTop + $capH * 0.78);
    imageantialias($im, true);
    imagefilledrectangle($im, $barX0, $bar1Y, $barX1, $bar1Y + $barH, $c);
    imagefilledrectangle($im, $barX0, $bar2Y, $barX1, $bar2Y + $barH, $c);
}

// ---------- Шакал: силуэт головы + глаза-«₽» ----------

// Голова анфас в сетке 100×100 ($unit — размер сетки в пикселях, ($cxPx,$cyPx) —
// где центр сетки). Шерсть $fur, прорези (внутренние уши, нос) и глаза — $bg.
function drawJackal($im, float $unit, float $cxPx, float $cyPx, array $fur, array $bg, string $font): void {
    // Контур: левое ухо → лоб → правое ухо → правая щека → морда → левая щека.
    // Уши высокие и острые, щёки с «клыками» шерсти наружу, морда вытянута вниз.
    $outline = [
        [24, 4], [39, 31], [50, 39], [61, 31], [76, 4],
        [81, 36], [80, 50], [85, 64], [76, 76],
        [63, 90], [50, 95], [37, 90],
        [24, 76], [15, 64], [20, 50], [19, 36],
    ];
    imageantialias($im, true);
    $cFur = imagecolorallocate($im, $fur[0], $fur[1], $fur[2]);
    $flat = [];
    foreach ($outline as $v) {
        $flat[] = (int) round($cxPx + ($v[0] - 50) * $unit);
        $flat[] = (int) round($cyPx + ($v[1] - 50) * $unit);
    }
    imagefilledpolygon($im, $flat, $cFur);

    // Прорези цветом фона: внутренние уши (вписаны в ушные треугольники) и нос
    $cBg = imagecolorallocate($im, $bg[0], $bg[1], $bg[2]);
    $cutouts = [
        [[25.7, 13.8], [33.2, 27.3], [23.2, 29.8]], // левое ухо
        [[74.3, 13.8], [66.8, 27.3], [76.8, 29.8]], // правое ухо
        [[45.5, 80.0], [54.5, 80.0], [50.0, 87.0]], // нос
    ];
    foreach ($cutouts as $tri) {
        $f = [];
        foreach ($tri as $v) {
            $f[] = (int) round($cxPx + ($v[0] - 50) * $unit);
            $f[] = (int) round($cyPx + ($v[1] - 50) * $unit);
        }
        imagefilledpolygon($im, $f, $cBg);
    }

    // Глаза — знаки «₽» цветом фона
    drawRub($im, $cxPx + (38.5 - 50) * $unit, $cyPx + (57 - 50) * $unit, 13 * $unit, $bg, $font);
    drawRub($im, $cxPx + (61.5 - 50) * $unit, $cyPx + (57 - 50) * $unit, 13 * $unit, $bg, $font);
}

function canvas(int $w, int $h, ?array $bg) {
    $im = imagecreatetruecolor($w, $h);
    imagealphablending($im, false);
    imagesavealpha($im, true);
    if ($bg === null) {
        $transparent = imagecolorallocatealpha($im, 0, 0, 0, 127);
        imagefill($im, 0, 0, $transparent);
    } else {
        imagefill($im, 0, 0, imagecolorallocate($im, $bg[0], $bg[1], $bg[2]));
    }
    imagealphablending($im, true);
    return $im;
}

function savePng($im, string $file): void {
    $dir = dirname($file);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    imagepng($im, $file, 9);
    imagedestroy($im);
    echo basename(dirname($file)), '/', basename($file), ' ', imagesx($im) ?: '', "\n";
}

$YELLOW = [YELLOW_R, YELLOW_G, YELLOW_B];
$DARK   = [DARK_R, DARK_G, DARK_B];

// ---------- Legacy-иконки: квадрат и круг ----------

$sizes = ['mdpi' => 48, 'hdpi' => 72, 'xhdpi' => 96, 'xxhdpi' => 144, 'xxxhdpi' => 192];
foreach ($sizes as $dpi => $px) {
    $im = canvas($px, $px, $YELLOW);
    drawJackal($im, $px / 100 * 0.94, $px / 2, $px / 2, $DARK, $YELLOW, $FONT);
    savePng($im, "{$res}/mipmap-{$dpi}/ic_launcher.png");

    $im = canvas($px, $px, null); // круг на прозрачном
    imageantialias($im, true);
    imagefilledellipse($im, (int) ($px / 2), (int) ($px / 2), $px, $px,
        imagecolorallocate($im, YELLOW_R, YELLOW_G, YELLOW_B));
    // кончики ушей на расстоянии ~53 ед. от центра — уменьшаем, чтобы влезли в круг r=50
    drawJackal($im, $px / 100 * 0.88, $px / 2, $px / 2, $DARK, $YELLOW, $FONT);
    savePng($im, "{$res}/mipmap-{$dpi}/ic_launcher_round.png");
}

// ---------- Adaptive foreground: шакал в безопасной зоне (66/108 диаметр) ----------

// Силуэт выше шириной (91 ед. из 100) — вписываем высоту в 66: 66/91 ≈ 0.72
$fgSizes = ['mdpi' => 108, 'hdpi' => 162, 'xhdpi' => 216, 'xxhdpi' => 324, 'xxxhdpi' => 432];
foreach ($fgSizes as $dpi => $px) {
    $im = canvas($px, $px, null);
    drawJackal($im, $px / 100 * 0.70, $px / 2, $px / 2, $DARK, $YELLOW, $FONT);
    savePng($im, "{$res}/mipmap-{$dpi}/ic_launcher_fg.png");
}

echo "Иконки обновлены в android/app/src/main/res/mipmap-*\n";
