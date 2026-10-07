package ru.wallet.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Iterator;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Фоновая автосинхронизация брокеров (настройка «Автосинхронизация», раз в день).
 *
 * Будильник (AlarmScheduler, код 1002) стартует SyncReceiver даже если
 * приложение не открывали. Сервис поднимает невидимый WebView с той же
 * офлайн-страницей и флагом ?autosync=1: sync-client.js видит флаг, даёт
 * приложению инициализироваться и гонит штатный __walletRunSync — тот же
 * путь, что у кнопки синхронизации. localStorage общий с приложением, поэтому
 * данные брокеров оказываются на месте к следующему запуску.
 *
 * foreground-сервис НЕ держит процессор: будильник будит телефон только на
 * ~10 с ресивера. Дальше CPU может уснуть (экран выключен, Doze) — JS WebView
 * замерзал бы на полпути, syncDone не приходил, пуш висел «Синхронизация
 * брокеров…» вечно. Поэтому держим partial WakeLock до конца работы.
 *
 * Пока идёт синхронизация, висит видимый пуш («Синхронизация брокеров…»),
 * по завершении JS зовёт WalletAndroid.syncDone(ok, text) и пуш заменяется
 * итогом («Данные обновлены: …» / причина ошибки); пустой текст — работы не
 * было, уведомление убирается тихо. Страхуемся таймаутом 5 мин (страница не
 * загрузилась, мост потерялся; два брокера честно синхронизируются дольше
 * полутора минут) и ошибкой загрузки. JS-консоль страницы и ход загрузки
 * дублируются в logcat (тег WalletSync) — диагностика на реальном телефоне.
 */
public class SyncService extends Service {

    private static final int NOTIF_ID = 43;
    private static final String CHANNEL_ID = "sync_alert";
    // канал «sync» из 1.0.7 был создан с IMPORTANCE_LOW — важность живого канала
    // система поменять не даёт, удаляем и создаём заново с HIGH
    private static final String CHANNEL_LEGACY = "sync";
    private static final String TAG = "WalletSync";
    private static final long TIMEOUT_MS = 300_000L;
    private static final String START_URL =
            "file:///android_asset/www/index.html?autosync=1";

