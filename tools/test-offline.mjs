// tools/test-offline.mjs — смоук-тесты автономного бандла (android/assets/www)
// и веб-регрессия. Запуск: node tools/test-offline.mjs
//
// Паттерн (см. память проекта): jsdom runScripts:'outside-only' + ОДИН
// window.eval бандла — let/const не пересекают границы отдельных eval'ов.
// Offline-режим: fetch-стаб БРОСАЕТ — тест падает, если кто-то полез мимо
// моста WalletAndroid в сеть.

import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'android/assets/www');

let passed = 0, failed = 0;
function ok(cond, label) {
    if (cond) { passed++; console.log('  ✓ ' + label); }
    else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function section(t) { console.log('\n== ' + t); }

// ---------- Фикстура календаря (синтетика, без личных данных) ----------

const FIXTURE = {
    transactions: [
        { id: 't1', name: 'Зарплата', date: '2026-09-05', amount: 50000, type: 'income', period: 'monthly', category: 'Доход' },
        { id: 't2', name: 'Интернет', date: '2026-10-10', amount: 700, type: 'expense', period: 'monthly', category: 'Связь' },
        { id: 't3', name: 'Продукты', date: '2026-10-06', amount: 3000, type: 'expense', period: 'once', category: 'Еда' }
    ],
    categories: [
        { name: 'Доход', color: '#4CAF50', type: 'inc' },
        { name: 'Еда', color: '#FF7043', type: 'exp' },
        { name: 'Связь', color: '#42A5F5', type: 'exp' }
    ],
    occurrences: [],
    investmentConfig: { goal: 100000, monthlyInvestment: 20000 }
};

// ---------- Сборка окружения ----------

function makeBridge() {
    const spy = { http: 0, saveFile: [], persistSnapshot: 0, scheduleNotification: [], requestPerm: 0 };
    return {
        spy,
        bridge: {
            // В mock-режиме синхронизация НЕ должна звать http вообще
            http: (json) => { spy.http++; return JSON.stringify({ status: 0, body: '', error: 'нет сети' }); },
            saveFile: (name, content) => { spy.saveFile.push({ name, content }); return true; },
            persistSnapshot: () => { spy.persistSnapshot++; return true; },
            scheduleNotification: (enabled, h, m) => { spy.scheduleNotification.push([enabled, h, m]); },
            requestNotificationsPermission: () => { spy.requestPerm++; },
            toast: () => {},
            appVersion: () => '1.0-test'
        }
    };
}

function setupWindow(window, fetchImpl) {
    window.fetch = fetchImpl;
    window.PointerEvent = window.MouseEvent;
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.scrollTo = () => {};
    window.confirm = () => true;
    window.alert = () => {};
}

function bundle(files) {
    // Эпилог в ТОМ ЖЕ eval: let/const бандла не видны из других eval'ов,
    // поэтому прокидываем геттеры замыканием
    const epilogue = `
;window.__hooks = {
    get transactions() { return transactions; },
    get state() { return typeof state !== 'undefined' ? state : null; }
};`;
    return files.map(f => readFileSync(path.join(WWW, f), 'utf8')).join('\n;\n') + epilogue;
}

async function boot(html, files, { fetchImpl, seed, bridge } = {}) {
    // url с http-origin: у file:// origin «opaque» и localStorage кидает
    // SecurityError (в APK origin — file://, но там настоящий браузер)
    const dom = new JSDOM(readFileSync(html, 'utf8'), {
        url: 'https://wallet.local/',
        pretendToBeVisual: true, runScripts: 'outside-only'
    });
    const { window } = dom;
    setupWindow(window, fetchImpl);
    if (bridge) window.WalletAndroid = bridge;
    if (seed) for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, JSON.stringify(v));
    window.eval(bundle(files));
    // app.js слушает DOMContentLoaded (jsdom его уже «отправил» при парсинге) — дергаем сами
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80)); // асинхронный обработчик app.js
    return window;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// =====================================================================
// 1. Автономный бандл (APK-режим)
// =====================================================================

section('Автономный бандл: среда');
const { spy, bridge } = makeBridge();
let netAttempts = 0;
const offlineWindow = await boot(path.join(WWW, 'index.html'),
    ['standalone.js', 'sync-client.js', 'app.js', 'backup.js', 'settings.js', 'charts.js', 'forecast.js', 'dashboard.js'],
    {
        fetchImpl: () => { netAttempts++; return Promise.reject(new Error('СЕТЬ ЗАПРЕЩЕНА (offline-тест)')); },
        seed: { financialCalendar: FIXTURE },
        bridge
    });
const doc = offlineWindow.document;

