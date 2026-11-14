/* 浏览量：把公开计数填进页面上的占位元素。浏览记录与数据都来自 site.js 的 HB.hit()（POST /api/hit，
   每次打开页面只发这一个请求；本文件不再单独请求 /api/view、/api/views）。
   占位元素：
     [data-views="total"]      全站累计浏览
     [data-views="today-pv"]   今日浏览
     [data-views="today-uv"]   今日访客
     [data-views-page="<id>"]  某页面累计浏览（作品 id、home 等）
   /stats/ 页面另有 #views-chart 与 #views-rank，由本文件渲染（近 30 天走势随 hit 一起返回）。
   API 不可用时静默失败，占位元素保持隐藏。 */
(function () {
  'use strict';
  var W = window, D = document;

  function fmt(n) { return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function fill(data) {
    var map = { total: data.total, 'today-pv': data.today && data.today.pv, 'today-uv': data.today && data.today.uv };
    D.querySelectorAll('[data-views]').forEach(function (el) {
      var v = map[el.getAttribute('data-views')];
      if (v == null) return;
      el.textContent = fmt(v);
      var box = el.closest('[data-views-box]'); if (box) box.hidden = false;
    });
    D.querySelectorAll('[data-views-page]').forEach(function (el) {
      var v = data.pages && data.pages[el.getAttribute('data-views-page')];
      if (!v) return;
      el.textContent = fmt(v);
      var box = el.closest('[data-views-box]'); if (box) box.hidden = false;
    });
    renderStats(data);
  }

  function renderStats(data) {
    var chart = D.getElementById('views-chart');
    if (chart && data.series) {
      var s = data.series, max = 1;
      s.forEach(function (d) { if (d.pv > max) max = d.pv; });
      var w = 600, h = 180, bw = w / s.length;
      var bars = s.map(function (d, i) {
        var ph = Math.round(d.pv / max * (h - 24)), uh = Math.round(d.uv / max * (h - 24));
        var x = (i * bw + 1).toFixed(1);
        return '<g><title>' + d.day + '：浏览 ' + fmt(d.pv) + '，访客 ' + fmt(d.uv) + '</title>' +
          '<rect class="v-pv" x="' + x + '" y="' + (h - ph) + '" width="' + (bw - 2).toFixed(1) + '" height="' + ph + '"/>' +
          '<rect class="v-uv" x="' + x + '" y="' + (h - uh) + '" width="' + (bw - 2).toFixed(1) + '" height="' + uh + '"/></g>';
      }).join('');
      chart.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="近 30 天浏览量与访客数">' + bars +
        '<line class="v-base" x1="0" y1="' + h + '" x2="' + w + '" y2="' + h + '"/></svg>' +
        '<p class="v-axis"><span>' + s[0].day.slice(5) + '</span><span>' + s[s.length - 1].day.slice(5) + '</span></p>';
    }
    var rank = D.getElementById('views-rank');
    if (rank && data.pages) {
      var titles = {};
      try { titles = JSON.parse((D.getElementById('works-data') || {}).textContent || '{}'); } catch (e) { titles = {}; }
      var list = Array.isArray(titles) ? titles : (titles.works || []);
      var rows = list.map(function (w) { return { id: w.id, title: w.title, author: w.author, n: data.pages[w.id] || 0 }; })
        .sort(function (a, b) { return b.n - a.n; });
      var top = rows.length ? Math.max(rows[0].n, 1) : 1;
      rank.innerHTML = rows.map(function (r) {
        return '<li><a href="/works/' + r.id + '/"><span class="r-t">《' + r.title + '》</span><span class="r-a">' + r.author +
          '</span></a><span class="r-bar" style="--w:' + (r.n / top * 100).toFixed(1) + '%"></span><b>' + fmt(r.n) + '</b></li>';
      }).join('');
    }
  }

  function start() {
    if (!W.HB || !W.HB.hit) return;
    W.HB.hit().then(function (d) {
      if (!d || !d.views) return;
      var data = { total: d.views.total, today: d.views.today, pages: d.views.pages, series: d.series };
      fill(data);
    }, function () {});
  }
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', start); else start();
})();
