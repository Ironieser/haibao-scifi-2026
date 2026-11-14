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

  /* ---------- 偏好：主题 / 字号 / 字体 ---------- */
  var SIZE_MIN = 15, SIZE_MAX = 26, SIZE_DEF = 18;
  function prefs() {
    var p = jget('hb.prefs', {});
    if (!p || typeof p !== 'object') p = {};
    var size = parseInt(p.size, 10);
    return {
      size: size >= SIZE_MIN && size <= SIZE_MAX ? size : SIZE_DEF,
      font: p.font === 'sans' ? 'sans' : 'serif',
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'auto'
    };
  }
  function applyPrefs(p) {
    if (p.theme === 'auto') H.removeAttribute('data-theme'); else H.setAttribute('data-theme', p.theme);
    if (p.font === 'sans') H.setAttribute('data-font', 'sans'); else H.removeAttribute('data-font');
    H.style.setProperty('--read-size', p.size + 'px');
    $$('[data-pref]').forEach(function (b) {
      var k = b.getAttribute('data-pref'), v = b.getAttribute('data-val');
      b.setAttribute('aria-pressed', String(String(p[k]) === v));
    });
    var out = $('#size-out');
    if (out) out.textContent = p.size + 'px';
  }
  function savePrefs(p) { jset('hb.prefs', p); applyPrefs(p); }
  D.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-pref]');
    if (!b) return;
    var p = prefs();
    p[b.getAttribute('data-pref')] = b.getAttribute('data-val');
    keepPosition(function () { savePrefs(p); });
  });
  applyPrefs(prefs());

  /* 改字号/字体时保持阅读位置 */
  var keepPosition = function (fn) { fn(); };

  /* ---------- 首页 ---------- */
  function initHome() {
    var list = $('#wl');
    if (!list) return;
    var rows = $$('.wrow', list);
    var filter = 'all', sort = 'award', haveStats = false;
    var sortSel = $('#sort'), countEl = $('#wl-count'), empty = $('#wl-empty');

    function apply() {
      var shown = 0;
      rows.forEach(function (r) {
        var ok = filter === 'all' || (filter === 'both' && r.getAttribute('data-both') === '1') ||
          (filter === 'noai' && r.getAttribute('data-ai') === '0');
        r.hidden = !ok;
        if (ok) shown++;
      });
      var key = function (r) {
        if (sort === 'likes') return -(parseInt(r.getAttribute('data-likes') || '0', 10));
        if (sort === 'chars') return -parseInt(r.getAttribute('data-chars'), 10);
        return 0;
      };
      rows.slice().sort(function (a, b) {
        return (key(a) - key(b)) || (parseInt(a.getAttribute('data-order'), 10) - parseInt(b.getAttribute('data-order'), 10));
      }).forEach(function (r) { list.appendChild(r); });
      if (countEl) countEl.textContent = shown === rows.length ? '共 ' + rows.length + ' 部' : '显示 ' + shown + ' / ' + rows.length + ' 部';
      if (empty) empty.hidden = shown > 0;
    }
    $$('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        filter = b.getAttribute('data-filter');
        $$('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        apply();
      });
    });
    if (sortSel) {
      sortSel.addEventListener('change', function () { sort = sortSel.value; apply(); });
      var likeOpt = sortSel.querySelector('option[value="likes"]');
      if (likeOpt) likeOpt.disabled = true;
    }
    apply();

    api('GET', '/api/stats').then(function (data) {
      var works = data && data.works;
      if (!works) return;
      haveStats = true;
      rows.forEach(function (r) {
        var s = works[r.getAttribute('data-id')];
        if (!s) return;
        r.setAttribute('data-likes', String(s.likes || 0));
        $$('[data-stat]', r).forEach(function (n) {
          var k = n.getAttribute('data-stat');
          var v = s[k] || 0;
          $('.n', n).textContent = fmtNum(v);
          n.hidden = false;
        });
      });
      $$('.wl-head [data-stat]').forEach(function (n) { n.hidden = false; });
      if (sortSel) {
        var o = sortSel.querySelector('option[value="likes"]');
        if (o) o.disabled = false;
      }
      if (sort === 'likes') apply();
    }, function () { /* 计数保持隐藏 */ });
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
    api('GET', '/api/stats').then(function (data) {
      var s = data && data.works && data.works[id];
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

    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        var url = location.origin + location.pathname;
        var title = D.title;
        if (navigator.share) {
          navigator.share({ title: title, url: url }).catch(function () {});
          return;
        }
        copyText(url).then(function () { toast('链接已复制'); }, function () { toast('复制失败，请手动复制地址栏链接', true); });
      });
    }

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

  /* ---------- 阅读：进度条、继续阅读、设置、目录 ---------- */
  function initReading(id) {
    var text = $('#text'), bar = $('#progress');
    if (!text) return;
    var key = 'hb.read.' + id;
    function geom() {
      var top = text.getBoundingClientRect().top + W.pageYOffset;
      return { top: top, h: Math.max(1, text.offsetHeight) };
    }
    function ratio() {
      var g = geom();
      var r = (W.pageYOffset + W.innerHeight - g.top) / g.h;
      return Math.max(0, Math.min(1, r));
    }
    function scrollToRatio(r) {
      var g = geom();
      W.scrollTo(0, Math.max(0, g.top + r * g.h - W.innerHeight));
    }
    keepPosition = function (fn) {
      var r = ratio(), atTop = W.pageYOffset < 50;
      fn();
      if (!atTop) scrollToRatio(r);
    };

    var initial = ratio(), saved = parseFloat(rawGet(key));
    var ticking = false, saveTimer = null;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      W.requestAnimationFrame(function () {
        ticking = false;
        var r = ratio();
        if (bar) bar.style.setProperty('--p', r.toFixed(4));
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function () {
          if (r > initial + 0.01 || r >= 0.995) rawSet(key, r.toFixed(4));
        }, 400);
      });
    }
    W.addEventListener('scroll', onScroll, { passive: true });
    W.addEventListener('resize', onScroll);
    onScroll();

    var resume = $('#resume');
    if (resume && saved > initial + 0.02 && saved < 0.98 && !location.hash && W.pageYOffset < 200) {
      $('.pct', resume).textContent = Math.round(saved * 100) + '%';
      resume.hidden = false;
      $('.go', resume).addEventListener('click', function () { resume.hidden = true; scrollToRatio(saved); });
      $('.x', resume).addEventListener('click', function () { resume.hidden = true; });
    }

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
          var cur = panel.querySelector('a.on') || panel.querySelector('button, a');
          if (cur && cur.scrollIntoView && panel.scrollHeight > panel.clientHeight && panel.querySelector('a.on')) cur.scrollIntoView({ block: 'center' });
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

    var sizeBtns = $$('[data-size]');
    sizeBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var p = prefs();
        p.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, p.size + parseInt(b.getAttribute('data-size'), 10)));
        keepPosition(function () { savePrefs(p); });
      });
    });

    /* 目录面板高亮当前章节 */
    var heads = $$('.ch', text), tocLinks = $$('#panel-toc a');
    if (heads.length && tocLinks.length && W.IntersectionObserver) {
      var map = {};
      tocLinks.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            tocLinks.forEach(function (a) { a.classList.remove('on'); });
            var a = map[en.target.id]; if (a) a.classList.add('on');
          }
        });
      }, { rootMargin: '0px 0px -70% 0px' });
      heads.forEach(function (h) { io.observe(h); });
    }
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
        var r = parseFloat(rawGet('hb.read.' + w.id));
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

  device();
  if (page === 'home') initHome();
  else if (page === 'work') initWork();
  else if (page === 'favorites') initFavorites();
})();