ok(offlineWindow.WALLET_STANDALONE === true, 'WALLET_STANDALONE = true');
ok(doc.body.classList.contains('standalone'), 'body.standalone');
ok(offlineWindow.__hooks.transactions.length === 3, 'данные из localStorage загружены (3 транзакции)');

// Урок из памяти: проверяем computed display, а не атрибут
ok(offlineWindow.getComputedStyle(doc.querySelector('#dashboardEmpty .server-only')).display === 'none',
    '.server-only скрыт (computed display:none)');
ok(offlineWindow.getComputedStyle(doc.querySelector('.standalone-only')).display !== 'none',
    '.standalone-only виден');

section('Автономный бандл: календарь');
ok(doc.querySelectorAll('.day-cell').length === 42, 'календарь: 42 ячейки (6 недель)');
const txCount = doc.querySelectorAll('.day-transaction').length;
ok(txCount >= 3, 'в месяце есть транзакции (monthly-серия + once): ' + txCount);

section('Автономный бандл: мобильная вёрстка (Т-Банк)');
const daySums = doc.querySelectorAll('.day-sums');
ok(daySums.length >= 2, 'day-sums: компактные суммы в ячейках (' + daySums.length + ')');
ok(doc.querySelector('.day-sums .ds-in') !== null
    && doc.querySelector('.day-sums .ds-out') !== null, 'day-sums: есть ds-in и ds-out');
const dsInEl = doc.querySelector('.day-sums .ds-in');
ok(dsInEl && dsInEl.textContent.indexOf('тыс') !== -1,
    'day-sums: компактный формат («' + (dsInEl ? dsInEl.textContent.trim() : '?') + '» — 50 тыс из фикстуры)');
ok(doc.querySelectorAll('#viewNav .view-ico').length === 2
    && doc.querySelectorAll('#viewNav .view-label').length === 2,
    'таб-панель: иконка + метка в каждой вкладке');
ok(doc.querySelector('.tx-avatar') !== null, 'списки: ячейки с аватаром (.tx-avatar)');
// Каркас мобильного слоя — строковыми проверками исходника (jsdom не применяет media queries)
const srcIndex = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(srcIndex.indexOf('id="tb-mobile"') !== -1, 'index.html: есть мобильный блок #tb-mobile');
ok(srcIndex.indexOf('.modal::before') !== -1, 'index.html: грабер bottom sheet (.modal::before)');
ok(/padding-bottom: (\d+)px;[\s\S]*?padding-bottom: calc\(\1px \+ env\(safe-area-inset-bottom\)\)/.test(srcIndex),
    'index.html: env() идёт после обычного фолбэка того же значения (Chromium 57)');

section('Шрифты: локально, без CDN');
// index.html раньше тянул fonts.css с cdn.tbank.ru — теперь файлы в репозитории
ok(srcIndex.indexOf('cdn.tbank.ru') === -1,
    'index.html: внешнего CDN шрифтов нет');
ok(srcIndex.indexOf('href="fonts/fonts.css"') !== -1,
    'index.html: локальный линк fonts/fonts.css');
const repoFonts = ['fonts.css', 'T-Sans_Regular.woff2', 'T-Sans_Medium.woff2', 'T-Sans_Bold.woff2',
    'NeueHaasUnicaW1G-Regular.woff2', 'NeueHaasUnicaW1G-Medium.woff2'];
let fontsOk = true;
for (const f of repoFonts) {
    if (!existsSync(path.join(ROOT, 'fonts', f))) fontsOk = false;
}
ok(fontsOk && readFileSync(path.join(ROOT, 'fonts', 'fonts.css'), 'utf8').includes('@font-face'),
    'fonts/: css + woff2 лежат в репозитории');
ok(existsSync(path.join(WWW, 'fonts', 'fonts.css')),
    'бандл: шрифты скопированы в www/fonts/');

section('Навигация: шапка и меню ☰');
ok(doc.querySelector('header').firstElementChild === doc.getElementById('menuBtn'),
    '☰: первый элемент шапки (левый верхний угол)');
ok(!doc.getElementById('saveBtn'),
    'шапка: 💾 убран (сохранение автоматическое)');
const actionsRow = doc.getElementById('categoriesBtn').closest('.header-actions');
ok(actionsRow.contains(doc.getElementById('stealthBtn'))
    && actionsRow.contains(doc.getElementById('undoBtn'))
    && actionsRow.contains(doc.getElementById('syncBtn')),
    'шапка: 🏷 и ↩️ — в ряду иконок рядом с 👁 (и 🔄 там же)');
ok(doc.getElementById('logoutBtn').hidden === true
    && srcIndex.indexOf('.header-actions .btn[hidden] { display: none; }') !== -1,
    '🔒 «Выйти»: скрыт без пароля — [hidden] не перебивается inline-flex на мобиле');
