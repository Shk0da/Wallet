// ==================== State ====================
let transactions = [];
let categories = [];
let currentDate = new Date();
let selectedDate = null;
let occurrences = []; // Фактические occurrence'ы из бекапа
let previousState = null; // Для отмены операций

// Переменные для свайпов
let touchStartX = 0;
let touchEndX = 0;

// Категории по умолчанию
const defaultCategories = [
    { name: 'Зарплата', type: 'inc', color: '#4CAF50' },
    { name: 'Дом', type: 'exp', color: '#FF9800' },
    { name: 'ЖКХ и Услуги', type: 'exp', color: '#66A3FF' },
    { name: 'Развлечения', type: 'exp', color: '#E91E63' },
    { name: 'Транспорт', type: 'exp', color: '#2196F3' },
    { name: 'Машина', type: 'exp', color: '#607D8B' },
    { name: 'Одежда', type: 'exp', color: '#9C27B0' },
    { name: 'Образование', type: 'exp', color: '#3F51B5' },
    { name: 'Путешествия', type: 'exp', color: '#2ABBF4' },
    { name: 'Кредит', type: 'exp', color: '#F44336' },
    { name: 'Подарки', type: 'exp', color: '#E91E63' },
    { name: 'Инвестиции', type: 'exp', color: '#8BC34A' },
    { name: 'Рестораны и кафе', type: 'exp', color: '#FF5722' }
];

// Конфиг инвестиций: как деньги из категории «Инвестиции» распределяются по брокерам
// и с какими параметрами строится прогноз (редактируется на дашборде, хранится в data.json)
let investmentConfig = null;
const defaultInvestmentConfig = {
    categoryName: 'Инвестиции',
    split: { tinkoff: 50, finam: 50 },        // % пополнений на каждый счёт
    yieldOverrides: { tinkoff: null, finam: null }, // % годовых вручную; null = из данных брокера
    defaultAnnualYieldPct: 12,
    horizonYears: 20,
    customMonthlyAmount: null,                // null = авто из monthly-транзакций «Инвестиции»
    inflationPct: null,                       // предполагаемая инфляция, %/год; null = 14.5 по умолчанию
    goal: { monthlyTarget: null, endYear: null } // цель по пассивному доходу, ₽/мес; null = не задана
};

function mergeInvestmentConfig(loaded) {
    const cfg = Object.assign({}, defaultInvestmentConfig, loaded || {});
    cfg.split = Object.assign({}, defaultInvestmentConfig.split, (loaded && loaded.split) || {});
    cfg.yieldOverrides = Object.assign({}, defaultInvestmentConfig.yieldOverrides, (loaded && loaded.yieldOverrides) || {});
    cfg.goal = Object.assign({}, defaultInvestmentConfig.goal, (loaded && loaded.goal) || {});
    return cfg;
}

// ==================== Initialization ====================
document.addEventListener('DOMContentLoaded', async () => {
    // Автономный режим (APK): данные только в localStorage, сервера нет.
    // Веб-режим как раньше: сервер — источник правды, localStorage — кэш.
    if (window.WALLET_STANDALONE) {
        loadFromLocalStorage();
    } else {
        await loadFromServer();
    }
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    updateCategorySelect();
    renderCategoriesList();
    
    // Инициализация свайпов для календаря
    initCalendarSwipe();

    // Сег-переключатели модалок, свотчи цветов, режим «скрыть суммы»
    initSegControls();
    initStealth();
    initHeaderServiceButtons();

    // Тап по подложке и Escape закрывают модалки (у bottom sheet это ожидаемо)
    initModalDismiss();

    // Дашборд подписан на это событие: конфиг инвестиций и календарь загружены
    document.dispatchEvent(new CustomEvent('wallet:data-loaded'));
});

// ==================== Swipe Support ====================
function initCalendarSwipe() {
    const calendarSection = document.querySelector('.calendar-section');
    if (!calendarSection) return;
    
    calendarSection.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    
    calendarSection.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });
}

function handleSwipe() {
    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;
    
    if (Math.abs(diff) < swipeThreshold) return;
    
    if (diff > 0) {
        // Свайп влево - следующий месяц
        nextMonth();
    } else {
        // Свайп вправо - предыдущий месяц
        previousMonth();
    }
}

// ==================== Server Sync ====================
async function loadFromServer() {
    try {
        const response = await fetch('api.php', { credentials: 'same-origin' });
        if (response.status === 401) {
            // Требуется вход (пароль в settings.json): покажем оверлей, данные не трогаем
            if (window.WalletAuth) WalletAuth.show();
            return;
        }
        const result = await response.json();

        if (result.success && result.data) {
            transactions = result.data.transactions || [];
            categories = result.data.categories || [];
            occurrences = result.data.occurrences || [];
            investmentConfig = mergeInvestmentConfig(result.data.investmentConfig);

            // Если категорий нет, инициализируем по умолчанию
            if (categories.length === 0) {
                initDefaultCategories();
            }

            console.log('Данные загружены с сервера:', {
                transactions: transactions.length,
                categories: categories.length,
                occurrences: occurrences.length
            });

            // Сохраняем в localStorage как кэш
            saveToLocalStorage();
        } else {
            // Ошибка или нет данных - начинаем с чистых данных и категориями по умолчанию
            console.warn('Не удалось загрузить данные с сервера, начинаем с чистых данных');
            transactions = [];
            categories = [];
            occurrences = [];
            initDefaultCategories();
        }
    } catch (error) {
        console.error('Ошибка подключения к серверу:', error);
        // При ошибке начинаем с чистых данных и категориями по умолчанию
        transactions = [];
        categories = [];
        occurrences = [];
        initDefaultCategories();
    }
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem('financialCalendar');
    if (saved) {
        const data = JSON.parse(saved);
        transactions = data.transactions || [];
        categories = data.categories || [];
        occurrences = data.occurrences || [];
        // Как и в loadFromServer: конфиг инвестиций мержится на дефолт
        investmentConfig = mergeInvestmentConfig(data.investmentConfig);
        
        // Если категорий нет, инициализируем по умолчанию
        if (categories.length === 0) {
            initDefaultCategories();
        }
    } else {
        // Нет данных в localStorage - инициализируем категории
        initDefaultCategories();
    }
}

function saveToLocalStorage() {
    localStorage.setItem('financialCalendar', JSON.stringify({
        transactions,
        categories,
        occurrences,
        investmentConfig
    }));
}

async function saveToServer() {
    // Автономный режим (APK): сервера нет — сохранение только локальное
    if (window.WALLET_STANDALONE) return true;
    try {
        const response = await fetch('api.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                transactions,
                categories,
                occurrences,
                investmentConfig
            })
        });

        if (response.status === 401) {
            // Сессия истекла: покажем вход, данные сохраняем локально до входа
            if (window.WalletAuth) WalletAuth.show('Сессия истекла — войдите заново');
            saveToLocalStorage();
            return false;
        }
        const result = await response.json();

        if (result.success) {
            saveToLocalStorage();
            return true;
        } else {
            console.error('Ошибка сохранения данных:', result.error);
            saveToLocalStorage();
            return false;
        }
    } catch (error) {
        console.error('Ошибка подключения к серверу:', error);
        saveToLocalStorage();
        return false;
    }
}

// Явное сохранение по кнопке
function saveDataToServer() {
    // Автономный режим: кнопки «на сервер» нет, но защита от случайного вызова
    if (window.WALLET_STANDALONE) { saveData(); return; }
    saveToServer().then(success => {
        if (success) {
            alert('Данные успешно сохранены на сервере');
        } else {
            alert('Данные сохранены локально (ошибка соединения с сервером)');
        }
    });
}

// ==================== Data Management ====================
function saveData() {
    saveToLocalStorage();
    // Автономный режим: обновляем снапшот для Java (утренние уведомления)
    if (window.WALLET_STANDALONE && window.WalletBackup) WalletBackup.persistSnapshot();
    saveToServer();
}

// Сохранение состояния перед изменениями
function savePreviousState() {
    previousState = {
        transactions: JSON.parse(JSON.stringify(transactions)),
        categories: JSON.parse(JSON.stringify(categories)),
        occurrences: JSON.parse(JSON.stringify(occurrences))
    };
}

