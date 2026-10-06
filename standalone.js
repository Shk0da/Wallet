// standalone.js — признак автономного режима (APK).
//
// Подключается ПЕРВЫМ в offline-сборке (tools/build-www.sh), до app.js и
// dashboard.js. В веб-версии файл не подключается — все проверки
// window.WALLET_STANDALONE в коде дают false, поведение не меняется.
//
// Что переключает режим:
//   app.js      — старт с localStorage вместо loadFromServer(), сохранение без POST api.php
//   dashboard.js— портфель из localStorage['walletPortfolio'], синхронизация через WalletSync
//   CSS         — body.standalone прячет .server-only и показывает .standalone-only
window.WALLET_STANDALONE = true;
document.body.classList.add('standalone');