const drawerItems = doc.querySelectorAll('#appDrawer .drawer-item');
ok(drawerItems.length === 6, 'меню: 6 пунктов-экранов (' + drawerItems.length + ')');
ok(doc.querySelector('#appDrawer .drawer-item[data-nav="balance"]') !== null
    && doc.querySelector('#appDrawer .drawer-item[data-nav="pf-assets"]') !== null,
    'меню: «Баланс по дням» и разделы портфеля');
ok(doc.querySelector('#appDrawer .drawer-item[data-action]') === null,
    'меню: только навигация (категории/отмена — кнопки шапки календаря)');
const logoSvg = doc.querySelector('.drawer-logo svg');
ok(logoSvg !== null && logoSvg.querySelectorAll('polygon').length >= 4
    && logoSvg.querySelectorAll('g').length >= 3,
    'меню: логотип-шакал у «ШАКАЛ» (контур + прорези + глаза-₽)');
ok(doc.getElementById('syncBtn')
    && doc.getElementById('syncBtn').closest('.header-actions') !== null,
    '🔄: кнопка синхронизации — в ряду иконок шапки');
ok(doc.getElementById('chipTinkoff').closest('[data-pf="overview"]') !== null
    && doc.getElementById('syncLastTime').closest('[data-pf="overview"]') !== null
    && doc.getElementById('chipTinkoff').closest('#appDrawer') === null,
    'синхронизация: время и чипы брокеров — на «Обзоре», из меню убраны');
const pfCount = v => doc.querySelectorAll('#dashboardContent [data-pf="' + v + '"]').length;
ok(pfCount('overview') === 6 && pfCount('assets') === 1
    && pfCount('payouts') === 2 && pfCount('forecast') === 2,
    'разделы портфеля: 6/1/2/2 карточки (обзор+синхро/активы/выплаты/прогноз, без «Топ позиций»)');

section('Навигация: поведение (клики)');
doc.getElementById('menuBtn').click();
ok(doc.body.classList.contains('drawer-open') && !doc.getElementById('drawerOverlay').hidden,
    '☰ → меню открылось');
doc.getElementById('drawerClose').click();
ok(!doc.body.classList.contains('drawer-open'), '✕ → меню закрылось');
doc.querySelector('#appDrawer .drawer-item[data-nav="balance"]').click();
ok(doc.body.classList.contains('balance-mode'), '«Баланс по дням» → body.balance-mode');
ok(offlineWindow.getComputedStyle(doc.getElementById('balanceView')).display !== 'none',
    'экран баланса виден (computed display)');
const balPages = doc.querySelectorAll('#balanceStrip .balance-page');
ok(balPages.length >= 7, 'баланс: ≥7 страниц-месяцев (' + balPages.length + ')');
const readout = doc.getElementById('balanceReadout').textContent;
ok(readout.indexOf('₽') !== -1, 'баланс: рид-аут с суммой («' + readout.replace(/\s+/g, ' ').trim() + '»)');
const balSvg = balPages[0] && balPages[0].querySelector('svg');
ok(balSvg && balSvg.children.length > 3, 'баланс: SVG-график построен');
ok(offlineWindow.localStorage.getItem('walletView') === 'balance', 'баланс: выбор сохранён (walletView)');
doc.querySelector('#appDrawer .drawer-item[data-nav="pf-assets"]').click();
ok(doc.body.classList.contains('dashboard-mode'), 'раздел портфеля → режим портфеля');
ok(doc.getElementById('dashboardContent').getAttribute('data-section') === 'assets'
    && offlineWindow.localStorage.getItem('walletPfSection') === 'assets',
    '«Активы» → data-section=assets и запомнен');

// Сервисные кнопки шапки (только экран календаря): 🏷 и ↩️
ok(offlineWindow.getComputedStyle(doc.getElementById('undoBtn')).display === 'none',
    'портфель: ↩️ скрыт (display:none) — кнопки календаря не мешают');
doc.querySelector('#appDrawer .drawer-item[data-nav="calendar"]').click();
ok(offlineWindow.getComputedStyle(doc.getElementById('undoBtn')).display !== 'none',
    'календарь: ↩️ снова виден');
doc.getElementById('categoriesBtn').click();
ok(doc.getElementById('categoriesModal').classList.contains('active'),
    '🏷 в шапке → модалка категорий открылась');
offlineWindow.eval('closeCategoriesModal()');
doc.getElementById('undoBtn').click();
ok(offlineWindow.__hooks.transactions.length === 3,
    '↩️ в шапке: пустой стек отмены — «нечего отменять», данные целы');

