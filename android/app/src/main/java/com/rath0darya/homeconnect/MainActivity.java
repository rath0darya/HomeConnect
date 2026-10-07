package com.rath0darya.homeconnect;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends Activity {

    private static final int MEDIA_PERMISSION_REQUEST = 7001;
    private WebView webView;
    private PermissionRequest pendingPermissionRequest;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        configureWebView();

        if (!hasMediaPermissions()) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{
                            Manifest.permission.CAMERA,
                            Manifest.permission.RECORD_AUDIO
                    },
                    MEDIA_PERMISSION_REQUEST
            );
        }

        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(false);

        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler(
                        "/assets/",
                        new WebViewAssetLoader.AssetsPathHandler(this)
                )
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    String[] requested = request.getResources();
                    boolean audio = false;
                    boolean video = false;

                    for (String resource : requested) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                            audio = true;
                        }
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            video = true;
                        }
                    }

                    boolean allowed = (!audio || hasPermission(Manifest.permission.RECORD_AUDIO))
                            && (!video || hasPermission(Manifest.permission.CAMERA));

                    if (allowed) {
                        request.grant(requested);
                    } else {
                        pendingPermissionRequest = request;
                        ActivityCompat.requestPermissions(
                                MainActivity.this,
                                new String[]{
                                        Manifest.permission.CAMERA,
                                        Manifest.permission.RECORD_AUDIO
                                },
                                MEDIA_PERMISSION_REQUEST
                        );
                    }
                });
            }
        });

        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.getSettings().setBuiltInZoomControls(false);
        webView.getSettings().setDisplayZoomControls(false);
        webView.getSettings().setSupportZoom(false);
    }

    private boolean hasMediaPermissions() {
        return hasPermission(Manifest.permission.CAMERA)
                && hasPermission(Manifest.permission.RECORD_AUDIO);
    }

    private boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(this, permission)
                == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != MEDIA_PERMISSION_REQUEST) {
            return;
        }

        if (pendingPermissionRequest != null) {
            boolean audio = hasPermission(Manifest.permission.RECORD_AUDIO);
            boolean video = hasPermission(Manifest.permission.CAMERA);

            String[] requested = pendingPermissionRequest.getResources();

            boolean allowed = true;

            for (String resource : requested) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && !audio) {
                    allowed = false;
                }

                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && !video) {
                    allowed = false;
                }
            }

            if (allowed) {
                pendingPermissionRequest.grant(requested);
            } else {
                pendingPermissionRequest.deny();
            }

            pendingPermissionRequest = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
