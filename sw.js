"use strict";

// アプリシェルのオフラインキャッシュ。音声データはIndexedDB側にあるためここでは扱わない。
// 更新時はCACHE名のバージョンを上げること(古いキャッシュはactivateで削除される)。
const CACHE = "kikinagashi-player-v6";
const ASSETS = [
  "./",
  "./index.html",
  "./player.js",
  "./player.css",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        // オフラインで未キャッシュのナビゲーションはトップページで代替
        if (req.mode === "navigate") return caches.match("./");
        return Response.error();
      });
    })
  );
});
