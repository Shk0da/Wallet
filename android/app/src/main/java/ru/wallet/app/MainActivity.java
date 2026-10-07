package ru.wallet.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
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
 * Единственная Activity: WebView с offline-сборкой фронтенда
 * (android/assets/www/, собирается tools/build-www.sh) и Java-мостом
 * «WalletAndroid» для HTTP (синхронизация брокеров), сохранения файлов,
 * снапшота данных и планирования утренних уведомлений.
 */
public class MainActivity extends Activity {

    private static final String START_URL = "file:///android_asset/www/index.html";
    private static final int REQ_FILE_CHOOSER = 42;

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Строка состояния под фон приложения (#F6F7F8) с тёмными значками —
        // стык с вёрсткой WebView незаметен (стиль T-Bank: светлая тема, жёлтый акцент).
        // Тёмная тема переключает строку состояния через мост setStatusBarTheme().
        getWindow().setStatusBarColor(0xFFF6F7F8);
        getWindow().getDecorView().setSystemUiVisibility(
                getWindow().getDecorView().getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // localStorage — основное хранилище приложения
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        // Без этого WebView игнорирует <meta viewport> и рендерит легаси-ширину
        // 980px, ужатую зумом, — «десктоп» на телефоне (проверено на API 34:
        // innerWidth=980 → 411). Широкая вьюпа + обзорный зум = мобильная вёрстка
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            // <input type="file"> в WebView не работает без хром-клиента:
            // импорт бэкапа идёт через системный выбор файла
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "Выберите файл"), REQ_FILE_CHOOSER);
                } catch (android.content.ActivityNotFoundException e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "WalletAndroid");
        setContentView(web);
        web.loadUrl(START_URL);

        // Будильник мог слететь (перезагрузка, чистка) — восстановим из снапшота
        AlarmScheduler.rescheduleFromSnapshot(this);
    }

    // Пароль на вход: уход в фон = запирание (auth.js перезапирает оверлей).
    // Иначе процесс WebView переживает закрытие активности, и «закрыл-открыл»
    // приложение показывало данные без пароля.
    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.evaluateJavascript("if (window.__walletRelock) window.__walletRelock();", null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] uris = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    uris = new Uri[]{ data.getData() };
                }
                filePathCallback.onReceiveValue(uris);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ==================== Мост WalletAndroid ====================

    private class Bridge {

        /**
         * HTTP-запрос для синхронизации брокеров (вместо fetch — в WebView нет CORS).
         * Вызывается синхронно из JS (поток JavaBridge), ответ:
         *   { status: <код, 0 при сетевой ошибке>, body: <string|null>, error: <string|null> }
         * — зеркалит httpCall() в sync.php, включая статус 0 как «транспорт упал».
         */
        @JavascriptInterface
        public String http(String requestJson) {
            JSONObject resp = new JSONObject();
            try {
                JSONObject req = new JSONObject(requestJson);
                String method = req.optString("method", "GET");
                String urlStr = req.optString("url", "");
                String body = req.isNull("body") ? null : req.optString("body", null);
                int timeoutMs = Math.max(5000, req.optInt("timeoutMs", 30000));
                boolean trustAll = req.optBoolean("trustAll", false);

                HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(timeoutMs);
                conn.setRequestMethod(method.toUpperCase());
                JSONObject headers = req.optJSONObject("headers");
                // Нейтральный User-Agent: отдельные API-шлюзы (в т.ч. Finam)
                // режут дефолтный «Dalvik/…» ещё до авторизации
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
                String text = readStream(status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream());
                resp.put("status", status);
                resp.put("body", text);
            } catch (Exception e) {
                try {
                    resp.put("status", 0);
                    resp.put("body", JSONObject.NULL);
                    resp.put("error", String.valueOf(e.getMessage()));
                } catch (Exception ignored) { }
            }
            return resp.toString();
        }

        /** Сохранить файл в Downloads (MediaStore, API 29+) или в каталог приложения (24–28). */
        @JavascriptInterface
        public boolean saveFile(String name, String content) {
            try {
                byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) return false;
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) return false;
                        os.write(bytes);
                    }
                    toast("Сохранено в Downloads/" + name);
                } else {
                    File dir = getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) dir = getFilesDir();
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File file = new File(dir, name);
                    try (FileOutputStream fo = new FileOutputStream(file)) {
                        fo.write(bytes);
                    }
                    toast("Сохранено: " + file.getAbsolutePath());
                }
                return true;
            } catch (Exception e) {
                toast("Не удалось сохранить файл: " + e.getMessage());
                return false;
            }
        }

        /**
         * Снапшот календаря и настроек: localStorage из Java не читается,
         * поэтому JS сам сбрасывает сюда всё, что нужно NotifyReceiver
         * (утреннее уведомление) и BootReceiver. Запись атомарная (tmp + rename).
         */
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
        public void scheduleNotification(boolean enabled, int hour, int minute) {
            if (enabled) AlarmScheduler.schedule(MainActivity.this, hour, minute);
            else AlarmScheduler.cancel(MainActivity.this);
        }

        /** Разрешение на уведомления (Android 13+) — запрашивается в момент включения. */
        @JavascriptInterface
        public void requestNotificationsPermission() {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 41);
            }
        }

        /** Тема строки состояния синхронно с темой вёрстки (settings.js, «Тёмная тема»). */
        @JavascriptInterface
        public void setStatusBarTheme(final boolean dark) {
            runOnUiThread(() -> {
                if (dark) {
                    getWindow().setStatusBarColor(0xFF17181A);
                    getWindow().getDecorView().setSystemUiVisibility(
                            getWindow().getDecorView().getSystemUiVisibility()
                                    & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                } else {
                    getWindow().setStatusBarColor(0xFFF6F7F8);
                    getWindow().getDecorView().setSystemUiVisibility(
                            getWindow().getDecorView().getSystemUiVisibility()
                                    | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                }
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String appVersion() {
            return getString(R.string.app_version);
        }

        // ---------- служебное ----------

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
                // не удалось переопределить — останется системная проверка сертификатов
            }
        }

        private String readStream(InputStream in) throws IOException {
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