section('Автономный бандл: синхронизация (mock, ноль сети)');
const events = [];
offlineWindow.__collect = (line) => events.push(typeof line === 'string' ? JSON.parse(line) : line);
await offlineWindow.eval('WalletSync.runSync(true, l => window.__collect(l))');
await sleep(100);
const start = events.find(e => e.event === 'start');
const done = events.find(e => e.event === 'done');
ok(!!start && start.mock === true, 'sync: start{mock:true}');
ok(!!done && done.portfolio && typeof done.portfolio.totals.value === 'number',
    'sync: done с portfolio.totals (' + (done && done.portfolio ? done.portfolio.totals.value : '?') + ')');
ok(done.saved === true, 'sync: первый запуск (портфеля не было) saved:true');
ok(offlineWindow.localStorage.getItem('walletPortfolio') !== null, 'sync: walletPortfolio в localStorage');
ok(spy.http === 0, 'sync mock: НОЛЬ вызовов WalletAndroid.http');

// Повторный запуск: mock не перезаписывает существующее (паритет с sync.php)
const events2 = [];
offlineWindow.__collect2 = (line) => events2.push(typeof line === 'string' ? JSON.parse(line) : line);
await offlineWindow.eval('WalletSync.runSync(true, l => window.__collect2(l))');
await sleep(100);
const done2 = events2.find(e => e.event === 'done');
ok(done2 && done2.saved === false, 'sync: повторный mock — saved:false (не трогает портфель)');
// Ошибка брокера раньше писалась только в #syncStatus (на мобиле скрыт) —
// теперь всплывает тостом
const dashSrc = readFileSync(path.join(WWW, 'dashboard.js'), 'utf8');
ok(dashSrc.indexOf("toast('❌ ' + BROKER_TITLES[ev.broker] + ': ' + ev.error)") !== -1,
    'sync: ошибка брокера (напр. Финам) показывается всплывающим тостом');
ok(dashSrc.indexOf("'⚠️ Обновлено без '") !== -1,
    'sync: частичный провал не маскируется «✅ Данные обновлены»');
// Портфель в localStorage — дашборд перечитывает его по событию импорта
// (в реальном приложении тот же loadPortfolio зовёт обработчик кнопки синхронизации)
await offlineWindow.eval('document.dispatchEvent(new CustomEvent("wallet:portfolio-imported"))');
await sleep(60);

section('Прогноз: таблица по годам');
const fcScroll = doc.querySelector('#fcTable .chart-scroll');
ok(fcScroll && fcScroll.querySelector('table.chart-table') !== null,
    'прогноз: таблица в обёртке .chart-scroll (горизонтальный скролл)');
const fcHeads = Array.from(doc.querySelectorAll('#fcTable thead th')).map(th => th.textContent);
ok(fcHeads.indexOf('Реальный') !== -1 && fcHeads.indexOf('Пассивный (реальный)') === -1,
    'прогноз: колонка с инфляцией — короткий заголовок «Реальный»');
const fcRows = doc.querySelectorAll('#fcTable tbody tr');
ok(fcRows.length === 9, 'прогноз: горизонт 20 лет → 9 строк-вех (0–5 и каждые 5), было ' + fcRows.length);
ok(doc.querySelector('#fcTable .fc-table-note') !== null,
    'прогноз: под таблицей подпись про вехи');
const fcTd = doc.querySelector('#fcTable tbody td');
ok(fcTd && offlineWindow.getComputedStyle(fcTd).whiteSpace === 'nowrap',
    'прогноз: ячейки без переноса — колонки едут скроллом, а не сжимаются');

section('Автономный бандл: настройки');
offlineWindow.WalletSettings.open();
await sleep(20);
ok(doc.getElementById('settingsModal').classList.contains('active'), 'модалка настроек открылась');
// «?» у полей токенов: клик раскрывает пояснение про выпуск токена у брокера
const hintBtn = doc.querySelector('.hint-btn[data-hint="tinkoffHint"]');
ok(hintBtn && hintBtn.closest('.form-group').contains(doc.getElementById('setTinkoffToken')),
    'настройки: «?» рядом с полем токена Т-Инвестиций');
hintBtn.click();
const tinkHint = doc.getElementById('tinkoffHint');
ok(tinkHint && tinkHint.hidden === false
    && hintBtn.getAttribute('aria-expanded') === 'true'
    && tinkHint.textContent.indexOf('API') !== -1,
    '«?» → подсказка «откуда токен» раскрылась');
hintBtn.click();
ok(tinkHint.hidden === true, 'повторный «?» → подсказка спряталась');
doc.getElementById('setNotifyEnabled').checked = true;
doc.getElementById('setNotifyTime').value = '07:30';
doc.getElementById('setTinkoffToken').value = 'test-token-123';
doc.getElementById('setFinamAccount').value = 'FAB00012345';
offlineWindow.WalletSettings.saveFromForm();
const savedSettings = JSON.parse(offlineWindow.localStorage.getItem('walletSettings'));
ok(savedSettings.notifications.enabled === true
    && savedSettings.notifications.hour === 7
    && savedSettings.notifications.minute === 30, 'настройки сохранены (07:30, вкл)');