// Отмена последней операции
function undoLastOperation() {
    if (!previousState) {
        alert('Нечего отменять');
        return;
    }
    
    transactions = previousState.transactions;
    categories = previousState.categories;
    occurrences = previousState.occurrences;
    previousState = null;
    
    saveData();
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    renderCategoriesList();
    updateCategorySelect();
    
    alert('Последняя операция отменена');
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Инициализация категорий по умолчанию
function initDefaultCategories() {
    categories = defaultCategories.map(cat => ({
        id: generateId(),
        name: cat.name,
        type: cat.type,
        color: cat.color,
        index: categories.length,
        icon: cat.type === 'inc' ? 10 : 20,
        uid: generateId()
    }));
    saveToLocalStorage();
    saveToServer();
}

// ==================== Calendar Rendering ====================
function renderCalendar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    // Update month display
    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                       'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    document.getElementById('currentMonth').textContent = `${monthNames[month]} ${year}`;
    
    // Get first day of month and total days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const totalDays = lastDay.getDate();
    
    // Adjust for Monday start (0 = Sunday in JS, we want Monday = 0)
    let startDay = firstDay.getDay() - 1;
    if (startDay === -1) startDay = 6;
    
    // Get previous month's last days
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    
    const calendarDays = document.getElementById('calendarDays');
    calendarDays.innerHTML = '';
    
    const today = new Date();
    
    // Previous month days
    for (let i = startDay - 1; i >= 0; i--) {
        const day = prevMonthLastDay - i;
        const date = new Date(year, month - 1, day);
        calendarDays.appendChild(createDayCell(date, true));
    }
    
    // Current month days
    for (let day = 1; day <= totalDays; day++) {
        const date = new Date(year, month, day);
        const isToday = date.toDateString() === today.toDateString();
        calendarDays.appendChild(createDayCell(date, false, isToday));
    }
    
    // Next month days
    const totalCells = startDay + totalDays;
    const nextMonthDays = 42 - totalCells; // 6 rows * 7 days = 42
    for (let day = 1; day <= nextMonthDays; day++) {
        const date = new Date(year, month + 1, day);
        calendarDays.appendChild(createDayCell(date, true));
    }
}

function createDayCell(date, isOtherMonth, isToday = false) {
    const cell = document.createElement('div');
    const cumulativeBalance = getCumulativeBalance(date);
    // отрицательный баланс на конец дня — красный фон клетки
    cell.className = `day-cell${isOtherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}`
        + (cumulativeBalance < 0 ? ' neg-eod' : '');
    cell.onclick = () => openDayModal(date);

    const balanceClass = cumulativeBalance >= 0 ? 'positive' : 'negative';
    const dayTransactions = getDayTransactions(date);

    // Компактные суммы дня для мобильной ячейки (десктоп их прячет в CSS)
    let dayIn = 0, dayOut = 0;
    dayTransactions.forEach(t => {
        if (t.type === 'income') dayIn += t.amount; else dayOut += t.amount;
    });
    const sumsHtml = (dayIn || dayOut) ? `<div class="day-sums">`
        + (dayIn ? `<div class="ds-in">+${compactSum(dayIn)}</div>` : '')
        + (dayOut ? `<div class="ds-out">−${compactSum(dayOut)}</div>` : '')
        + `</div>` : '';

    let transactionsHtml = '';
    dayTransactions.slice(0, 3).forEach(t => {
        const typeClass = t.type === 'income' ? 'income' : 'expense';
        const sign = t.type === 'income' ? '+' : '-';
        transactionsHtml += `<div class="day-transaction ${typeClass}">${sign}${Math.abs(t.amount).toLocaleString()} ₽</div>`;
    });
    if (dayTransactions.length > 3) {
        transactionsHtml += `<div style="color: #888; font-size: 0.7rem;">+${dayTransactions.length - 3} ещё</div>`;
    }

    cell.innerHTML = `
        <div class="day-number">${date.getDate()}</div>
        ${sumsHtml}
        <div class="day-balance ${balanceClass}">${cumulativeBalance.toLocaleString()} ₽</div>
        <div class="day-transactions">${transactionsHtml}</div>
    `;

    return cell;
}

// Короткая запись суммы для мобильной ячейки календаря: «50 тыс», «1,2 млн».
// Обычно это Charts.fmt.compactNum; локальный фолбэк — на случай, если app.js
// используется без charts.js.
function compactSum(v) {
    if (window.Charts && Charts.fmt && Charts.fmt.compactNum) return Charts.fmt.compactNum(v);
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн';
    if (a >= 1e3) return (v / 1e3).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' тыс';
    return Math.round(v).toLocaleString('ru-RU');
}

function previousMonth() {
    currentDate.setMonth(currentDate.getMonth() - 1);
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
}

function nextMonth() {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
}

function goToToday() {
    const today = new Date();
    currentDate = new Date(today.getFullYear(), today.getMonth(), 1);
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
}

// ==================== Transaction Calculations ====================
function getDayTransactions(date) {
    const dateStr = formatDate(date);
    const dayTransactions = [];
    
    const hasOccurrences = occurrences.length > 0;
    
    if (hasOccurrences) {
        const sortedOccurrences = [...occurrences].sort((a, b) => new Date(a.date) - new Date(b.date));
        const lastOccurrenceDate = sortedOccurrences[sortedOccurrences.length - 1].date;
        
        // Если дата в пределах occurrence'ов - используем их
        if (dateStr <= lastOccurrenceDate) {
            occurrences.forEach(occ => {
                if (occ.date === dateStr) {
                    const transaction = transactions.find(t => t.id === occ.transactionId);
                    dayTransactions.push({
                        id: occ.transactionId,
                        type: occ.type,
                        amount: occ.amount,
                        name: transaction ? transaction.name : 'Операция',
                        note: transaction ? transaction.note : null,
                        category: transaction ? transaction.category : null
                    });
                }
            });
            
            // Добавляем новые периодические операции (не из импорта)
            transactions.forEach(t => {
                if (t.period !== 'once' && isTransactionActiveOnDate(t, date)) {
                    const existsInOccurrences = occurrences.some(occ => 
                        occ.transactionId === t.id && occ.date === dateStr
                    );
                    if (!existsInOccurrences) {
                        dayTransactions.push({
                            ...t,
                            amount: t.amount
                        });
                    }
                }
            });
            
            return dayTransactions;
        }
        
        // Для будущих дат генерируем из периодических операций
        transactions.forEach(t => {
            if (t.period !== 'once') {
                const startDate = parseLocalDate(t.date);
                const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

                let current = getNextOccurrenceDate(t, parseLocalDate(lastOccurrenceDate));
                while (current <= (endDate || new Date(2100, 0, 1))) {
                    if (formatDate(current) === dateStr) {
                        dayTransactions.push({
                            ...t,
                            amount: t.amount
                        });
                    }
                    current = getNextOccurrenceDate(t, current);
                }
            } else if (t.date === dateStr) {
                // Однократные операции
                dayTransactions.push({
                    ...t,
                    amount: t.amount
                });
            }
        });
        return dayTransactions;
    }
    
    // Нет occurrence'ов - генерируем по периоду (для новых операций)
    transactions.forEach(t => {
        if (isTransactionActiveOnDate(t, date)) {
            dayTransactions.push({
                ...t,
                amount: getTransactionAmountForDate(t, date)
            });
        }
    });
    
    return dayTransactions.sort((a, b) => b.amount - a.amount);
}

function isTransactionActiveOnDate(transaction, date) {
    const startDate = parseLocalDate(transaction.date);
    const endDate = transaction.endDate ? parseLocalDate(transaction.endDate) : null;

    if (date < startDate) return false;
    if (endDate && date > endDate) return false;

    if (transaction.period === 'once') {
        return formatDate(date) === formatDate(startDate);
    }

    if (transaction.period === 'daily') {
        return true;
    }

    if (transaction.period === 'weekly' || transaction.period === 'biweekly') {
        const stepDays = transaction.period === 'biweekly' ? 14 : 7;
        const daysDiff = Math.floor((date - startDate) / (1000 * 60 * 60 * 24));
        return daysDiff % stepDays === 0;
    }

    if (transaction.period === 'monthly') {
        return date.getDate() === startDate.getDate();
    }

    if (transaction.period === 'yearly') {
        return date.getDate() === startDate.getDate() &&
               date.getMonth() === startDate.getMonth();
    }

    return false;
}

