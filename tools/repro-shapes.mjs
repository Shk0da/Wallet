// Репродукция вариантов данных прогноза/цели (standalone-бандл, как в APK)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import path from 'path';

const WWW = '/Users/a.shkondin/Documents/Projects/wallet/android/assets/www';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(name, cfgOverrides) {
    const FIXTURE = {
        transactions: [
            { id: 't1', name: 'Зарплата', date: '2026-09-05', amount: 50000, type: 'income', period: 'monthly', category: 'Доход' },
            { id: 't2', name: 'Инвестиции', date: '2026-10-06', amount: 10000, type: 'expense', period: 'monthly', category: 'Инвестиции' }
        ],
        categories: [
            { name: 'Доход', color: '#4CAF50', type: 'inc' },
            { name: 'Инвестиции', color: '#9C27B0', type: 'exp' }
        ],
        occurrences: [],
        investmentConfig: cfgOverrides
    };
    const dom = new JSDOM(readFileSync(path.join(WWW, 'index.html'), 'utf8'), {
        url: 'https://wallet.local/', pretendToBeVisual: true, runScripts: 'outside-only'
    });
    const { window } = dom;
    window.fetch = () => Promise.reject(new Error('нет сети'));
    window.PointerEvent = window.MouseEvent;
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.scrollTo = () => {};
    window.confirm = () => true; window.alert = () => {};
    const errors = [];
    window.addEventListener('error', e => errors.push(String(e.error && e.error.stack || e.message)));
    window.WalletAndroid = {
        http: () => JSON.stringify({ status: 0, body: '', error: 'нет сети' }),
        saveFile: () => true, persistSnapshot: () => true,
        scheduleNotification: () => {}, requestNotificationsPermission: () => {},
        toast: () => {}, appVersion: () => '1.0-test'
    };
    window.localStorage.setItem('financialCalendar', JSON.stringify(FIXTURE));
    const files = ['standalone.js', 'sync-client.js', 'app.js', 'backup.js', 'settings.js', 'charts.js', 'forecast.js', 'dashboard.js'];
    window.eval(files.map(f => readFileSync(path.join(WWW, f), 'utf8')).join('\n;\n'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    await sleep(80);
    await window.WalletSync.runSync(true);
    await sleep(50);
    window.document.dispatchEvent(new window.CustomEvent('wallet:portfolio-imported'));
    await sleep(100);
    const doc = window.document;
    const table = doc.querySelector('#fcTable .chart-scroll table');
    const rows = table ? table.querySelectorAll('tr').length : 0;
    const goal = (doc.getElementById('goalView').textContent || '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(name.padEnd(34), 'таблица:', table ? rows + ' строк' : 'НЕТ', '| цель:', goal || '-', errors.length ? '| ОШИБКА: ' + errors[0].split('\n')[0] : '');
}

await run('цель 50к, горизонт 20 (база)', { goal: { monthlyTarget: 50000, endYear: 2046 }, horizonYears: 20 });
await run('горизонт 5', { goal: { monthlyTarget: 50000 }, horizonYears: 5 });
await run('инфляция 0', { goal: { monthlyTarget: 50000 }, inflationPct: 0 });
await run('без цели (CTA)', { horizonYears: 20 });
await run('ручной взнос', { goal: { monthlyTarget: 30000 }, customMonthlyAmount: 15000 });
await run('goal-число (старый формат)', { goal: 100000 });
await run('horizonYears строкой', { goal: { monthlyTarget: 50000 }, horizonYears: '20' });
