// Репродукция №1+№2: старый формат portfolio (без payments/sources/byBroker)
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import path from 'path';

const WWW = '/Users/a.shkondin/Documents/Projects/wallet/android/assets/www';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OLD_PORTFOLIO = {
    totals: {
        value: 1246890, cost: 1227966, pnl: 18924, pnlPct: 1.54, cash: 30000,
        paymentsNext12m: 85550, payingValue: 1100000
        // БЕЗ byBroker — старый формат
    },
    history: [
        { date: '2026-09-01', value: 1100000 },
        { date: '2026-10-01', value: 1246890 }
    ],
    holdings: [
        { ticker: 'SBER', name: 'Сбербанк', instrumentType: 'share', quantity: 1500, avgPrice: 250, cost: 375000, value: 420000, pnl: 45000, pnlPct: 12 },
        { ticker: 'LKOH', name: 'Лукойл', instrumentType: 'share', quantity: 40, avgPrice: 6500, cost: 260000, value: 296000, pnl: 36000, pnlPct: 13.8 }
        // БЕЗ payments/sources/paymentsNext12m — старый формат
    ],
    accounts: [
        { id: '123456789', broker: 'tinkoff', name: 'Т-Инвестиции', equity: 1246890, cash: 30000, positionsCount: 2 }
    ],
    meta: { generatedAt: new Date().toISOString(), brokers: { tinkoff: { configured: true, status: 'ok' } } }
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
window.localStorage.setItem('financialCalendar', JSON.stringify({
    transactions: [
        { id: 't1', name: 'Зарплата', date: '2026-09-05', amount: 50000, type: 'income', period: 'monthly', category: 'Доход' },
        { id: 't2', name: 'Инвестиции', date: '2026-10-06', amount: 10000, type: 'expense', period: 'monthly', category: 'Инвестиции' }
    ],
    categories: [
        { name: 'Доход', color: '#4CAF50', type: 'inc' },
        { name: 'Инвестиции', color: '#9C27B0', type: 'exp' }
    ],
    occurrences: [],
    investmentConfig: { goal: { monthlyTarget: 50000, endYear: 2046 }, horizonYears: 20 }
}));
window.localStorage.setItem('walletPortfolio', JSON.stringify(OLD_PORTFOLIO));

const files = ['standalone.js', 'sync-client.js', 'app.js', 'backup.js', 'settings.js', 'charts.js', 'forecast.js', 'dashboard.js'];
window.eval(files.map(f => readFileSync(path.join(WWW, f), 'utf8')).join('\n;\n'));
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
await sleep(150);

const doc = window.document;
const table = doc.querySelector('#fcTable .chart-scroll table');
console.log('таблица прогноза:', table ? 'ЕСТЬ (' + table.querySelectorAll('tr').length + ' строк)' : 'НЕТ');
const goalCard = doc.getElementById('goalCard');
console.log('карточка цели hidden:', goalCard.hidden);
const ht = doc.querySelectorAll('#holdingsTable tbody tr');
console.log('строк активов:', ht.length);
if (ht.length) {
    const cells = ht[0].querySelectorAll('td');
    console.log('ячейки 1-й строки:', [...cells].map(c => c.textContent.trim().replace(/\s+/g, ' ').slice(0, 16)).join(' | '));
}
console.log('JS-ошибки:', errors.length ? '\n' + errors.join('\n---\n') : 'нет');
