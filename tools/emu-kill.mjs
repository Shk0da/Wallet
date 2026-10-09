// tools/emu-kill.mjs — погасить эмулятор через консоль-порт 5554 (telnet).
// adb emu kill иногда отвечает «unknown command»; консоль требует auth.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const home = process.argv[2] || 'tools/android-home';
let token = '';
try { token = readFileSync(home + '/.emulator_console_auth_token', 'utf8').trim(); }
catch { try { token = readFileSync(process.env.HOME + '/.emulator_console_auth_token', 'utf8').trim(); } catch { /* без токена */ } }

const sock = createConnection({ host: '127.0.0.1', port: 5554 }, () => {
    if (token) sock.write('auth ' + token + '\n');
    sock.write('kill\n');
});
setTimeout(() => process.exit(0), 3000);
sock.on('error', e => { console.error('console error:', e.code); process.exit(1); });