function parseLocalDate(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
}

function getTransactionAmountForDate(transaction, date) {
    // For most periods, amount is constant
    // Could be extended for variable amounts
    return transaction.amount;
}

function getDayBalance(date) {
    const dayTransactions = getDayTransactions(date);
    return dayTransactions.reduce((sum, t) => {
        return t.type === 'income' ? sum + t.amount : sum - t.amount;
    }, 0);
}

function getCumulativeBalance(date) {
    const targetDate = new Date(date);
    targetDate.setHours(23, 59, 59, 999);

    let balance = 0;

    // Считаем по occurrence'ам (фактические данные из импорта)
    const sortedOccurrences = [...occurrences].sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));

    sortedOccurrences.forEach(occ => {
        const occDate = parseLocalDate(occ.date);
        if (occDate <= targetDate) {
            if (occ.type === 'income') {
                balance += occ.amount;
            } else {
                balance -= occ.amount;
            }
        }
    });

    // Для будущих дат (после последнего occurrence) добавляем периодические операции
    const lastOccurrenceDate = sortedOccurrences.length > 0
        ? parseLocalDate(sortedOccurrences[sortedOccurrences.length - 1].date)
        : null;

    if (lastOccurrenceDate && targetDate > lastOccurrenceDate) {
        // Есть occurrence'ы, добавляем периодические операции после последней даты
        transactions.forEach(t => {
            if (t.period !== 'once') {
                const startDate = parseLocalDate(t.date);
                const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

                // Генерируем occurrence'ы после последней фактической даты
                let current = getNextOccurrenceDate(t, lastOccurrenceDate);

                while (current <= targetDate && (!endDate || current <= endDate)) {
                    if (current > lastOccurrenceDate) {
                        if (t.type === 'income') {
                            balance += t.amount;
                        } else {
                            balance -= t.amount;
                        }
                    }

                    current = getNextOccurrenceDate(t, current);
                }
            } else {
                // Однократные операции в будущем
                const tDate = parseLocalDate(t.date);
                if (tDate > lastOccurrenceDate && tDate <= targetDate) {
                    if (t.type === 'income') {
                        balance += t.amount;
                    } else {
                        balance -= t.amount;
                    }
                }
            }
        });
    } else if (!lastOccurrenceDate) {
        // Нет occurrence'ов вообще, считаем по периоду
        const allDates = [];
        transactions.forEach(t => {
            const startDate = parseLocalDate(t.date);
            const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

            if (t.period === 'once') {
                if (startDate <= targetDate) {
                    allDates.push({date: new Date(startDate), transaction: t});
                }
            } else if (t.period === 'daily') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setDate(current.getDate() + 1);
                    if (allDates.length > 10000) break;
                }
            } else if (t.period === 'weekly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setDate(current.getDate() + 7);
                }
            } else if (t.period === 'biweekly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setDate(current.getDate() + 14);
                }
            } else if (t.period === 'monthly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setMonth(current.getMonth() + 1);
                }
            } else if (t.period === 'yearly') {
                let current = new Date(startDate);
                while (current <= targetDate && (!endDate || current <= endDate)) {
                    allDates.push({date: new Date(current), transaction: t});
                    current.setFullYear(current.getFullYear() + 1);
                }
            }
        });

        allDates.sort((a, b) => a.date - b.date);

        const processed = new Set();
        allDates.forEach(item => {
            const key = item.transaction.id + '-' + item.date.toDateString();
            if (!processed.has(key)) {
                processed.add(key);
                if (item.transaction.type === 'income') {
                    balance += item.transaction.amount;
                } else {
                    balance -= item.transaction.amount;
                }
            }
        });
    }
    
    return balance;
}

// ==================== Экран «Баланс по дням» ====================
// Горизонтальная лента месяцев: SVG-график баланса (getCumulativeBalance) по дням.
// Листание бесконечное и без перерыва: прошлое (оно конечно — от месяца первой
// операции) строится заранее целиком, будущее добавляется страницами только
// append'ом — позиция скролла при этом не меняется и инерция не глохнет.
// Полная перерисовка редка: лишь когда график выходит за текущую шкалу Y.
// Будущее раскручивается до 2100 года, слева при упоре — «Начало истории».

const BAL_DAY_W = 14;    // px на один день
// Страницы-месяцы встык: день 1 в x=0, ширина = дням месяца, без полей и
// отступов между страницами — тогда день 1 следующего месяца оказывается
// ровно на один день правее последнего дня предыдущего и линия/заливка
// читаются как один непрерывный график (разрывов по месяцам нет).
const BAL_PAD_L = 0;
const BAL_PAD_R = 0;
const BAL_TOP = 8;
const BAL_H = 168;       // высота поля графика
const BAL_BOTTOM = 18;   // подписи дней
const BAL_TRIGGER = 160; // запас до края, при котором тянем следующие страницы
const BAL_PREBUILD = 48; // сколько месяцев прошлого строим заранее за раз

const balanceState = { built: false, dirty: true, months: [], cache: {}, scrollBusy: false };

// Имена месяцев вручную: ICU старых WebView (Chromium 57) для {month:'long',year}
// даёт родительный падеж («сентября 2026»), заголовку нужен именительный.
const BAL_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const BAL_MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function balMonthKey(y, m) { return y + '-' + ('0' + (m + 1)).slice(-2); }
function balPrevMonth(y, m) { return m === 0 ? { y: y - 1, m: 11 } : { y: y, m: m - 1 }; }
function balNextMonth(y, m) { return m === 11 ? { y: y + 1, m: 0 } : { y: y, m: m + 1 }; }
function balCmp(a, b) { return a.y !== b.y ? a.y - b.y : a.m - b.m; } // <0 — a раньше b

// Месяц самой ранней операции (стартов серии или occurrence) — левый край истории.
function balFirstDataMonth() {
    let best = null;
    const see = (str) => {
        if (!str) return;
        const d = parseLocalDate(str);
        if (!d || isNaN(d.getTime())) return;
        const y = d.getFullYear();
        const m = d.getMonth();
        if (!best || y < best.y || (y === best.y && m < best.m)) best = { y: y, m: m };
    };
    transactions.forEach(t => see(t.date));
    occurrences.forEach(o => see(o.date));
    return best;
}

// Точки месяца (день → баланс), кэшируются до смены данных.
function balMonthPoints(y, m) {
    const key = balMonthKey(y, m);
    if (balanceState.cache[key]) return balanceState.cache[key];
    const days = new Date(y, m + 1, 0).getDate();
    const pts = [];
    for (let d = 1; d <= days; d++) {
        pts.push({ d: d, bal: getCumulativeBalance(new Date(y, m, d)) });
    }
    balanceState.cache[key] = pts;
    return pts;
}

function balSvgEl(name, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}