ok(savedSettings.finamAccountId === 'FAB00012345',
    'настройки: счёт Финам сохранён (sync-client фильтрует счета по нему)');
ok(doc.getElementById('setFinamAccount').closest('.standalone-only') !== null,
    'модалка: поле «Счёт Финам» есть и только в APK');
ok(spy.scheduleNotification.length === 1 && spy.scheduleNotification[0][0] === true
    && spy.scheduleNotification[0][1] === 7 && spy.scheduleNotification[0][2] === 30,
    'мост: scheduleNotification(true, 7, 30)');
ok(spy.requestPerm >= 1, 'мост: запрошено разрешение уведомлений');
ok(spy.persistSnapshot >= 1, 'мост: persistSnapshot при сохранении настроек');
ok(!doc.getElementById('settingsModal').classList.contains('active'), 'модалка закрылась после сохранения');

section('Тёмная тема');
ok(doc.getElementById('setDarkTheme') !== null, 'настройки: чекбокс «Тёмная тема»');
offlineWindow.WalletSettings.open();
doc.getElementById('setDarkTheme').checked = true;
offlineWindow.WalletSettings.saveFromForm();
ok(doc.documentElement.classList.contains('dark'), 'включение: html.dark');
ok(offlineWindow.localStorage.getItem('walletTheme') === 'dark', 'localStorage walletTheme=dark');
doc.getElementById('setDarkTheme').checked = false;
offlineWindow.WalletSettings.saveFromForm();
ok(!doc.documentElement.classList.contains('dark')
    && offlineWindow.localStorage.getItem('walletTheme') === 'light',
    'выключение: класс снят, walletTheme=light');
ok(srcIndex.indexOf('html.dark {') !== -1
    && srcIndex.indexOf('--tui-surface-glass: rgba(38, 39, 42, 0.92)') !== -1
    && srcIndex.indexOf("classList.add('dark')") !== -1,
    'CSS: html.dark с токенами + бут-скрипт без вспышки светлого');
ok(srcIndex.indexOf('html.dark .drawer-logo svg .fur') !== -1
    && doc.querySelector('.drawer-logo svg .fur') !== null,
    'логотип: в тёмной теме шакал жёлтый (html.dark .fur)');

section('Тёмная тема: таблицы и поля ввода');
// Зебра таблиц графиков была захардкожена белым — в тёмной теме строки «засвечены»
ok(srcIndex.indexOf('--tui-stripe: #FAFBFD') !== -1
    && srcIndex.indexOf('--tui-stripe: #2C2D30') !== -1,
    'CSS: токен зебры --tui-stripe объявлен для светлой и тёмной темы');
ok(/\.chart-table tbody tr:nth-child\(even\) td \{ background: var\(--tui-stripe\); \}/.test(srcIndex),
    'CSS: зебра .chart-table на var(--tui-stripe), без белого литерала');
ok(/\.goal-form > input, \.goal-form > select[\s\S]{0,420}background: var\(--tui-surface\)/.test(srcIndex),
    'CSS: «голые» поля формы цели (без .form-group) получили фон var(--tui-surface)');
ok(/\.fc-yields input\[type="number"\][\s\S]{0,320}background: var\(--tui-surface\)/.test(srcIndex),
    'CSS: поля доходности прогноза получили фон var(--tui-surface)');
// Чернила SVG-графиков были чёрными константами — подписи графиков и оси
// («Купоны и дивиденды» и др.) в тёмной теме не читались
const chartsSrc = readFileSync(path.join(WWW, 'charts.js'), 'utf8');
ok(chartsSrc.indexOf("ink: 'var(--tui-text)'") !== -1
    && chartsSrc.indexOf("grid: 'var(--tui-border-soft)'") !== -1
    && chartsSrc.indexOf("surface: 'var(--tui-surface)'") !== -1,
    'графики: чернила/сетка/поверхность — токены темы, не чёрные литералы');
