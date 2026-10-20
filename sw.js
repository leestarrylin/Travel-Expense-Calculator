/* 旅行记账 · 离线缓存
   v6：「记一笔」悬浮按钮重做为立体球面，右缘与内容区对齐，缓存版本 +1。
   v5：分类扩到 10 个（新增打车/公交地铁/大巴车/高铁火车），缓存版本 +1。
   v4：新增「内联新增支付方式」与微信 logo，缓存版本 +1 强制刷新。
   v3：把 app.js / styles.css 纳入预缓存；代码类资源改为「网络优先」，
       保证以后更新能生效，离线时仍可用缓存。 */
var CACHE = 'travel-split-v6';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function put(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
  }
  return res;
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  /* 页面导航：网络优先，断网回 index.html */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(function (res) { put(req, res); return res; })
        .catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  var url = new URL(req.url);
  var codeAsset = /\.(?:js|css)$/.test(url.pathname);

  /* 代码资源：网络优先，失败再读缓存（避免旧版本卡住） */
  if (codeAsset && url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then(function (res) { put(req, res); return res; })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match('./index.html');
          });
        })
    );
    return;
  }

  /* 其余静态资源：缓存优先 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) { put(req, res); return res; })
        .catch(function () { return caches.match('./index.html'); });
    })
  );
});
