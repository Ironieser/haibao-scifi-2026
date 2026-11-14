/* 海豹杯 2026 — 分享面板与分享图。原生 JS，无第三方依赖。
   用到 window.HB（site.js）与 window.qrcode（vendor/qrcode.js，在本文件之后加载，所以只在调用时再取）。
   对外：window.HBShare.open({ text?: 选中的引文, pid?: 段落编号 })
   调试：地址加 ?wx=1 按微信内置浏览器处理。 */
(function () {
  'use strict';
  var D = document, W = window, H = D.documentElement;

  var meta = null;
  try { meta = JSON.parse((D.getElementById('work-meta') || {}).textContent || 'null'); } catch (e) { meta = null; }
  if (!meta || !meta.url || !meta.title) {
    W.HBShare = { open: function () {} };
    return;
  }

  var UA = navigator.userAgent || '';
  var QS = location.search || '';
  var IS_WX = /MicroMessenger/i.test(UA) || /[?&]wx=1(?:&|$)/.test(QS);
  var IS_IOS = /iP(hone|ad|od)/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  var LONG_PRESS = IS_WX || IS_IOS || /\bQQ\/|MQQBrowser|Weibo/i.test(UA);

  var INK = '#1E2140', PAPER = '#EEEFEA', MUTED = '#6B6E85';
  var JC = { human: '#FF48B0', ai: '#0078BF', rod: '#FFE800' };
  var JT = { human: '#B8006B', ai: '#005A8F', rod: INK };      // 小字用的加深色
  var JW = { human: 'rgba(255,72,176,.12)', ai: 'rgba(0,120,191,.10)', rod: '#FFE800' };
  var JURY_ORDER = ['human', 'ai', 'rod'];
  var juries = JURY_ORDER.filter(function (j) { return (meta.juries || []).indexOf(j) >= 0; });
  if (!juries.length) juries = ['human'];
  var mainJury = juries[0];

  var F_DISP = '"HB Display", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  var F_UI = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  var F_READ = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif';

  var TITLE_LINE = '《' + meta.title + '》' + meta.author + '｜2026 海豹杯获奖作品';

  /* ---------- 小工具 ---------- */
  function hb() { return W.HB || {}; }
  function toast(msg, isErr) { if (hb().toast) hb().toast(msg, isErr); }
  function el(tag, cls, text) {
    var n = D.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function enc(s) { return encodeURIComponent(s); }
  function chars(s) { return Array.from ? Array.from(s) : s.split(''); }
  function clip(s, n) {
    var a = chars(s);
    return a.length > n ? a.slice(0, n).join('').replace(/[\s，、；：,;:]+$/, '') + '……' : s;
  }
  function absUrl(p) {
    try { return new URL(p, meta.url).href; } catch (e) { return p; }
  }
  function cleanQuote(t) {
    t = String(t || '').replace(/\r\n?/g, '\n').replace(/[ \t 　]+/g, ' ');
    t = t.replace(/ *\n[\s]*/g, '\n').trim();
    return chars(t).length > 2000 ? chars(t).slice(0, 2000).join('') : t;
  }
  function juryOf(award) {
    if (/^人类/.test(award)) return 'human';
    if (/^AI/i.test(award)) return 'ai';
    if (/鱼竿/.test(award)) return 'rod';
    return mainJury;
  }
  function copy(text) {
    if (hb().copyText) return hb().copyText(text);
    if (navigator.clipboard && W.isSecureContext) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error('no clipboard'));
  }
  function ogImage() {
    var m = D.querySelector('meta[property="og:image"]');
    return m ? m.getAttribute('content') : '';
  }

  /* ---------- 渠道链接 ---------- */
  function links(st) {
    var url = st.url, q = st.quote, pic = ogImage();
    var wbText = q ? '「' + clip(q.replace(/\n/g, ' '), 80) + '」' + TITLE_LINE : TITLE_LINE;
    var summary = q ? clip(q.replace(/\n/g, ' '), 100) : (meta.awards || []).join('、');
    var body = [];
    if (q) body.push('「' + clip(q, 300) + '」', '');
    body.push('《' + meta.title + '》 作者：' + meta.author);
    if (meta.awards && meta.awards.length) body.push('获奖：' + meta.awards.join('、'));
    body.push('在线阅读：' + url);
    if (meta.txt) body.push('下载 TXT：' + absUrl(meta.txt));
    if (meta.epub) body.push('下载 EPUB：' + absUrl(meta.epub));
    body.push('', '2026 海豹杯科幻文学大赛获奖作品集');
    return {
      weibo: 'https://service.weibo.com/share/share.php?url=' + enc(url) + '&title=' + enc(wbText) +
        (pic ? '&pic=' + enc(pic) : ''),
      qq: 'https://connect.qq.com/widget/shareqq/index.html?url=' + enc(url) + '&title=' + enc(TITLE_LINE) +
        '&summary=' + enc(summary) + (pic ? '&pics=' + enc(pic) : ''),
      mail: 'mailto:?subject=' + enc('推荐阅读：《' + meta.title + '》') + '&body=' + enc(body.join('\r\n'))
    };
  }

  /* ---------- 二维码 ---------- */
  function qrMake(text) {
    var f = W.qrcode;
    if (typeof f !== 'function') return null;
    try { var q = f(0, 'M'); q.addData(text); q.make(); return q; } catch (e) { return null; }
  }
  function qrSvg(text, label) {
    var q = qrMake(text);
    if (!q) return null;
    var n = q.getModuleCount(), m = 4, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
    var NS = 'http://www.w3.org/2000/svg';
    var svg = D.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.setAttribute('shape-rendering', 'crispEdges');
    var bg = D.createElementNS(NS, 'rect');
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', PAPER);
    var p = D.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', INK);
    svg.appendChild(bg); svg.appendChild(p);
    return svg;
  }

  /* ---------- 图标（静态字符串） ---------- */
  var I = {
    wx: '<path d="M9.5 4.5C5.4 4.5 2.5 7 2.5 10c0 1.7.9 3.1 2.3 4.1L4.3 16.5l2.6-1.3c.8.2 1.7.3 2.6.3"/><path d="M15 9c3.6 0 6.5 2.3 6.5 5.1 0 1.5-.8 2.8-2 3.7l.5 2-2.3-1.1c-.9.3-1.8.4-2.7.4-3.6 0-6.5-2.3-6.5-5S11.4 9 15 9z"/><path d="M7.4 8.4h.01M11.6 8.4h.01M13 13.4h.01M17 13.4h.01" stroke-width="2.4"/>',
    card: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M5 10h14"/><circle cx="10" cy="6.6" r="1.6"/><path d="M8 14h8M8 17h5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    wb: '<path d="M4.5 13.5c0 3.2 3.6 5.5 7.6 5.5 4.5 0 7.4-2.7 7.4-5.2 0-2.2-2.4-3-3.5-2.6.6-1.6-.1-2.9-2.3-2.4L10.6 10c.4-2-1-2.6-3-1.3-2 1.3-3.1 3.2-3.1 4.8z"/><path d="M16 3.6a5 5 0 0 1 4.6 6M15.4 6.3a2.3 2.3 0 0 1 2.4 2.8"/>',
    qq: '<path d="M12 3c-3 0-5 2.4-5 5.6v1.6c-1 1.2-2 3-2 4.6 0 .9.4 1.2 1.2.4l.6-.6c.3 1.2 1 2.2 1.9 3-1 .4-1.6.9-1.6 1.4 0 .8 1.9 1 3.6.6L12 19l1.3.6c1.7.4 3.6.2 3.6-.6 0-.5-.6-1-1.6-1.4.9-.8 1.6-1.8 1.9-3l.6.6c.8.8 1.2.5 1.2-.4 0-1.6-1-3.4-2-4.6V8.6C17 5.4 15 3 12 3z"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="1"/><path d="M3.5 6.5l8.5 7 8.5-7"/>',
    sys: '<path d="M12 15V4M8 8l4-4 4 4M6 12v8h12v-8"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + I[name] + '</svg>';
  }

  /* ---------- 面板 DOM ---------- */
  var ui = null, state = null, opener = null, wxGuide = null, wxOpener = null;

  function build() {
    var root = el('div', 'sh sh-j-' + mainJury);
    root.hidden = true;
    var scrim = el('div', 'sh-scrim');
    scrim.setAttribute('aria-hidden', 'true');
    var box = el('section', 'sh-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'sh-h');
    box.tabIndex = -1;

    var head = el('header', 'sh-head');
    var back = el('button', 'sh-ib sh-back');
    back.type = 'button';
    back.setAttribute('aria-label', '返回分享方式');
    back.innerHTML = icon('back');
    back.hidden = true;
    var h = el('h2', 'sh-h', '分享');
    h.id = 'sh-h';
    var x = el('button', 'sh-ib sh-x');
    x.type = 'button';
    x.setAttribute('aria-label', '关闭分享面板');
    x.innerHTML = icon('x');
    head.appendChild(back); head.appendChild(h); head.appendChild(x);

    /* 主视图 */
    var main = el('div', 'sh-view sh-main');
    var quote = el('figure', 'sh-quote');
    var qtext = el('blockquote', 'sh-qt');
    var qcap = el('figcaption', 'sh-qc');
    quote.appendChild(qtext); quote.appendChild(qcap);

    var linkBox = el('div', 'sh-link');
    var ttl = el('p', 'sh-ttl', TITLE_LINE);
    var urlIn = el('input', 'sh-url');
    urlIn.type = 'text'; urlIn.readOnly = true;
    urlIn.setAttribute('aria-label', '分享链接');
    urlIn.addEventListener('focus', function () { try { urlIn.select(); } catch (e) {} });
    urlIn.addEventListener('click', function () { try { urlIn.select(); } catch (e) {} });
    linkBox.appendChild(ttl); linkBox.appendChild(urlIn);

    var grid = el('ul', 'sh-ch');
    grid.setAttribute('aria-label', '分享方式');
    function tile(key, label, ic, link) {
      var li = el('li');
      var b;
      if (link) {
        b = el('a', 'sh-c');
        if (link === 'blank') { b.target = '_blank'; b.rel = 'noopener'; }
      } else {
        b = el('button', 'sh-c');
        b.type = 'button';
      }
      b.setAttribute('data-ch', key);
      b.innerHTML = icon(ic);
      b.appendChild(el('span', 'sh-cl', label));
      li.appendChild(b);
      grid.appendChild(li);
      return b;
    }
    var c = {};
    c.wx = tile('wx', '微信', 'wx');
    c.card = tile('card', '分享图', 'card');
    c.copy = tile('copy', '复制链接', 'link');
    c.weibo = tile('weibo', '微博', 'wb', 'blank');
    c.qq = tile('qq', 'QQ', 'qq', 'blank');
    c.mail = tile('mail', '邮件', 'mail', 'self');
    if (navigator.share) c.sys = tile('sys', '系统分享', 'sys');
    c.weibo.setAttribute('aria-label', '分享到微博（新窗口）');
    c.qq.setAttribute('aria-label', '分享给 QQ 好友（新窗口）');

    main.appendChild(quote); main.appendChild(linkBox); main.appendChild(grid);

    /* 二级视图：二维码 / 分享图 */
    var sub = el('div', 'sh-view sh-sub');
    sub.hidden = true;

    box.appendChild(head); box.appendChild(main); box.appendChild(sub);
    root.appendChild(scrim); root.appendChild(box);
    D.body.appendChild(root);

    scrim.addEventListener('click', close);
    x.addEventListener('click', close);
    back.addEventListener('click', function () { showMain(true); });
    root.addEventListener('keydown', onKey);

    c.copy.addEventListener('click', function () {
      var t = (state.quote ? '「' + clip(state.quote.replace(/\n/g, ' '), 120) + '」\n' : '') + TITLE_LINE + '\n' + state.url;
      copy(t).then(function () { toast('已复制标题和链接'); },
        function () { toast('复制没有成功，请长按上面的链接手动复制', true); try { urlIn.focus(); urlIn.select(); } catch (e) {} });
    });
    c.wx.addEventListener('click', function () {
      if (IS_WX) { close(); showWxGuide(); } else showQr();
    });
    c.card.addEventListener('click', function () { showCard(state.quote ? 'quote' : 'work'); });
    if (c.sys) c.sys.addEventListener('click', function () {
      var data = { title: '《' + meta.title + '》' + meta.author, text: state.quote ? '「' + clip(state.quote.replace(/\n/g, ' '), 120) + '」' : TITLE_LINE, url: state.url };
      try {
        navigator.share(data).then(function () {}, function (e) {
          if (e && e.name !== 'AbortError') toast('系统分享没有成功，可以改用复制链接', true);
        });
      } catch (e) { toast('系统分享没有成功，可以改用复制链接', true); }
    });

    ui = { root: root, box: box, h: h, back: back, x: x, main: main, sub: sub, quote: quote, qtext: qtext, qcap: qcap, url: urlIn, c: c };
  }

  function onKey(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key !== 'Tab') return;
    var f = focusables(ui.box);
    if (!f.length) { ev.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1], a = D.activeElement;
    if (ev.shiftKey && (a === first || a === ui.box)) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && a === last) { ev.preventDefault(); first.focus(); }
  }
  function focusables(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]'),
      function (n) { return !n.hidden && (n.offsetWidth || n.offsetHeight || n.getClientRects().length); });
  }

  function fill() {
    var q = state.quote;
    ui.quote.hidden = !q;
    ui.qtext.textContent = q ? clip(q, 160) : '';
    ui.qcap.textContent = q ? (state.pid ? '选自正文第 ' + state.pid + ' 段，链接会直接定位到这一段' : '选自《' + meta.title + '》') : '';
    ui.url.value = state.url;
    var L = links(state);
    ui.c.weibo.href = L.weibo;
    ui.c.qq.href = L.qq;
    ui.c.mail.href = L.mail;
  }

  function showMain(focusBack) {
    var from = ui.sub.getAttribute('data-view');
    ui.sub.hidden = true;
    ui.sub.removeAttribute('data-view');
    ui.main.hidden = false;
    ui.back.hidden = true;
    ui.h.textContent = state && state.quote ? '分享这段文字' : '分享';
    if (focusBack && from) {
      var t = ui.c[from];
      if (t) t.focus();
    }
  }
  function showSub(view, title) {
    ui.main.hidden = true;
    ui.sub.hidden = false;
    ui.sub.setAttribute('data-view', view);
    ui.sub.innerHTML = '';
    ui.back.hidden = false;
    ui.h.textContent = title;
    ui.box.scrollTop = 0;
    ui.back.focus();
  }

  function open(opts) {
    opts = opts || {};
    if (!ui) build();
    var pid = parseInt(opts.pid, 10);
    if (!(pid > 0)) pid = null;
    var quote = cleanQuote(opts.text);
    state = {
      quote: quote || '',
      pid: pid,
      url: meta.url.replace(/#.*$/, '') + (pid ? '#p-' + pid : '')
    };
    fill();
    showMain(false);
    if (ui.root.hidden) {
      opener = D.activeElement && D.activeElement !== D.body ? D.activeElement : D.getElementById('act-share');
      ui.root.hidden = false;
      H.classList.add('sh-open');
    }
    ui.box.focus();
  }

  function close() {
    if (!ui || ui.root.hidden) return;
    ui.root.hidden = true;
    H.classList.remove('sh-open');
    ui.sub.innerHTML = '';
    releaseCard();
    var o = opener;
    opener = null;
    if (o && o.focus && D.contains(o)) { try { o.focus({ preventScroll: true }); } catch (e) { o.focus(); } }
  }

  /* ---------- 微信：二维码 / 内置浏览器引导 ---------- */
  function showQr() {
    showSub('wx', '分享到微信');
    var wrap = el('div', 'sh-qr');
    var svg = qrSvg(state.url, '本页链接的二维码');
    var fig = el('div', 'sh-qr-img');
    if (svg) fig.appendChild(svg);
    else fig.appendChild(el('p', 'sh-note', '二维码没有加载出来，可以先复制链接，再粘贴到微信里。'));
    wrap.appendChild(fig);
    wrap.appendChild(el('p', 'sh-qr-t', '用微信扫一扫，打开后点右上角分享给朋友'));
    ui.sub.appendChild(wrap);
    var row = el('div', 'sh-row');
    var b = el('button', 'btn btn-quiet sh-btn', '复制链接，粘贴到微信');
    b.type = 'button';
    b.addEventListener('click', function () {
      copy(TITLE_LINE + '\n' + state.url).then(function () { toast('已复制，打开微信粘贴即可'); },
        function () { toast('复制没有成功，请手动复制链接', true); });
    });
    row.appendChild(b);
    ui.sub.appendChild(row);
  }

  function showWxGuide() {
    if (!wxGuide) {
      wxGuide = el('div', 'sh-wx');
      wxGuide.setAttribute('role', 'dialog');
      wxGuide.setAttribute('aria-modal', 'true');
      wxGuide.setAttribute('aria-label', '分享引导');
      wxGuide.tabIndex = -1;
      wxGuide.innerHTML =
        '<svg class="sh-wx-arrow" viewBox="0 0 120 140" aria-hidden="true" focusable="false">' +
        '<path d="M14 132C22 82 52 46 96 22" fill="none" stroke-width="5" stroke-linecap="round"/>' +
        '<path d="M70 16l30 4-10 28" fill="none" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var p = el('p', 'sh-wx-t');
      p.appendChild(D.createTextNode('点右上角 '));
      p.appendChild(el('span', 'sh-wx-dots', '···'));
      p.appendChild(el('br'));
      p.appendChild(D.createTextNode('发送给朋友或分享到朋友圈'));
      var ok = el('button', 'btn sh-wx-ok', '知道了');
      ok.type = 'button';
      wxGuide.appendChild(p);
      wxGuide.appendChild(ok);
      wxGuide.hidden = true;
      D.body.appendChild(wxGuide);
      wxGuide.addEventListener('click', hideWxGuide);
      wxGuide.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' || ev.key === 'Esc') { ev.preventDefault(); ev.stopPropagation(); hideWxGuide(); }
        if (ev.key === 'Tab') { ev.preventDefault(); ok.focus(); }
      });
    }
    wxOpener = D.getElementById('act-share');
    wxGuide.hidden = false;
    H.classList.add('sh-open');
    wxGuide.querySelector('.sh-wx-ok').focus();
  }
  function hideWxGuide() {
    if (!wxGuide || wxGuide.hidden) return;
    wxGuide.hidden = true;
    if (!ui || ui.root.hidden) H.classList.remove('sh-open');
    if (wxOpener && wxOpener.focus) { try { wxOpener.focus({ preventScroll: true }); } catch (e) { wxOpener.focus(); } }
  }

  /* ---------- 分享图 ---------- */
  var cardUrl = null, cardCache = {};
  function releaseCard() {
    Object.keys(cardCache).forEach(function (k) { if (cardCache[k].blobUrl) URL.revokeObjectURL(cardCache[k].blobUrl); });
    cardCache = {};
    cardUrl = null;
  }

  function showCard(kind) {
    showSub('card', '生成分享图');
    var view = el('div', 'sh-card');
    if (state.quote) {
      var seg = el('div', 'sh-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', '分享图样式');
      [['quote', '金句卡'], ['work', '作品卡']].forEach(function (k) {
        var b = el('button', '', k[1]);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(k[0] === kind));
        b.addEventListener('click', function () {
          if (k[0] === kind) return;
          kind = k[0];
          Array.prototype.forEach.call(seg.children, function (x) { x.setAttribute('aria-pressed', String(x === b)); });
          render();
        });
        seg.appendChild(b);
      });
      view.appendChild(seg);
    }
    var stage = el('div', 'sh-stage');
    var status = el('p', 'sh-status', '正在生成分享图…');
    status.setAttribute('role', 'status');
    var img = el('img', 'sh-img');
    img.alt = '';
    img.hidden = true;
    stage.appendChild(status); stage.appendChild(img);
    view.appendChild(stage);
    var hint = el('p', 'sh-note');
    hint.hidden = true;
    var row = el('div', 'sh-row');
    var save = el('a', 'btn btn-primary sh-btn', '保存图片');
    save.hidden = true;
    row.appendChild(save);
    var shareFile = null;
    if (navigator.canShare && W.File && !IS_WX) {
      shareFile = el('button', 'btn sh-btn', '发送图片');
      shareFile.type = 'button';
      shareFile.hidden = true;
      row.appendChild(shareFile);
    }
    view.appendChild(row);
    view.appendChild(hint);
    ui.sub.appendChild(view);

    var cur = null, seq = 0;
    if (shareFile) shareFile.addEventListener('click', function () {
      if (!cur || !cur.blob) return;
      var f = new File([cur.blob], fileName(), { type: 'image/png' });
      if (!navigator.canShare({ files: [f] })) { toast('这个浏览器不支持直接发送图片，请先保存', true); return; }
      navigator.share({ files: [f], title: '《' + meta.title + '》' + meta.author }).then(function () {}, function (e) {
        if (e && e.name !== 'AbortError') toast('发送没有成功，请先保存图片', true);
      });
    });

    function render() {
      var my = ++seq, key = kind + '|' + state.url + '|' + (kind === 'quote' ? state.quote : '');
      status.textContent = '正在生成分享图…';
      status.hidden = false;
      img.hidden = true; save.hidden = true; hint.hidden = true;
      if (shareFile) shareFile.hidden = true;
      var p = cardCache[key] ? Promise.resolve(cardCache[key]) : makeCard(kind).then(function (r) { cardCache[key] = r; return r; });
      p.then(function (r) {
        if (my !== seq || ui.sub.getAttribute('data-view') !== 'card') return;
        cur = r;
        img.src = r.src;
        img.alt = kind === 'quote' ? '分享图预览：《' + meta.title + '》金句卡' : '分享图预览：《' + meta.title + '》作品卡';
        img.hidden = false;
        status.hidden = true;
        if (IS_WX) {
          hint.textContent = '长按图片保存，或直接发送给朋友';
          hint.hidden = false;
        } else {
          save.href = r.blobUrl;
          save.setAttribute('download', fileName());
          save.hidden = false;
          if (shareFile) shareFile.hidden = !navigator.canShare({ files: [new File([r.blob], fileName(), { type: 'image/png' })] });
          if (LONG_PRESS) { hint.textContent = '也可以长按图片保存到相册'; hint.hidden = false; }
        }
      }, function () {
        if (my !== seq) return;
        status.textContent = '分享图没有生成成功。可以改用复制链接或二维码分享。';
      });
    }
    render();
  }

  function fileName() {
    var t = String(meta.title).replace(/[\\/:*?"<>|]/g, '');
    return t + '-海豹杯分享图.png';
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (ok) { setTimeout(ok, ms); })]);
  }
  function loadImage(src) {
    return new Promise(function (ok, no) {
      if (!src) { no(new Error('no src')); return; }
      var im = new Image();
      im.decoding = 'async';
      im.onload = function () { ok(im); };
      im.onerror = function () { no(new Error('img')); };
      im.src = src;
    });
  }

  function makeCard(kind) {
    var fontsReady = D.fonts && D.fonts.load ? withTimeout(Promise.all([
      D.fonts.load('700 48px "HB Display"', '海豹杯' + meta.title + meta.author).catch(function () {}),
      D.fonts.load('48px ' + F_READ.split(',')[0], '文').catch(function () {})
    ]), 3000) : Promise.resolve();
    var cover = withTimeout(loadImage(meta.cover).catch(function () { return null; }), 4000);
    return Promise.all([fontsReady, cover]).then(function (r) {
      var im = r[1] || null;
      var cv = drawCard(kind, im);
      return exportCanvas(cv).catch(function (e) {
        if (!im) throw e;
        return exportCanvas(drawCard(kind, null));   // 封面导致画布不可导出时，退回几何色块
      });
    });
  }

  function exportCanvas(cv) {
    return new Promise(function (ok, no) {
      try {
        cv.toBlob(function (blob) {
          if (!blob) { no(new Error('blob')); return; }
          var res = { blob: blob, blobUrl: URL.createObjectURL(blob) };
          if (IS_WX && W.FileReader) {
            var fr = new FileReader();
            fr.onload = function () { res.src = fr.result; ok(res); };
            fr.onerror = function () { res.src = res.blobUrl; ok(res); };
            fr.readAsDataURL(blob);
          } else { res.src = res.blobUrl; ok(res); }
        }, 'image/png');
      } catch (e) { no(e); }
    });
  }

  /* 可复现的伪随机数（同一作品的颗粒每次一样） */
  function rng(seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var CW = 1080, CH = 1440, M = 96;

  function drawCard(kind, coverImg) {
    var cv = D.createElement('canvas');
    cv.width = CW; cv.height = CH;
    var g = cv.getContext('2d');
    var R = rng(meta.id + kind);
    g.fillStyle = PAPER;
    g.fillRect(0, 0, CW, CH);

    var artH = kind !== 'quote' ? 640 : chars(state.quote).length > 90 ? 380 : 470;
    drawArt(g, coverImg, artH, kind === 'quote');

    var footTop = 1122;
    if (kind === 'quote') drawQuote(g, artH + 40, footTop - 56);
    else drawWork(g, artH + 52, footTop - 48);
    drawFooter(g, footTop, kind);
    grain(g, R);
    return cv;
  }

  function drawArt(g, im, artH, withAwards) {
    var ok = false;
    if (im) {
      try {
        var iw = im.naturalWidth || 600, ih = im.naturalHeight || 800;
        if (!iw || !ih) { iw = 600; ih = 800; }
        var h = artH - 40, w = h * iw / ih;
        var x = (CW - w) / 2 + 80, y = 28;
        regMarks(g, x, y, w, h);
        g.drawImage(im, x, y, w, h);
        ok = true;
      } catch (e) { ok = false; }
    }
    if (!ok) shapes(g, artH);
    /* 左侧印色条：每个获奖评审团一条，套印叠色 */
    var bx = M, bw = 26, by = 56, bh = artH - 130;
    juries.forEach(function (j, i) {
      g.save();
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = JC[j];
      g.globalAlpha = j === 'rod' ? 1 : 0.92;
      g.fillRect(bx + i * 18, by + i * 10, bw, bh);
      g.restore();
    });
    var lx = M + juries.length * 18 + 48;
    g.fillStyle = INK;
    g.font = '700 30px ' + F_DISP;
    g.textBaseline = 'alphabetic';
    g.fillText('海豹杯', lx, by + 30);
    g.fillText('2026', lx, by + 72);
    g.fillStyle = MUTED;
    g.font = '24px ' + F_UI;
    var aw = withAwards ? (meta.awards || []).slice(0, 4) : [];
    aw.forEach(function (a, i) {
      g.fillStyle = JT[juryOf(a)];
      g.fillText(a, lx, by + 128 + i * 38);
    });
  }

  function regMarks(g, x, y, w, h) {
    /* 封面的「错版」底色：主色块偏移在封面后面 */
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = JC[mainJury];
    g.globalAlpha = mainJury === 'rod' ? 1 : 0.9;
    g.fillRect(x + 16, y + 16, w, h);
    g.restore();
  }

  function shapes(g, artH) {
    var cx = CW * 0.62, cy = artH * 0.5;
    g.save();
    g.globalCompositeOperation = 'multiply';
    if (juries.indexOf('human') >= 0) {
      g.fillStyle = JC.human; g.globalAlpha = 0.92;
      g.beginPath(); g.arc(cx - 70, cy - 10, artH * 0.34, 0, Math.PI * 2); g.fill();
    }
    if (juries.indexOf('ai') >= 0) {
      g.fillStyle = JC.ai; g.globalAlpha = 0.85;
      g.save(); g.translate(cx + 90, cy + 10); g.rotate(-0.12);
      g.fillRect(-artH * 0.3, -artH * 0.3, artH * 0.6, artH * 0.6);
      g.restore();
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.strokeStyle = INK; g.lineWidth = 4;
    g.beginPath(); g.arc(cx - 150, cy + 40, artH * 0.2, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - 330, cy + 40); g.lineTo(cx + 260, cy + 40); g.stroke();
    g.globalCompositeOperation = 'multiply';
    if (juries.indexOf('rod') >= 0) {
      g.fillStyle = JC.rod; g.globalAlpha = 1;
      g.fillRect(cx - artH * 0.45, cy + artH * 0.22, artH * 0.9, artH * 0.12);
    }
    g.restore();
  }

  function grain(g, R) {
    var i, x, y, s;
    for (i = 0; i < 9000; i++) {
      x = R() * CW; y = R() * CH; s = R() < 0.85 ? 1.4 : 2.4;
      g.fillStyle = 'rgba(30,33,64,' + (0.035 + R() * 0.09).toFixed(3) + ')';
      g.fillRect(x, y, s, s);
    }
    for (i = 0; i < 2200; i++) {
      x = R() * CW; y = R() * CH; s = R() < 0.8 ? 1.4 : 2.2;
      g.fillStyle = 'rgba(255,255,255,' + (0.12 + R() * 0.2).toFixed(3) + ')';
      g.fillRect(x, y, s, s);
    }
  }

  /* CJK 断行：行首禁则（标点挂在行尾）、行尾禁则、英文单词不拆开 */
  var NO_START = '，。、；：？！）」』》〉】〕”’…—～·,.;:?!)]}%';
  var NO_END = '（「『《〈【〔“‘([{';
  function wrap(g, text, maxW) {
    var out = [];
    String(text).split('\n').forEach(function (para) {
      var a = chars(para), line = '';
      for (var i = 0; i < a.length; i++) {
        var ch = a[i];
        if (line && g.measureText(line + ch).width > maxW) {
          if (NO_START.indexOf(ch) >= 0) { line += ch; continue; }
          var carry = '';
          var la = chars(line);
          if (/[A-Za-z0-9]/.test(ch) && /[A-Za-z0-9]$/.test(line)) {
            var k = la.length - 1;
            while (k > 0 && /[A-Za-z0-9'\-]/.test(la[k])) k--;
            if (k > 0 && la.length - k < 24) { carry = la.slice(k + 1).join(''); la = la.slice(0, k + 1); }
          }
          while (la.length > 1 && NO_END.indexOf(la[la.length - 1]) >= 0) { carry = la.pop() + carry; }
          out.push(la.join('').replace(/\s+$/, ''));
          line = (carry + ch).replace(/^\s+/, '');
        } else line += ch;
      }
      out.push(line);
    });
    return out;
  }
  function ellipsize(g, line, maxW) {
    var a = chars(line.replace(/[，、；：,;:\s]+$/, ''));
    while (a.length && g.measureText(a.join('') + '……').width > maxW) a.pop();
    return a.join('').replace(/[，、；：,;:\s]+$/, '') + '……';
  }

  var PAIRS = { '“': '”', '「': '」', '『': '』', '"': '"' };
  function unwrapQuote(t) {
    var a = chars(t), o = a[0], c = PAIRS[o];
    if (a.length > 2 && c && a[a.length - 1] === c) {
      var inner = a.slice(1, -1).join('');
      if (inner.indexOf(o) < 0 && (o === c || inner.indexOf(c) < 0)) return inner;
    }
    return t;
  }

  function drawQuote(g, top, bottom) {
    var q = clip(unwrapQuote(state.quote), 160);
    var x = M + 20, maxW = CW - M - x, capH = state.pid ? 60 : 0;
    var sizes = [64, 58, 52, 47, 43, 40], pick = null;
    for (var i = 0; i < sizes.length; i++) {
      var s = sizes[i], lh = Math.round(s * 1.72);
      g.font = '500 ' + s + 'px ' + F_READ;
      var lines = wrap(g, q, maxW);
      var maxLines = Math.floor((bottom - top - 90 - capH) / lh);
      pick = { s: s, lh: lh, lines: lines, max: maxLines };
      if (lines.length <= maxLines) break;
    }
    g.font = '500 ' + pick.s + 'px ' + F_READ;
    var ls = pick.lines;
    if (ls.length > pick.max) { ls = ls.slice(0, pick.max); ls[ls.length - 1] = ellipsize(g, ls[ls.length - 1], maxW); }
    g.fillStyle = INK;
    g.textBaseline = 'alphabetic';
    /* 短引文在可用区域里略偏上居中，长引文从顶部排起 */
    var blockH = ls.length * pick.lh, room = bottom - top - 90 - capH;
    var y = top + 90 + Math.max(0, Math.round((room - blockH) * 0.4)) + pick.s;
    var y0 = y - pick.s;
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = JC[mainJury];
    if (PAIRS[chars(q)[0]]) g.fillRect(x, y0 - 54, 96, 12);   // 引文自带引号时只画一道色条
    else { g.font = '700 200px ' + F_DISP; g.fillText('「', M - 50, y0 + 46); }
    g.restore();
    g.fillStyle = INK;
    g.font = '500 ' + pick.s + 'px ' + F_READ;
    ls.forEach(function (l) { g.fillText(l, x, y); y += pick.lh; });
    /* 段落定位提示 */
    if (state.pid) {
      g.fillStyle = MUTED;
      g.font = '26px ' + F_UI;
      g.fillText('选自正文第 ' + state.pid + ' 段', x, y - pick.lh + Math.round(pick.s * 0.5) + 44);
    }
  }

  function drawWork(g, top, bottom) {
    var maxW = CW - 2 * M;
    var size = 128, lines;
    for (; size >= 72; size -= 8) {
      g.font = '700 ' + size + 'px ' + F_DISP;
      lines = wrap(g, '《' + meta.title + '》', maxW + size * 0.4);
      if (lines.length <= 2) break;
    }
    if (lines.length > 2) { lines = lines.slice(0, 2); lines[1] = ellipsize(g, lines[1], maxW); }
    g.fillStyle = INK;
    g.textBaseline = 'alphabetic';
    var y = top + size * 0.92;
    lines.forEach(function (l) { g.fillText(l, M - size * 0.42, y); y += size * 1.14; });
    g.font = '700 52px ' + F_DISP;
    g.fillText(meta.author, M, y - size * 1.14 + 96);
    y = y - size * 1.14 + 150;

    /* 获奖印章 */
    var aw = meta.awards || [], sx = M, sy = y, rot = [-0.04, 0.03, -0.018];
    g.font = '700 38px ' + F_DISP;
    aw.forEach(function (a, i) {
      var j = juryOf(a), tw = g.measureText(a).width, w = tw + 56, h = 76;
      if (sx + w > CW - M) { sx = M; sy += h + 26; }
      if (sy + h > bottom) return;
      g.save();
      g.translate(sx + w / 2, sy + h / 2);
      g.rotate(rot[i % 3]);
      if (j !== 'rod') g.globalCompositeOperation = 'multiply';
      g.fillStyle = JW[j];
      g.fillRect(-w / 2, -h / 2, w, h);
      g.strokeStyle = JC[j];
      g.lineWidth = 5;
      g.strokeRect(-w / 2 + 2.5, -h / 2 + 2.5, w - 5, h - 5);
      g.lineWidth = 2;
      g.strokeStyle = j === 'rod' ? 'rgba(30,33,64,.35)' : JC[j];
      g.strokeRect(-w / 2 + 11, -h / 2 + 11, w - 22, h - 22);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = JT[j];
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(a, 0, 3);
      g.restore();
      sx += w + 26;
    });
  }

  function drawFooter(g, top, kind) {
    g.fillStyle = INK;
    g.fillRect(M, top, CW - 2 * M, 4);
    var qs = 232, qx = CW - M - qs, qy = top + 44;
    var q = qrMake(state.url);
    if (q) {
      var n = q.getModuleCount(), pad = 3, cell = Math.floor(qs / (n + 2 * pad)), size = cell * (n + 2 * pad);
      qx = CW - M - size; qs = size;
      g.fillStyle = '#F7F7F2';
      g.fillRect(qx, qy, size, size);
      g.fillStyle = INK;
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++)
        if (q.isDark(r, c)) g.fillRect(qx + (c + pad) * cell, qy + (r + pad) * cell, cell, cell);
    }
    g.textBaseline = 'alphabetic';
    g.fillStyle = INK;
    g.textAlign = 'center';
    g.font = '26px ' + F_UI;
    g.fillText(q ? '扫码阅读全文' : 'scifi.ironieser.cc', qx + qs / 2, qy + qs + 40);
    g.textAlign = 'left';

    var maxW = qx - M - 40, y = top + 96;
    if (kind !== 'quote') {
      g.font = '700 46px ' + F_DISP;
      g.fillText('2026 海豹杯', M, y + 4);
      g.fillText('科幻文学大赛获奖作品', M, y + 66);
      g.fillStyle = MUTED;
      g.font = '24px ' + F_UI;
      g.fillText('scifi.ironieser.cc', M, y + 184);
      return;
    }
    g.font = '700 52px ' + F_DISP;
    var t = '《' + meta.title + '》';
    if (g.measureText(t).width > maxW) t = ellipsize(g, t, maxW);
    g.fillText(t, M - 22, y);
    g.font = '700 36px ' + F_DISP;
    g.fillText(meta.author, M, y + 58);
    g.fillStyle = MUTED;
    g.font = '28px ' + F_UI;
    g.fillText('2026 海豹杯科幻文学大赛', M, y + 140);
    g.font = '24px ' + F_UI;
    g.fillText('scifi.ironieser.cc', M, y + 184);
  }

  /* ---------- 对外 ---------- */
  W.HBShare = { open: open, close: close };

  var btn = D.getElementById('act-share');
  if (btn) {
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', function () { open({}); });
  }
})();
