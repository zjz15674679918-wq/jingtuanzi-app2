/* 鲸团子 Service Worker
   ── 缓存策略 ────────────────────────────────────────────────
   · 外壳（HTML / manifest / 图标）→ 预缓存，断网也能开
   · 背景图等图片        → 单独的 cache，缓存优先，换版本不清
   · 聊天记录 / API / 数据 → 永不缓存（走网络，SW 直接放过）
   ★ 上一版把 bg.jpg 漏在预缓存之外，只能靠「第一次成功加载后顺手存」，
     弱网第一次就没存上 → 之后永远白背景。这里补上了。 */
const VERSION = 'jt-v4-20261119a';
const IMG_CACHE = 'jt-img-v2';   // 图片单独一个 cache：换版本不删，避免重下

const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-180.png',
];

/* 预缓存图片：只要来过一次，以后弱网/断网都是本地出图 */
const IMG = [
  'bg-stars.webp',
  'bg-stars-small.webp',
  'icons/icon-96.png',
  'icons/favicon-32.png',
  'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(VERSION);
    await shell.addAll(SHELL).catch(() => {});
    const img = await caches.open(IMG_CACHE);
    await Promise.all(IMG.map((u) => img.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== VERSION && k !== IMG_CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* 这些一律走网络，不缓存（API / 数据 / 备份 / QQ 表情） */
const BYPASS = [
  '/chat', '/tts', '/starmap-extra', '/sync-memory',
  'stickers-qq.json',
];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 只处理同源
  if (url.origin !== location.origin) return;
  if (BYPASS.some((p) => url.pathname.indexOf(p) >= 0)) return;

  /* 星图的两个大文件（starmap.js 352KB / starmap.json 370KB）：
     先给本地缓存（秒开），后台再悄悄拉新版。原来它们被 bypass 掉，
     每次打开都重下 700 多 KB，手机上很容易超时被判成「加载失败」。 */
  const SWR = ['starmap/starmap.json', 'starmap/starmap.js'];
  if (SWR.some((p) => url.pathname.indexOf(p) >= 0)) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      }).catch(() => null);
      return hit || (await net) || new Response('', { status: 504, statusText: 'offline' });
    })());
    return;
  }

  const isImg = req.destination === 'image' ||
                /\.(jpe?g|png|webp|gif|svg|ico)(\?|$)/i.test(url.pathname + url.search);

  if (isImg) {
    /* 图片：缓存优先。有就用本地的，不再等网络 —— 弱网下秒出图。
       忽略 query（CSS 里的 ?v= 只用于穿透 CDN，不影响缓存命中） */
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic') {
          caches.open(IMG_CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
        }
        return res;
      } catch (_) {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  /* 其余：网络优先（保证新版本立刻生效），失败回落缓存 */
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        caches.open(VERSION).then((c) => c.put(req, res.clone())).catch(() => {});
      }
      return res;
    } catch (_) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const shell = await caches.match('index.html', { ignoreSearch: true });
      return shell || new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