    private WebView web;
    private PowerManager.WakeLock wakeLock;
    private boolean finished;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable watchdog = new Runnable() {
        @Override public void run() { finish("Превышено время ожидания синхронизации", false); }
    };

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        // держим CPU до конца синхронизации (withTimeout — страховка от утечки)
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "wallet:autosync");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(TIMEOUT_MS + 60_000L);
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            nm.deleteNotificationChannel(CHANNEL_LEGACY);
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
                    "Синхронизация брокеров", NotificationManager.IMPORTANCE_HIGH));
        }
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle(getString(R.string.app_name))
                .setContentText("Синхронизация брокеров…")
                .setSmallIcon(R.drawable.ic_notify)
                .setOngoing(true);
        startForeground(NOTIF_ID, b.build());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            web = new WebView(this);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);   // тот же localStorage, что у приложения
            s.setAllowFileAccess(true);
            web.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                    Log.i(TAG, "страница начинает грузиться: " + url);
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    Log.i(TAG, "страница загружена: " + url);
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                    if (req.isForMainFrame()) {
                        Log.w(TAG, "страница не загрузилась: " + err.getDescription());
                        finish("Страница синхронизации не загрузилась", false);
                    }
                }
            });
            // JS-консоль страницы → logcat: ошибки фоновой синхронизации видны
            // на реальном телефоне, где иначе диагностики нет
            web.setWebChromeClient(new android.webkit.WebChromeClient() {
                @Override
                public boolean onConsoleMessage(android.webkit.ConsoleMessage msg) {
                    Log.d(TAG, "[js] " + msg.message() + " (" + msg.sourceId()
                            + ":" + msg.lineNumber() + ")");
                    return true;
                }
            });
            web.addJavascriptInterface(new SyncBridge(), "WalletAndroid");
            web.loadUrl(START_URL);
            Log.i(TAG, "невидимый WebView запущен: " + START_URL);
        } catch (Exception e) {
            Log.e(TAG, "не удалось поднять WebView: " + e.getMessage(), e);
            finish("Не удалось запустить синхронизацию", false);
            return START_NOT_STICKY;
        }
        handler.postDelayed(watchdog, TIMEOUT_MS);
        return START_NOT_STICKY;
    }

    /**
     * Гасит сервис. summary — текст итогового пуша (пустой/null — работы не
     * было, уведомление сервиса убираем без итога); ok — успешный ли итог.
     */
    private void finish(String summary, boolean ok) {
        if (finished) return;
        finished = true;
        Log.i(TAG, "остановка сервиса синхронизации");
        handler.removeCallbacks(watchdog);
        handler.post(() -> {
            if (web != null) {
                try { web.stopLoading(); web.destroy(); } catch (Exception ignored) { }
                web = null;
            }
            if (wakeLock != null && wakeLock.isHeld()) {
                try { wakeLock.release(); } catch (Exception ignored) { }
                wakeLock = null;
            }
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            // DETACH: уведомление переживает stopSelf — заменяем его итоговым
            stopForeground(STOP_FOREGROUND_DETACH);
            if (nm != null) {
                if (summary == null || summary.isEmpty()) {
                    nm.cancel(NOTIF_ID);
                } else {
                    Notification.Builder b = Build.VERSION.SDK_INT >= 26
                            ? new Notification.Builder(this, CHANNEL_ID)
                            : new Notification.Builder(this);
                    b.setContentTitle(getString(R.string.app_name))
                            .setContentText((ok ? "✅ " : "⚠️ ") + summary)
                            .setSmallIcon(R.drawable.ic_notify)
                            .setAutoCancel(true);
                    nm.notify(NOTIF_ID, b.build());
                }
            }
            stopSelf();
        });
    }

    // Минимальный мост для страницы синхронизации: http (как в MainActivity)
    // + syncDone + persistSnapshot (backup.js зовёт его безусловно).
    private class SyncBridge {

        /** Синхронизация завершилась — страницу можно гасить, показываем итог. */
        @JavascriptInterface
        public void syncDone(boolean ok, String summary) {
            Log.i(TAG, "JS завершил синхронизацию (syncDone): ok=" + ok
                    + (summary != null && !summary.isEmpty() ? " — " + summary : ""));
            finish(summary, ok);
        }

        /** Зеркалит Bridge.http в MainActivity (тот же формат ответа). */
        @JavascriptInterface
        public String http(String requestJson) {
            JSONObject resp = new JSONObject();
            long startedAt = System.currentTimeMillis();
            String method = "GET";
            String urlStr = "";
            try {
                JSONObject req = new JSONObject(requestJson);
                method = req.optString("method", "GET");
                urlStr = req.optString("url", "");
                String body = req.isNull("body") ? null : req.optString("body", null);
                int timeoutMs = Math.max(5000, req.optInt("timeoutMs", 30000));
                boolean trustAll = req.optBoolean("trustAll", true);

                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(timeoutMs);
                conn.setRequestMethod(method.toUpperCase());
                JSONObject headers = req.optJSONObject("headers");
                if (headers == null || !headers.has("User-Agent")) {
                    conn.setRequestProperty("User-Agent",
                            "Wallet/" + getString(R.string.app_version) + " (Android)");
                }
                if (headers != null) {
                    Iterator<String> it = headers.keys();
                    while (it.hasNext()) {
                        String key = it.next();
                        conn.setRequestProperty(key, headers.optString(key));
                    }
                }
                if (trustAll && conn instanceof HttpsURLConnection) {
                    trustEveryone((HttpsURLConnection) conn);
                }
                if (body != null) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(bytes);
                    }
                }

                int status = conn.getResponseCode();
                String text = readStream(status >= 200 && status < 300
                        ? conn.getInputStream() : conn.getErrorStream());
                resp.put("status", status);
                resp.put("body", text);
                Log.d(TAG, "http " + method + " " + hostOf(urlStr) + " → " + status
                        + " (" + (System.currentTimeMillis() - startedAt) + " мс)");
            } catch (Exception e) {
                try {
                    resp.put("status", 0);
                    resp.put("body", JSONObject.NULL);
                    resp.put("error", String.valueOf(e.getMessage()));
                } catch (Exception ignored) { }
            }
            return resp.toString();
        }

        /** Снапшот после фоновой синхронизации: та же запись, что в MainActivity. */
        @JavascriptInterface
        public boolean persistSnapshot(String json) {
            try {
                File tmp = new File(getFilesDir(), AlarmScheduler.SNAPSHOT_FILE + ".tmp");
                try (FileOutputStream fo = new FileOutputStream(tmp)) {
                    fo.write(json.getBytes(StandardCharsets.UTF_8));
                }
                //noinspection ResultOfMethodCallIgnored
                tmp.renameTo(new File(getFilesDir(), AlarmScheduler.SNAPSHOT_FILE));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void toast(String msg) { /* фоновый запуск — без визуального шума */ }

        @JavascriptInterface
        public String appVersion() {
            return getString(R.string.app_version);
        }

        private void trustEveryone(HttpsURLConnection conn) {
            try {
                TrustManager[] tm = { new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
                    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }};
                SSLContext sc = SSLContext.getInstance("TLS");
                sc.init(null, tm, new SecureRandom());
                conn.setSSLSocketFactory(sc.getSocketFactory());
                conn.setHostnameVerifier((hostname, session) -> true);
            } catch (Exception e) {
                // не удалось переопределить — останется системная проверка
            }
        }

        private String hostOf(String url) {
            try {
                java.net.URI u = java.net.URI.create(url);
                return u.getHost() + u.getPath();
            } catch (Exception e) {
                return url.length() > 60 ? url.substring(0, 60) + "…" : url;
            }
        }

        private String readStream(InputStream in) throws java.io.IOException {
            if (in == null) return null;
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
            return new String(bo.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