// Страница-месяц: подпись + SVG (линия, заливка, «сегодня», подписи, гайд).
// Шкала сумм — не здесь, а в общей оси слева от ленты (balanceAxis).
function buildBalPage(mo, lo, hi) {
    const pts = balMonthPoints(mo.y, mo.m);
    const days = pts.length;
    const w = BAL_PAD_L + days * BAL_DAY_W + BAL_PAD_R;
    const h = BAL_TOP + BAL_H + BAL_BOTTOM;
    const span = (hi - lo) || 1;
    const yOf = v => BAL_TOP + BAL_H - ((v - lo) / span) * BAL_H;
    const xOf = i => BAL_PAD_L + i * BAL_DAY_W;

    const page = document.createElement('div');
    page.className = 'balance-page';
    page.setAttribute('data-month', balMonthKey(mo.y, mo.m));

    const title = document.createElement('div');
    title.className = 'balance-page-title';
    title.textContent = BAL_MONTHS[mo.m] + ' ' + mo.y;
    page.appendChild(title);

    const svg = balSvgEl('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h });

    // заливка под линией
    let d = '';
    let linePts = '';
    pts.forEach((p, i) => {
        const x = xOf(i);
        const y = yOf(p.bal);
        d += (i ? ' L' : 'M') + x + ' ' + y;
        linePts += (i ? ' ' : '') + x + ',' + y;
    });
    const baseY = BAL_TOP + BAL_H;
    d += ' L' + xOf(days - 1) + ' ' + baseY + ' L' + xOf(0) + ' ' + baseY + ' Z';
    const area = balSvgEl('path', { d: d });
    area.style.fill = 'rgba(92, 167, 255, 0.12)';
    svg.appendChild(area);

    const line = balSvgEl('polyline', { points: linePts, fill: 'none', 'stroke-width': 2 });
    line.style.stroke = 'var(--tui-blue)';
    svg.appendChild(line);

    // участки ниже нуля — красным: линия поверх синей + заливка до нулевой.
    // На пересечении нуля вставляем точку на самой нулевой линии, чтобы
    // красный начинался/заканчивался ровно там, где баланс меняет знак
    const yZero = yOf(0);
    let run = [];
    const flushRun = () => {
        if (run.length >= 2) {
            let rd = '', rp = '';
            run.forEach((q, k) => {
                rd += (k ? ' L' : 'M') + q.x + ' ' + q.y;
                rp += (k ? ' ' : '') + q.x + ',' + q.y;
            });
            rd += ' L' + run[run.length - 1].x + ' ' + yZero + ' L' + run[0].x + ' ' + yZero + ' Z';
            const ra = balSvgEl('path', { d: rd });
            ra.style.fill = 'rgba(255, 92, 92, 0.14)';
            svg.appendChild(ra);
            const rl = balSvgEl('polyline', { points: rp, fill: 'none', 'stroke-width': 2 });
            rl.style.stroke = 'var(--tui-red)';
            svg.appendChild(rl);
        }
        run = [];
    };
    for (let i = 0; i < days; i++) {
        const b = pts[i].bal;
        const prev = i > 0 ? pts[i - 1].bal : null;
        if (b < 0) {
            if (prev !== null && prev >= 0) {
                const t = (0 - prev) / (b - prev);
                run.push({ x: xOf(i - 1) + t * BAL_DAY_W, y: yZero });
            }
            run.push({ x: xOf(i), y: yOf(b) });
        } else if (prev !== null && prev < 0) {
            const t = (0 - prev) / (b - prev);
            run.push({ x: xOf(i - 1) + t * BAL_DAY_W, y: yZero });
            flushRun();
        }
    }
    flushRun();

    // нулевая линия, если баланс меняет знак
    if (lo < 0 && hi > 0) {
        const zero = balSvgEl('line', { x1: BAL_PAD_L, x2: w - BAL_PAD_R, y1: yOf(0), y2: yOf(0), 'stroke-dasharray': '3 3', 'stroke-width': 1 });
        zero.style.stroke = 'var(--tui-border)';
        svg.appendChild(zero);
    }

    // «сегодня» — жёлтая линия и точка
    const today = new Date();
    if (mo.y === today.getFullYear() && mo.m === today.getMonth()) {
        const ti = Math.min(today.getDate() - 1, days - 1);
        svg.appendChild(balSvgEl('line', {
            x1: xOf(ti), x2: xOf(ti), y1: BAL_TOP, y2: baseY,
            stroke: '#FFDD2D', 'stroke-width': 2, 'stroke-dasharray': '3 3'
        }));
        svg.appendChild(balSvgEl('circle', {
            cx: xOf(ti), cy: yOf(pts[ti].bal), r: 4,
            fill: '#FFDD2D', stroke: '#333333', 'stroke-width': 1.5
        }));
    }

    // подписи дней (1, 5, 10, …); минимум 4px, чтобы «1» не резалась о край страницы
    for (let day = 1; day <= days; day += (day === 1 ? 4 : 5)) {
        const t = balSvgEl('text', { x: Math.max(4, xOf(day - 1)), y: h - 4, 'text-anchor': 'middle', 'font-size': 9 });
        t.style.fill = 'var(--tui-text-3)';
        t.textContent = day;
        svg.appendChild(t);
    }

    // гайд и точка выбора (появляются при наведении/тапе)
    const guide = balSvgEl('line', { y1: BAL_TOP, y2: baseY, 'stroke-width': 1, 'stroke-dasharray': '4 3' });
    guide.style.stroke = 'var(--tui-text-3)';
    guide.style.display = 'none';
    const dot = balSvgEl('circle', { r: 4, 'stroke-width': 1.5 });
    dot.style.fill = 'var(--tui-blue)';
    dot.style.stroke = 'var(--tui-surface)';
    dot.style.display = 'none';
    svg.appendChild(guide);
    svg.appendChild(dot);

    const pick = e => {
        const rect = svg.getBoundingClientRect();
        let i = Math.round((e.clientX - rect.left - BAL_PAD_L) / BAL_DAY_W);
        if (i < 0) i = 0;
        if (i > days - 1) i = days - 1;
        return i;
    };
    const show = i => {
        const px = xOf(i);
        guide.setAttribute('x1', px);
        guide.setAttribute('x2', px);
        guide.style.display = '';
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', yOf(pts[i].bal));
        dot.style.display = '';
        // метка одна на всю ленту: прошлую (другой месяц) прячем
        const prev = balanceState.activeMark;
        if (prev && prev.guide !== guide) {
            prev.guide.style.display = 'none';
            prev.dot.style.display = 'none';
        }
        balanceState.activeMark = { guide: guide, dot: dot };
        balUpdateReadout(new Date(mo.y, mo.m, pts[i].d), pts[i].bal);
    };
    // «📍 Сегодня» и повторный вход на экран зовут метку снаружи — регистрируем
    if (!balanceState.pickers) balanceState.pickers = {};
    balanceState.pickers[balMonthKey(mo.y, mo.m)] = { show: show, days: days };
    svg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') show(pick(e)); });
    svg.addEventListener('click', e => {
        const i = pick(e);
        show(i);
        openDayModal(new Date(mo.y, mo.m, pts[i].d));
    });

    page.appendChild(svg);
    return page;
}

function balUpdateReadout(date, bal) {
    const el = document.getElementById('balanceReadout');
    if (!el) return;
    const now = new Date();
    const isToday = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const label = isToday ? 'Баланс на сегодня'
        : 'Баланс на ' + date.getDate() + ' ' + BAL_MONTHS_GEN[date.getMonth()] + ':';
    const color = bal < 0 ? ' style="color: var(--tui-red)"' : '';
    el.innerHTML = label + '<strong' + color + '>' + Math.round(bal).toLocaleString('ru-RU') + ' ₽</strong>';
}

// Перерисовать ленту по текущему окну месяцев; единая Y-шкала по всем страницам.
function renderBalanceWindow() {
    const strip = document.getElementById('balanceStrip');
    strip.innerHTML = '';
    // страницы пересоздаются — старые show-замыкания указывают в никуда
    balanceState.pickers = {};
    balanceState.activeMark = null;
    let lo = Infinity;
    let hi = -Infinity;
    balanceState.months.forEach(mo => balMonthPoints(mo.y, mo.m).forEach(p => {
        if (p.bal < lo) lo = p.bal;
        if (p.bal > hi) hi = p.bal;
    }));
    if (lo === Infinity) { lo = 0; hi = 0; }
    if (hi - lo < 1) hi = lo + 1;
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;

    const fl = balanceState.floor;
    const f0 = balanceState.months[0];
    if (fl && f0.y === fl.y && f0.m === fl.m) {
        const edge = document.createElement('div');
        edge.className = 'balance-start';
        edge.textContent = 'Начало истории';
        strip.appendChild(edge);
    }
    balanceState.months.forEach(mo => strip.appendChild(buildBalPage(mo, lo, hi)));
    balanceState.lo = lo; // текущая шкала: fast-path добавления сверяется с ней
    balanceState.hi = hi;

    // Ось сумм слева от ленты: 5 делений по общей шкале окна. Вертикально
    // совмещаем с полем графика страницы (заголовок месяца + верхний отступ).
    const axis = document.getElementById('balanceAxis');
    if (axis) {
        axis.innerHTML = '';
        const firstTitle = strip.querySelector('.balance-page .balance-page-title');
        const titleH = (firstTitle ? firstTitle.offsetHeight : 17) + 6; // + margin
        for (let i = 0; i <= 4; i++) {
            const v = hi - (hi - lo) * i / 4;
            const t = document.createElement('span');
            t.textContent = compactSum(v);
            t.style.top = (titleH + BAL_TOP + (BAL_H * i) / 4) + 'px';
            axis.appendChild(t);
        }
    }
}

function balScrollToToday() {
    const strip = document.getElementById('balanceStrip');
    const t = new Date();
    const el = strip.querySelector('.balance-page[data-month="' + balMonthKey(t.getFullYear(), t.getMonth()) + '"]');
    if (!el) return;
    const dayX = BAL_PAD_L + (t.getDate() - 1) * BAL_DAY_W;
    strip.scrollLeft = Math.max(0, el.offsetLeft + dayX - strip.clientWidth / 2);
    // метка на сегодняшнем дне + баланс на сегодня в рид-ауте
    const picker = balanceState.pickers && balanceState.pickers[balMonthKey(t.getFullYear(), t.getMonth())];
    if (picker) picker.show(Math.min(t.getDate() - 1, picker.days - 1));
    else balUpdateReadout(t, getCumulativeBalance(t));
}

// Бесконечность без перерыва. Будущее: добавляем страницы только append'ом —
// существующий DOM не трогаем, scrollLeft не меняем, инерция живёт. Полная
// перерисовка — единственный редкий случай: график вышел за шкалу Y. Прошлое
// уже построено заранее от месяца первой операции; глубже упреждающей
// глубины (очень длинная история) — prepend с компенсацией, там флинг и
// заглохнет, но это крайний случай.
function onBalStripScroll() {
    if (balanceState.scrollBusy) return;
    balanceState.scrollBusy = true;
    setTimeout(() => { balanceState.scrollBusy = false; }, 30);

    const strip = document.getElementById('balanceStrip');
    const months = balanceState.months;

    // --- будущее: append-only ---
    let guard = 3; // страниц за один проход — защита от вечного цикла
    while (guard-- > 0 && strip.scrollWidth - strip.scrollLeft - strip.clientWidth < BAL_TRIGGER) {
        const l = months[months.length - 1];
        if (l.y >= 2100) break;
        const nm = balNextMonth(l.y, l.m);
        const pts = balMonthPoints(nm.y, nm.m);
        let lo2 = balanceState.lo, hi2 = balanceState.hi;
        for (let i = 0; i < pts.length; i++) {
            if (pts[i].bal < lo2) lo2 = pts[i].bal;
            if (pts[i].bal > hi2) hi2 = pts[i].bal;
        }
        months.push(nm);
        if (lo2 < balanceState.lo || hi2 > balanceState.hi) {
            renderBalanceWindow(); // редкий случай: новая шкала + всё заново
        } else {
            strip.appendChild(buildBalPage(nm, balanceState.lo, balanceState.hi));
        }
    }

    // --- прошлое: обычно уже построено, здесь только очень глубокая история ---
    guard = 2;
    while (guard-- > 0 && strip.scrollLeft < BAL_TRIGGER) {
        const fl = balanceState.floor;
        const f = months[0];
        if (fl && f.y === fl.y && f.m === fl.m) break;
        const wasEdge = !!strip.querySelector('.balance-start');
        const pm = balPrevMonth(f.y, f.m);
        const oldLeft = strip.scrollLeft;
        const probe = buildBalPage(pm, balanceState.lo, balanceState.hi);
        months.unshift(pm);
        strip.insertBefore(probe, strip.firstChild);
        const edge = strip.querySelector('.balance-start');
        strip.scrollLeft = oldLeft + probe.offsetWidth
            + (edge && !wasEdge ? edge.offsetWidth : 0);
    }
}

function initBalanceView() {
    const strip = document.getElementById('balanceStrip');
    if (!strip.__balInit) {
        strip.__balInit = true;
        strip.addEventListener('scroll', onBalStripScroll);
        // колесо мыши листает ленту по горизонтали (полосы прокрутки под
        // графиком нет — только свайп и колесо); тачпад с горизонтальным
        // скроллом уже попадает в deltaX и не перенаправляется
        strip.addEventListener('wheel', e => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                strip.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
        const todayBtn = document.getElementById('balanceTodayBtn');
        if (todayBtn) todayBtn.addEventListener('click', balScrollToToday);
    }

    // Прошлое строим заранее целиком — от месяца первой операции (глубже
    // BAL_PREBUILD месяцев не тянем: очень длинные истории добираются
    // prepend'ом уже при прокрутке). Будущее — cur+6, дальше append'ом.
    // До первой операции баланс = 0, листать там нечего.
    const now = new Date();
    const cur = { y: now.getFullYear(), m: now.getMonth() };
    let back = cur;
    for (let i = 0; i < 3; i++) back = balPrevMonth(back.y, back.m);
    const fm = balFirstDataMonth();
    let start = back;
    if (fm && balCmp(fm, back) > 0 && balCmp(fm, cur) <= 0) start = fm;
    // левый край листания: месяц первой операции; без данных — стоп на старте
    balanceState.floor = fm && balCmp(fm, start) < 0 ? fm : start;
    balanceState.months = [start];
    let q = start;
    const total = 1 + (cur.y * 12 + cur.m - start.y * 12 - start.m) + 6;
    for (let j = 1; j < total && j <= BAL_PREBUILD + 6; j++) {
        q = balNextMonth(q.y, q.m);
        balanceState.months.push(q);
    }
    renderBalanceWindow();
    balUpdateReadout(now, getCumulativeBalance(now));
    balScrollToToday();
}

// Данные изменились — точки и кэш устарели, при следующем входе строим заново.
// Если пользователь стоит на «Балансе по дням» (например, рефреш страницы:
// вид восстановился из localStorage раньше, чем пришли данные), перестраиваем
// ленту сразу — иначе график стоит нулевым до повторного захода на экран.
function markBalanceDirty() {
    balanceState.dirty = true;
    balanceState.cache = {};
}
function onBalanceDataChanged() {
    const wasBuilt = balanceState.built;
    markBalanceDirty();
    if (wasBuilt && document.body.classList.contains('balance-mode')) {
        window.__walletShowBalance();
    }
}
document.addEventListener('wallet:data-changed', onBalanceDataChanged);
document.addEventListener('wallet:data-loaded', onBalanceDataChanged);

// Хук для setView (dashboard.js): первый вход строит экран, повторные — скролл к «сегодня».
window.__walletShowBalance = function () {
    if (balanceState.dirty || !balanceState.built) {
        initBalanceView();
        balanceState.built = true;
        balanceState.dirty = false;
    } else {
        balScrollToToday();
    }
};

function getNextOccurrenceDate(transaction, afterDate) {
    const startDate = parseLocalDate(transaction.date);
    const after = parseLocalDate(afterDate);

    if (transaction.period === 'daily') {
        return new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1);
    }

    if (transaction.period === 'weekly') {
        const daysSinceStart = Math.floor((after - startDate) / (1000 * 60 * 60 * 24));
        const nextWeek = Math.ceil((daysSinceStart + 1) / 7) * 7;
        return new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + nextWeek);
    }

    if (transaction.period === 'biweekly') {
        const daysSinceStart = Math.floor((after - startDate) / (1000 * 60 * 60 * 24));
        const next = Math.ceil((daysSinceStart + 1) / 14) * 14;
        return new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + next);
    }

    if (transaction.period === 'monthly') {
        let monthsSinceStart = (after.getFullYear() - startDate.getFullYear()) * 12 + (after.getMonth() - startDate.getMonth());
        // если «день серии» в текущем месяце ещё впереди — ближайшее вхождение в этом же месяце
        if (after.getDate() < startDate.getDate()) monthsSinceStart -= 1;
        const nextMonth = monthsSinceStart + 1;
        const year = startDate.getFullYear() + Math.floor(nextMonth / 12);
        const month = startDate.getMonth() + (nextMonth % 12);
        const day = Math.min(startDate.getDate(), new Date(year, month + 1, 0).getDate());
        return new Date(year, month, day);
    }

    if (transaction.period === 'yearly') {
        let yearsSinceStart = after.getFullYear() - startDate.getFullYear();
        // если дата серии в текущем году ещё впереди — ближайшее вхождение в этом же году
        if (after.getMonth() < startDate.getMonth() ||
            (after.getMonth() === startDate.getMonth() && after.getDate() < startDate.getDate())) yearsSinceStart -= 1;
        const nextYear = yearsSinceStart + 1;
        const year = startDate.getFullYear() + nextYear;
        const month = startDate.getMonth();
        const day = Math.min(startDate.getDate(), new Date(year, month + 1, 0).getDate());
        return new Date(year, month, day);
    }

    return new Date(startDate);
}