ok(/function el\(name[\s\S]{0,700}n\.style\[k\] = v/.test(chartsSrc),
    'графики: var()-цвета переносятся из атрибутов в style (SVG-атрибуты var не знают)');
const themeInkText = Array.prototype.some.call(
    doc.querySelectorAll('svg text'),
    t => (t.style.fill || '').indexOf('var(--tui-') === 0);
ok(themeInkText,
    'графики: подписи через var(--tui-*) — перекрасятся вместе с темой');

section('Баланс по дням: месяцы слитно');
offlineWindow.eval('window.__walletShowBalance()');
await sleep(30);
const seamPages = doc.querySelectorAll('#balanceStrip .balance-page');
let balSeamBad = '';
seamPages.forEach(p => {
    const svgEl = p.querySelector('svg');
    const parts = p.getAttribute('data-month').split('-').map(Number);
    const days = new Date(parts[0], parts[1], 0).getDate();
    if (!svgEl || +svgEl.getAttribute('width') !== days * 14) balSeamBad = p.getAttribute('data-month');
});
ok(seamPages.length >= 7 && balSeamBad === '',
    'баланс: ширина страницы = дням месяца × 14px — стык месяцев без зазоров'
    + (balSeamBad ? ' (сбой: ' + balSeamBad + ')' : ''));
ok(srcIndex.indexOf('.balance-page { flex: none; padding: 0; }') !== -1,
    'CSS: .balance-page без горизонтальных отступов');
const appSrc = readFileSync(path.join(WWW, 'app.js'), 'utf8');
ok(/const BAL_PAD_L = 0;[\s\S]{0,220}const BAL_PAD_R = 0;/.test(appSrc),
    'баланс: поля страницы убраны — линия непрерывна через границы месяцев');
// Ленивая лента: будущее добавляется append'ом без перестройки DOM и без
// правки scrollLeft — инерция скролла не глохнет; удалений страниц нет.
// Прошлое предстроено от месяца первой операции (до BAL_PREBUILD глубины).
ok(appSrc.indexOf('strip.appendChild(buildBalPage(nm, balanceState.lo, balanceState.hi))') !== -1
    && appSrc.indexOf('months.shift()') === -1 && appSrc.indexOf('months.pop()') === -1,
    'баланс: append-only добавление месяцев, без перестройки и урезания ленты');
const balStrip = doc.getElementById('balanceStrip');
balStrip.scrollLeft = 0;
balStrip.dispatchEvent(new offlineWindow.Event('scroll'));
await sleep(120);
balStrip.dispatchEvent(new offlineWindow.Event('scroll'));
await sleep(30);
ok(doc.querySelectorAll('#balanceStrip .balance-page').length >= 7,
    'баланс: после прокрутки лента жива и продолжается без предела');
ok(srcIndex.indexOf('.balance-strip::-webkit-scrollbar { display: none; }') !== -1,
    'баланс: полоса прокрутки под графиком скрыта (свайп/колесо)');
ok(appSrc.indexOf("strip.addEventListener('wheel'") !== -1,
    'баланс: колесо мыши листает ленту по горизонтали');
const axisTicks = doc.querySelectorAll('#balanceAxis span');
ok(doc.getElementById('balanceAxis') !== null && axisTicks.length === 5,
    'баланс: ось сумм слева от ленты — 5 делений общей шкалы');
// Рефреш на «Балансе по дням»: данные приходят после первого входа (вид уже
// восстановлен из localStorage) — лента обязана перестроиться, а не стоять нулёвой
ok(/function onBalanceDataChanged[\s\S]{0,250}classList\.contains\('balance-mode'\)[\s\S]{0,200}wallet:data-loaded/.test(appSrc),
    'баланс: data-loaded перестраивает открытый экран (фикс «всё по нулям»)');
doc.body.classList.add('balance-mode');
doc.dispatchEvent(new offlineWindow.Event('wallet:data-loaded'));
await sleep(30);
ok(doc.querySelectorAll('#balanceStrip .balance-page').length >= 7
    && doc.querySelectorAll('#balanceAxis span').length === 5,
    'баланс: после data-loaded лента и ось перестроены без ошибок');

section('Активы: все колонки и на мобиле');
// Раньше клетки прятали классами hide-sm/hide-xs, а заголовки — нет: на узком
// экране значения съезжали под чужие заголовки (Доля/Доходность/Выплата/Брокеры
// «пропадали»). Теперь ничего не прячем — таблица едет горизонтальным скроллом.
ok(dashSrc.indexOf('hide-sm') === -1 && dashSrc.indexOf('hide-xs') === -1,
    'активы: колонки не прячутся классами hide-sm/hide-xs');
const htHeads = doc.querySelectorAll('#holdingsTable thead th').length;
const htFirst = doc.querySelector('#holdingsTable tbody tr');
ok(htHeads === 10 && htFirst && htFirst.querySelectorAll('td').length === 10,
    'активы: 10 заголовков = 10 клеток в строке (без рассинхрона)');
ok(srcIndex.indexOf('border-radius: 14px;') !== -1
    && srcIndex.indexOf('left: 6px; right: 6px; bottom: 0; width: auto; margin-bottom: 14px;') !== -1,
    'мобильная таб-панель: все углы закруглены, margin-bottom 14px от края');

section('Автономный бандл: экспорт');
offlineWindow.WalletBackup.exportBackup();
await sleep(20);
ok(spy.saveFile.length === 1, 'мост: saveFile вызван');
const backup = JSON.parse(spy.saveFile[0].content);
ok(backup.version === 2, 'экспорт: version 2');
ok(/^wallet-backup-\d{4}-\d{2}-\d{2}\.json$/.test(spy.saveFile[0].name), 'имя файла wallet-backup-ГГГГ-ММ-ДД.json');
ok(backup.calendar && backup.calendar.transactions.length === 3, 'экспорт: календарь целиком');
ok(backup.portfolio && backup.portfolio.totals, 'экспорт: портфель (из localStorage)');
ok(!backup.settings || !backup.settings.tinkoffToken, 'экспорт: токены НЕ включены по умолчанию');

section('Автономный бандл: импорт');
const importPayload = {
    version: 2,
    calendar: {
        transactions: [{ id: 'n1', name: 'Новая серия', date: '2026-10-15', amount: 1234, type: 'expense', period: 'monthly', category: 'Еда' }],
        categories: FIXTURE.categories, occurrences: [], investmentConfig: FIXTURE.investmentConfig
    },
    portfolio: { totals: { value: 123456 } },
    settings: { tinkoffToken: 'imp-token', notifications: { enabled: true, hour: 9, minute: 15 } }
};
const file = new offlineWindow.File([JSON.stringify(importPayload)], 'wallet-backup.json', { type: 'application/json' });
offlineWindow.WalletBackup.importFile(file);
await sleep(150); // FileReader
ok(offlineWindow.__hooks.transactions.length === 1
    && offlineWindow.__hooks.transactions[0].name === 'Новая серия', 'импорт: календарь заменён');
const stored = JSON.parse(offlineWindow.localStorage.getItem('financialCalendar'));
ok(stored.transactions.length === 1, 'импорт: сохранено в localStorage');
ok(offlineWindow.localStorage.getItem('walletPortfolio')
    && JSON.parse(offlineWindow.localStorage.getItem('walletPortfolio')).totals.value === 123456,
    'импорт: портфель применён');
const settingsAfterImport = JSON.parse(offlineWindow.localStorage.getItem('walletSettings'));
ok(settingsAfterImport.tinkoffToken === 'imp-token', 'импорт: настройки применены');

section('Автономный бандл: офлайн-гарантия');
ok(netAttempts === 0, 'за весь сценарий fetch не вызывался ни разу');

// =====================================================================
// 2. Веб-регрессия (без standalone.js / sync-client.js)
// =====================================================================

section('Веб-режим: сервер — источник правды');
let webCalls = [];
let lastSettingsBody = null;
let lastBlob = null;
const webWindow = await boot(path.join(ROOT, 'index.html'),
    ['app.js', 'backup.js', 'settings.js', 'charts.js', 'forecast.js', 'dashboard.js'],
    {
        fetchImpl: (url, opts) => {
            const method = ((opts && opts.method) || 'GET').toUpperCase();
            webCalls.push(String(url) + ' ' + method);
            const u = String(url);
            if (u.includes('settings.php') && method === 'POST') lastSettingsBody = opts && opts.body;
            const respond = (body) => Promise.resolve({
                ok: true, status: 200,
                json: () => Promise.resolve(body)
            });
            if (u.includes('api.php') && method === 'GET') {
                return respond({ success: true, data: FIXTURE });
            }
            if (u.includes('api.php')) return respond({ success: true });
            if (u.includes('portfolio.php')) return respond(null); // пустой портфель
            if (u.includes('settings.php') && u.includes('export=tokens')) {
                return respond({ success: true, tinkoffToken: 'srv-tink', finamToken: 'srv-fin' });
            }
            if (u.includes('settings.php')) return respond({
                success: true, passwordSet: true,
                tinkoff: { set: true, tail: '…ab12' }, finam: { set: false, tail: '' }
            });
            return respond({ success: true });
        },
        seed: {}
    });
const wdoc = webWindow.document;

ok(!webWindow.WALLET_STANDALONE, 'WALLET_STANDALONE не задан');
ok(!wdoc.body.classList.contains('standalone'), 'body без класса standalone');
ok(webWindow.getComputedStyle(wdoc.querySelector('#dashboardEmpty .server-only')).display !== 'none',
    '.server-only видим в вебе');
ok(webWindow.__hooks.transactions.length === 3, 'данные загружены с api.php');
ok(wdoc.querySelectorAll('.day-transaction').length >= 3, 'календарь отрендерился');
ok(webCalls.some(c => c.startsWith('api.php GET')), 'loadFromServer сходил в api.php');

// Сохранение уходит на сервер (не в localStorage-режим)
await webWindow.eval('saveDataToServer()');
await sleep(50);
ok(webCalls.some(c => c.startsWith('api.php POST')), 'saveDataToServer отправил POST api.php');

// Настройки в вебе: токены и пароль — на сервере (settings.php)
section('Веб-режим: токены и пароль — в модалке настроек');
ok(!wdoc.getElementById('setTinkoffToken').closest('.standalone-only'),
    'модалка: секция «Брокеры» видна и в вебе');
ok(wdoc.getElementById('setAuthPassword') !== null
    && wdoc.getElementById('setAuthPassword').closest('.server-only') !== null,
    'модалка: секция «Пароль» есть и только для веба');
ok(wdoc.getElementById('setTrustAll').closest('.standalone-only') !== null,
    'модалка: «доверять сертификатам» — только APK');
webWindow.WalletSettings.open();
await sleep(60); // refreshServerStatus
ok(webCalls.some(c => c.indexOf('settings.php GET') !== -1),
    'открытие модалки: GET settings.php (статус токенов/пароля)');
ok(wdoc.getElementById('setTinkoffToken').placeholder.indexOf('…ab12') !== -1,
    'плейсхолдер токена: хвост с сервера («' + wdoc.getElementById('setTinkoffToken').placeholder + '»)');
ok(wdoc.getElementById('setAuthDisableRow').hidden === false,
    'пароль включён → галочка «Отключить» показана');
wdoc.getElementById('setTinkoffToken').value = 'new-tok';
wdoc.getElementById('setAuthPassword').value = 'new-pass';
wdoc.getElementById('setFinamToken').value = ''; // пусто = не менять
webWindow.WalletSettings.saveFromForm();
await sleep(60);
const sent = lastSettingsBody ? JSON.parse(lastSettingsBody) : null;
ok(sent && sent.tinkoffToken === 'new-tok' && sent.password === 'new-pass'
    && !('finamToken' in sent),
    'сохранение: POST settings.php — только заполненные поля');
ok(!wdoc.getElementById('settingsModal').classList.contains('active'),
    'модалка закрылась после успешного сохранения');

section('Веб-режим: экспорт бэкапа с токенами');
// В вебе токены живут на сервере: галочка «включать токены» должна подтянуть
// их из settings.php?export=tokens, а не отдавать пустые строки
webWindow.URL.createObjectURL = (b) => { b.text().then(t => { lastBlob = t; }); return 'blob:test'; };
webWindow.URL.revokeObjectURL = () => {};
wdoc.getElementById('setBackupTokens').checked = true;
webWindow.WalletBackup.exportBackup();
await sleep(80);
const webBackup = lastBlob ? JSON.parse(lastBlob) : null;
ok(webCalls.some(c => c.indexOf('settings.php') !== -1 && c.indexOf('export=tokens') !== -1),
    'экспорт с галочкой: GET settings.php?export=tokens');
ok(webBackup && webBackup.settings && webBackup.settings.tinkoffToken === 'srv-tink'
    && webBackup.settings.finamToken === 'srv-fin',
    'экспорт с галочкой: в JSON ушли полные токены с сервера');
ok(webBackup && webBackup.__tokensMissing === undefined,
    'экспорт: служебный флаг в файл не пишется');
wdoc.getElementById('setBackupTokens').checked = false;
webWindow.WalletBackup.exportBackup();
await sleep(60);
const webBackup2 = lastBlob ? JSON.parse(lastBlob) : null;
ok(webBackup2 && webBackup2.settings === null,
    'экспорт без галочки: settings null — токены с сервера не тащим');

section('Веб-режим: импорт бэкапа с токенами');
lastSettingsBody = null;
const webFile = new webWindow.File([JSON.stringify({
    version: 2,
    calendar: { transactions: FIXTURE.transactions, categories: FIXTURE.categories, occurrences: [], investmentConfig: FIXTURE.investmentConfig },
    settings: { tinkoffToken: 'imp-web-tok' }
})], 'wallet-backup.json', { type: 'application/json' });
webWindow.WalletBackup.importFile(webFile);
await sleep(200); // FileReader + POST
ok(lastSettingsBody !== null && JSON.parse(lastSettingsBody).tinkoffToken === 'imp-web-tok',
    'импорт в вебе: токены ушли POST в settings.php (на сервере, не в localStorage)');

section('settings.php: экспорт токенов за авторизацией');
const phpSrc = readFileSync(path.join(ROOT, 'settings.php'), 'utf8');
ok(phpSrc.indexOf("=== 'tokens'") !== -1 && phpSrc.indexOf('auth_require') !== -1,
    'settings.php: ветка ?export=tokens есть и закрыта auth_require');

// =====================================================================

console.log('\n—————————————————');
console.log('Пройдено: ' + passed + ', упало: ' + failed);
process.exit(failed ? 1 : 0);
