/* 海豹杯 2026 — 阅读增强：划线与笔记、热门划线、段落定位（作品页），以及「我的笔记」页（/notes/）。
   原生 JS，无依赖；在 site.js 之后执行，使用 window.HB。划线与笔记只存在本机 localStorage：
     hb.marks.<作品id> = [{id, p, s, e, c, note, t, x}]
     p 段落编号（正文 <p id="p-N">），s/e 段内纯文本（textContent）字符偏移，c 颜色，t 创建时间，
     x 划线原文（供「我的笔记」页展示，那一页没有正文）。跨段选区拆成多条。
   热门划线（公开、匿名）：某段的划线集合变化时，只把该段的区间并集 [[s,e],...] 上传到 POST /api/works/<id>/hot
   （不上传笔记、原文与颜色）。待上传的段落编号存 hb.hotq.<id>（失败时下次打开再传）；
   hb.hotv.<id> 标记这部作品的已有划线已经整体同步过一次（旧版本只同步过段落级计数）。
   服务器聚合出的热门片段随 HB.hit() 一起返回，显示为虚线下划线（优先用 CSS Custom Highlight API，不改 DOM；
   不支持时退回 <mark class="hot"> 包裹），轻点 / 悬停 / 键盘聚焦显示「N 人划线」气泡。 */