function getMonthBalance() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    let income = 0;
    let expense = 0;
    
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    
    const hasOccurrences = occurrences.length > 0;

    if (hasOccurrences) {
        const sortedOccurrences = [...occurrences].sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));
        const lastOccurrenceDate = sortedOccurrences.length > 0
            ? parseLocalDate(sortedOccurrences[sortedOccurrences.length - 1].date)
            : null;

        // Считаем occurrence'ы за этот месяц
        sortedOccurrences.forEach(occ => {
            const occDate = parseLocalDate(occ.date);
            if (occDate.getFullYear() === year && occDate.getMonth() === month) {
                if (occ.type === 'income') {
                    income += occ.amount;
                } else {
                    expense += occ.amount;
                }
            }
        });

        // Добавляем периодические операции для будущих дат
        if (lastOccurrenceDate && monthEnd > lastOccurrenceDate) {
            transactions.forEach(t => {
                if (t.period !== 'once') {
                    const startDate = parseLocalDate(t.date);
                    const endDate = t.endDate ? parseLocalDate(t.endDate) : null;

                    let current = getNextOccurrenceDate(t, lastOccurrenceDate);
                    while (current <= (endDate || new Date(2100, 0, 1))) {
                        if (current > lastOccurrenceDate && current >= monthStart && current <= monthEnd) {
                            if (t.type === 'income') {
                                income += t.amount;
                            } else {
                                expense += t.amount;
                            }
                        }
                        current = getNextOccurrenceDate(t, current);
                    }
                } else {
                    const tDate = parseLocalDate(t.date);
                    if (tDate > lastOccurrenceDate && tDate >= monthStart && tDate <= monthEnd) {
                        if (t.type === 'income') {
                            income += t.amount;
                        } else {
                            expense += t.amount;
                        }
                    }
                }
            });
        }
    } else {
        // Нет occurrence'ов - генерируем по периоду
        const daysInMonth = monthEnd.getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            const dayTransactions = getDayTransactions(date);
            
            dayTransactions.forEach(t => {
                if (t.type === 'income') {
                    income += t.amount;
                } else {
                    expense += Math.abs(t.amount);
                }
            });
        }
    }
    
    return { income, expense, balance: income - expense };
}

