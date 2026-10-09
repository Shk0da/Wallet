// tools/cdp-eval.mjs — выполнить JS в живом WebView приложения через CDP.
// Использование: node tools/cdp-eval.mjs 'выражение'
// (отладочный сокет WebView уже проброшен: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>)
const expr = process.argv[2];
if (!expr) { console.error('укажите выражение'); process.exit(1); }

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find(p => p.type === 'page');
if (!page) { console.error('страница не найдена'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
const timeout = setTimeout(() => { console.error('timeout'); process.exit(2); }, 15000);

ws.onopen = () => {
    ws.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
    }));
};
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === 1) {
        clearTimeout(timeout);
        if (m.result && m.result.exceptionDetails) {
            const d = m.result.exceptionDetails;
            console.log('EXCEPTION:', d.text, d.exception && d.exception.description ? d.exception.description.slice(0, 800) : '');
        } else if (m.result && m.result.result) {
            const r = m.result.result;
            console.log(r.type === 'string' ? r.value : JSON.stringify(r.value, null, 1));
        } else {
            console.log(JSON.stringify(m.result));
        }
        ws.close();
        process.exit(0);
    }
};
ws.onerror = (e) => { console.error('ws error'); process.exit(3); };