(function () {
  'use strict';
  var D = document, W = window, HB = W.HB;
  if (!HB) return;
  var page = D.body.getAttribute('data-page');
  var KEY = 'hb.marks.';
  var COLORS = ['yellow', 'pink', 'blue', 'ink'];
  var COLOR_LABEL = { yellow: '黄色马克笔', pink: '粉色下划线', blue: '蓝色下划线', ink: '墨色下划线' };
  var MAX_PARAS = 30, MAX_NOTE = 2000;
  var NOTE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2.5 2.5h11v8h-6l-3 3v-3h-2z"/></svg>';

  function el(tag, cls, txt) { return HB.el(tag, cls, txt); }
  function btn(cls, txt, label) {
    var b = el('button', cls, txt);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  }
  function validMark(m) {
    return m && typeof m === 'object' && typeof m.id === 'string' && m.p >= 1 && m.s >= 0 && m.e > m.s;
  }
  function loadMarks(wid) {
    var a = HB.jget(KEY + wid, []);
    return Array.isArray(a) ? a.filter(validMark) : [];
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function fmtDate(t) {
    var d = new Date(t || 0);
    if (!t || isNaN(d)) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  if (page === 'work') initWork();
  else if (page === 'notes') initNotes();

  /* ======================================================================= 作品页 */
  function initWork() {
    var text = D.getElementById('text');
    var metaEl = D.getElementById('work-meta');
    if (!text || !metaEl) return;
    var meta;
    try { meta = JSON.parse(metaEl.textContent); } catch (e) { return; }
    var wid = meta.id;
    var marks = loadMarks(wid);
    var paras = Array.prototype.slice.call(text.querySelectorAll('p[id^="p-"], li[id^="p-"]'));
    var coarse = W.matchMedia && W.matchMedia('(pointer: coarse)').matches;

    function para(n) { return D.getElementById('p-' + n); }
    function pnum(p) { return parseInt(p.id.slice(2), 10); }
    function save() {
      marks.sort(function (a, b) { return a.p - b.p || a.s - b.s; });
      if (!HB.jset(KEY + wid, marks)) HB.toast('浏览器存储不可用，划线只在这次打开时有效', true);
    }
    function byId(id) { for (var i = 0; i < marks.length; i++) if (marks[i].id === id) return marks[i]; return null; }
    function source() { return '——《' + meta.title + '》' + meta.author; }
    function paraUrl(n) { return meta.url + '#p-' + n; }

    /* ---------- 段内纯文本偏移（跳过 data-rx 的界面元素：笔记图标、热门标记） ---------- */
    function textNodes(p) {
      var out = [];
      var tw = D.createTreeWalker(p, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          if (n.nodeType === 1) return n.hasAttribute('data-rx') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      var n;
      while ((n = tw.nextNode())) out.push(n);
      return out;
    }
    function ptext(p) { return textNodes(p).map(function (n) { return n.data; }).join(''); }
    function offsetOf(p, node, off) {
      var nodes = textNodes(p), sum = 0, i;
      if (node.nodeType === 3) {
        for (i = 0; i < nodes.length; i++) {
          if (nodes[i] === node) return sum + off;
          sum += nodes[i].length;
        }
        return sum;
      }
      var r = D.createRange();
      r.setStart(node, off);
      for (i = 0; i < nodes.length; i++) {
        if (r.comparePoint(nodes[i], 0) >= 0) break;  // 这个文本节点在边界之后
        sum += nodes[i].length;
      }
      return sum;
    }

    /* ---------- 渲染：每段先拆掉旧的 <mark>，再按偏移重新包裹 ---------- */
    function unwrapSel(p, sel) {
      Array.prototype.slice.call(p.querySelectorAll(sel)).forEach(function (m) {
        while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
        m.parentNode.removeChild(m);
      });
    }
    function unwrap(p) {
      unwrapHot(p, true);
      unwrapSel(p, 'mark.hl');
      Array.prototype.slice.call(p.querySelectorAll('.rx-note')).forEach(function (b) { b.parentNode.removeChild(b); });
      p.normalize();
    }
    /* 按段内偏移 [s, e) 建 Range（跳过 data-rx 的界面元素） */
    function rangeOf(p, s, e) {
      var nodes = textNodes(p), sum = 0, r = D.createRange(), started = false;
      for (var i = 0; i < nodes.length; i++) {
        var tn = nodes[i], ns = sum, ne = sum + tn.length;
        sum = ne;
        if (!started && s < ne) { r.setStart(tn, Math.max(0, s - ns)); started = true; }
        if (started && e <= ne) { r.setEnd(tn, e - ns); return r; }
      }
      if (!started) return null;
      var last = nodes[nodes.length - 1];
      r.setEnd(last, last.length);
      return r;
    }
    /* 把 [s, e) 范围内的文本节点逐个包进 tag 元素（make 设置属性），返回包裹元素列表 */
    function wrapRange(p, s, e, make) {
      var nodes = textNodes(p), sum = 0, out = [];
      for (var i = 0; i < nodes.length; i++) {
        var tn = nodes[i], len = tn.length, ns = sum, ne = sum + len;
        sum = ne;
        if (ne <= s || ns >= e) continue;
        var a = Math.max(s, ns) - ns, b = Math.min(e, ne) - ns;
        if (b < len) tn.splitText(b);
        var target = a > 0 ? tn.splitText(a) : tn;
        var mk = make();
        target.parentNode.insertBefore(mk, target);
        mk.appendChild(target);
        out.push(mk);
      }
      return out;
    }
    function wrap(p, m) {
      var first = wrapRange(p, m.s, m.e, function () {
        var mk = D.createElement('mark');
        mk.className = 'hl hl-' + (COLORS.indexOf(m.c) >= 0 ? m.c : 'yellow');
        mk.setAttribute('data-mid', m.id);
        return mk;
      })[0];
      if (first) {
        first.tabIndex = 0;
        first.setAttribute('role', 'button');
        first.setAttribute('aria-haspopup', 'true');
        first.setAttribute('aria-description', '划线' + (m.note ? '，有笔记' : '') + '。按 Enter 改色、编辑笔记或删除');
      }
    }
    function renderPara(n) {
      var p = para(n);
      if (!p) return;
      unwrap(p);
      marks.filter(function (m) { return m.p === n; }).sort(function (a, b) { return a.s - b.s; }).forEach(function (m) {
        wrap(p, m);
        if (m.note) {
          var nb = btn('rx-note rx-note-' + m.c, null, '查看笔记：' + m.note.slice(0, 40));
          nb.setAttribute('data-rx', '');
          nb.setAttribute('data-mid', m.id);
          nb.innerHTML = NOTE_SVG;
          p.appendChild(nb);
        }
      });
      paintHotPara(n);  // 本人划线之后再叠加热门划线（热门包裹总在最内层，不影响本人划线的元素与偏移）
    }
    function renderAll() {
      var seen = {};
      marks.forEach(function (m) { if (!seen[m.p]) { seen[m.p] = 1; renderPara(m.p); } });
    }
    /* 偏移超出段落（正文改过）的划线丢弃 */
    marks = marks.filter(function (m) { var p = para(m.p); return p && m.e <= ptext(p).length; });
    renderAll();

    /* ---------- 热门划线同步：某段的划线区间并集变化时，上传该段的新并集（只有区间，没有笔记与原文） ---------- */
    var HOT_POS_MAX = 5000, HOT_SEGS_MAX = 20, HOT_P_MAX = 5000, HOT_BODY_MAX = 6000;
    var QKEY = 'hb.hotq.' + wid, VKEY = 'hb.hotv.' + wid;
    function unionOf(n) {
      var list = marks.filter(function (m) { return m.p === n; })
        .map(function (m) { return [m.s, Math.min(m.e, HOT_POS_MAX)]; })
        .filter(function (x) { return x[0] < x[1]; })
        .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
      var out = [];
      list.forEach(function (x) {
        var last = out[out.length - 1];
        if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([x[0], x[1]]);
      });
      return out.slice(0, HOT_SEGS_MAX);
    }
    function loadQ() {
      var q = HB.jget(QKEY, []);
      return Array.isArray(q) ? q.filter(function (x) { return x === Math.floor(x) && x >= 1 && x <= HOT_P_MAX; }) : [];
    }
    var syncBusy = false, syncTimer = null, syncStop = false;
    function queueSync(ps) {
      var q = loadQ();
      ps.forEach(function (n) { if (n >= 1 && n <= HOT_P_MAX && q.indexOf(n) < 0) q.push(n); });
      HB.jset(QKEY, q);
      scheduleSync(800);
    }
    function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(flushSync, ms); }
    function flushSync() {
      if (syncStop) return;
      if (syncBusy) { scheduleSync(800); return; }
      var q = loadQ();
      if (!q.length) return;
      var items = [], sent = {}, size = 0;
      for (var i = 0; i < q.length && items.length < MAX_PARAS; i++) {
        var segs = unionOf(q[i]), js = JSON.stringify(segs);
        if (items.length && size + js.length + 16 > HOT_BODY_MAX) break;   // 请求体上限 8KB
        size += js.length + 16;
        items.push({ p: q[i], segs: segs });
        sent[q[i]] = js;
      }
      syncBusy = true;
      HB.api('POST', '/api/works/' + encodeURIComponent(wid) + '/hot', { items: items }).then(function (d) {
        syncBusy = false;
        var done = (d && Array.isArray(d.done)) ? d.done : [], failed = (d && Array.isArray(d.failed)) ? d.failed : [];
        // 已提交、且发出后没有再改动的段落出队
        var q2 = loadQ().filter(function (n) { return !(done.indexOf(n) >= 0 && JSON.stringify(unionOf(n)) === sent[n]); });
        HB.jset(QKEY, q2);
        // 还有没发过的段（超过一次的上限，或期间又有改动）就继续；只剩并发冲突失败的段时，下次打开再试
        if (q2.some(function (n) { return failed.indexOf(n) < 0; })) scheduleSync(300);
      }, function (e) {
        syncBusy = false;
        if (e.status === 400) {
          // 不应发生（区间已在本机规范化）；丢掉这一批，免得队列卡住
          HB.jset(QKEY, loadQ().filter(function (n) { return !(n in sent); }));
        } else syncStop = true;   // 429 限流 / 离线：只影响公开热门划线，下次打开作品页再同步
      });
    }
    // 迁移：已有划线（旧版本只同步过段落级计数）在第一次打开新版作品页时整体同步一次
    if (!HB.jget(VKEY, 0)) {
      var had = {};
      marks.forEach(function (m) { had[m.p] = 1; });
      var all = Object.keys(had).map(Number);
      if (all.length) {
        var q0 = loadQ();
        all.forEach(function (n) { if (q0.indexOf(n) < 0) q0.push(n); });
        HB.jset(QKEY, q0);
      }
      HB.jset(VKEY, 1);
    }
    if (loadQ().length) scheduleSync(3000);   // 晚于页面打开时的 /api/hit

    /* ---------- 增删改 ---------- */
    function addMarks(pieces, color) {
      var ids = [];
      pieces.forEach(function (pc) {
        var p = para(pc.p), s = pc.s, e = pc.e, notes = [], keep = null;
        marks = marks.filter(function (m) {
          if (m.p !== pc.p || m.s > e || m.e < s) return true;
          s = Math.min(s, m.s); e = Math.max(e, m.e);
          if (m.note) notes.push(m.note);
          if (!keep) keep = m;
          return false;
        });
        var m = { id: keep ? keep.id : newId(), p: pc.p, s: s, e: e, c: color, note: notes.join('\n\n'), t: keep ? keep.t : Date.now() };
        m.x = ptext(p).slice(s, e);
        marks.push(m);
        ids.push(m.id);
      });
      save();
      pieces.forEach(function (pc) { renderPara(pc.p); });
      queueSync(pieces.map(function (pc) { return pc.p; }));
      HB.jset('hb.hlc', color);
      return ids;
    }
    function removeMark(id) {
      var m = byId(id);
      if (!m) return;
      marks = marks.filter(function (x) { return x.id !== id; });
      save();
      renderPara(m.p);
      queueSync([m.p]);
    }
    function setColor(id, c) {
      var m = byId(id);
      if (!m) return;
      m.c = c;
      save();
      renderPara(m.p);
      HB.jset('hb.hlc', c);
    }
    function setNote(id, note) {
      var m = byId(id);
      if (!m) return;
      m.note = note;
      save();
      renderPara(m.p);
    }
    function defColor() { var c = HB.jget('hb.hlc', 'yellow'); return COLORS.indexOf(c) >= 0 ? c : 'yellow'; }

    /* ---------- 选区 → 段落片段 ---------- */
    function piecesFromRange(r) {
      var out = [];
      for (var i = 0; i < paras.length; i++) {
        var p = paras[i];
        if (!r.intersectsNode(p)) { if (out.length) break; continue; }
        var t = ptext(p);
        var s = p.contains(r.startContainer) ? offsetOf(p, r.startContainer, r.startOffset) : 0;
        var e = p.contains(r.endContainer) ? offsetOf(p, r.endContainer, r.endOffset) : t.length;
        while (s < e && /\s/.test(t.charAt(s))) s++;
        while (e > s && /\s/.test(t.charAt(e - 1))) e--;
        if (e > s) out.push({ p: pnum(p), s: s, e: e, x: t.slice(s, e) });
      }
      return out;
    }
    function quoteOf(pieces) { return pieces.map(function (pc) { return pc.x; }).join('\n'); }

    /* ---------- 复制 / 分享 ---------- */
    function copyQuote(q) {
      HB.copyText(q + '\n' + source()).then(function () { HB.toast('已复制（附出处）'); },
        function () { HB.toast('复制没有成功，请手动选择文字复制', true); });
    }
    function share(q, pid) {
      if (W.HBShare && typeof W.HBShare.open === 'function') {
        try { W.HBShare.open({ text: q, pid: pid }); return; } catch (e) { /* 退化为复制 */ }
      }
      HB.copyText('「' + q + '」\n' + source() + '\n' + paraUrl(pid)).then(function () { HB.toast('已复制引文和段落链接'); },
        function () { HB.toast('复制没有成功', true); });
    }

    /* ---------- 工具条（选区 / 已有划线） ---------- */
    var bar = el('div', 'hl-bar');
    bar.setAttribute('role', 'toolbar');
    bar.hidden = true;
    var pop = el('div', 'hl-pop');
    pop.setAttribute('role', 'dialog');
    pop.hidden = true;
    var live = el('p', 'sr');
    live.setAttribute('aria-live', 'polite');
    D.body.appendChild(live);
    var state = null;   // {mode:'new', pieces, rects} | {mode:'edit', id}
    var barBusy = 0;

    function rectsOf(list) {
      var rs = [];
      list.forEach(function (n) {
        var cr = n.getClientRects ? n.getClientRects() : [];
        for (var i = 0; i < cr.length; i++) if (cr[i].width > 0 || cr[i].height > 0) rs.push(cr[i]);
      });
      return rs;
    }
    function markEls(id) { return Array.prototype.slice.call(text.querySelectorAll('mark.hl[data-mid="' + id + '"]')); }
    function placeNear(box, rs, gapBelow) {
      if (!rs.length) return;
      var first = rs[0], last = rs[rs.length - 1];
      var vw = D.documentElement.clientWidth, vh = W.innerHeight;
      box.style.left = '0px'; box.style.top = '0px';
      var w = box.offsetWidth, h = box.offsetHeight, top;
      if (coarse || gapBelow) {
        // 手机：放在选区下方，避开系统的选择菜单（通常在选区上方）
        top = last.bottom + (gapBelow || 28);
        if (top + h > vh - 8) top = first.top - h - 12;
      } else {
        top = first.top - h - 10;
        if (top < 64) top = last.bottom + 10;
      }
      top = Math.max(8, Math.min(vh - h - 8, top));
      var ref = coarse || gapBelow ? last : first;
      var left = Math.max(8, Math.min(vw - w - 8, (ref.left + ref.right) / 2 - w / 2));
      var tr = text.getBoundingClientRect();
      box.style.left = Math.round(left - tr.left) + 'px';
      box.style.top = Math.round(top - tr.top) + 'px';
    }
    function mountAfter(box, p) {
      // 放在相关段落之后：Tab 键从选区处可以直接进入工具条
      while (p && p.parentNode && p.parentNode !== text) p = p.parentNode;  // 段落可能在区块/列表容器里
      if (p && p.parentNode === text) text.insertBefore(box, p.nextSibling);
      else text.appendChild(box);
    }
    function roving(container) {
      var items = Array.prototype.slice.call(container.querySelectorAll('button'));
      items.forEach(function (b, i) { b.tabIndex = i === 0 ? 0 : -1; });
      return items;
    }
    bar.addEventListener('keydown', function (ev) {
      var items = Array.prototype.slice.call(bar.querySelectorAll('button'));
      var i = items.indexOf(D.activeElement);
      var k = ev.key, j = -1;
      if (k === 'ArrowRight' || k === 'ArrowDown') j = (i + 1) % items.length;
      else if (k === 'ArrowLeft' || k === 'ArrowUp') j = (i - 1 + items.length) % items.length;
      else if (k === 'Home') j = 0;
      else if (k === 'End') j = items.length - 1;
      else if (k === 'Escape') { ev.preventDefault(); hideBar(true); return; }
      if (j >= 0) {
        ev.preventDefault();
        items.forEach(function (b, x) { b.tabIndex = x === j ? 0 : -1; });
        items[j].focus();
      }
    });
    // 桌面：按下工具条按钮时不清除选区；手机：选区可能被系统清除，用 barBusy 防止工具条随之消失
    bar.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
    bar.addEventListener('pointerdown', function () { barBusy = Date.now(); });

    function swatch(c, label, pressed) {
      var b = btn('hl-sw hl-sw-' + c, null, label);
      b.appendChild(el('i'));
      if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
      return b;
    }
    function sep() { var s = el('span', 'hl-sep'); s.setAttribute('aria-hidden', 'true'); return s; }

    function showNewBar(pieces, rs) {
      state = { mode: 'new', pieces: pieces };
      bar.innerHTML = '';
      bar.setAttribute('aria-label', '划线工具：已选 ' + quoteOf(pieces).length + ' 字');
      var c0 = defColor();
      var main = btn('hl-main hl-main-' + c0, '划线', '划线（' + COLOR_LABEL[c0] + '）');
      main.insertBefore(el('i'), main.firstChild);
      main.addEventListener('click', function () { doMark(c0); });
      bar.appendChild(main);
      COLORS.forEach(function (c) {
        var s = swatch(c, COLOR_LABEL[c] + '划线');
        s.addEventListener('click', function () { doMark(c); });
        bar.appendChild(s);
      });
      bar.appendChild(sep());
      var nb = btn('', '笔记', '划线并写笔记');
      nb.addEventListener('click', function () {
        var ids = doMark(defColor(), true);
        if (ids && ids.length) openEditor(ids[ids.length - 1], true);
      });
      bar.appendChild(nb);
      var cb = btn('', '复制', '复制（附出处）');
      cb.addEventListener('click', function () { copyQuote(quoteOf(pieces)); clearSel(); hideBar(); });
      bar.appendChild(cb);
      var sb = btn('', '分享');
      sb.addEventListener('click', function () { var q = quoteOf(pieces); clearSel(); hideBar(); share(q, pieces[0].p); });
      bar.appendChild(sb);
      roving(bar);
      mountAfter(bar, para(pieces[pieces.length - 1].p));
      bar.hidden = false;
      placeNear(bar, rs);
    }
    function doMark(c, quiet) {
      if (!state || state.mode !== 'new') return null;
      var pieces = state.pieces;
      if (pieces.length > MAX_PARAS) { HB.toast('一次最多划 ' + MAX_PARAS + ' 段，请分几次选择', true); return null; }
      var ids = addMarks(pieces, c);
      clearSel();
      hideBar();
      if (!quiet) { HB.toast('已划线，可在「我的笔记」里查看'); live.textContent = '已划线'; }
      return ids;
    }
    function showEditBar(id, viaKey) {
      var m = byId(id);
      if (!m) return;
      state = { mode: 'edit', id: id };
      bar.innerHTML = '';
      bar.setAttribute('aria-label', '编辑划线');
      var hn = 0;
      if (hotOn) (hotBy[m.p] || []).forEach(function (h) { if (h.s < m.e && h.e > m.s && h.n > hn) hn = h.n; });
      if (hn) {
        var hl = el('span', 'hl-hotn', hn + ' 人划线');
        bar.appendChild(hl);
        bar.appendChild(sep());
      }
      COLORS.forEach(function (c) {
        var s = swatch(c, '改为' + COLOR_LABEL[c], m.c === c);
        s.addEventListener('click', function () { setColor(id, c); showEditBar(id, true); });
        bar.appendChild(s);
      });
      bar.appendChild(sep());
      var nb = btn('', m.note ? '改笔记' : '写笔记');
      nb.addEventListener('click', function () { hideBar(); openEditor(id, false); });
      bar.appendChild(nb);
      var cb = btn('', '复制', '复制（附出处）');
      cb.addEventListener('click', function () { copyQuote(m.x || ''); hideBar(true); });
      bar.appendChild(cb);
      var sb = btn('', '分享');
      sb.addEventListener('click', function () { hideBar(); share(m.x || '', m.p); });
      bar.appendChild(sb);
      var db = btn('hl-del', '删除', '删除这条划线' + (m.note ? '和笔记' : ''));
      db.addEventListener('click', function () {
        var p = para(m.p);
        hideBar();
        removeMark(id);
        HB.toast(m.note ? '已删除划线和笔记' : '已删除划线');
        live.textContent = '已删除划线';
        if (p) { p.tabIndex = -1; p.focus({ preventScroll: true }); }
      });
      bar.appendChild(db);
      var items = roving(bar);
      var els = markEls(id);
      mountAfter(bar, para(m.p));
      bar.hidden = false;
      placeNear(bar, rectsOf(els), 12);
      els.forEach(function (x) { x.classList.add('is-active'); });
      if (viaKey !== false) items[0].focus({ preventScroll: true });
    }
    function hideBar(restoreFocus) {
      if (bar.hidden) return;
      var st = state;
      bar.hidden = true;
      state = null;
      Array.prototype.slice.call(text.querySelectorAll('mark.is-active')).forEach(function (x) { x.classList.remove('is-active'); });
      if (restoreFocus && st && st.mode === 'edit') { var f = markEls(st.id)[0]; if (f) f.focus({ preventScroll: true }); }
    }
    function clearSel() { try { var s = W.getSelection(); if (s) s.removeAllRanges(); } catch (e) {} }

    /* ---------- 笔记编辑 / 查看气泡 ---------- */
    var popFor = null;
    function popBase(m, title) {
      pop.innerHTML = '';
      pop.className = 'hl-pop hl-pop-' + m.c;
      var h = el('h3', 'hl-pop-h', title);
      h.id = 'hl-pop-h';
      pop.setAttribute('aria-labelledby', 'hl-pop-h');
      pop.appendChild(h);
      pop.appendChild(el('blockquote', null, m.x || ''));
    }
    function openEditor(id, fresh) {
      var m = byId(id);
      if (!m) return;
      popFor = id;
      popBase(m, m.note ? '编辑笔记' : '写笔记');
      var ta = el('textarea');
      ta.maxLength = MAX_NOTE;
      ta.value = m.note || '';
      ta.setAttribute('aria-label', '笔记内容');
      ta.placeholder = '写下你的想法（只保存在这台设备上）';
      pop.appendChild(ta);
      var acts = el('div', 'acts');
      var cnt = el('span', 'cnt');
      var upd = function () { cnt.textContent = ta.value.length + ' / ' + MAX_NOTE; };
      upd();
      ta.addEventListener('input', upd);
      var cancel = btn('btn btn-quiet', '取消');
      var ok = btn('btn btn-primary', '保存');
      acts.appendChild(cnt); acts.appendChild(cancel); acts.appendChild(ok);
      pop.appendChild(acts);
      var doSave = function () {
        var v = ta.value.replace(/\s+$/, '').slice(0, MAX_NOTE);
        setNote(id, v.trim() ? v : '');
        closePop(true);
        HB.toast(v.trim() ? (fresh ? '已划线并保存笔记' : '笔记已保存') : (fresh ? '已划线' : '笔记已清空'));
      };
      ok.addEventListener('click', doSave);
      cancel.addEventListener('click', function () { closePop(true); if (fresh) HB.toast('已划线'); });
      ta.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); doSave(); }
      });
      showPop(m);
      ta.focus({ preventScroll: true });
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    }
    function openBubble(id) {
      var m = byId(id);
      if (!m || !m.note) return;
      popFor = id;
      popBase(m, '笔记');
      pop.appendChild(el('p', 'note-text', m.note));
      var acts = el('div', 'acts');
      acts.appendChild(el('span', 'cnt', fmtDate(m.t)));
      var close = btn('btn btn-quiet', '关闭');
      var edit = btn('btn', '编辑');
      acts.appendChild(close); acts.appendChild(edit);
      pop.appendChild(acts);
      close.addEventListener('click', function () { closePop(true); });
      edit.addEventListener('click', function () { openEditor(id, false); });
      showPop(m);
      close.focus({ preventScroll: true });
    }
    function showPop(m) {
      mountAfter(pop, para(m.p));
      pop.hidden = false;
      var nb = text.querySelector('.rx-note[data-mid="' + m.id + '"]');
      placeNear(pop, rectsOf(markEls(m.id).concat(nb ? [nb] : [])), 12);
      // 窄屏键盘弹出时浏览器会自动滚动到输入框；这里只确保气泡在视口内
      var r = pop.getBoundingClientRect();
      if (r.bottom > W.innerHeight || r.top < 0) pop.scrollIntoView({ block: 'nearest' });
    }
    function closePop(restoreFocus) {
      if (pop.hidden) return;
      pop.hidden = true;
      var id = popFor;
      popFor = null;
      if (restoreFocus && id) {
        var f = text.querySelector('.rx-note[data-mid="' + id + '"]') || markEls(id)[0];
        if (f) f.focus({ preventScroll: true });
      }
    }
    pop.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePop(true); }
    });

    /* ---------- 事件 ---------- */
    var selTimer = null, pointerDown = false;
    function evaluateSelection() {
      var sel = W.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) {
        if (state && state.mode === 'new' && Date.now() - barBusy > 600) hideBar();
        return;
      }
      var r = sel.getRangeAt(0), ca = r.commonAncestorContainer;
      if (bar.contains(ca) || pop.contains(ca) || hp.contains(ca)) return;
      if (!text.contains(ca)) { if (state && state.mode === 'new') hideBar(); return; }
      var pieces = piecesFromRange(r);
      if (!pieces.length) { if (state && state.mode === 'new') hideBar(); return; }
      if (!pop.hidden) closePop(false);
      closeHot(false);
      showNewBar(pieces, rectsOf([r]));
      live.textContent = '已选中文字，按 Tab 打开划线工具条';
    }
    D.addEventListener('selectionchange', function () {
      clearTimeout(selTimer);
      if (pointerDown && !coarse) return;
      selTimer = setTimeout(evaluateSelection, coarse ? 350 : 120);
    });
    D.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse') pointerDown = true;
    }, true);
    D.addEventListener('pointerup', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      pointerDown = false;
      clearTimeout(selTimer);
      selTimer = setTimeout(evaluateSelection, 10);
    }, true);
    D.addEventListener('keyup', function (ev) {
      if (ev.shiftKey || ev.key === 'Shift') { clearTimeout(selTimer); selTimer = setTimeout(evaluateSelection, 150); }
    });

    text.addEventListener('click', function (ev) {
      var t = ev.target;
      var nb = t.closest && t.closest('.rx-note[data-mid]');
      if (nb) { ev.preventDefault(); hideBar(); openBubble(nb.getAttribute('data-mid')); return; }
      if (hp.contains(t)) return;
      var mk = t.closest && t.closest('mark.hl[data-mid]');
      var sel = W.getSelection();
      if (sel && !sel.isCollapsed) return;   // 正在选择文字
      if (mk) {
        closePop(false);
        closeHot(false);
        showEditBar(mk.getAttribute('data-mid'), ev.detail === 0);
        return;
      }
      var hk = t.closest && t.closest('.rx-hk');
      var h = hk ? segByKey(hk.getAttribute('data-hk')) : hotAtPoint(t, ev.clientX, ev.clientY);
      if (h) {
        if (hpSeg === h && hpMode !== 'hover') { closeHot(false); return; }
        hideBar();
        closePop(false);
        showHot(h, ev.detail === 0 ? 'key' : 'tap');
      } else if (hpMode && hpMode !== 'hover') closeHot(false);
    });
    text.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      // 热门锚点可能位于本人划线 <mark> 内部：先判断锚点
      var hk = ev.target.classList && ev.target.classList.contains('rx-hk') ? ev.target : null;
      if (hk) {
        var h = segByKey(hk.getAttribute('data-hk'));
        if (h) { ev.preventDefault(); hideBar(); showHot(h, 'key'); }
        return;
      }
      var mk = ev.target.closest && ev.target.closest('mark.hl[data-mid]');
      if (mk) { ev.preventDefault(); closeHot(false); showEditBar(mk.getAttribute('data-mid'), true); }
    });
    D.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!bar.hidden && state && state.mode === 'edit' && !bar.contains(t) && !(t.closest && t.closest('mark.hl'))) hideBar();
      if (!pop.hidden && !pop.contains(t) && !bar.contains(t) && !(t.closest && t.closest('.rx-note, mark.hl'))) closePop(false);
      if (!hp.hidden && !hp.contains(t) && !text.contains(t)) closeHot(false);
    });
    D.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !bar.hidden) { hideBar(true); if (state === null) clearSel(); }
      else if (ev.key === 'Escape' && !hp.hidden) { closeHot(hpMode === 'focus' || hpMode === 'key'); }
    });
    W.addEventListener('resize', function () { if (state && state.mode === 'new') hideBar(); closeHot(false); });

    /* ---------- 热门划线：片段级虚线下划线 + 「N 人划线」气泡；可在阅读设置里关闭 ---------- */
    var hotOn = HB.prefs().hot, hotAsked = false;
    var hotBy = {};          // 段落编号 → [{p, s, e, n, k, range, mine}]
    var hotList = [];
    var useHL = !!(W.CSS && CSS.highlights && typeof W.Highlight === 'function');
    var hlMain = null, hlOn = null;
    if (useHL) {
      try {
        hlMain = new Highlight(); hlOn = new Highlight();
        CSS.highlights.set('hb-hot', hlMain);
        CSS.highlights.set('hb-hot-on', hlOn);
      } catch (e) { useHL = false; }
    }
    var hp = el('div', 'hot-pop');
    hp.setAttribute('role', 'dialog');
    hp.setAttribute('aria-label', '热门划线');
    hp.hidden = true;
    var hpSeg = null, hpMode = null, hoverTimer = null, hideTimer = null;

    function unwrapHot(p, keepDom) {
      if (!hotBy) return;   // 初次渲染本人划线时热门数据还没准备好
      var n = pnum(p);
      (hotBy[n] || []).forEach(function (h) {
        if (h.range && hlMain) { hlMain.delete(h.range); if (hlOn) hlOn.delete(h.range); }
        h.range = null;
      });
      Array.prototype.slice.call(p.querySelectorAll('.rx-hk')).forEach(function (a) { a.parentNode.removeChild(a); });
      unwrapSel(p, 'mark.hot');
      if (!keepDom) p.normalize();
    }
    function coveredByMine(h) {
      var u = unionOf(h.p);
      for (var i = 0; i < u.length; i++) if (u[i][0] <= h.s && u[i][1] >= h.e) return true;
      return false;
    }
    function overlapsMine(h) {
      return marks.some(function (m) { return m.p === h.p && m.s < h.e && m.e > h.s; });
    }
    function hotLabel(h) { return h.n + ' 人划线'; }
    function paintHotPara(n) {
      if (!hotBy) return;
      var p = para(n), list = hotOn ? hotBy[n] : null;
      if (!p || !list || !list.length) return;
      var txt = ptext(p);
      list.forEach(function (h) {
        if (h.e > txt.length) return;   // 正文改过，偏移失效
        if (!useHL) {
          wrapRange(p, h.s, h.e, function () {
            var mk = D.createElement('mark');
            mk.className = 'hot';
            mk.setAttribute('data-hk', h.k);
            mk.setAttribute('data-n', String(h.n));
            return mk;
          });
        }
        // 键盘入口：片段开头一个不含文字的可聚焦锚点（data-rx：不计入偏移、不影响复制）
        var r0 = rangeOf(p, h.s, h.s + 1);
        if (r0) {
          var a = D.createElement('span');
          a.className = 'rx-hk';
          a.setAttribute('data-rx', '');
          a.setAttribute('data-hk', h.k);
          a.tabIndex = 0;
          a.setAttribute('role', 'button');
          a.setAttribute('aria-label', hotLabel(h) + '：' + txt.slice(h.s, Math.min(h.e, h.s + 30)) + (h.e - h.s > 30 ? '…' : '') + '。按 Enter 查看');
          r0.insertNode(a);
        }
      });
      // DOM 改完之后再建 Range（Range 会随之后的 DOM 变化自动调整，但这里一次建好最稳妥）
      list.forEach(function (h) {
        if (h.e > txt.length) return;
        h.range = rangeOf(p, h.s, h.e);
        if (h.range && hlMain) hlMain.add(h.range);
      });
    }
    function setHot(data) {
      var segs = data && Array.isArray(data.segs) ? data.segs : [];
      var old = Object.keys(hotBy).map(Number);
      closeHot(false);
      if (hlMain) hlMain.clear();
      hotBy = {}; hotList = [];
      segs.forEach(function (x, i) {
        if (!(x && x.p >= 1 && x.s >= 0 && x.e > x.s && x.n >= 1)) return;
        var h = { p: x.p, s: x.s, e: x.e, n: x.n, k: 'h' + i, range: null };
        (hotBy[h.p] = hotBy[h.p] || []).push(h);
        hotList.push(h);
      });
      repaintHot(old);
    }
    function repaintHot(extra) {
      closeHot(false);
      var seen = {};
      Object.keys(hotBy).map(Number).concat(extra || []).forEach(function (n) {
        if (seen[n]) return;
        seen[n] = 1;
        var p = para(n);
        if (!p) return;
        unwrapHot(p);
        paintHotPara(n);
      });
    }
    function segByKey(k) { for (var i = 0; i < hotList.length; i++) if (hotList[i].k === k) return hotList[i]; return null; }
    function segRects(h) {
      if (!h.range) return [];
      var cr = h.range.getClientRects(), out = [];
      for (var i = 0; i < cr.length; i++) if (cr[i].width > 0 && cr[i].height > 0) out.push(cr[i]);
      return out;
    }
    function hotAtPoint(t, x, y) {
      if (!hotOn || !hotList.length || !t || !t.closest) return null;
      var p = t.closest('p[id^="p-"], li[id^="p-"]');
      if (!p || !text.contains(p)) return null;
      var list = hotBy[pnum(p)] || [];
      for (var i = 0; i < list.length; i++) {
        var rs = segRects(list[i]);
        for (var j = 0; j < rs.length; j++) {
          var r = rs[j];
          if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 3 && y <= r.bottom + 3) return list[i];
        }
      }
      return null;
    }
    function setActive(h) {
      if (hlOn) hlOn.clear();
      Array.prototype.slice.call(text.querySelectorAll('mark.hot.is-on')).forEach(function (x) { x.classList.remove('is-on'); });
      if (!h) return;
      if (hlOn && h.range) hlOn.add(h.range);
      else Array.prototype.slice.call(text.querySelectorAll('mark.hot[data-hk="' + h.k + '"]')).forEach(function (x) { x.classList.add('is-on'); });
    }
    function anchorOf(h) { return text.querySelector('.rx-hk[data-hk="' + h.k + '"]'); }
    function showHot(h, mode) {
      clearTimeout(hideTimer); clearTimeout(hoverTimer);
      hpSeg = h; hpMode = mode;
      hp.innerHTML = '';
      var line = el('p', 'hot-n');
      line.tabIndex = -1;
      line.appendChild(el('b', null, String(h.n)));
      line.appendChild(D.createTextNode(' 人划线'));
      hp.appendChild(line);
      var join = null;
      if (h.mine || coveredByMine(h)) {
        hp.appendChild(el('p', 'hot-me', h.mine ? '你也划了这里' : '你划过这里'));
      } else {
        join = btn('btn hot-join', '我也划线');
        join.addEventListener('click', function () { joinHot(h); });
        hp.appendChild(join);
      }
      setActive(h);
      mountAfter(hp, para(h.p));
      hp.hidden = false;
      placeNear(hp, segRects(h), 10);
      if (mode === 'key') (join || hp.querySelector('.hot-n')).focus({ preventScroll: true });
    }
    function closeHot(restoreFocus) {
      clearTimeout(hideTimer); clearTimeout(hoverTimer);
      if (hp.hidden) return;
      var h = hpSeg;
      hp.hidden = true;
      hpSeg = null; hpMode = null;
      setActive(null);
      if (restoreFocus && h) { var a = anchorOf(h); if (a) a.focus({ preventScroll: true }); }
    }
    function joinHot(h) {
      var had = overlapsMine(h);
      closeHot(false);
      addMarks([{ p: h.p, s: h.s, e: h.e }], defColor());
      if (!had) h.n += 1;   // 本机先加上自己（服务器计数约 1 分钟后更新）
      h.mine = true;
      HB.toast('已划线，可在「我的笔记」里查看');
      live.textContent = '已划线';
      var a = anchorOf(h);
      if (a) {
        a.setAttribute('aria-label', hotLabel(h) + '，你也划了这里');
        a.focus({ preventScroll: true });
      }
    }
    // 热门数据：随页面打开时的 HB.hit() 一起返回；读者打开开关时若当初没取，再单独请求一次
    function askHot() {
      if (hotAsked || !hotOn) return;
      hotAsked = true;
      HB.api('GET', '/api/works/' + encodeURIComponent(wid) + '/hot').then(setHot, function () { hotAsked = false; });
    }
    if (hotOn && HB.hit) {
      hotAsked = true;
      HB.hit().then(function (d) { if (d && d.hot) setHot(d.hot); else hotAsked = false; }, function () { hotAsked = false; });
    }
    D.addEventListener('hb:prefs', function (ev) {
      var on = !!(ev.detail && ev.detail.hot);
      if (on === hotOn) return;
      hotOn = on;
      if (on && !hotList.length) askHot();
      repaintHot();
    });

    /* 气泡交互：轻点 / 悬停（有鼠标的设备）/ 键盘聚焦锚点 */
    hp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeHot(true); }
    });
    hp.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    hp.addEventListener('mouseleave', function () { if (hpMode === 'hover') hideTimer = setTimeout(function () { closeHot(false); }, 300); });
    hp.addEventListener('focusout', function (ev) {
      var to = ev.relatedTarget;
      if (to && (hp.contains(to) || (to.classList && to.classList.contains('rx-hk')))) return;
      if (hpMode === 'key' || hpMode === 'focus') closeHot(false);
    });
    text.addEventListener('focusin', function (ev) {
      var a = ev.target;
      if (!a.classList || !a.classList.contains('rx-hk')) return;
      var h = segByKey(a.getAttribute('data-hk'));
      var kb = true;
      try { kb = a.matches(':focus-visible'); } catch (e) { /* 旧浏览器：按键盘聚焦处理 */ }
      if (h && kb) { hideBar(); closePop(false); showHot(h, 'focus'); }
    });
    text.addEventListener('focusout', function (ev) {
      var a = ev.target;
      if (!a.classList || !a.classList.contains('rx-hk')) return;
      var to = ev.relatedTarget;
      if (to && hp.contains(to)) return;
      if (hpMode === 'focus') closeHot(false);
    });
    var hoverable = W.matchMedia && W.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (hoverable) {
      var mvRaf = 0, mvEv = null, hoverSeg = null;
      text.addEventListener('mousemove', function (ev) {
        mvEv = ev;
        if (mvRaf) return;
        mvRaf = W.requestAnimationFrame(function () {
          mvRaf = 0;
          var e2 = mvEv;
          if (pointerDown || hp.contains(e2.target) || bar.contains(e2.target)) return;
          var h = hotAtPoint(e2.target, e2.clientX, e2.clientY);
          text.classList.toggle('hot-hover', !!h);
          if (h === hoverSeg) return;
          hoverSeg = h;
          clearTimeout(hoverTimer);
          if (h) {
            clearTimeout(hideTimer);
            if (hpMode && hpMode !== 'hover') return;   // 轻点或键盘打开的气泡不被悬停替换
            hoverTimer = setTimeout(function () {
              var sel = W.getSelection();
              if (sel && !sel.isCollapsed) return;
              if (!bar.hidden || !pop.hidden) return;
              showHot(h, 'hover');
            }, 350);
          } else if (hpMode === 'hover') {
            hideTimer = setTimeout(function () { closeHot(false); }, 300);
          }
        });
      });
      text.addEventListener('mouseleave', function () {
        hoverSeg = null;
        clearTimeout(hoverTimer);
        text.classList.remove('hot-hover');
        if (hpMode === 'hover') hideTimer = setTimeout(function () { closeHot(false); }, 300);
      });
    }

    /* ---------- #p-N：滚动到该段并短暂高亮 ---------- */
    function flashHash() {
      var m = /^#p-(\d+)$/.exec(location.hash);
      if (!m) return;
      var p = para(m[1]);
      if (!p) return;
      p.scrollIntoView({ block: 'start' });
      p.classList.remove('rx-flash');
      void p.offsetWidth;
      p.classList.add('rx-flash');
      setTimeout(function () { p.classList.remove('rx-flash'); }, 2600);
    }
    W.addEventListener('hashchange', flashHash);
    flashHash();
    if (/^#p-\d+$/.test(location.hash)) {
      // 字体加载完成后标题高度会变：用户还没动过页面时重新对齐一次
      var moved = false;
      var mark = function () { moved = true; };
      ['wheel', 'touchmove', 'keydown', 'pointerdown'].forEach(function (t) { W.addEventListener(t, mark, { passive: true, once: true }); });
      var realign = function () { var p = para(location.hash.slice(3)); if (p && !moved) p.scrollIntoView({ block: 'start' }); };
      if (D.fonts && D.fonts.ready) D.fonts.ready.then(realign);
      if (D.readyState === 'complete') realign(); else W.addEventListener('load', realign);
    }

    // 给其他脚本（share.js）用：当前作品的划线
    W.HBReader = { marks: function () { return marks.slice(); } };
  }

  /* ======================================================================= 我的笔记 */
  function initNotes() {
    var list = D.getElementById('notes-list'), empty = D.getElementById('notes-empty');
    var barEl = D.getElementById('notes-bar'), countEl = D.getElementById('notes-count');
    var dataEl = D.getElementById('works-data');
    if (!list || !dataEl) return;
    var works;
    try { works = JSON.parse(dataEl.textContent); } catch (e) { works = []; }
    var byId = {};
    works.forEach(function (w) { byId[w.id] = w; });

    function collect() {
      var groups = [];
      works.forEach(function (w) {
        var ms = loadMarks(w.id);
        if (!ms.length) return;
        ms.sort(function (a, b) { return a.p - b.p || a.s - b.s; });
        var latest = Math.max.apply(null, ms.map(function (m) { return m.t || 0; }));
        groups.push({ w: w, marks: ms, latest: latest });
      });
      groups.sort(function (a, b) { return b.latest - a.latest || a.w.order - b.w.order; });
      return groups;
    }
    function link(wid, p) { return location.origin + '/works/' + wid + '/#p-' + p; }

    function render() {
      var groups = collect(), n = 0, nn = 0;
      list.innerHTML = '';
      groups.forEach(function (g) {
        var sec = el('section', 'nw');
        var h = el('h2');
        var a = el('a', null, '《' + g.w.title + '》');
        a.href = '/works/' + g.w.id + '/';
        h.appendChild(a);
        h.appendChild(el('span', 'nw-a', g.w.author));
        h.appendChild(el('span', 'nw-c', g.marks.length + ' 条'));
        sec.appendChild(h);
        var ol = el('ol', 'nl');
        g.marks.forEach(function (m) {
          n++;
          var li = el('li', 'ni ni-' + (COLORS.indexOf(m.c) >= 0 ? m.c : 'yellow'));
          var q = el('a', 'ni-q', m.x || '（第 ' + m.p + ' 段的划线）');
          q.href = '/works/' + g.w.id + '/#p-' + m.p;
          li.appendChild(q);
          if (m.note) {
            nn++;
            var np = el('p', 'ni-note');
            np.appendChild(el('b', null, '笔记'));
            np.appendChild(D.createTextNode(m.note));
            li.appendChild(np);
          }
          li.appendChild(el('p', 'ni-meta', '第 ' + m.p + ' 段' + (m.t ? '，' + fmtDate(m.t) : '')));
          ol.appendChild(li);
        });
        sec.appendChild(ol);
        list.appendChild(sec);
      });
      list.hidden = !n;
      barEl.hidden = !n;
      empty.hidden = !!n;
      if (countEl) countEl.textContent = n
        ? groups.length + ' 部作品，' + n + ' 条划线' + (nn ? '，其中 ' + nn + ' 条有笔记' : '') + '。只保存在这台设备的浏览器里。'
        : '划线和笔记保存在这台设备的浏览器里，不会上传。';
      return groups;
    }
    var groups = render();

    function quoteLines(s, prefix) { return s.split('\n').map(function (l) { return prefix + l; }).join('\n'); }
    function markdown() {
      var out = ['# 我的笔记｜海豹杯 2026', '', '导出于 ' + fmtDate(Date.now()) + '。', ''];
      groups.forEach(function (g) {
        out.push('## 《' + g.w.title + '》' + g.w.author, '');
        g.marks.forEach(function (m) {
          out.push(quoteLines(m.x || '', '> '), '');
          if (m.note) out.push(quoteLines(m.note, ''), '');
          out.push('[第 ' + m.p + ' 段](' + link(g.w.id, m.p) + ')' + (m.t ? '，' + fmtDate(m.t) : ''), '');
        });
      });
      return out.join('\n');
    }
    function plainText() {
      var out = [];
      groups.forEach(function (g) {
        out.push('《' + g.w.title + '》' + g.w.author);
        g.marks.forEach(function (m) {
          out.push('「' + (m.x || '') + '」');
          if (m.note) out.push('笔记：' + m.note);
          out.push(link(g.w.id, m.p), '');
        });
        out.push('');
      });
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }
    D.getElementById('notes-export').addEventListener('click', function () {
      groups = collect();
      try {
        var blob = new Blob([markdown()], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = el('a');
        var d = new Date(), pad = function (x) { return (x < 10 ? '0' : '') + x; };
        a.href = url;
        a.download = '海豹杯2026-我的笔记-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.md';
        D.body.appendChild(a);
        a.click();
        D.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        HB.toast('已导出。若没有开始下载（例如在微信里），请改用「复制全部」');
      } catch (e) {
        HB.toast('这个浏览器不支持导出文件，请改用「复制全部」', true);
      }
    });
    D.getElementById('notes-copy').addEventListener('click', function () {
      groups = collect();
      HB.copyText(plainText()).then(function () { HB.toast('已复制全部划线和笔记'); },
        function () { HB.toast('复制没有成功', true); });
    });
    // 其他标签页改了划线时同步
    W.addEventListener('storage', function (ev) { if (!ev.key || ev.key.indexOf(KEY) === 0) groups = render(); });
  }
})();