// ==================== Balance Summary ====================
function updateBalanceSummary() {
    const { income, expense, balance } = getMonthBalance();

    document.getElementById('monthIncome').textContent = `+${income.toLocaleString()} ₽`;
    document.getElementById('monthExpense').textContent = `-${expense.toLocaleString()} ₽`;

    const balanceEl = document.getElementById('monthBalance');
    balanceEl.textContent = `${balance >= 0 ? '+' : ''}${balance.toLocaleString()} ₽`;
    balanceEl.className = `balance-value ${balance >= 0 ? 'income' : 'expense'}`;
}

// ==================== Transactions List ====================
function renderTransactionsList() {
    const container = document.getElementById('transactionsList');
    
    // Используем выбранный месяц из currentDate
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Собираем предстоящие транзакции за выбранный месяц
    const upcomingTransactions = [];
    
    for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
        // Показываем только будущие транзакции
        if (d < today) continue;
        
        const dayTrans = getDayTransactions(new Date(d));
        dayTrans.forEach(t => {
            upcomingTransactions.push({
                ...t,
                displayDate: new Date(d)
            });
        });
    }
    
    // Удаляем дубликаты и сортируем по дате
    const seen = new Set();
    const unique = upcomingTransactions.filter(t => {
        const key = `${t.id}-${t.displayDate.toISOString()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    
    const sorted = unique.sort((a, b) => a.displayDate - b.displayDate).slice(0, 30);

    if (sorted.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: #888; padding: 20px;">Нет предстоящих операций</div>';
        return;
    }

    container.innerHTML = sorted.map(t => {
        const amountClass = t.type === 'income' ? 'income' : 'expense';
        const sign = t.type === 'income' ? '+' : '−';
        const category = getCategoryById(t.category);
        const catName = category ? category.name : (t.category || '');
        const color = category ? category.color : '';
        const avatarStyle = color ? ` style="background: ${color}26; color: ${color};"` : '';
        const letter = escapeHtml((catName || t.name || '?').trim().charAt(0).toUpperCase());

        const dateStr = t.displayDate.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short'
        });

        return `
            <div class="transaction-item">
                <div class="tx-avatar"${avatarStyle}>${letter}</div>
                <div class="transaction-info">
                    <div class="transaction-name">${escapeHtml(t.name)}</div>
                    <div class="transaction-meta">${catName ? escapeHtml(catName) + ' · ' : ''}📅 ${dateStr}</div>
                </div>
                <div class="transaction-amount ${amountClass}">
                    ${sign}${Math.abs(t.amount).toLocaleString()} ₽
                </div>
            </div>
        `;
    }).join('');
}

// ==================== Modal Functions ====================
// ==================== Segmented controls / swatches ====================
// Синхронизируют кнопку-«сег» со скрытым input: у формы остаётся контракт .value
function syncSeg(segId, value) {
    const seg = document.getElementById(segId);
    if (!seg) return;
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

function wireSeg(segId, inputId, onChange) {
    const seg = document.getElementById(segId);
    const input = document.getElementById(inputId);
    if (!seg || !input) return;
    seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        input.value = btn.dataset.value;
        syncSeg(segId, input.value);
        if (onChange) onChange();
    });
}

// Палитра свотчей категорий — валидированный Taiga-категориальный набор + зелёный дефолт
const CATEGORY_SWATCHES = ['#8BC34A', '#428BF9', '#F59200', '#D08FFF', '#00A328', '#FF7A91', '#2ABBF4', '#FF6347'];

function renderSwatches(activeColor) {
    const box = document.getElementById('categoryColorSwatches');
    const input = document.getElementById('categoryColor');
    if (!box || !input) return;
    const current = (activeColor || input.value || CATEGORY_SWATCHES[0]).toUpperCase();
    box.innerHTML = '';
    CATEGORY_SWATCHES.forEach(hex => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch' + (hex.toUpperCase() === current ? ' active' : '');
        b.style.background = hex;
        b.title = hex;
        b.setAttribute('aria-label', 'Цвет ' + hex);
        b.addEventListener('click', () => {
            input.value = hex;
            renderSwatches(hex);
        });
        box.appendChild(b);
    });
}

function initSegControls() {
    wireSeg('transactionTypeSeg', 'transactionType', () => updateCategorySelectByType());
    wireSeg('transactionPeriodSeg', 'transactionPeriod', () => { togglePeriodInfo(); updateScopeVisibility(); });
    wireSeg('transactionScopeSeg', 'transactionScope', () => updateScopeInfo());
    wireSeg('categoryTypeSeg', 'categoryType', null);
}

// ==================== Stealth mode (скрыть суммы) ====================
function initStealth() {
    const btn = document.getElementById('stealthBtn');
    if (!btn) return;
    const apply = (on) => {
        document.body.classList.toggle('stealth', on);
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? 'Показать суммы' : 'Скрыть суммы';
    };
    apply(localStorage.getItem('wallet-stealth') === '1');
    btn.addEventListener('click', () => {
        const on = !document.body.classList.contains('stealth');
        apply(on);
        localStorage.setItem('wallet-stealth', on ? '1' : '0');
    });
}

// Шапка календаря: 🏷 категории и ↩️ отмена (только на этом экране — CSS прячет
// в dashboard/balance-режимах; листенеры, а не onclick — jsdom не исполняет инлайн)
function initHeaderServiceButtons() {
    const catBtn = document.getElementById('categoriesBtn');
    if (catBtn) catBtn.addEventListener('click', () => openCategoriesModal());
    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) undoBtn.addEventListener('click', () => undoLastOperation());
}

// Закрытие модалок приложения тапом по подложке и Escape
// (по образцу WalletSettings; для мобильных bottom sheet — обязательный жест)
function initModalDismiss() {
    const closers = {
        transactionModal: closeTransactionModal,
        dayModal: closeDayModal,
        categoriesModal: closeCategoriesModal
    };
    Object.keys(closers).forEach(id => {
        const overlay = document.getElementById(id);
        if (!overlay) return;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closers[id]();
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        Object.keys(closers).forEach(id => {
            const overlay = document.getElementById(id);
            if (overlay && overlay.classList.contains('active')) closers[id]();
        });
    });
}

function openTransactionModal(date = null) {
    document.getElementById('transactionForm').reset();
    document.getElementById('transactionId').value = '';
    document.getElementById('modalTitle').textContent = 'Добавить операцию';
    document.getElementById('transactionDate').value = date ? formatDate(date) : formatDate(new Date());
    document.getElementById('periodInfo').textContent = '';
    // reset() возвращает скрытым input их value-атрибуты; сеги синхронизируем вручную
    syncSeg('transactionTypeSeg', document.getElementById('transactionType').value);
    syncSeg('transactionPeriodSeg', document.getElementById('transactionPeriod').value);
    document.getElementById('transactionDeleteBtn').hidden = true;
    document.getElementById('transactionScopeGroup').hidden = true;
    document.getElementById('scopeInfo').textContent = '';
    syncSeg('transactionScopeSeg', document.getElementById('transactionScope').value);

    updateCategorySelectByType();

    document.getElementById('transactionModal').classList.add('active');
}

function closeTransactionModal() {
    document.getElementById('transactionModal').classList.remove('active');
}

function openDayModal(date) {
    selectedDate = date;
    const dateStr = date.toLocaleDateString('ru-RU', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    document.getElementById('dayModalTitle').textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    
    const dayTransactions = getDayTransactions(date);
    const cumulativeBalance = getCumulativeBalance(date);
    
    let content = `
        <div class="dm-balance-card${cumulativeBalance < 0 ? ' neg' : ''}">
            <div class="dm-balance-label">Баланс на конец дня</div>
            <div class="dm-balance-value">${cumulativeBalance.toLocaleString()} ₽</div>
        </div>
    `;

    if (dayTransactions.length === 0) {
        content += '<div class="dm-empty">Нет операций</div>';
    } else {
        content += '<div class="transactions-list">';
        dayTransactions.forEach(t => {
            const amountClass = t.type === 'income' ? 'income' : 'expense';
            const sign = t.type === 'income' ? '+' : '−';
            const category = getCategoryById(t.category);
            const catName = category ? category.name : (t.category || '');
            const color = category ? category.color : '';
            const avatarStyle = color ? ` style="background: ${color}26; color: ${color};"` : '';
            const letter = escapeHtml((catName || t.name || '?').trim().charAt(0).toUpperCase());
            content += `
                <div class="transaction-item">
                    <div class="tx-avatar"${avatarStyle}>${letter}</div>
                    <div class="transaction-info">
                        <div class="transaction-name">${escapeHtml(t.name)}</div>
                        <div class="transaction-meta">${catName ? escapeHtml(catName) + (t.note ? ' · ' : '') : ''}${t.note ? escapeHtml(t.note) : ''}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <div class="transaction-amount ${amountClass}">
                            ${sign}${Math.abs(t.amount).toLocaleString()} ₽
                        </div>
                        <div class="transaction-actions">
                            <button onclick="editTransaction('${t.id}')" title="Редактировать">✏️</button>
                            <button onclick="deleteTransaction('${t.id}')" title="Удалить">🗑️</button>
                        </div>
                    </div>
                </div>
            `;
        });
        content += '</div>';
    }
    
    content += `
        <button class="btn btn-primary" onclick="closeDayModal(); openTransactionModal(selectedDate);" style="width: 100%; margin-top: 15px;">
            + Добавить операцию
        </button>
    `;
    
    document.getElementById('dayModalContent').innerHTML = content;
    document.getElementById('dayModal').classList.add('active');
}

function closeDayModal() {
    document.getElementById('dayModal').classList.remove('active');
}

// ==================== Form Handling ====================
function saveTransaction(event) {
    event.preventDefault();

    // Сохраняем состояние перед изменением
    savePreviousState();

    const id = document.getElementById('transactionId').value;
    const transaction = {
        id: id || generateId(),
        type: document.getElementById('transactionType').value,
        name: document.getElementById('transactionName').value,
        amount: parseFloat(document.getElementById('transactionAmount').value),
        date: document.getElementById('transactionDate').value,
        endDate: document.getElementById('transactionEndDate').value || null,
        period: document.getElementById('transactionPeriod').value,
        category: document.getElementById('transactionCategory').value || null,
        note: document.getElementById('transactionNote').value || null
    };

    if (id) {
        const index = transactions.findIndex(t => t.id === id);
        if (index !== -1) {
            const existing = transactions[index];
            const split = document.getElementById('transactionScope').value === 'future'
                ? seriesSplitPoint(existing) : null;
            if (split) {
                // «С текущей даты»: прошлое не меняем — старая серия заканчивается накануне разреза,
                // с точки разреза работает новая серия с параметрами из формы
                transactions[index] = Object.assign({}, existing, { endDate: split.prev });
                transactions.push(Object.assign({}, transaction, {
                    id: generateId(),
                    date: transaction.date > split.split ? transaction.date : split.split,
                    endDate: existing.endDate || null
                }));
            } else {
                transactions[index] = transaction;
            }
        }
    } else {
        transactions.push(transaction);
    }

    saveData();
    closeTransactionModal();

    // Всегда обновляем календарь и баланс после сохранения
    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    // Прогноз на вкладке «Портфель» должен увидеть новую сумму «Инвестиций»
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));

    // Reopen day modal if we were editing from day view
    if (selectedDate) {
        setTimeout(() => openDayModal(selectedDate), 100);
    }
}

function editTransaction(id) {
    const transaction = transactions.find(t => t.id === id);
    if (!transaction) return;
    
    document.getElementById('transactionId').value = transaction.id;
    document.getElementById('transactionType').value = transaction.type;
    document.getElementById('transactionName').value = transaction.name;
    document.getElementById('transactionAmount').value = transaction.amount;
    document.getElementById('transactionDate').value = transaction.date;
    document.getElementById('transactionEndDate').value = transaction.endDate || '';
    document.getElementById('transactionPeriod').value = transaction.period;
    document.getElementById('transactionNote').value = transaction.note || '';
    syncSeg('transactionTypeSeg', transaction.type);
    syncSeg('transactionPeriodSeg', transaction.period);
    togglePeriodInfo();
    // по умолчанию правка серии не трогает прошлые записи
    document.getElementById('transactionScope').value = 'future';
    syncSeg('transactionScopeSeg', 'future');
    updateScopeVisibility();
    document.getElementById('transactionDeleteBtn').hidden = false;

    document.getElementById('modalTitle').textContent = 'Редактировать операцию';
    updateCategorySelectByType();
    // категорию выставляем после перестройки списка опций, иначе выбор сбрасывается
    document.getElementById('transactionCategory').value = transaction.category || '';
    
    // Close day modal if open
    document.getElementById('dayModal').classList.remove('active');
    document.getElementById('transactionModal').classList.add('active');
}

// Удаление прямо из открытой модалки редактирования
function deleteTransactionFromModal() {
    const id = document.getElementById('transactionId').value;
    if (!id) return;
    document.getElementById('transactionModal').classList.remove('active');
    deleteTransaction(id);
}

function deleteTransaction(id) {
    if (!confirm('Вы уверены, что хотите удалить эту операцию?')) return;

    // Сохраняем состояние перед удалением
    savePreviousState();

    transactions = transactions.filter(t => t.id !== id);

    // Also remove from occurrences if present
    occurrences = occurrences.filter(occ => occ.transactionId !== id);

    saveData();

    // Close day modal if open
    document.getElementById('dayModal').classList.remove('active');

    renderCalendar();
    updateBalanceSummary();
    renderTransactionsList();
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));
}

function togglePeriodInfo() {
    const period = document.getElementById('transactionPeriod').value;
    const infoEl = document.getElementById('periodInfo');
    
    const info = {
        once: '',
        daily: 'Будет повторяться каждый день',
        weekly: 'Будет повторяться раз в неделю',
        biweekly: 'Будет повторяться раз в 2 недели',
        monthly: 'Будет повторяться каждый месяц в эту дату',
        yearly: 'Будет повторяться каждый год в эту дату'
    };
    
    infoEl.textContent = info[period];
}

// Точка разреза серии для правки «с текущей даты»: первое будущее вхождение и день перед ним.
// null — править серию целиком (однократная, ещё не началась, уже закончилась или вхождений впереди нет).
function seriesSplitPoint(transaction) {
    if (!transaction || transaction.period === 'once') return null;
    const today = new Date();
    const todayStr = formatDate(today);
    if (transaction.date >= todayStr) return null;
    if (transaction.endDate && transaction.endDate <= todayStr) return null;
    const splitDate = isTransactionActiveOnDate(transaction, today) ? today : getNextOccurrenceDate(transaction, todayStr);
    if (!splitDate) return null;
    const splitStr = formatDate(splitDate);
    if (transaction.endDate && transaction.endDate < splitStr) return null;
    const prev = parseLocalDate(splitStr);
    return { split: splitStr, prev: formatDate(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() - 1)) };
}

// Сег «Применить изменения» виден только при редактировании повторяющейся операции
function updateScopeVisibility() {
    const group = document.getElementById('transactionScopeGroup');
    if (!group) return;
    const editing = document.getElementById('transactionId').value !== '';
    const recurring = document.getElementById('transactionPeriod').value !== 'once';
    group.hidden = !(editing && recurring);
    updateScopeInfo();
}

function updateScopeInfo() {
    const infoEl = document.getElementById('scopeInfo');
    if (!infoEl) return;
    if (document.getElementById('transactionScope').value !== 'future') {
        infoEl.textContent = '';
        return;
    }
    const t = transactions.find(x => x.id === document.getElementById('transactionId').value);
    const split = t ? seriesSplitPoint(t) : null;
    infoEl.textContent = split
        ? 'Записи до ' + formatDDMMYYYY(split.split) + ' — с прежней суммой, с ' + formatDDMMYYYY(split.split) + ' — новая'
        : 'Прошлых записей нет — изменения применятся ко всей серии';
}

function formatDDMMYYYY(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const day = ('0' + date.getDate()).slice(-2);
    const month = ('0' + (date.getMonth() + 1)).slice(-2);
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

function generateOccurrences(transaction) {
    const occurrences = [];
    const startDate = new Date(transaction.date);
    const endDate = transaction.endDate ? new Date(transaction.endDate) : null;
    
    if (transaction.period === 'once') {
        occurrences.push({
            date: formatDDMMYYYY(transaction.date),
            amount: transaction.type === 'income' ? transaction.amount : -transaction.amount,
            active: true
        });
        return occurrences;
    }
    
    // Generate occurrences up to 12 instances or until end date
    let currentDate = new Date(startDate);
    let count = 0;
    const maxOccurrences = 12;
    
    while (count < maxOccurrences) {
        if (endDate && currentDate > endDate) break;
        
        const dateStr = formatDDMMYYYY(currentDate);
        const amount = transaction.type === 'income' ? transaction.amount : -transaction.amount;
        
        occurrences.push({
            date: dateStr,
            amount: amount,
            active: true
        });
        
        count++;
        
        // Move to next occurrence based on period
        switch (transaction.period) {
            case 'daily':
                currentDate.setDate(currentDate.getDate() + 1);
                break;
            case 'weekly':
                currentDate.setDate(currentDate.getDate() + 7);
                break;
            case 'monthly':
                currentDate.setMonth(currentDate.getMonth() + 1);
                break;
            case 'yearly':
                currentDate.setFullYear(currentDate.getFullYear() + 1);
                break;
        }
        
        // Handle invalid dates (e.g., 31st in months with 30 days)
        if (currentDate.getDate() !== startDate.getDate() && transaction.period !== 'daily') {
            currentDate.setDate(0); // Set to last day of previous month
        }
    }
    
    return occurrences;
}

// ==================== Utilities ====================
function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = ('0' + (d.getMonth() + 1)).slice(-2);
    const day = ('0' + d.getDate()).slice(-2);
    return `${year}-${month}-${day}`;
}

function formatDateDisplay(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('ru-RU');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateCategorySelect() {
    const select = document.getElementById('transactionCategory');
    const typeSelect = document.getElementById('transactionType');
    const currentType = (typeSelect ? typeSelect.value : '') || 'expense';
    
    // Map 'expense'/'income' to 'exp'/'inc'
    const typeMap = { 'expense': 'exp', 'income': 'inc' };
    const targetType = typeMap[currentType] || currentType;
    
    select.innerHTML = '<option value="">Без категории</option>';

    categories.filter(cat => cat.type === targetType).forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.id;
        option.textContent = cat.name;
        select.appendChild(option);
    });
}

function updateCategorySelectByType() {
    updateCategorySelect();
}

// ==================== Categories Management ====================
function renderCategoriesList() {
    const container = document.getElementById('categoriesList');
    if (!container) return;

    if (categories.length === 0) {
        container.innerHTML = '<div class="cat-list-note">Нет категорий</div>';
        return;
    }

    const sorted = [...categories].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'inc' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    container.innerHTML = sorted.map(cat => `
        <div class="cat-row">
            <span class="cat-dot" style="background: ${cat.color}"></span>
            <span class="cat-name">${escapeHtml(cat.name)}</span>
            <span class="cat-type">${cat.type === 'inc' ? 'Доход' : 'Расход'}</span>
            <span class="cat-actions">
                <button onclick="editCategory('${cat.id}')" title="Редактировать">✏️</button>
                <button onclick="deleteCategory('${cat.id}')" title="Удалить">🗑️</button>
            </span>
        </div>
    `).join('');
}

function openCategoriesModal() {
    renderCategoriesList();
    document.getElementById('addCategoryForm').classList.add('hidden');
    document.getElementById('categoriesModal').classList.add('active');
}

function closeCategoriesModal() {
    document.getElementById('categoriesModal').classList.remove('active');
    document.getElementById('addCategoryForm').classList.add('hidden');
}

function openAddCategoryForm() {
    document.getElementById('editCategoryId').value = '';
    document.getElementById('categoryName').value = '';
    document.getElementById('categoryType').value = 'exp';
    document.getElementById('categoryColor').value = '#8BC34A';
    syncSeg('categoryTypeSeg', 'exp');
    renderSwatches('#8BC34A');
    document.getElementById('categoryFormTitle').textContent = 'Новая категория';
    document.getElementById('addCategoryForm').classList.remove('hidden');
}

function cancelCategoryForm() {
    document.getElementById('addCategoryForm').classList.add('hidden');
}

function editCategory(id) {
    const category = categories.find(c => c.id === id);
    if (!category) return;

    document.getElementById('editCategoryId').value = category.id;
    document.getElementById('categoryName').value = category.name;
    document.getElementById('categoryType').value = category.type;
    document.getElementById('categoryColor').value = category.color;
    syncSeg('categoryTypeSeg', category.type);
    renderSwatches(category.color);
    document.getElementById('categoryFormTitle').textContent = 'Редактировать категорию';
    document.getElementById('addCategoryForm').classList.remove('hidden');
}

function saveCategory() {
    const id = document.getElementById('editCategoryId').value;
    const name = document.getElementById('categoryName').value.trim();
    const type = document.getElementById('categoryType').value;
    const color = document.getElementById('categoryColor').value;

    if (!name) {
        alert('Введите название категории');
        return;
    }

    // Сохраняем состояние перед изменением
    savePreviousState();

    if (id) {
        // Edit existing
        const index = categories.findIndex(c => c.id === id);
        if (index !== -1) {
            categories[index] = {
                ...categories[index],
                name,
                type,
                color
            };
        }
    } else {
        // Add new
        categories.push({
            id: generateId(),
            name,
            type,
            color,
            index: categories.length,
            icon: type === 'inc' ? 10 : 20,
            uid: generateId()
        });
    }

    saveData();
    renderCategoriesList();
    updateCategorySelect();
    renderTransactionsList();
    cancelCategoryForm();
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));
}

function deleteCategory(id) {
    if (!confirm('Удалить эту категорию? Операции останутся без категории.')) return;

    // Сохраняем состояние перед удалением
    savePreviousState();

    categories = categories.filter(c => c.id !== id);
    
    // Remove category from transactions
    transactions.forEach(t => {
        if (t.category === id) {
            t.category = null;
        }
    });
    
    saveData();
    renderCategoriesList();
    updateCategorySelect();
    renderTransactionsList();
    document.dispatchEvent(new CustomEvent('wallet:data-changed'));
}

function getCategoryById(id) {
    // Основной ключ — id; фолбэк по имени: старые/импортированные транзакции
    // хранят в category имя, а не id
    return categories.find(c => c.id === id) || categories.find(c => c.name === id);
}
