package com.rath0darya.homeconnect;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

public class MainActivity extends Activity {
    private static final int MEDIA_PERMISSION_REQUEST = 7001;
    private WebView webView;
    private ServerSocket serverSocket;
    private PermissionRequest pendingRequest;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);
        configureWebView();
        requestMediaPermissions();
        startLocalWebServer();
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        webView.setWebViewClient(new WebViewClient());

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean audio = false, video = false;
                    for (String resource : request.getResources()) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) video = true;
                    }

                    boolean audioAllowed = !audio || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                    boolean videoAllowed = !video || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;

                    if (audioAllowed && videoAllowed) {
                        grantSafeMediaResources(request);
                    } else {
                        pendingRequest = request;
                        requestMediaPermissions();
                    }
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (pendingRequest == request) pendingRequest = null;
            }
        });
    }

    private void grantSafeMediaResources(PermissionRequest request) {
        ArrayList<String> safe = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                safe.add(resource);
            }
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                safe.add(resource);
            }
        }
        if (safe.isEmpty()) request.deny();
        else request.grant(safe.toArray(new String[0]));
    }

    private void requestMediaPermissions() {
        ArrayList<String> permissions = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            permissions.add(Manifest.permission.CAMERA);
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            permissions.add(Manifest.permission.RECORD_AUDIO);

        if (!permissions.isEmpty()) {
            requestPermissions(permissions.toArray(new String[0]), MEDIA_PERMISSION_REQUEST);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MEDIA_PERMISSION_REQUEST && pendingRequest != null) {
            PermissionRequest request = pendingRequest;
            pendingRequest = null;
            grantSafeMediaResources(request);
        }
    }

    private void startLocalWebServer() {
        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(0, 10, java.net.InetAddress.getByName("127.0.0.1"));
                int port = serverSocket.getLocalPort();

                runOnUiThread(() -> webView.loadUrl("http://localhost:" + port + "/index.html"));

                while (!serverSocket.isClosed()) {
                    Socket socket = serverSocket.accept();
                    new Thread(() -> serve(socket)).start();
                }
            } catch (IOException ignored) {}
        }).start();
    }

    private void serve(Socket socket) {
        try (Socket s = socket) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
            String requestLine = reader.readLine();
            if (requestLine == null) return;

            String[] parts = requestLine.split(" ");
            String requested = parts.length >= 2 ? parts[1] : "/index.html";

            String header;
            while ((header = reader.readLine()) != null && !header.isEmpty()) {}

            String requestPath = requested.split("\?", 2)[0];
            try { requestPath = URLDecoder.decode(requestPath, StandardCharsets.UTF_8); } catch (Exception ignored) {}

            if (requestPath.equals("/")) requestPath = "/index.html";

            if (!(requestPath.equals("/index.html")
                    || requestPath.equals("/style.css")
                    || requestPath.equals("/app.js")
                    || requestPath.equals("/config.js"))) {
                writeResponse(s, 404, "text/plain; charset=utf-8", "Not Found".getBytes(StandardCharsets.UTF_8));
                return;
            }

            String asset = requestPath.substring(1);

            try (InputStream input = getAssets().open(asset)) {
                byte[] data = input.readAllBytes();
                String contentType = "text/html; charset=utf-8";
                if (asset.endsWith(".css")) contentType = "text/css; charset=utf-8";
                if (asset.endsWith(".js")) contentType = "application/javascript; charset=utf-8";
                writeResponse(s, 200, contentType, data);
            }
        } catch (Exception ignored) {}
    }

    private void writeResponse(Socket socket, int status, String contentType, byte[] body) throws IOException {
        String statusText = status == 200 ? "OK" : "Not Found";
        String headers = "HTTP/1.1 " + status + " " + statusText + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream output = socket.getOutputStream();
        output.write(headers.getBytes(StandardCharsets.US_ASCII));
        output.write(body);
        output.flush();
    }

    @Override protected void onDestroy() {
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
