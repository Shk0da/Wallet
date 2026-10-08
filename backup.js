// backup.js — экспорт/импорт всех данных приложения в JSON + снапшот для Java.
//
// Работает в обеих версиях:
//   веб        — экспорт скачивает файл (Blob + a[download]), импорт применяется
//                к календарю и уходит на сервер обычным saveData();
//   APK        — экспорт через мост WalletAndroid.saveFile (файл в Downloads),
//                импорт применяется к localStorage и снапшоту.
//
// Формат комбинированного бэкапа:
//   {
//     version: 2, exportedAt: "2026-10-06T09:00:00.000Z",
//     calendar: { transactions, categories, occurrences, investmentConfig },
//     portfolio: { totals, history, holdings, ... } | null,
//     settings: { tinkoffToken, finamToken, trustAllCerts, notifications } | null
//   }
// Импорт дополнительно распознаёт «сырые» файлы сервера: data.json (есть transactions)
// и portfolio.json (есть totals) — так бэкап с сервера переносится в приложение.
//
// Снапшот: WebView localStorage из Java не читается, поэтому при каждом сохранении
// сбрасываем те же данные в файл через WalletAndroid.persistSnapshot — их читает
// NotifyReceiver для утреннего уведомления и BootReceiver после перезагрузки.
const WalletBackup = (() => {

    // ---------- Скачивание файла: мост APK или браузерный Blob ----------

    function downloadFile(name, content) {
        if (window.WalletAndroid && WalletAndroid.saveFile) {
            const ok = WalletAndroid.saveFile(name, content);
            return ok === true || ok === 'true';
        }
        // Браузер: классическое скачивание
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return true;
    }

    // ---------- Сборка бэкапа ----------

    // В веб-версии портфель берём с сервера (свежий), в автономной — из localStorage
    async function collectPortfolio() {
        if (window.WALLET_STANDALONE) {
            try { return JSON.parse(localStorage.getItem('walletPortfolio') || 'null'); }
            catch (e) { return null; }
        }
        try {
            const resp = await fetch('portfolio.php', { credentials: 'same-origin' });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (e) { return null; }
    }

    // Настройки для бэкапа: в автономке — localStorage (там живут токены),
    // в вебе — токены с сервера, и только когда пользователь попросил их
    // включить (settings.php?export=tokens, за auth_require). Без токенов
    // в вебе писать нечего: настройки-данные веба лежат на сервере.
    async function collectSettings(includeTokens) {
        if (window.WALLET_STANDALONE) {
            if (!window.WalletSettings) return null;
            const s = WalletSettings.load();
            return includeTokens ? s : Object.assign({}, s, { tinkoffToken: '', finamToken: '' });
        }
        if (!includeTokens) return null;
        try {
            const resp = await fetch('settings.php?export=tokens', { credentials: 'same-origin' });
            if (!resp.ok) return null;
            const d = await resp.json();
            if (!d || !d.success) return null;
            return { tinkoffToken: d.tinkoffToken || '', finamToken: d.finamToken || '' };
        } catch (e) { return null; }
    }

    async function buildBackup(includeTokens) {
        const settings = await collectSettings(includeTokens);
        const backup = {
            version: 2,
            exportedAt: new Date().toISOString(),
            calendar: {
                transactions: transactions,
                categories: categories,
                occurrences: occurrences,
                investmentConfig: investmentConfig
            },
            portfolio: await collectPortfolio(),
            settings: settings
        };
        // флаг «просили токены, но не смогли получить» — только для тоста,
        // в сам файл не пишется
        backup.__tokensMissing = includeTokens && !settings;
        return backup;
    }

    async function exportBackup() {
        const includeTokens = !!(document.getElementById('setBackupTokens') || {}).checked;
        const backup = await buildBackup(includeTokens);
        const missing = backup.__tokensMissing;
        delete backup.__tokensMissing;
        const date = new Date().toISOString().slice(0, 10);
        const name = 'wallet-backup-' + date + '.json';
        const ok = downloadFile(name, JSON.stringify(backup, null, 2));
        if (window.toast) {
            if (!ok) toast('Не удалось сохранить файл');
            else if (missing) toast('Бэкап: ' + name + ' — токены получить не удалось, экспорт без них');
            else toast('Бэкап: ' + name);
        }
    }

    // ---------- Импорт ----------

    function applyCalendar(cal) {
        transactions = cal.transactions || [];
        categories = cal.categories || [];
        occurrences = cal.occurrences || [];
        if (typeof mergeInvestmentConfig === 'function') {
            investmentConfig = mergeInvestmentConfig(cal.investmentConfig);
        }
        if (categories.length === 0 && typeof initDefaultCategories === 'function') {
            initDefaultCategories();
        }
        saveData(); // localStorage + (веб: api.php / APK: снапшот)
        renderCalendar();
        updateBalanceSummary();
        renderTransactionsList();
        updateCategorySelect();
        renderCategoriesList();
        document.dispatchEvent(new CustomEvent('wallet:data-changed'));
    }

    function applyPortfolio(p) {
        try { localStorage.setItem('walletPortfolio', JSON.stringify(p)); } catch (e) {}
        // В автономном режиме дашборд перечитает localStorage; в вебе портфель
        // остаётся серверным — сохранённый снимок пригодится при переносе в APK.
        document.dispatchEvent(new CustomEvent('wallet:portfolio-imported'));
    }

    async function applySettings(s) {
        if (!s) return;
        if (!window.WALLET_STANDALONE) {
            // Веб: токены живут на сервере — непустые уйдут одним POST
            // в settings.php (тот же контракт, что у модалки настроек)
            const payload = {};
            if (s.tinkoffToken) payload.tinkoffToken = s.tinkoffToken;
            if (s.finamToken) payload.finamToken = s.finamToken;
            if (Object.keys(payload).length) {
                try {
                    const resp = await fetch('settings.php', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    const d = await resp.json().catch(() => null);
                    if (!d || !d.success) {
                        toast('Токены не сохранены на сервере: ' + (d && d.error ? d.error : 'HTTP ' + resp.status));
                    }
                } catch (e) {
                    toast('Токены не сохранены на сервере: сервер недоступен');
                }
            }
            return;
        }
        if (!window.WalletSettings) return;
        const merged = Object.assign({}, WalletSettings.load(), s);
        WalletSettings.save(merged, { reschedule: true });
    }

    async function importFile(file) {
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (e) {
            alert('Не удалось прочитать файл: неверный JSON');
            return;
        }
        if (!data || typeof data !== 'object') {
            alert('Не удалось прочитать файл: это не бэкап Шакала');
            return;
        }

        // Дискриминатор формы: комбинированный бэкап / data.json / portfolio.json
        const has = (data.calendar && (data.calendar.transactions || data.calendar.categories));
        const isRawCalendar = !has && Array.isArray(data.transactions);
        const isRawPortfolio = !has && data.totals;

        if (!has && !isRawCalendar && !isRawPortfolio) {
            alert('Не удалось распознать файл: нет ни календаря, ни портфеля');
            return;
        }
        if (!confirm('Заменить текущие данные данными из файла?\n' +
            (has || isRawCalendar ? 'Календарь будет перезаписан. ' : '') +
            ((data.portfolio || isRawPortfolio) ? 'Портфель будет заменён. ' : '') +
            (data.settings ? 'Настройки будут обновлены.' : ''))) {
            return;
        }

        try {
            if (has) {
                applyCalendar(data.calendar);
            } else if (isRawCalendar) {
                applyCalendar(data);
            }
            if (data.portfolio) applyPortfolio(data.portfolio);
            else if (isRawPortfolio) applyPortfolio(data);
            if (data.settings) await applySettings(data.settings);
            persistSnapshot();
            if (window.toast) toast('Импорт завершён');
        } catch (e) {
            console.error('Ошибка импорта:', e);
            alert('Ошибка импорта: ' + e.message);
        }
    }

    // ---------- Снапшот для Java (утренние уведомления, BootReceiver) ----------

    function persistSnapshot() {
        if (!window.WalletAndroid || !WalletAndroid.persistSnapshot) return;
        const snapshot = {
            calendar: {
                transactions: transactions,
                categories: categories,
                occurrences: occurrences,
                investmentConfig: investmentConfig
            },
            settings: window.WalletSettings ? WalletSettings.load() : null
        };
        // Портфель — тоже: файл всегда свежий (мост пишет синхронно), а
        // localStorage живого приложения после ФОНОВОЙ синхронизации отстаёт
        // (ту страницу обновил рендерер сервиса) — при возврате из фона
        // dashboard.__walletOnResume лечит его из этого снапшота
        if (window.WALLET_STANDALONE) {
            try { snapshot.portfolio = JSON.parse(localStorage.getItem('walletPortfolio') || 'null'); }
            catch (e) { snapshot.portfolio = null; }
        }
        try {
            WalletAndroid.persistSnapshot(JSON.stringify(snapshot));
        } catch (e) { /* мост недоступен — веб-режим */ }
    }

    // ---------- Инициализация ----------

    document.addEventListener('DOMContentLoaded', () => {
        const input = document.getElementById('importFileInput');
        if (input) {
            input.addEventListener('change', () => {
                if (input.files && input.files[0]) {
                    importFile(input.files[0]);
                    input.value = ''; // позволяет повторно выбрать тот же файл
                }
            });
        }
    });

    return { exportBackup, importFile, persistSnapshot, downloadFile };
})();
window.WalletBackup = WalletBackup;
