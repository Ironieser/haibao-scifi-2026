/* 海豹杯 2026 — 站点交互。原生 JS，无依赖。
   所有 localStorage 访问都经过 try/catch；API 不可用时交互区降级，正文不受影响。 */
(function () {
  'use strict';
  var D = document, H = D.documentElement, W = window;
  var page = D.body.getAttribute('data-page') || '';

  /* ---------- 本地存储 ---------- */
  var mem = {};
  function rawGet(k) {
    try { var v = W.localStorage.getItem(k); return v === null ? (k in mem ? mem[k] : null) : v; }
    catch (e) { return k in mem ? mem[k] : null; }
  }
  function rawSet(k, v) {
    mem[k] = v;
    try { W.localStorage.setItem(k, v); return true; } catch (e) { return false; }
  }
  function jget(k, def) {
    var v = rawGet(k);
    if (v === null) return def;
    try { var o = JSON.parse(v); return o === null ? def : o; } catch (e) { return def; }
  }
  function jset(k, v) { return rawSet(k, JSON.stringify(v)); }
  function idList(k) {
    var a = jget(k, []);
    return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'string' || typeof x === 'number'; }) : [];
  }
  function listHas(k, id) { return idList(k).indexOf(id) >= 0; }
  function listSet(k, id, on) {
    var a = idList(k).filter(function (x) { return x !== id; });
    if (on) a.unshift(id);
    jset(k, a.slice(0, 2000));
  }

  function device() {
    var d = rawGet('hb.device');
    if (d && /^[A-Za-z0-9-]{8,64}$/.test(d)) return d;
    try {
      if (W.crypto && crypto.randomUUID) d = crypto.randomUUID();
      else if (W.crypto && crypto.getRandomValues) {
        var b = new Uint8Array(16); crypto.getRandomValues(b);
        d = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
      }
    } catch (e) { d = null; }
    if (!d) d = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    rawSet('hb.device', d);
    return d;
  }

  /* ---------- API ---------- */
  function apiError(msg, status, offline) {
    var e = new Error(msg); e.status = status || 0; e.offline = !!offline; return e;
  }
  function api(method, path, body) {
    if (!W.fetch) return Promise.reject(apiError('当前浏览器不支持互动功能', 0, true));
    var opt = { method: method, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' };
    // GET 接口有边缘缓存；浏览器端不要沿用本地缓存副本（线上 zone 的 Browser Cache TTL 曾把计数缓存 4 小时）
    if (method === 'GET') opt.cache = 'no-cache';
    if (body) {
      body.device = device();
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(path, opt).then(function (r) {
      var ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) {
        throw apiError(r.ok ? '服务器返回了无法识别的内容' : '互动服务暂时不可用（' + r.status + '）', r.status, true);
      }
      return r.json().then(function (data) {
        if (!r.ok) throw apiError(data && data.error ? String(data.error) : '请求失败（' + r.status + '）', r.status, false);
        return data;
      }, function () { throw apiError('服务器返回了无法识别的内容', r.status, true); });
    }, function () { throw apiError('网络连接失败，请稍后再试', 0, true); });
  }

  /* ---------- 页面打开时的唯一一次请求：POST /api/hit ----------
     记一次浏览，并一次性取回本页需要的公开数据：浏览量、点赞/收藏/评论数、作品页的热门划线、首页的最新讨论、
     /stats/ 的近 30 天走势。site.js、views.js、reader.js 共用同一个 Promise（只发一次请求）。评论列表仍按需加载。 */
  var hitP = null;
  var VIEW_PAGES = ['home', 'favorites', 'notes', 'stats'];   // 与服务端白名单一致；其余页面（如 404）记为 other
  function pageKey() {
    var work = D.body.getAttribute('data-work');
    if (work) return work;
    return VIEW_PAGES.indexOf(page) >= 0 ? page : 'other';
  }
  function hit() {
    if (hitP) return hitP;
    var work = D.body.getAttribute('data-work') || '';
    var body = { page: pageKey() };
    if (work) { body.work = work; body.hot = prefs().hot; }  // 读者关闭了「热门划线」时不取
    hitP = api('POST', '/api/hit', body);
    hitP.catch(function () { /* 各调用方自行降级 */ });
    return hitP;
  }

  /* ---------- 提示 ---------- */
  var toastEl = D.getElementById('toast'), toastTimer;
  function toast(msg, isErr) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isErr ? ' err' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, isErr ? 5000 : 2600);
  }

  function $(sel, root) { return (root || D).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || D).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var n = D.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------- 偏好：阅读设置（全站只有这一套，存 hb.prefs） ----------
     head 内联脚本（build.py 的 HEAD_JS）在首屏前按同样的取值设置 html 属性，避免闪烁。 */
  var SIZE_MIN = 14, SIZE_MAX = 26, SIZE_DEF = 18;
  function pick(v, list, def) { return list.indexOf(v) >= 0 ? v : def; }
  function prefs() {
    var p = jget('hb.prefs', {});
    if (!p || typeof p !== 'object') p = {};
    var size = parseInt(p.size, 10);
    return {
      size: size >= SIZE_MIN && size <= SIZE_MAX ? size : SIZE_DEF,
      font: pick(p.font, ['serif', 'sans', 'kai'], 'serif'),
      theme: pick(p.theme, ['auto', 'light', 'dark'], 'auto'),
      lh: pick(p.lh, ['tight', 'normal', 'loose'], 'normal'),
      width: pick(p.width, ['narrow', 'mid', 'wide'], 'mid'),
      bg: pick(p.bg, ['paper', 'green', 'sepia'], 'paper'),   // 「夜间」= theme dark
      justify: p.justify !== false,
      hot: p.hot !== false
    };
  }
  var darkMq = W.matchMedia ? W.matchMedia('(prefers-color-scheme: dark)') : null;
  function isDark(p) { return p.theme === 'dark' || (p.theme === 'auto' && !!(darkMq && darkMq.matches)); }
  function attr(name, v) { if (v === null) H.removeAttribute(name); else H.setAttribute(name, v); }
  function applyPrefs(p) {
    attr('data-theme', p.theme === 'auto' ? null : p.theme);
    attr('data-font', p.font === 'serif' ? null : p.font);
    attr('data-lh', p.lh === 'normal' ? null : p.lh);
    attr('data-width', p.width === 'mid' ? null : p.width);
    attr('data-bg', p.bg === 'paper' ? null : p.bg);
    attr('data-justify', p.justify ? null : 'off');
    H.style.setProperty('--read-size', p.size + 'px');
    var dark = isDark(p);
    $$('[data-pref]').forEach(function (b) {
      var k = b.getAttribute('data-pref'), v = b.getAttribute('data-val'), on;
      if (k === 'bg') on = v === 'night' ? dark : (!dark && p.bg === v);
      else on = String(p[k]) === v;
      b.setAttribute('aria-pressed', String(on));
    });
    $$('[data-toggle]').forEach(function (b) { b.setAttribute('aria-checked', String(!!p[b.getAttribute('data-toggle')])); });
    var rng = $('#set-size');
    if (rng && String(rng.value) !== String(p.size)) rng.value = p.size;
    var out = $('#size-out');
    if (out) out.textContent = p.size + 'px';
    try { D.dispatchEvent(new CustomEvent('hb:prefs', { detail: p })); } catch (e) {}
  }
  function savePrefs(p) { jset('hb.prefs', p); applyPrefs(p); }
  D.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-pref], [data-toggle]');
    if (!b) return;
    var p = prefs();
    if (b.hasAttribute('data-toggle')) {
      var tk = b.getAttribute('data-toggle');
      p[tk] = !p[tk];
    } else {
      var k = b.getAttribute('data-pref'), v = b.getAttribute('data-val');
      if (k === 'bg') {
        if (v === 'night') p.theme = 'dark';
        else { p.bg = v; if (isDark(p)) p.theme = 'light'; }
      } else p[k] = v;
    }
    keepPosition(function () { savePrefs(p); });
  });
  var sizeRange = $('#set-size');
  if (sizeRange) {
    // 手机上最小 16px（CSS 同样兜底）
    if (W.matchMedia && W.matchMedia('(max-width: 719px)').matches) sizeRange.min = '16';
    sizeRange.addEventListener('input', function () {
      var p = prefs();
      p.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, parseInt(sizeRange.value, 10) || SIZE_DEF));
      keepPosition(function () { savePrefs(p); });
    });
  }
  if (darkMq) {
    var onMq = function () { applyPrefs(prefs()); };
    if (darkMq.addEventListener) darkMq.addEventListener('change', onMq); else if (darkMq.addListener) darkMq.addListener(onMq);
  }

  /* 改设置时保持阅读位置（作品页由 initReading 替换为段落级实现） */
  var keepPosition = function (fn) { fn(); };
  applyPrefs(prefs());

  /* 阅读位置：新格式 {"p":段落编号,"o":段内偏移比例,"r":全文比例,"t":时间}；兼容旧格式（0–1 的比例字符串） */
  function readPos(wid) {
    var raw = rawGet('hb.read.' + wid);
    if (raw === null || raw === '') return null;
    if (/^\s*\{/.test(raw)) {
      try {
        var o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return null;
        var r = parseFloat(o.r);
        return { p: parseInt(o.p, 10) || 0, o: Math.max(0, Math.min(1, parseFloat(o.o) || 0)), r: r >= 0 && r <= 1 ? r : 0 };
      } catch (e) { return null; }
    }
    var x = parseFloat(raw);
    return x >= 0 && x <= 1 ? { p: 0, o: 0, r: x, legacy: true } : null;
  }

  /* ---------- 首页 ---------- */
  function initHome() {
    var list = $('#shelf');
    if (list) initShelf(list);
    initRecent();
  }

  // 全部作品书架：筛选、排序；阅读量与点赞评论数（都来自 /api/hit）到了才开放对应排序
  function initShelf(list) {
    var books = $$('.book', list);
    var filter = 'all', sort = 'award';
    var sortSel = $('#sort'), countEl = $('#shelf-count'), empty = $('#shelf-empty');
    var num = function (b, k) { return parseInt(b.getAttribute('data-' + k) || '0', 10) || 0; };

    function apply() {
      var shown = 0;
      books.forEach(function (b) {
        var ok = filter === 'all' || (filter === 'both' && b.getAttribute('data-both') === '1') ||
          (filter === 'rod' && b.getAttribute('data-rod') === '1') ||
          (filter === 'noai' && b.getAttribute('data-ai') === '0');
        b.hidden = !ok;
        if (ok) shown++;
      });
      var key = function (b) {
        if (sort === 'views') return -num(b, 'views');
        if (sort === 'likes') return -num(b, 'likes');
        if (sort === 'short') return num(b, 'chars');
        if (sort === 'long') return -num(b, 'chars');
        return 0;
      };
      books.slice().sort(function (a, b) {
        return (key(a) - key(b)) || (num(a, 'order') - num(b, 'order'));
      }).forEach(function (b) { list.appendChild(b); });
      if (countEl) countEl.textContent = shown === books.length ? '共 ' + books.length + ' 部' : '显示 ' + shown + ' / ' + books.length + ' 部';
      if (empty) empty.hidden = shown > 0;
    }
    function enable(v, on) {
      var o = sortSel && sortSel.querySelector('option[value="' + v + '"]');
      if (o) o.disabled = !on;
    }
    $$('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        filter = b.getAttribute('data-filter');
        $$('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        apply();
      });
    });
    if (sortSel) {
      sortSel.value = 'award';
      sortSel.addEventListener('change', function () { sort = sortSel.value; apply(); });
    }
    enable('views', false);
    enable('likes', false);
    apply();

    hit().then(function (d) {
      var works = d && d.stats && d.stats.works;
      if (!works) return;
      books.forEach(function (b) {
        var s = works[b.getAttribute('data-id')];
        if (!s) return;
        b.setAttribute('data-likes', String(s.likes || 0));
        $$('[data-stat]', b).forEach(function (n) {
          var v = s[n.getAttribute('data-stat')] || 0;
          $('.n', n).textContent = fmtNum(v);
          n.hidden = !v; // 0 不显示
        });
      });
      enable('likes', true);
      if (sort === 'likes') apply();
    }, function () { /* 计数保持隐藏 */ });

    // 数字本身由 views.js 填进 [data-views-page]；这里只取排序用的数据（同一个 hit 响应）
    hit().then(function (d) {
      var pages = d && d.views && d.views.pages;
      if (!pages) return;
      books.forEach(function (b) { b.setAttribute('data-views', String(pages[b.getAttribute('data-id')] || 0)); });
      enable('views', true);
      if (sort === 'views') apply();
    }, function () {});
  }

  // 最新讨论：有评论才显示整个区块
  function initRecent() {
    var sec = $('#recent'), box = $('#recent-list');
    if (!sec || !box) return;
    var titles = {};
    $$('.book').forEach(function (b) {
      var t = $('.b-t', b);
      if (t) titles[b.getAttribute('data-id')] = t.textContent;
    });
    hit().then(function (d) {
      var data = d && d.recent;
      var cs = (data && Array.isArray(data.comments) ? data.comments : []).filter(function (c) {
        return c && titles[c.work] && typeof c.body === 'string';
      }).slice(0, 8);
      if (!cs.length) return;
      box.innerHTML = '';
      cs.forEach(function (c) {
        var li = el('li'), a = el('a');
        a.href = '/works/' + encodeURIComponent(c.work) + '/#talk';
        var h = el('span', 'rc-h');
        h.appendChild(el('b', null, String(c.name || '匿名读者')));
        h.appendChild(D.createTextNode(' 在'));
        h.appendChild(el('span', 'w', '《' + titles[c.work] + '》'));
        h.appendChild(D.createTextNode('下说：'));
        var when = fmtTime(c.created);
        if (when) h.appendChild(el('span', 'rc-t', when));
        a.appendChild(h);
        a.appendChild(el('span', 'rc-b', c.body));
        li.appendChild(a);
        box.appendChild(li);
      });
      sec.hidden = false;
    }, function () { /* 区块保持隐藏 */ });
  }

  /* ---------- 作品页 ---------- */
  function initWork() {
    var id = D.body.getAttribute('data-work');
    if (!id) return;
    var likeBtn = $('#act-like'), favBtn = $('#act-fav'), shareBtn = $('#act-share');
    var counts = { likes: null, favs: null };

    function paint() {
      if (likeBtn) {
        likeBtn.setAttribute('aria-pressed', String(listHas('hb.liked', id)));
        $('.c', likeBtn).textContent = counts.likes === null ? '' : fmtNum(counts.likes);
      }
      if (favBtn) {
        var on = listHas('hb.faved', id);
        favBtn.setAttribute('aria-pressed', String(on));
        $('.l', favBtn).textContent = on ? '已收藏' : '收藏';
        $('.c', favBtn).textContent = counts.favs === null ? '' : fmtNum(counts.favs);
      }
    }
    hit().then(function (d) {
      var s = d && d.stats && d.stats.works && d.stats.works[id];
      if (!s) return;
      counts.likes = s.likes || 0; counts.favs = s.favs || 0;
      paint();
      var cc = $('#talk-count');
      if (cc && s.comments) cc.textContent = fmtNum(s.comments) + ' 条';
    }, function () {});
    paint();

    function toggle(btn, key, kind, countKey, okMsgOn, okMsgOff) {
      if (!btn) return;
      var busy = false;
      btn.addEventListener('click', function () {
        if (busy) return;
        busy = true;
        var was = listHas(key, id), now = !was, prevCount = counts[countKey];
        listSet(key, id, now);
        if (counts[countKey] !== null) counts[countKey] = Math.max(0, counts[countKey] + (now ? 1 : -1));
        paint();
        api('POST', '/api/works/' + encodeURIComponent(id) + '/' + kind, { on: now }).then(function (d) {
          if (d && typeof d[countKey] === 'number') counts[countKey] = d[countKey];
          paint();
          if (key === 'hb.faved') toast(now ? okMsgOn : okMsgOff);
        }, function (e) {
          if (key === 'hb.faved' && e.offline) {
            /* 收藏以本机为准：服务器连不上时保留本地收藏，仅计数不同步 */
            counts[countKey] = prevCount;
            paint();
            toast(now ? '已收藏到本机（服务器暂时连不上，收藏数未同步）' : '已从本机收藏中移除');
          } else {
            listSet(key, id, was);
            counts[countKey] = prevCount;
            paint();
            toast((kind === 'like' ? '点赞没有成功：' : '收藏没有成功：') + e.message, true);
          }
        }).then(function () { busy = false; });
      });
    }
    toggle(likeBtn, 'hb.liked', 'like', 'likes');
    toggle(favBtn, 'hb.faved', 'fav', 'favs', '已收藏，可在「我的收藏」里找到', '已取消收藏');

    // 分享按钮由 share.js（window.HBShare）接管

    initReading(id);
    initTalk(id);
  }

  function copyText(t) {
    if (navigator.clipboard && W.isSecureContext) return navigator.clipboard.writeText(t);
    return new Promise(function (ok, no) {
      var ta = el('textarea'); ta.value = t; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      D.body.appendChild(ta); ta.select();
      var r = false;
      try { r = D.execCommand('copy'); } catch (e) { r = false; }
      D.body.removeChild(ta);
      if (r) ok(); else no();
    });
  }

  /* ---------- 阅读：进度、继续阅读、面板、章节、沉浸顶栏、键盘翻页 ---------- */
  var TOP_LINE = 72;  // 视口顶部基准线（与 scroll-margin-top 一致，避开顶栏）
  function initReading(id) {
    var text = $('#text'), bar = $('#progress');
    if (!text) return;
    var key = 'hb.read.' + id;
    var mast = $('#masthead'), mhCh = $('#mh-ch'), dockPct = $('#dock-pct');
    var titleEl = $('#work-title');
    var heads = $$('h2.ch', text);
    var headNames = heads.map(function (h) { return (h.textContent || '').replace(/#\s*$/, '').trim(); });
    var workName = titleEl ? '《' + titleEl.textContent.trim() + '》' : '';
    var tocLinks = {};
    $$('#panel-toc a').forEach(function (a) { tocLinks[a.getAttribute('href').slice(1)] = a; });

    /* 每个块（段落、章节标题、表格…）的字数前缀和：用于阅读百分比与剩余时间（500 字/分钟） */
    var blocks = Array.prototype.slice.call(text.children).filter(function (b) { return b.offsetParent !== null || b.getClientRects().length; });
    var lens = blocks.map(function (b) { return (b.textContent || '').replace(/\s+/g, '').length; });
    var cum = [], total = 0;
    lens.forEach(function (n) { cum.push(total); total += n; });
    total = Math.max(1, total);
    /* 剩余时间与页头「约 x 分钟读完」同一口径：build.py 输出的 data-chars（正文字数）÷ 500 字/分钟，按已读比例折算 */
    var readChars = parseInt(text.getAttribute('data-chars'), 10) || total;

    /* 布局缓存：块相对 #text 顶部的位置；#text 尺寸变化（字号、行距、字体加载）时失效 */
    var L = null;
    function layout() {
      if (L) return L;
      var base = text.getBoundingClientRect().top;
      var tops = [], hs = [];
      blocks.forEach(function (b) { var r = b.getBoundingClientRect(); tops.push(r.top - base); hs.push(r.height); });
      L = { tops: tops, hs: hs, heads: heads.map(function (h) { return h.getBoundingClientRect().top - base; }), h: text.offsetHeight };
      return L;
    }
    function textTop() { return text.getBoundingClientRect().top + W.pageYOffset; }
    function blockAt(rel) {
      var t = layout().tops, lo = 0, hi = t.length - 1, ans = -1;
      while (lo <= hi) { var m = (lo + hi) >> 1; if (t[m] <= rel) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans;
    }
    function charsAt(rel) {
      var i = blockAt(rel);
      if (i < 0) return 0;
      var g = layout(), f = g.hs[i] ? Math.max(0, Math.min(1, (rel - g.tops[i]) / g.hs[i])) : 1;
      return cum[i] + f * lens[i];
    }
    function ratio() { return Math.min(1, charsAt(W.pageYOffset + W.innerHeight - textTop()) / total); }
    /* 视口顶部基准线所在的正文段落 + 段内偏移比例 */
    function anchor() {
      var rel = W.pageYOffset + TOP_LINE - textTop();
      if (rel < 0) return null;
      var g = layout(), i = Math.max(0, blockAt(rel + 0.5));
      // 基准线落在段间距里时，取下一段的开头
      if (i < blocks.length - 1 && rel > g.tops[i] + g.hs[i]) i++;
      for (; i < blocks.length; i++) {
        var b = blocks[i];
        if (b.id && b.id.indexOf('p-') === 0) {
          var o = g.hs[i] ? Math.max(0, Math.min(1, (rel - g.tops[i]) / g.hs[i])) : 0;
          return { p: parseInt(b.id.slice(2), 10), o: Math.round(o * 1000) / 1000, r: Math.round(ratio() * 10000) / 10000 };
        }
      }
      return null;
    }
    function scrollToAnchor(a) {
      var el = a && a.p ? D.getElementById('p-' + a.p) : null;
      if (!el) return false;
      var r = el.getBoundingClientRect();
      W.scrollTo(0, Math.max(0, r.top + W.pageYOffset + (a.o || 0) * r.height - TOP_LINE));
      return true;
    }
    function scrollToRatioLegacy(r) { // 旧格式：视口底部所在位置占正文高度的比例
      W.scrollTo(0, Math.max(0, textTop() + r * text.offsetHeight - W.innerHeight));
    }
    function goTo(pos) { if (!scrollToAnchor(pos)) scrollToRatioLegacy(pos.r); }
    keepPosition = function (fn) {
      var a = W.pageYOffset > 50 ? anchor() : null;
      fn();
      L = null;
      if (a) scrollToAnchor(a);
    };
    if (W.ResizeObserver) new ResizeObserver(function () { L = null; schedule(); }).observe(text);
    W.addEventListener('resize', function () { L = null; schedule(); });

    /* 继续上次阅读
       带锚点进入（#p-N 段落链接、#ch-N、#talk…）时页面落在锚点处，不是上次读到的位置：设 guard，
       只有读到比已保存位置更靠后才覆盖记录（打开别人分享的段落不会冲掉自己的进度）；
       上次的位置更靠后时，提示条浮在底部（正文开头的提示条此时不在视口里），仍可一键回去。 */
    var saved = readPos(id), initial = ratio(), guard = null;
    var resume = $('#resume'), fromHash = !!location.hash, hashEl = null;
    if (fromHash) { try { hashEl = D.getElementById(decodeURIComponent(location.hash.slice(1))); } catch (e) { hashEl = null; } }
    if (fromHash && saved) guard = saved.r;
    // 锚点处的阅读比例（与 ratio() 同口径：锚点在基准线时视口底部读到哪里）；锚点在正文之后（讨论区）算读完
    var here = initial;
    if (hashEl) here = text.contains(hashEl)
      ? Math.min(1, charsAt(hashEl.getBoundingClientRect().top + W.pageYOffset - textTop() - TOP_LINE + W.innerHeight) / total)
      : 1;
    if (resume && saved && saved.r > here + 0.02 && saved.r < 0.98 && (hashEl || (!fromHash && W.pageYOffset < 200))) {
      guard = saved.r;  // 提示未处理前，只有读到比上次更靠后才覆盖记录
      $('.pct', resume).textContent = Math.round(saved.r * 100) + '%';
      if (hashEl) { resume.classList.add('is-float'); $('.x', resume).textContent = '留在这里'; }
      resume.hidden = false;
      $('.go', resume).addEventListener('click', function () {
        resume.hidden = true; resume.classList.remove('is-float'); guard = null; goTo(saved); initial = ratio();
      });
      // 「从头读」：之后按新的位置记录；「留在这里」（锚点进入）：只关掉提示，guard 保留
      $('.x', resume).addEventListener('click', function () { resume.hidden = true; if (!hashEl) guard = null; });
    }
    function save() {
      var a = anchor();
      if (!a) return;
      if (guard !== null) { if (a.r <= guard) return; guard = null; if (resume) resume.hidden = true; }
      if (a.r > initial + 0.002 || a.r >= 0.995) { a.t = Date.now(); rawSet(key, JSON.stringify(a)); initial = -1; }
    }

    /* 章节：顶栏中部显示当前章节名，目录面板高亮当前章节 */
    var curHead = -2;
    function setChapter(i) {
      if (i === curHead) return;
      curHead = i;
      if (mhCh) mhCh.textContent = i >= 0 ? headNames[i] : workName;
      Object.keys(tocLinks).forEach(function (k) { tocLinks[k].classList.remove('on'); tocLinks[k].removeAttribute('aria-current'); });
      var a = i >= 0 ? tocLinks[heads[i].id] : null;
      if (a) { a.classList.add('on'); a.setAttribute('aria-current', 'true'); }
    }
    function headAt(rel) {
      var hs = layout().heads, ans = -1;
      for (var i = 0; i < hs.length && hs[i] <= rel; i++) ans = i;
      return ans;
    }

    /* 沉浸阅读：向下滚动收起顶栏，向上滚动出现；焦点在顶栏内或接近页顶时始终显示 */
    var lastY = W.pageYOffset, mastHidden = false;
    function setMast(hide) {
      if (!mast || hide === mastHidden) return;
      mastHidden = hide;
      mast.classList.toggle('is-hidden', hide);
    }
    if (mast) mast.addEventListener('focusin', function () { setMast(false); });

    var ticking = false, saveTimer = null, pctTxt = '';
    function schedule() { if (!ticking) { ticking = true; W.requestAnimationFrame(update); } }
    function update() {
      ticking = false;
      var y = W.pageYOffset, tt = textTop(), g = layout();
      var r = ratio();
      if (bar) bar.style.setProperty('--p', r.toFixed(4));
      var rel = y + TOP_LINE - tt;
      var reading = rel > 0 && rel < g.h + 40;
      D.body.classList.toggle('is-reading', reading);
      setChapter(reading ? headAt(rel + 8) : -2);
      if (dockPct) {
        var left = Math.max(1, Math.round(readChars * (1 - r) / 500)), t;
        if (r >= 0.995) t = '读完了';
        else if (left >= 60) t = '剩 ' + Math.floor(left / 60) + ' 小时' + (left % 60 ? ' ' + (left % 60) + ' 分' : '');
        else t = '剩 ' + left + ' 分钟';
        var s2 = Math.round(r * 100) + '%|' + t;
        if (s2 !== pctTxt) { pctTxt = s2; $('.n', dockPct).textContent = Math.round(r * 100) + '%'; $('.t', dockPct).textContent = t; }
        dockPct.hidden = !(rel > -W.innerHeight * 0.5);
      }
      var dy = y - lastY;
      if (y < 120) { setMast(false); lastY = y; }
      else if (Math.abs(dy) > 6) {
        if (dy > 0 && !(mast && mast.contains(D.activeElement))) setMast(true);
        else if (dy < 0) setMast(false);
        lastY = y;
      }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 400);
    }
    W.addEventListener('scroll', schedule, { passive: true });
    if (D.fonts && D.fonts.ready) D.fonts.ready.then(function () { L = null; schedule(); });
    update();

    /* 键盘：← → / PageUp PageDown / 空格 翻屏（保留一行重叠），J / K 下一章、上一章 */
    function lineH() { return parseFloat(W.getComputedStyle(text).lineHeight) || 34; }
    function page(dir) {
      var y = W.pageYOffset, line = lineH();
      var covered = mast && !mastHidden && y > 0 ? mast.offsetHeight : 0;
      if (dir > 0) W.scrollTo(0, y + W.innerHeight - line);
      else W.scrollTo(0, Math.max(0, y + covered + line - W.innerHeight));
    }
    function chapter(dir) {
      if (!heads.length) { toast('这部作品没有分章'); return; }
      var rel = W.pageYOffset + TOP_LINE - textTop(), hs = layout().heads, i;
      if (dir > 0) { for (i = 0; i < hs.length && hs[i] <= rel + 8; i++); }
      else { for (i = hs.length - 1; i >= 0 && hs[i] >= rel - 4; i--); }
      if (i < 0 || i >= hs.length) { toast(dir > 0 ? '已经是最后一章' : '已经是第一章'); return; }
      W.scrollTo(0, Math.max(0, textTop() + hs[i] - TOP_LINE));
    }
    D.addEventListener('keydown', function (ev) {
      if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey || ev.isComposing) return;
      var t = ev.target, k = ev.key;
      if (t && t.closest) {
        if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="toolbar"], [role="dialog"], .tbl')) return;
        if ((k === ' ' || k === 'Spacebar') && t.closest('button, a, summary')) return;
      }
      if (k === 'ArrowRight' || k === 'PageDown' || ((k === ' ' || k === 'Spacebar') && !ev.shiftKey)) { ev.preventDefault(); page(1); }
      else if (k === 'ArrowLeft' || k === 'PageUp' || ((k === ' ' || k === 'Spacebar') && ev.shiftKey)) { ev.preventDefault(); page(-1); }
      else if (k === 'j' || k === 'J') { ev.preventDefault(); chapter(1); }
      else if (k === 'k' || k === 'K') { ev.preventDefault(); chapter(-1); }
    });

    /* 浮动工具条面板 */
    var openPanel = null;
    function setPanel(btn, panel, open) {
      btn.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
      if (open) openPanel = { btn: btn, panel: panel };
      else if (openPanel && openPanel.panel === panel) openPanel = null;
    }
    $$('[data-panel]').forEach(function (btn) {
      var panel = D.getElementById(btn.getAttribute('data-panel'));
      if (!panel) return;
      btn.addEventListener('click', function () {
        var willOpen = panel.hidden;
        if (openPanel && openPanel.panel !== panel) setPanel(openPanel.btn, openPanel.panel, false);
        setPanel(btn, panel, willOpen);
        if (willOpen) {
          var cur = panel.querySelector('a.on');
          if (cur && cur.scrollIntoView && panel.scrollHeight > panel.clientHeight) cur.scrollIntoView({ block: 'center' });
          var first = cur || panel.querySelector('input, button, a');
          if (first) first.focus({ preventScroll: true });
        }
      });
      panel.addEventListener('click', function (ev) {
        if (ev.target.closest('a')) setPanel(btn, panel, false);
      });
    });
    D.addEventListener('click', function (ev) {
      if (!openPanel) return;
      if (openPanel.panel.contains(ev.target) || openPanel.btn.contains(ev.target)) return;
      setPanel(openPanel.btn, openPanel.panel, false);
    });
    D.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && openPanel) { var b = openPanel.btn; setPanel(b, openPanel.panel, false); b.focus(); }
    });
  }

  /* ---------- 讨论区 ---------- */
  function fmtTime(ms) {
    var t = typeof ms === 'number' ? ms : Date.parse(ms);
    if (!t) return '';
    if (t < 1e12) t *= 1000;
    var d = new Date(t), now = Date.now(), diff = (now - t) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    var s = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.getFullYear() !== new Date().getFullYear()) s = d.getFullYear() + '年' + s;
    return s;
  }

  function initTalk(id) {
    var root = $('#talk-app');
    if (!root) return;
    var list = $('.clist', root), status = $('.talk-status', root), more = $('.cmore', root);
    var form = $('#cform', root);
    var oldest = null, loading = false, loaded = false;
    var nameInput = $('input[name="name"]', form);
    var savedName = rawGet('hb.name');
    if (savedName && nameInput) nameInput.value = savedName;

    function mine() { return idList('hb.mine'); }
    function isMine(cid) { return mine().indexOf(cid) >= 0; }

    function setStatus(msg, retry) {
      status.textContent = msg || '';
      status.hidden = !msg;
      if (retry) {
        var b = el('button', 'btn btn-quiet', '重试');
        b.type = 'button';
        b.addEventListener('click', function () { load(true); });
        status.appendChild(b);
      }
    }

    function renderComment(c, topId) {
      var li = el('li', 'cmt');
      li.id = 'c-' + c.id;
      li.setAttribute('data-cid', c.id);
      var head = el('div', 'chead');
      var nm = el('span', 'cname' + (isMine(c.id) ? ' me' : ''), c.name || '匿名读者');
      var tm = el('time', 'ctime', fmtTime(c.created));
      try { tm.dateTime = new Date(c.created < 1e12 ? c.created * 1000 : c.created).toISOString(); } catch (e) {}
      head.appendChild(nm); head.appendChild(tm);
      li.appendChild(head);
      li.appendChild(el('p', 'cbody', c.body));
      var acts = el('div', 'cacts');
      var like = el('button', 'cl');
      like.type = 'button';
      var liked = listHas('hb.clikes', c.id);
      var likes = c.likes || 0;
      function paintLike() {
        like.setAttribute('aria-pressed', String(liked));
        like.textContent = (liked ? '已赞' : '赞') + (likes ? ' ' + fmtNum(likes) : '');
      }
      paintLike();
      like.addEventListener('click', function () {
        if (like.disabled) return;
        var was = liked, prev = likes;
        liked = !was; likes = Math.max(0, likes + (liked ? 1 : -1));
        listSet('hb.clikes', c.id, liked); paintLike();
        like.disabled = true;
        api('POST', '/api/comments/' + c.id + '/like', { on: liked }).then(function (d) {
          if (d && typeof d.likes === 'number') { likes = d.likes; paintLike(); }
        }, function (e) {
          liked = was; likes = prev; listSet('hb.clikes', c.id, was); paintLike();
          toast('点赞没有成功：' + e.message, true);
        }).then(function () { like.disabled = false; });
      });
      acts.appendChild(like);

      var parentId = topId || c.id;
      var rep = el('button', 'cr', '回复');
      rep.type = 'button';
      rep.addEventListener('click', function () { openReply(li, parentId, topId ? c.name : null); });
      acts.appendChild(rep);

      if (isMine(c.id)) {
        var del = el('button', 'cd', '删除');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!W.confirm('删除这条评论？删除后无法恢复。')) return;
          del.disabled = true;
          api('DELETE', '/api/comments/' + c.id, {}).then(function () {
            var m = mine().filter(function (x) { return x !== c.id; });
            jset('hb.mine', m);
            li.parentNode && li.parentNode.removeChild(li);
            toast('评论已删除');
            if (!list.children.length) setStatus('还没有评论。来写第一条。');
          }, function (e) {
            del.disabled = false;
            toast('删除没有成功：' + e.message, true);
          });
        });
        acts.appendChild(del);
      }
      li.appendChild(acts);

      if (!topId) {
        var rl = el('ol', 'creplies');
        (c.replies || []).forEach(function (r) { rl.appendChild(renderComment(r, c.id)); });
        if (!rl.children.length) rl.hidden = true;
        li.appendChild(rl);
      }
      return li;
    }

    function openReply(li, parentId, atName) {
      var top = D.getElementById('c-' + parentId);
      if (!top) return;
      var exist = $('.cform-reply', top);
      if (exist) { exist.parentNode.removeChild(exist); if (!atName) return; }
      var f = form.cloneNode(true);
      f.removeAttribute('id');
      f.classList.add('cform-reply');
      $('.cform-title', f) && $('.cform-title', f).remove();
      var ta = $('textarea', f);
      ta.value = atName ? '回复 ' + atName + '：' : '';
      ta.setAttribute('aria-label', '回复内容');
      ta.removeAttribute('id');
      var ni = $('input[name="name"]', f);
      ni.removeAttribute('id');
      ni.value = rawGet('hb.name') || (nameInput ? nameInput.value : '');
      $$('label', f).forEach(function (l) { l.removeAttribute('for'); });
      $('.ferr', f).hidden = true;
      var sub = $('button[type="submit"]', f);
      sub.textContent = '发表回复';
      var cancel = el('button', 'btn btn-quiet', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', function () { f.parentNode.removeChild(f); });
      $('.bts', f).insertBefore(cancel, sub);
      bindForm(f, parentId);
      var rl = $('.creplies', top);
      top.insertBefore(f, rl);
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    }

    function bindForm(f, parentId) {
      f.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var err = $('.ferr', f), sub = $('button[type="submit"]', f);
        var name = ($('input[name="name"]', f).value || '').trim();
        var body = ($('textarea', f).value || '').trim();
        err.hidden = true;
        if (body.length < 2) { err.textContent = '评论至少 2 个字'; err.hidden = false; return; }
        if (body.length > 1000) { err.textContent = '评论最多 1000 字，现在是 ' + body.length + ' 字'; err.hidden = false; return; }
        var payload = { name: name || '匿名读者', body: body };
        if (parentId) payload.parent = parentId;
        sub.disabled = true;
        api('POST', '/api/works/' + encodeURIComponent(id) + '/comments', payload).then(function (d) {
          var c = d && d.comment;
          if (!c) throw apiError('服务器没有返回评论', 0, false);
          if (name) rawSet('hb.name', name);
          var m = mine(); m.unshift(c.id); jset('hb.mine', m.slice(0, 500));
          if (parentId) {
            var top = D.getElementById('c-' + parentId);
            var rl = top && $('.creplies', top);
            if (rl) { rl.hidden = false; rl.appendChild(renderComment(c, parentId)); }
            f.parentNode && f.parentNode.removeChild(f);
            toast('回复已发表');
          } else {
            c.replies = [];
            list.insertBefore(renderComment(c, null), list.firstChild);
            $('textarea', f).value = '';
            setStatus('');
            toast('评论已发表');
            var cc = $('#talk-count');
            if (cc) { var n = parseInt((cc.textContent || '0').replace(/\D/g, ''), 10) || 0; cc.textContent = fmtNum(n + 1) + ' 条'; }
          }
        }, function (e) {
          err.textContent = e.message;
          err.hidden = false;
        }).then(function () { sub.disabled = false; });
      });
      var ta = $('textarea', f), hint = $('.hint', f);
      if (ta && hint) ta.addEventListener('input', function () {
        var n = ta.value.trim().length;
        hint.textContent = n ? n + ' / 1000 字' : '2–1000 字';
      });
    }
    bindForm(form, null);

    function load(reset) {
      if (loading) return;
      loading = true;
      if (reset) { oldest = null; list.innerHTML = ''; }
      if (!oldest) setStatus('正在加载评论…');
      more.disabled = true;
      var q = '/api/works/' + encodeURIComponent(id) + '/comments?limit=30' + (oldest ? '&before=' + oldest : '');
      api('GET', q).then(function (d) {
        loaded = true;
        form.hidden = false;
        var cs = (d && d.comments) || [];
        cs.forEach(function (c) {
          if (!D.getElementById('c-' + c.id)) list.appendChild(renderComment(c, null));
          oldest = c.id;
        });
        more.hidden = !(d && d.more);
        if (!list.children.length) setStatus('还没有评论。来写第一条。');
        else setStatus('');
      }, function (e) {
        if (!oldest) {
          if (e.offline) form.hidden = true;
          setStatus('讨论区暂时无法加载：' + e.message + '。正文阅读不受影响。', true);
        } else toast('加载更多没有成功：' + e.message, true);
      }).then(function () { loading = false; more.disabled = false; });
    }
    more.addEventListener('click', function () { load(false); });

    /* 讨论区接近视口时才请求，减轻高峰期压力 */
    var talk = $('#talk');
    if (W.IntersectionObserver && talk && !/^#c-/.test(location.hash) && location.hash !== '#talk') {
      var io = new IntersectionObserver(function (en) {
        if (en.some(function (x) { return x.isIntersecting; })) { io.disconnect(); if (!loaded) load(true); }
      }, { rootMargin: '800px 0px' });
      io.observe(talk);
    } else load(true);
  }

  /* ---------- 我的收藏 ---------- */
  function initFavorites() {
    var box = $('#fav-list'), emptyEl = $('#fav-empty'), dataEl = $('#works-data');
    if (!box || !dataEl) return;
    var works;
    try { works = JSON.parse(dataEl.textContent); } catch (e) { works = []; }
    var byId = {};
    works.forEach(function (w) { byId[w.id] = w; });
    function render() {
      var ids = idList('hb.faved').filter(function (x) { return byId[x]; });
      box.innerHTML = '';
      ids.forEach(function (wid) {
        var w = byId[wid];
        var li = el('li', 'wrow fav-row');
        var a = el('a'); a.href = '/works/' + w.id + '/';
        if (w.cover) {
          var img = el('img', 'cover w-cv');
          img.src = w.cover; img.alt = ''; img.width = 72; img.height = 96;
          img.loading = 'lazy'; img.decoding = 'async';
          a.appendChild(img);
        } else {
          var ph = el('span', w.ph + ' w-cv'); ph.setAttribute('aria-hidden', 'true');
          a.appendChild(ph);
        }
        var wb = el('span', 'w-body');
        a.appendChild(wb);
        var tt = el('span', 'w-tt');
        tt.appendChild(el('span', 'w-t', w.title));
        tt.appendChild(el('span', 'w-a', w.author));
        wb.appendChild(tt);
        var aw = el('span', 'w-aw');
        w.awards.forEach(function (x) { aw.appendChild(el('span', 'mark mark-' + x.c, x.label)); });
        wb.appendChild(aw);
        wb.appendChild(el('span', 'w-ch', w.chars));
        var pos = readPos(w.id), r = pos ? pos.r : 0;
        wb.appendChild(el('span', 'w-ai', r > 0.02 ? (r >= 0.98 ? '已读完' : '读到 ' + Math.round(r * 100) + '%') : '未开始'));
        li.appendChild(a);
        var rm = el('button', 'fav-rm', '移出收藏');
        rm.type = 'button';
        rm.setAttribute('aria-label', '把《' + w.title + '》移出收藏');
        rm.addEventListener('click', function () {
          listSet('hb.faved', w.id, false);
          render();
          toast('已移出收藏');
          api('POST', '/api/works/' + encodeURIComponent(w.id) + '/fav', { on: false }).catch(function () {});
        });
        li.appendChild(rm);
        box.appendChild(li);
      });
      emptyEl.hidden = ids.length > 0;
      box.hidden = ids.length === 0;
      var c = $('#fav-count');
      if (c) c.textContent = ids.length ? '共 ' + ids.length + ' 部，保存在这台设备的浏览器里。' : '收藏保存在这台设备的浏览器里。';
    }
    render();
  }

  // 读者越过操作条（操作条滚出视口上方）之前收起浮动的阅读工具（只在窄屏的 CSS 中生效）：
  // 首屏的标题、元信息、操作条可能比一屏高，只看「操作条是否可见」时工具条会压在元信息上。面板打开时不收起。
  // HTML 里默认带 is-tucked，避免首帧闪现；不支持 IntersectionObserver 时直接显示。
  function tuckDock() {
    var dock = document.querySelector('.dock'), bar = document.querySelector('.actions');
    if (!dock) return;
    if (!bar || !('IntersectionObserver' in window)) { dock.classList.remove('is-tucked'); return; }
    new IntersectionObserver(function (es) {
      var e = es[es.length - 1], open = dock.querySelector('[aria-expanded="true"]');
      var passed = !e.isIntersecting && e.boundingClientRect.bottom <= 0;
      dock.classList.toggle('is-tucked', !passed && !open);
    }).observe(bar);
  }

  /* ---------- 下载：微信内置浏览器会拦截 TXT / EPUB / ZIP 下载 ----------
     在微信里点下载链接时不跳转，改为提示「在浏览器打开」（样式与分享的微信引导共用 .sh-wx）。地址加 ?wx=1 可在普通浏览器调试。 */
  var IN_WX = /MicroMessenger/i.test(navigator.userAgent || '') || /[?&]wx=1(?:&|$)/.test(location.search || '');
  var dlGuide = null, dlOpener = null;
  function hideDlGuide() {
    if (!dlGuide || dlGuide.hidden) return;
    dlGuide.hidden = true;
    H.classList.remove('sh-open');
    if (dlOpener && dlOpener.focus) { try { dlOpener.focus({ preventScroll: true }); } catch (e) { dlOpener.focus(); } }
    dlOpener = null;
  }
  function showDlGuide(opener) {
    if (!dlGuide) {
      dlGuide = el('div', 'sh-wx');
      dlGuide.setAttribute('role', 'dialog');
      dlGuide.setAttribute('aria-modal', 'true');
      dlGuide.setAttribute('aria-labelledby', 'dl-wx-t');
      dlGuide.tabIndex = -1;
      dlGuide.innerHTML =
        '<svg class="sh-wx-arrow" viewBox="0 0 120 140" aria-hidden="true" focusable="false">' +
        '<path d="M14 132C22 82 52 46 96 22" fill="none" stroke-width="5" stroke-linecap="round"/>' +
        '<path d="M70 16l30 4-10 28" fill="none" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var p = el('p', 'sh-wx-t');
      p.id = 'dl-wx-t';
      p.appendChild(D.createTextNode('微信内无法直接下载，请点右上角 '));
      var dots = el('span', 'sh-wx-dots', '···');
      dots.setAttribute('aria-label', '更多');
      p.appendChild(dots);
      p.appendChild(D.createTextNode(' 选择「在浏览器打开」后再下载'));
      var ok = el('button', 'btn sh-wx-ok', '知道了');
      ok.type = 'button';
      dlGuide.appendChild(p);
      dlGuide.appendChild(ok);
      dlGuide.hidden = true;
      D.body.appendChild(dlGuide);
      dlGuide.addEventListener('click', hideDlGuide);
      dlGuide.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); ev.stopPropagation(); hideDlGuide(); }
        if (ev.key === 'Tab') { ev.preventDefault(); ok.focus(); }
      });
    }
    dlOpener = opener || null;
    dlGuide.hidden = false;
    H.classList.add('sh-open');
    dlGuide.querySelector('.sh-wx-ok').focus();
  }
  function initDownloads() {
    if (!IN_WX) return;
    D.addEventListener('click', function (ev) {
      var a = ev.target.closest && ev.target.closest('a[href]');
      if (!a || !/^\/downloads\//.test(a.getAttribute('href') || '')) return;
      ev.preventDefault();
      showDlGuide(a);
    });
  }

  // 共享给 reader.js / share.js 的工具（它们在 site.js 之后加载，均为 defer）
  W.HB = { toast: toast, api: api, hit: hit, copyText: copyText, device: device, jget: jget, jset: jset, el: el, prefs: prefs, savePrefs: savePrefs,
    readPos: readPos, keepPosition: function (fn) { keepPosition(fn); } };

  // 页脚「给网站开发者留言」：邮箱地址由脚本拼出，减少被爬虫收集
  D.querySelectorAll('a.js-mail').forEach(function (a) {
    var addr = a.getAttribute('data-u') + '@' + a.getAttribute('data-d');
    var page = location.origin + location.pathname;
    a.href = 'mailto:' + addr + '?subject=' + encodeURIComponent(a.getAttribute('data-s') || '') +
      '&body=' + encodeURIComponent('\r\n\r\n——\r\n来自页面：' + page);
    a.title = addr;
    var tail = el('span', 'mail-addr', '（' + addr + '）');
    a.after(tail);
  });

  device();
  hit();  // 尽早发出（不等各区块初始化）
  initDownloads();
  if (page === 'home') initHome();
  else if (page === 'work') { initWork(); tuckDock(); }
  else if (page === 'favorites') initFavorites();
})();
