// Репродукция: цель задана + портфель — падает ли renderGoal/renderForecast
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import path from 'path';

const WWW = '/Users/a.shkondin/Documents/Projects/wallet/android/assets/www';
const FIXTURE = {
    transactions: [
        { id: 't1', name: 'Зарплата', date: '2026-09-05', amount: 50000, type: 'income', period: 'monthly', category: 'Доход' },
        { id: 't2', name: 'Интернет', date: '2026-10-10', amount: 700, type: 'expense', period: 'monthly', category: 'Связь' },
        { id: 't3', name: 'Инвестиции', date: '2026-10-06', amount: 10000, type: 'expense', period: 'monthly', category: 'Инвестиции' }
    ],
    categories: [
        { name: 'Доход', color: '#4CAF50', type: 'inc' },
        { name: 'Связь', color: '#42A5F5', type: 'exp' },
        { name: 'Инвестиции', color: '#9C27B0', type: 'exp' }
    ],
    occurrences: [],
    investmentConfig: {
        goal: { monthlyTarget: 50000, endYear: 2046 }, // ЦЕЛЬ ЗАДАНА — ветка не покрыта тестами
        horizonYears: 20
    }
};

const dom = new JSDOM(readFileSync(path.join(WWW, 'index.html'), 'utf8'), {
    url: 'https://wallet.local/', pretendToBeVisual: true, runScripts: 'outside-only'
});
const { window } = dom;
window.fetch = () => Promise.reject(new Error('СЕТЬ ЗАПРЕЩЕНА'));
window.PointerEvent = window.MouseEvent;
window.HTMLElement.prototype.scrollIntoView = function () {};
window.scrollTo = () => {};
window.confirm = () => true;
window.alert = () => {};
const errors = [];
window.addEventListener('error', e => errors.push(String(e.error && e.error.stack || e.message)));

const bridge = {
    http: () => JSON.stringify({ status: 0, body: '', error: 'нет сети' }),
    saveFile: () => true, persistSnapshot: () => true,
    scheduleNotification: () => {}, requestNotificationsPermission: () => {},
    toast: () => {}, appVersion: () => '1.0-test'
};
window.WalletAndroid = bridge;
window.localStorage.setItem('financialCalendar', JSON.stringify(FIXTURE));

const files = ['standalone.js', 'sync-client.js', 'app.js', 'backup.js', 'settings.js', 'charts.js', 'forecast.js', 'dashboard.js'];
window.eval(files.map(f => readFileSync(path.join(WWW, f), 'utf8')).join('\n;\n'));
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
await new Promise(r => setTimeout(r, 100));

// демо-портфель как в тестах
await window.WalletSync.runSync(true);
await new Promise(r => setTimeout(r, 50));
window.document.dispatchEvent(new window.CustomEvent('wallet:portfolio-imported'));
await new Promise(r => setTimeout(r, 100));

const doc = window.document;
const table = doc.querySelector('#fcTable .chart-scroll table');
console.log('таблица:', table ? 'ЕСТЬ (' + table.querySelectorAll('tr').length + ' строк)' : 'НЕТ');
const goalCard = doc.getElementById('goalCard');
console.log('карточка цели hidden:', goalCard.hidden, '| mode:', JSON.stringify(goalCard.dataset.mode));
console.log('цель-контент:', (doc.getElementById('goalView').textContent || '').slice(0, 90).replace(/\s+/g, ' '));

// «Изменить» → форма
doc.getElementById('goalEditBtn').click();
await new Promise(r => setTimeout(r, 50));
console.log('после «Изменить»: mode=', JSON.stringify(goalCard.dataset.mode),
    '| форма:', doc.querySelector('.goal-form') ? 'ЕСТЬ' : 'НЕТ',
    '| input:', doc.querySelector('.goal-form input') ? doc.querySelector('.goal-form input').value : '-');
console.log('JS-ошибки:', errors.length ? errors.join('\n---\n') : 'нет');
