/* =========================================================
   旅行记账 · 多人分摊
   v2：N 人分摊 / 支付方式 / 精确到分钟
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  var LS_KEY = 'travel-split-m1';
  var DB_NAME = 'travel_split';
  var DB_VER = 1;
  var STORE = 'kv';
  var EXPORT_KEY = 'travel-split-last-export';

  var CATS = [
    { id: 'transport', name: '交通', icon: '✈️', color: '#3b82f6' },
    { id: 'stay',      name: '住宿', icon: '🏨', color: '#8b5cf6' },
    { id: 'food',      name: '餐饮', icon: '🍜', color: '#f59e0b' },
    { id: 'ticket',    name: '门票娱乐', icon: '🎫', color: '#10b981' },
    { id: 'shop',      name: '购物', icon: '🛍️', color: '#ec4899' },
    { id: 'other',     name: '其他', icon: '📦', color: '#64748b' }
  ];
  var CATMAP = {};
  CATS.forEach(function (c) { CATMAP[c.id] = c; });

  var CUR = {
    CNY: { name: '人民币', symbol: '¥' }, USD: { name: '美元', symbol: '$' },
    JPY: { name: '日元', symbol: 'JP¥' }, EUR: { name: '欧元', symbol: '€' },
    GBP: { name: '英镑', symbol: '£' }, HKD: { name: '港币', symbol: 'HK$' },
    KRW: { name: '韩元', symbol: '₩' }, THB: { name: '泰铢', symbol: '฿' },
    SGD: { name: '新加坡元', symbol: 'S$' }, MYR: { name: '林吉特', symbol: 'RM' },
    TWD: { name: '新台币', symbol: 'NT$' }, AUD: { name: '澳元', symbol: 'A$' },
    VND: { name: '越南盾', symbol: '₫' }, IDR: { name: '印尼盾', symbol: 'Rp' }
  };
  var ZERO_DEC = ['JPY', 'KRW', 'VND', 'IDR'];
  var PALETTE = ['#3b6ef6', '#12b3a0', '#f59e0b', '#8b5cf6', '#ec4899', '#0ea5e9', '#ef4444', '#84cc16'];

  /* ---------------- 工具 ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  var nfCache = {};
  function nf(d) {
    if (!nfCache[d]) nfCache[d] = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    return nfCache[d];
  }
  function money(n, code) {
    code = code || state.trip.base;
    var sym = CUR[code] ? CUR[code].symbol : code + ' ';
    var d = ZERO_DEC.indexOf(code) > -1 ? 0 : 2;
    return sym + nf(d).format(Number(n) || 0);
  }
  function pct(v) { return (Number(Number(v).toFixed(1))) + '%'; }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nowTime() { var d = new Date(); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function uid(p) { return (p || 'e') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function hexA(hex, a) {
    var h = String(hex || '#64748b').replace('#', '');
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' +
      parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }
  function fmtDate(s) {
    var d = new Date(s + 'T00:00:00');
    if (isNaN(d.getTime())) return s;
    var wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + wk;
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + ($('sheet').classList.contains('open') ? ' sheet-open' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.className = 'toast' + ($('sheet').classList.contains('open') ? ' sheet-open' : '');
    }, 2000);
  }

  /* ---------------- 存储 ---------------- */
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no idb')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VER); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }
  function idbSet(key, val) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readonly');
        var q = tx.objectStore(STORE).get(key);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }
  function persist() {
    var data = JSON.parse(JSON.stringify(state));
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
    idbSet('state', data).catch(function () {});
  }
  function readLS() {
    try { var raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  /* ---------------- 数据模型 ---------------- */
  var state = null;

  /* ---------------- 支付方式图标 ----------------
     内置方式用矢量 logo（icon 以 @ 开头），自定义方式仍可填 emoji */
  var PAY_LOGO = {
    card: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect width="24" height="24" rx="7" fill="#3b6ef6"/>' +
      '<path fill="#fff" d="M5.4 6.4h13.2a2.2 2.2 0 0 1 2.2 2.2v1.1H3.2V8.6a2.2 2.2 0 0 1 2.2-2.2Z"/>' +
      '<path fill="#fff" d="M3.2 11.2h17.6v4.2a2.2 2.2 0 0 1-2.2 2.2H5.4a2.2 2.2 0 0 1-2.2-2.2v-4.2Z"/>' +
      '</svg>',

    alipay: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect width="24" height="24" rx="7" fill="#1677FF"/>' +
      '<text x="12" y="17" text-anchor="middle" font-size="13.5" font-weight="700" fill="#fff" ' +
      'font-family="-apple-system,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">支</text>' +
      '</svg>',

    fund: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect width="24" height="24" rx="7" fill="#0ea5e9"/>' +
      '<path fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" ' +
      'd="M9 9.2V6.9c0-1.2.9-2.1 2.1-2.1h1.8c1.2 0 2.1.9 2.1 2.1v2.3"/>' +
      '<rect x="3.6" y="9" width="16.8" height="10.6" rx="2.4" fill="#fff"/>' +
      '<path stroke="#0ea5e9" stroke-width="1.5" stroke-linecap="round" d="M12 10.4v8.8"/>' +
      '</svg>',

    cash: '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect width="24" height="24" rx="7" fill="#16a34a"/>' +
      '<text x="12" y="16.9" text-anchor="middle" font-size="13" font-weight="700" fill="#fff" ' +
      'font-family="-apple-system,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">¥</text>' +
      '</svg>'
  };

  /* 老数据里的 emoji 图标 → 新 logo */
  var LEGACY_ICON = { pm_card: '@card', pm_alipay: '@alipay', pm_fund: '@fund', pm_cash: '@cash' };

  function payIconHTML(icon) {
    if (icon && icon.charAt(0) === '@') return PAY_LOGO[icon.slice(1)] || PAY_LOGO.card;
    return esc(icon || '💳');
  }
  function isLogo(icon) { return !!icon && icon.charAt(0) === '@'; }

  function defaultPayMethods() {
    return [
      { id: 'pm_card', name: '信用卡', icon: '@card' },
      { id: 'pm_alipay', name: '支付宝', icon: '@alipay' },
      { id: 'pm_fund', name: '旅游基金', icon: '@fund' },
      { id: 'pm_cash', name: '现金', icon: '@cash' }
    ];
  }

  function demoState() {
    function d(i) {
      var x = new Date(); x.setDate(x.getDate() - i);
      return x.getFullYear() + '-' + p2(x.getMonth() + 1) + '-' + p2(x.getDate());
    }
    return {
      version: 2,
      trip: {
        name: '关西赏枫 5 日', destination: '大阪 · 京都 · 奈良',
        start: d(4), end: d(0), base: 'CNY',
        members: [
          { id: 'A', name: '阿星', color: PALETTE[0] },
          { id: 'B', name: '小鹿', color: PALETTE[1] }
        ],
        currencies: [{ code: 'CNY', rate: 1 }, { code: 'JPY', rate: 0.048 }],
        payMethods: defaultPayMethods()
      },
      expenses: [
        { id: 'demo1', date: d(4), time: '09:20', title: '往返机票', cat: 'transport', amount: 3860, currency: 'CNY', payer: 'A', participants: ['A', 'B'], splitMode: 'equal', payMethod: 'pm_card', note: '', createdAt: 1 },
        { id: 'demo2', date: d(4), time: '15:40', title: '京都町屋民宿 4 晚', cat: 'stay', amount: 52400, currency: 'JPY', payer: 'A', participants: ['A', 'B'], splitMode: 'equal', payMethod: 'pm_card', note: '含清洁费', createdAt: 2 },
        { id: 'demo3', date: d(3), time: '19:15', title: '和牛烧肉', cat: 'food', amount: 15800, currency: 'JPY', payer: 'B', participants: ['A', 'B'], splitMode: 'custom', shares: { A: 70, B: 30 }, payMethod: 'pm_cash', note: '小鹿多吃了两盘', createdAt: 3 },
        { id: 'demo4', date: d(2), time: '10:05', title: '环球影城门票', cat: 'ticket', amount: 17600, currency: 'JPY', payer: 'A', participants: ['A', 'B'], splitMode: 'equal', payMethod: 'pm_alipay', note: '', createdAt: 4 },
        { id: 'demo5', date: d(1), time: '16:30', title: '药妆采购', cat: 'shop', amount: 8900, currency: 'JPY', payer: 'B', participants: ['B'], splitMode: 'equal', payMethod: 'pm_alipay', note: '各买各的', createdAt: 5 },
        { id: 'demo6', date: d(0), time: '11:50', title: '机场快线', cat: 'transport', amount: 320, currency: 'CNY', payer: 'B', participants: ['A', 'B'], splitMode: 'equal', payMethod: 'pm_fund', note: '', createdAt: 6 }
      ]
    };
  }

  /* 把 v1 数据升级到 v2 */
  function migrate(s) {
    if (!s || !s.trip) return s;
    var t = s.trip;
    if (!t.members || !t.members.length) {
      t.members = [{ id: 'A', name: '我' }, { id: 'B', name: '同伴' }];
    }
    t.members.forEach(function (m, i) {
      if (!m.color) m.color = PALETTE[i % PALETTE.length];
      if (!m.id) m.id = uid('m');
    });
    if (!t.payMethods || !t.payMethods.length) t.payMethods = defaultPayMethods();
    /* 内置方式的老 emoji 图标升级为矢量 logo */
    t.payMethods.forEach(function (p) {
      if (LEGACY_ICON[p.id] && !isLogo(p.icon)) p.icon = LEGACY_ICON[p.id];
    });

    var ids = t.members.map(function (m) { return m.id; });
    s.expenses = (s.expenses || []).map(function (e) {
      var o = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      if (o.time == null) o.time = '';

      if (!o.participants || !o.participants.length) {
        var a = ids[0], b = ids[1];
        if (typeof o.ratioA === 'number' && ids.length >= 2) {
          if (o.ratioA >= 99.5) { o.participants = [a]; o.splitMode = 'equal'; }
          else if (o.ratioA <= 0.5) { o.participants = [b]; o.splitMode = 'equal'; }
          else if (Math.abs(o.ratioA - 50) < 0.5) { o.participants = [a, b]; o.splitMode = 'equal'; }
          else {
            o.participants = [a, b]; o.splitMode = 'custom';
            o.shares = {}; o.shares[a] = o.ratioA; o.shares[b] = 100 - o.ratioA;
          }
        } else {
          o.participants = ids.slice();
          o.splitMode = 'equal';
        }
      }
      if (!o.splitMode) o.splitMode = 'equal';
      if (!o.payMethod) o.payMethod = t.payMethods[0].id;
      if (ids.indexOf(o.payer) === -1) o.payer = ids[0];
      o.participants = o.participants.filter(function (id) { return ids.indexOf(id) > -1; });
      if (!o.participants.length) o.participants = ids.slice();
      delete o.ratioA; delete o.mode;
      return o;
    });
    s.version = 2;
    return s;
  }

  function normalize(s) {
    if (!s || !s.trip || !Array.isArray(s.expenses)) return null;
    return migrate(s);
  }

  /* ---------------- 计算 ---------------- */
  function members() { return state.trip.members; }
  function memberById(id) {
    for (var i = 0; i < state.trip.members.length; i++) {
      if (state.trip.members[i].id === id) return state.trip.members[i];
    }
    return { id: id, name: '?', color: '#94a3b8' };
  }
  function memberName(id) { return memberById(id).name || '?'; }
  function rateOf(code) {
    var c = state.trip.currencies.filter(function (x) { return x.code === code; })[0];
    return c && Number(c.rate) > 0 ? Number(c.rate) : 1;
  }
  function expBase(e) { return Number(e.amount) * rateOf(e.currency); }
  function days() {
    var s = state.trip.start, e = state.trip.end;
    if (!s || !e) return 1;
    var d = (new Date(e) - new Date(s)) / 86400000 + 1;
    return d > 0 ? Math.round(d) : 1;
  }
  function participantsOf(e) {
    var ids = members().map(function (m) { return m.id; });
    var p = (e.participants || []).filter(function (id) { return ids.indexOf(id) > -1; });
    return p.length ? p : ids;
  }

  /* 某人在这笔账里应承担多少（折合结算货币）
     每笔都按「分」取整，尾差补到份额最大的人，保证 Σ承担 === 该笔折合金额 */
  function bears(e) {
    var total = expBase(e);
    var parts = participantsOf(e);
    var raw = {};
    if (e.splitMode === 'custom' && e.shares) {
      var sum = 0;
      parts.forEach(function (id) { sum += Math.max(0, Number(e.shares[id]) || 0); });
      if (sum <= 0) {
        parts.forEach(function (id) { raw[id] = total / parts.length; });
      } else {
        parts.forEach(function (id) {
          raw[id] = total * (Math.max(0, Number(e.shares[id]) || 0) / sum);
        });
      }
    } else {
      parts.forEach(function (id) { raw[id] = total / parts.length; });
    }

    var out = {}, acc = 0;
    parts.forEach(function (id) {
      out[id] = Math.round(raw[id] * 100) / 100;
      acc += out[id];
    });
    var target = Math.round(total * 100) / 100;
    var diff = Math.round((target - acc) * 100) / 100;
    if (Math.abs(diff) >= 0.005) {
      var big = parts[0];
      parts.forEach(function (id) { if (raw[id] > raw[big]) big = id; });
      out[big] = Math.round((out[big] + diff) * 100) / 100;
    }
    return out;
  }

  function summarize() {
    var s = { total: 0, count: 0, paid: {}, bear: {}, byCat: {}, byCur: {}, byDate: {}, byPay: {} };
    members().forEach(function (m) { s.paid[m.id] = 0; s.bear[m.id] = 0; });
    state.expenses.forEach(function (e) {
      var b = expBase(e);
      s.total += b; s.count++;
      s.paid[e.payer] = (s.paid[e.payer] || 0) + b;
      var bs = bears(e);
      Object.keys(bs).forEach(function (id) { s.bear[id] = (s.bear[id] || 0) + bs[id]; });
      s.byCat[e.cat] = (s.byCat[e.cat] || 0) + b;
      s.byCur[e.currency] = (s.byCur[e.currency] || 0) + Number(e.amount);
      s.byDate[e.date] = (s.byDate[e.date] || 0) + b;
      var pm = e.payMethod || '__none';
      s.byPay[pm] = (s.byPay[pm] || 0) + b;
    });
    return s;
  }

  function balances() {
    var s = summarize(), out = {};
    members().forEach(function (m) {
      out[m.id] = (s.paid[m.id] || 0) - (s.bear[m.id] || 0);
    });
    return out;
  }

  /* 最少笔数转账方案（贪心：最大债主配最大欠款人） */
  function settlePlan() {
    var bal = balances();
    var list = members().map(function (m) {
      return { id: m.id, name: m.name, color: m.color, v: Math.round((bal[m.id] || 0) * 100) / 100 };
    });
    var debtors = list.filter(function (x) { return x.v < -0.005; }).sort(function (a, b) { return a.v - b.v; });
    var creditors = list.filter(function (x) { return x.v > 0.005; }).sort(function (a, b) { return b.v - a.v; });
    var plan = [], i = 0, j = 0, guard = 0;
    while (i < debtors.length && j < creditors.length && guard++ < 200) {
      var pay = Math.min(-debtors[i].v, creditors[j].v);
      pay = Math.round(pay * 100) / 100;
      if (pay > 0.004) {
        plan.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
      }
      debtors[i].v = Math.round((debtors[i].v + pay) * 100) / 100;
      creditors[j].v = Math.round((creditors[j].v - pay) * 100) / 100;
      if (Math.abs(debtors[i].v) < 0.01) i++;
      if (Math.abs(creditors[j].v) < 0.01) j++;
    }
    return plan;
  }

  function splitText(e) {
    var parts = participantsOf(e);
    if (parts.length === 1) return memberName(parts[0]) + ' 全担';
    if (e.splitMode === 'custom') return '自定义 · ' + parts.length + '人';
    /* 全员平摊是默认口径，列表里不重复标注，省出空间给支付方式 */
    if (parts.length === members().length) return '';
    return '平摊 · ' + parts.length + '人';
  }
  function payMethodName(id) {
    var p = (state.trip.payMethods || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '';
  }
  function payMethodIcon(id) {
    var p = (state.trip.payMethods || []).filter(function (x) { return x.id === id; })[0];
    return p ? payIconHTML(p.icon) : '💳';
  }

  /* ---------------- 视图 ---------------- */
  var currentView = 'list';
  var filterCat = 'all';

  function renderTop() {
    $('tripName').textContent = state.trip.name || '未命名行程';
    var bits = [];
    if (state.trip.destination) bits.push(state.trip.destination);
    if (state.trip.start) bits.push(state.trip.start + ' → ' + (state.trip.end || '?'));
    bits.push(members().length + ' 人');
    $('tripSub').textContent = bits.join(' · ');
  }

  function renderList() {
    var s = summarize();
    var avg = members().length ? s.total / members().length : 0;
    $('heroCur').textContent = state.trip.base;
    $('heroTotal').textContent = money(s.total);
    $('heroMeta').textContent = '人均 ' + money(avg) + ' · ' + s.count + ' 笔 · ' + days() + ' 天';

    var hs = $('heroSettle'), plan = settlePlan();
    if (!s.count) {
      hs.className = 'hero-settle ok';
      hs.innerHTML = '<span>还没有支出，点右下角 ＋ 记第一笔</span>';
    } else if (!plan.length) {
      hs.className = 'hero-settle ok';
      hs.innerHTML = '<span>🎉 账目已平，无需转账</span>';
    } else if (plan.length === 1) {
      hs.className = 'hero-settle';
      hs.innerHTML = '<span>' + esc(memberName(plan[0].from)) + ' <span class="arrow">→</span> ' +
        esc(memberName(plan[0].to)) + '</span><b>' + money(plan[0].amount) + '</b>';
    } else {
      hs.className = 'hero-settle';
      hs.innerHTML = '<span>共 ' + plan.length + ' 笔转账</span><b>查看方案 ›</b>';
    }

    var fh = '<button class="fchip' + (filterCat === 'all' ? ' on' : '') + '" data-f="all">全部</button>';
    CATS.forEach(function (c) {
      fh += '<button class="fchip' + (filterCat === c.id ? ' on' : '') + '" data-f="' + c.id + '">' + c.icon + ' ' + c.name + '</button>';
    });
    $('filters').innerHTML = fh;
    Array.prototype.forEach.call($('filters').querySelectorAll('[data-f]'), function (b) {
      b.addEventListener('click', function () { filterCat = this.getAttribute('data-f'); renderList(); });
    });

    var list = state.expenses.filter(function (e) {
      return filterCat === 'all' || e.cat === filterCat;
    });

    if (!list.length) {
      $('listBody').innerHTML = '<div class="empty"><div class="ico">🧳</div><p>' +
        (state.expenses.length ? '这个分类还没有记录' : '还没有记账，从第一笔开始') +
        '</p><button class="empty-btn" id="emptyAdd">＋ 记一笔</button></div>';
      var eb = $('emptyAdd');
      if (eb) eb.addEventListener('click', function () { openSheet(null); });
      return;
    }

    var groups = {};
    list.forEach(function (e) { (groups[e.date] = groups[e.date] || []).push(e); });
    var dates = Object.keys(groups).sort(function (a, b) { return a < b ? 1 : -1; });

    var html = '';
    dates.forEach(function (d) {
      var arr = groups[d].sort(function (x, y) {
        var tx = x.time || '00:00', ty = y.time || '00:00';
        if (tx !== ty) return tx < ty ? 1 : -1;
        return (y.createdAt || 0) - (x.createdAt || 0);
      });
      var sub = arr.reduce(function (acc, e) { return acc + expBase(e); }, 0);
      html += '<div class="day-head"><span>' + esc(fmtDate(d)) + '</span><b>' + money(sub) + '</b></div>';
      arr.forEach(function (e) {
        var c = CATMAP[e.cat] || CATMAP.other;
        var other = e.currency !== state.trip.base;
        var m = memberById(e.payer);
        html += '<div class="item-wrap" data-wrap="' + e.id + '">' +
          '<button class="item-del" data-del="' + e.id + '">删除</button>' +
          '<div class="item" data-edit="' + e.id + '">' +
            '<div class="item-icon" style="background:' + hexA(c.color, .12) + ';color:' + c.color + '">' + c.icon + '</div>' +
            '<div class="item-body">' +
              '<div class="item-title">' + esc(e.title) + '</div>' +
              '<div class="item-sub">' +
                (e.time ? '<span class="tag time">' + esc(e.time) + '</span>' : '') +
                '<span class="tag" style="background:' + hexA(m.color, .12) + ';color:' + m.color + '">' + esc(m.name) + ' 付</span>' +
                (payMethodName(e.payMethod)
                  ? '<span class="tag pay">' + payMethodIcon(e.payMethod) + esc(payMethodName(e.payMethod)) + '</span>'
                  : '') +
                '<span class="split-txt">' + esc(splitText(e)) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="item-amt">' + money(e.amount, e.currency) +
              (other ? '<small>≈ ' + money(expBase(e)) + '</small>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
      });
    });
    $('listBody').innerHTML = html;

    Array.prototype.forEach.call($('listBody').querySelectorAll('[data-edit]'), function (el) {
      el.addEventListener('click', function () {
        if (this.parentNode.classList.contains('swiped')) { closeSwipe(this.parentNode); return; }
        openSheet(this.getAttribute('data-edit'));
      });
    });
    Array.prototype.forEach.call($('listBody').querySelectorAll('[data-del]'), function (el) {
      el.addEventListener('click', function () {
        var id = this.getAttribute('data-del');
        var e = state.expenses.filter(function (x) { return x.id === id; })[0];
        if (!e) return;
        if (!window.confirm('删除「' + e.title + '」？')) return;
        state.expenses = state.expenses.filter(function (x) { return x.id !== id; });
        persist(); renderAll(); toast('已删除');
      });
    });
    bindSwipe($('listBody'));
  }

  /* 左滑删除 */
  var swipedEl = null;
  function closeSwipe(wrap) {
    if (!wrap) return;
    wrap.classList.remove('swiped');
    var it = wrap.querySelector('.item');
    if (it) it.style.transform = '';
    if (swipedEl === wrap) swipedEl = null;
  }
  function bindSwipe(container) {
    var sx = 0, sy = 0, wrap = null, dx = 0, active = false, locked = false;
    container.addEventListener('touchstart', function (ev) {
      var w = ev.target.closest ? ev.target.closest('.item-wrap') : null;
      if (!w) return;
      if (swipedEl && swipedEl !== w) closeSwipe(swipedEl);
      wrap = w; sx = ev.touches[0].clientX; sy = ev.touches[0].clientY;
      dx = 0; active = true; locked = false;
    }, { passive: true });
    container.addEventListener('touchmove', function (ev) {
      if (!active || !wrap) return;
      var mx = ev.touches[0].clientX - sx, my = ev.touches[0].clientY - sy;
      if (!locked) {
        if (Math.abs(my) > Math.abs(mx)) { active = false; return; }
        if (Math.abs(mx) < 6) return;
        locked = true;
      }
      dx = Math.max(-92, Math.min(0, mx - (wrap.classList.contains('swiped') ? 88 : 0)));
      var it = wrap.querySelector('.item');
      if (it) { it.style.transition = 'none'; it.style.transform = 'translateX(' + dx + 'px)'; }
    }, { passive: true });
    container.addEventListener('touchend', function () {
      if (!active || !wrap) { active = false; return; }
      active = false;
      var it = wrap.querySelector('.item');
      if (!it) return;
      it.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
      if (dx < -44) { it.style.transform = 'translateX(-88px)'; wrap.classList.add('swiped'); swipedEl = wrap; }
      else { it.style.transform = ''; wrap.classList.remove('swiped'); if (swipedEl === wrap) swipedEl = null; }
    });
  }

  function renderStats() {
    var s = summarize();
    $('statSub').textContent = s.count ? ('共 ' + money(s.total)) : '';

    var rows = CATS.map(function (c) { return { c: c, v: s.byCat[c.id] || 0 }; })
      .filter(function (x) { return x.v > 0; })
      .sort(function (a, b) { return b.v - a.v; });

    if (!rows.length) {
      $('catBars').innerHTML = '<div style="color:#a2adbd;font-size:13px">暂无数据</div>';
    } else {
      var max = rows[0].v;
      $('catBars').innerHTML = rows.map(function (r) {
        var share = s.total > 0 ? r.v / s.total * 100 : 0;
        return '<div class="bar-row">' +
          '<div class="bar-top"><span>' + r.c.icon + ' ' + r.c.name + '</span>' +
          '<b>' + money(r.v) + '<em>' + pct(share) + '</em></b></div>' +
          '<div class="bar-track"><i style="width:' + Math.max(3, r.v / max * 100) + '%;background:' + r.c.color + '"></i></div>' +
          '</div>';
      }).join('');
    }

    var dk = Object.keys(s.byDate).sort();
    if (dk.length > 14) dk = dk.slice(-14);
    if (!dk.length) {
      $('dayChart').innerHTML = '<div style="color:#a2adbd;font-size:13px;margin:auto">暂无数据</div>';
    } else {
      var dmax = Math.max.apply(null, dk.map(function (k) { return s.byDate[k]; }));
      $('dayChart').innerHTML = dk.map(function (k) {
        var h = Math.max(4, s.byDate[k] / dmax * 88);
        return '<div class="dc-col" title="' + k + ' ' + money(s.byDate[k]) + '">' +
          '<div class="dc-bar" style="height:' + h + 'px"></div>' +
          '<div class="dc-lab">' + k.slice(5).replace('-', '/') + '</div></div>';
      }).join('');
    }

    // 已付 / 应担
    var maxv = 1;
    members().forEach(function (m) {
      maxv = Math.max(maxv, s.paid[m.id] || 0, s.bear[m.id] || 0);
    });
    $('cmpBox').innerHTML = members().map(function (m) {
      var paid = s.paid[m.id] || 0, bear = s.bear[m.id] || 0;
      return '<div style="margin-bottom:14px">' +
        '<div class="cmp-row"><span class="nm" style="color:' + m.color + '">' + esc(m.name) + '</span>' +
        '<div class="cmp-bar"><i style="width:' + (paid / maxv * 100) + '%;background:' + m.color + '"></i></div>' +
        '<span class="vv" style="color:' + m.color + '">' + money(paid) + '</span></div>' +
        '<div class="cmp-row"><span class="nm" style="color:#a2adbd;font-weight:600">应担</span>' +
        '<div class="cmp-bar"><i style="width:' + (bear / maxv * 100) + '%;background:' + hexA(m.color, .35) + '"></i></div>' +
        '<span class="vv" style="color:#8b97a8">' + money(bear) + '</span></div>' +
        '</div>';
    }).join('');

    // 支付方式
    var pays = Object.keys(s.byPay).filter(function (k) { return s.byPay[k] > 0; })
      .sort(function (a, b) { return s.byPay[b] - s.byPay[a]; });
    if (!pays.length) {
      $('payStats').innerHTML = '<div style="color:#a2adbd;font-size:13px">暂无数据</div>';
    } else {
      var pmax = s.byPay[pays[0]];
      $('payStats').innerHTML = pays.map(function (k) {
        var name = k === '__none' ? '未指定' : (payMethodName(k) || '已删除');
        var icon = k === '__none' ? '❔' : payMethodIcon(k);
        var share = s.total > 0 ? s.byPay[k] / s.total * 100 : 0;
        return '<div class="bar-row">' +
          '<div class="bar-top"><span>' + icon + ' ' + esc(name) + '</span>' +
          '<b>' + money(s.byPay[k]) + '<em>' + pct(share) + '</em></b></div>' +
          '<div class="bar-track"><i style="width:' + Math.max(3, s.byPay[k] / pmax * 100) + '%;background:#3b6ef6"></i></div>' +
          '</div>';
      }).join('');
    }

    var ck = Object.keys(s.byCur).sort(function (a, b) { return s.byCur[b] - s.byCur[a]; });
    $('curPills').innerHTML = ck.length ? ck.map(function (k) {
      return '<div class="cur-pill">' + esc(k) + '<b>' + money(s.byCur[k], k) + '</b></div>';
    }).join('') : '<div style="color:#a2adbd;font-size:13px">暂无数据</div>';
  }

  function renderSettle() {
    var s = summarize(), plan = settlePlan();
    var box = $('settleBig');

    if (!s.count) {
      box.innerHTML = '<div class="lbl">本次结算</div><div class="settle-amt ok">还没有记录</div>' +
        '<div class="settle-hint">记下支出后，这里会自动算出谁该给谁多少钱</div>';
    } else if (!plan.length) {
      box.innerHTML = '<div class="lbl">本次结算</div><div class="settle-amt ok">🎉 账目已平</div>' +
        '<div class="settle-hint">每个人已付与应担完全一致，不用转账</div>';
    } else if (plan.length === 1) {
      box.innerHTML = '<div class="lbl">本次结算</div>' +
        '<div class="settle-flow">' + esc(memberName(plan[0].from)) + ' 应付 ' + esc(memberName(plan[0].to)) + '</div>' +
        '<div class="settle-amt">' + money(plan[0].amount) + '</div>' +
        '<div class="settle-hint">转这一笔，账目两清</div>';
    } else {
      var totalMove = plan.reduce(function (a, p) { return a + p.amount; }, 0);
      box.innerHTML = '<div class="lbl">本次结算</div>' +
        '<div class="settle-flow">共 ' + plan.length + ' 笔转账</div>' +
        '<div class="settle-amt">' + money(totalMove) + '</div>' +
        '<div class="settle-hint">按下方方案转完，所有人账目两清</div>';
    }

    $('memberCards').innerHTML = members().map(function (m) {
      var paid = s.paid[m.id] || 0, bear = s.bear[m.id] || 0, bal = paid - bear;
      var isPos = bal > 0.005, isNeg = bal < -0.005;
      return '<div class="mcard">' +
        '<div class="n"><i style="background:' + m.color + '">' + esc((m.name || '?').slice(0, 1)) + '</i>' + esc(m.name) + '</div>' +
        '<div class="r"><span>已付</span><b>' + money(paid) + '</b></div>' +
        '<div class="r"><span>应担</span><b>' + money(bear) + '</b></div>' +
        '<div class="r net"><span>' + (isPos ? '应收' : isNeg ? '应付' : '结余') + '</span>' +
        '<b class="' + (isPos ? 'pos' : isNeg ? 'neg' : '') + '">' +
        (isPos ? '+' : isNeg ? '−' : '') + money(Math.abs(bal)) + '</b></div>' +
        '</div>';
    }).join('');

    $('transferList').innerHTML = plan.length ? plan.map(function (p) {
      var f = memberById(p.from), t = memberById(p.to);
      return '<div class="transfer">' +
        '<div class="tf"><i style="width:8px;height:8px;border-radius:50%;background:' + f.color + ';display:inline-block"></i>' +
        '<span>' + esc(f.name) + '</span></div>' +
        '<span class="ar">→</span>' +
        '<div class="tf"><i style="width:8px;height:8px;border-radius:50%;background:' + t.color + ';display:inline-block"></i>' +
        '<span>' + esc(t.name) + '</span></div>' +
        '<span class="ta">' + money(p.amount) + '</span>' +
        '</div>';
    }).join('') : '<div style="color:#a2adbd;font-size:13px;padding:14px 0">无需转账</div>';
  }

  /* ---------------- 设置 ---------------- */
  function renderSettings() {
    $('sName').value = state.trip.name || '';
    $('sDest').value = state.trip.destination || '';
    $('sStart').value = state.trip.start || '';
    $('sEnd').value = state.trip.end || '';
    $('sBase').innerHTML = Object.keys(CUR).map(function (k) {
      return '<option value="' + k + '"' + (k === state.trip.base ? ' selected' : '') + '>' + k + ' · ' + CUR[k].name + '</option>';
    }).join('');

    $('memberCount').textContent = members().length + ' 人';
    $('memberRows').innerHTML = members().map(function (m) {
      return '<div class="member-row" data-id="' + m.id + '" data-color="' + m.color + '">' +
        '<span class="av" style="background:' + m.color + '">' + esc((m.name || '?').slice(0, 1)) + '</span>' +
        '<input type="text" value="' + esc(m.name) + '" maxlength="10" placeholder="成员名">' +
        '<button class="x" data-delmember="' + m.id + '">✕</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call($('memberRows').querySelectorAll('[data-delmember]'), function (b) {
      b.addEventListener('click', function () { removeMember(this.getAttribute('data-delmember')); });
    });

    $('payRows').innerHTML = (state.trip.payMethods || []).map(function (p) {
      var logo = isLogo(p.icon);
      return '<div class="pay-row" data-id="' + p.id + '" data-icon="' + esc(p.icon || '💳') + '">' +
        '<span class="pi' + (logo ? ' logo' : '') + '">' + payIconHTML(p.icon) + '</span>' +
        '<input type="text" value="' + esc(p.name) + '" maxlength="12" placeholder="支付方式">' +
        '<button class="x" data-delpay="' + p.id + '">✕</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call($('payRows').querySelectorAll('[data-delpay]'), function (b) {
      b.addEventListener('click', function () { removePayMethod(this.getAttribute('data-delpay')); });
    });

    renderCurRows();

    var last = '';
    try { last = localStorage.getItem(EXPORT_KEY) || ''; } catch (e) {}
    $('storageTip').innerHTML = '共 ' + state.expenses.length + ' 笔记录 · 数据保存在本机<br>' +
      '上次导出：' + (last ? esc(last) : '<span style="color:#e5484d">还没导出过，建议备份一次</span>');
  }

  function renderCurRows() {
    var t = state.trip;
    $('curRows').innerHTML = t.currencies.map(function (c, i) {
      var isBase = c.code === t.base;
      return '<div class="cur-row' + (isBase ? ' base' : '') + '">' +
        '<select data-c="' + i + '">' + Object.keys(CUR).map(function (k) {
          return '<option value="' + k + '"' + (k === c.code ? ' selected' : '') + '>' + k + ' ' + CUR[k].name + '</option>';
        }).join('') + '</select>' +
        '<input type="number" step="0.0001" min="0" data-r="' + i + '" value="' + c.rate + '"' +
          (isBase ? ' disabled' : ' placeholder="汇率"') + '>' +
        '<button class="x" data-x="' + i + '"' + (isBase ? ' disabled style="opacity:.25"' : '') + '>✕</button>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call($('curRows').querySelectorAll('[data-x]'), function (b) {
      b.addEventListener('click', function () {
        var i = Number(this.getAttribute('data-x'));
        var code = state.trip.currencies[i].code;
        if (state.expenses.some(function (e) { return e.currency === code; })) {
          toast('「' + code + '」已有记录，不能移除'); return;
        }
        state.trip.currencies.splice(i, 1);
        renderCurRows();
      });
    });
  }

  function removeMember(id) {
    if (members().length <= 1) { toast('至少保留一位成员'); return; }
    var used = state.expenses.some(function (e) {
      return e.payer === id || (e.participants || []).indexOf(id) > -1;
    });
    if (used) { toast('「' + memberName(id) + '」已有记账记录，不能删除'); return; }
    if (!window.confirm('删除成员「' + memberName(id) + '」？')) return;
    state.trip.members = members().filter(function (m) { return m.id !== id; });
    persist();
    renderSettings();
    renderAll(true);
  }

  function removePayMethod(id) {
    if ((state.trip.payMethods || []).length <= 1) { toast('至少保留一种支付方式'); return; }
    var used = state.expenses.some(function (e) { return e.payMethod === id; });
    if (used) { toast('「' + payMethodName(id) + '」已有记录，不能删除'); return; }
    if (!window.confirm('删除支付方式「' + payMethodName(id) + '」？')) return;
    state.trip.payMethods = state.trip.payMethods.filter(function (p) { return p.id !== id; });
    persist();
    renderSettings();
  }

  function readMembers() {
    var rows = $('memberRows').querySelectorAll('.member-row');
    var out = [];
    Array.prototype.forEach.call(rows, function (r, i) {
      out.push({
        id: r.getAttribute('data-id') || uid('m'),
        name: (r.querySelector('input').value || '').trim() || ('成员' + (i + 1)),
        color: r.getAttribute('data-color') || PALETTE[i % PALETTE.length]
      });
    });
    return out.length ? out : members();
  }

  function readPayMethods() {
    var rows = $('payRows').querySelectorAll('.pay-row');
    var out = [];
    Array.prototype.forEach.call(rows, function (r, i) {
      out.push({
        id: r.getAttribute('data-id') || uid('p'),
        name: (r.querySelector('input').value || '').trim() || ('方式' + (i + 1)),
        icon: r.getAttribute('data-icon') || '💳'
      });
    });
    return out.length ? out : (state.trip.payMethods || defaultPayMethods());
  }

  function applySettings() {
    var t = state.trip;
    t.name = $('sName').value.trim() || '未命名行程';
    t.destination = $('sDest').value.trim();
    t.start = $('sStart').value;
    t.end = $('sEnd').value;
    t.base = $('sBase').value;
    t.members = readMembers();
    t.payMethods = readPayMethods();

    var rows = $('curRows').querySelectorAll('.cur-row');
    var list = [];
    Array.prototype.forEach.call(rows, function (row) {
      var code = row.querySelector('select').value;
      var rate = code === t.base ? 1 : (parseFloat(row.querySelector('input').value) || 1);
      if (!list.some(function (x) { return x.code === code; })) list.push({ code: code, rate: rate });
    });
    if (!list.some(function (x) { return x.code === t.base; })) list.unshift({ code: t.base, rate: 1 });
    t.currencies = list;

    persist();
    renderAll(true);
  }

  function renderAll(skipSettings) {
    renderTop();
    renderList();
    renderStats();
    renderSettle();
    if (!skipSettings && currentView === 'settings') renderSettings();
  }

  /* ---------------- 记账面板 ---------------- */
  var editingId = null;
  var formCat = 'food';
  var formPayer = null;
  var formParticipants = [];
  var formMode = 'equal';
  var formShares = {};
  var formPay = null;

  function defaultDate() {
    var t = todayStr(), s = state.trip.start, e = state.trip.end;
    if (s && t < s) return s;
    if (e && t > e) return e;
    return t;
  }

  function openSheet(id) {
    editingId = id || null;
    var e = id ? state.expenses.filter(function (x) { return x.id === id; })[0] : null;

    $('shTitle').textContent = e ? '修改记录' : '记一笔';
    $('delWrap').style.display = e ? '' : 'none';

    if (e) {
      $('fAmount').value = e.amount;
      $('fTitle').value = e.title;
      $('fNote').value = e.note || '';
      $('fDate').value = e.date;
      $('fTime').value = e.time || '';
      formCat = e.cat || 'other';
      formPayer = e.payer;
      formParticipants = participantsOf(e).slice();
      formMode = e.splitMode || 'equal';
      formShares = {};
      if (e.shares) Object.keys(e.shares).forEach(function (k) { formShares[k] = Number(e.shares[k]) || 0; });
      formPay = e.payMethod || null;
    } else {
      $('fAmount').value = '';
      $('fTitle').value = '';
      $('fNote').value = '';
      $('fDate').value = defaultDate();
      $('fTime').value = nowTime();          // 自动读取手机当前时间
      formCat = 'food';
      formPayer = members()[0].id;
      formParticipants = members().map(function (m) { return m.id; });
      formMode = 'equal';
      formShares = {};
      formPay = (state.trip.payMethods && state.trip.payMethods[0]) ? state.trip.payMethods[0].id : null;
    }
    if (!formPayer) formPayer = members()[0].id;
    if (!formPay && state.trip.payMethods && state.trip.payMethods.length) formPay = state.trip.payMethods[0].id;

    buildCurrencySelect(e ? e.currency : null);
    buildCatGrid();
    buildPayerRow();
    buildPartRow();
    buildSplitChips();
    buildPayRow();
    updateConv();

    $('sheet').classList.add('open');
    document.body.classList.add('lock');
    $('fab').classList.add('hide');
    setTimeout(function () { if (!e) $('fAmount').focus(); }, 320);
  }

  function closeSheet() {
    $('sheet').classList.remove('open');
    document.body.classList.remove('lock');
    $('fab').classList.toggle('hide', currentView !== 'list');
    editingId = null;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function buildCurrencySelect(prefer) {
    var sel = $('fCurrency');
    sel.innerHTML = state.trip.currencies.map(function (c) {
      return '<option value="' + c.code + '">' + c.code + '</option>';
    }).join('');
    var code = prefer || sel.value;
    var has = state.trip.currencies.some(function (c) { return c.code === code; });
    sel.value = has ? code : state.trip.base;
  }

  function buildCatGrid() {
    $('catGrid').innerHTML = CATS.map(function (c) {
      return '<button class="cat-cell' + (formCat === c.id ? ' on' : '') + '" data-cat="' + c.id + '">' +
        '<span class="ci">' + c.icon + '</span><span class="cn">' + c.name + '</span></button>';
    }).join('');
    Array.prototype.forEach.call($('catGrid').querySelectorAll('[data-cat]'), function (b) {
      b.addEventListener('click', function () { formCat = this.getAttribute('data-cat'); buildCatGrid(); });
    });
  }

  function buildPayerRow() {
    $('payerRow').innerHTML = members().map(function (m) {
      return '<button class="person' + (formPayer === m.id ? ' on' : '') + '" data-payer="' + m.id + '">' +
        '<span class="av" style="background:' + m.color + '">' + esc((m.name || '?').slice(0, 1)) + '</span>' +
        esc(m.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call($('payerRow').querySelectorAll('[data-payer]'), function (b) {
      b.addEventListener('click', function () {
        formPayer = this.getAttribute('data-payer');
        buildPayerRow();
      });
    });
  }

  function buildPartRow() {
    $('partRow').innerHTML = members().map(function (m) {
      var on = formParticipants.indexOf(m.id) > -1;
      return '<button class="person' + (on ? ' on' : '') + '" data-part="' + m.id + '">' +
        '<span class="av" style="background:' + m.color + '">' + esc((m.name || '?').slice(0, 1)) + '</span>' +
        esc(m.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call($('partRow').querySelectorAll('[data-part]'), function (b) {
      b.addEventListener('click', function () {
        var id = this.getAttribute('data-part');
        var i = formParticipants.indexOf(id);
        if (i > -1) {
          if (formParticipants.length === 1) { toast('至少要留一个人分摊'); return; }
          formParticipants.splice(i, 1);
        } else {
          formParticipants.push(id);
        }
        // 保持成员顺序
        var order = members().map(function (m) { return m.id; });
        formParticipants.sort(function (a, b2) { return order.indexOf(a) - order.indexOf(b2); });
        buildPartRow();
        buildSplitChips();
        updateConv();
      });
    });
    var hint = $('partHint');
    if (formParticipants.length === 1) hint.textContent = '· 只选一人 = 此人全担';
    else hint.textContent = '· 共 ' + formParticipants.length + ' 人';
  }

  function buildSplitChips() {
    var opts = [{ k: 'equal', t: '⚖️ 平摊' }, { k: 'custom', t: '✎ 自定义比例' }];
    $('splitChips').innerHTML = opts.map(function (o) {
      return '<button class="chip' + (formMode === o.k ? ' on' : '') + '" data-m="' + o.k + '">' + o.t + '</button>';
    }).join('');
    Array.prototype.forEach.call($('splitChips').querySelectorAll('[data-m]'), function (b) {
      b.addEventListener('click', function () {
        formMode = this.getAttribute('data-m');
        if (formMode === 'custom') initShares();
        buildSplitChips();
        renderCustomBox();
      });
    });
    renderCustomBox();
  }

  function initShares() {
    var n = formParticipants.length || 1;
    var each = Math.round(100 / n * 10) / 10;
    formShares = {};
    formParticipants.forEach(function (id, i) {
      formShares[id] = (i === formParticipants.length - 1)
        ? Math.round((100 - each * (n - 1)) * 10) / 10
        : each;
    });
  }

  function currentAmountBase() {
    var raw = $('fAmount').value;
    var amt = parseFloat(String(raw).replace(/[^\d.]/g, '')) || 0;
    return amt * rateOf($('fCurrency').value);
  }

  function renderCustomBox() {
    var box = $('customBox');
    if (formMode !== 'custom') { box.innerHTML = ''; return; }
    var total = 0;
    formParticipants.forEach(function (id) { total += Math.max(0, Number(formShares[id]) || 0); });
    var base = currentAmountBase();
    box.innerHTML = '<div style="margin-top:10px">' + formParticipants.map(function (id) {
      var m = memberById(id);
      var v = Number(formShares[id]) || 0;
      var amt = total > 0 ? base * v / total : 0;
      return '<div class="custom-row">' +
        '<span class="cn"><i style="background:' + m.color + '"></i>' + esc(m.name) + '</span>' +
        '<input type="number" min="0" max="100" step="5" value="' + v + '" data-share="' + id + '">' +
        '<span class="camt" data-camt="' + id + '">' + money(amt) + '</span>' +
        '</div>';
    }).join('') + '</div>' +
    '<div class="split-note" id="shareNote">' + shareNoteText(total) + '</div>';

    Array.prototype.forEach.call(box.querySelectorAll('[data-share]'), function (inp) {
      inp.addEventListener('input', function () {
        var id = this.getAttribute('data-share');
        formShares[id] = parseFloat(this.value) || 0;
        refreshShareAmounts();
      });
    });
  }

  function shareNoteText(total) {
    if (Math.abs(total - 100) < 0.5) return '合计 <b>100%</b>';
    if (total <= 0) return '请为至少一个人设置比例';
    return '合计 <b>' + pct(total) + '</b>，保存时按比例自动折算';
  }

  function refreshShareAmounts() {
    var total = 0;
    formParticipants.forEach(function (id) { total += Math.max(0, Number(formShares[id]) || 0); });
    var base = currentAmountBase();
    formParticipants.forEach(function (id) {
      var el = document.querySelector('[data-camt="' + id + '"]');
      if (!el) return;
      var v = Math.max(0, Number(formShares[id]) || 0);
      el.textContent = money(total > 0 ? base * v / total : 0);
    });
    var note = $('shareNote');
    if (note) note.innerHTML = shareNoteText(total);
  }

  function buildPayRow() {
    var list = state.trip.payMethods || [];
    $('payRow').innerHTML = list.map(function (p) {
      var logo = isLogo(p.icon);
      return '<button class="person' + (formPay === p.id ? ' on' : '') + '" data-pay="' + p.id + '">' +
        '<span class="av' + (logo ? ' logo' : '') + '"' +
          (logo ? '' : ' style="background:#f3f6fc;color:#475467;font-size:14px"') + '>' +
          payIconHTML(p.icon) + '</span>' +
        esc(p.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call($('payRow').querySelectorAll('[data-pay]'), function (b) {
      b.addEventListener('click', function () {
        formPay = this.getAttribute('data-pay');
        buildPayRow();
      });
    });
  }

  function updateConv() {
    var amt = parseFloat(String($('fAmount').value).replace(/[^\d.]/g, '')) || 0;
    var code = $('fCurrency').value;
    if (!amt) { $('convText').innerHTML = ''; }
    else if (code === state.trip.base) { $('convText').innerHTML = '结算货币'; }
    else {
      $('convText').innerHTML = '≈ <b>' + money(amt * rateOf(code)) + '</b>　（1 ' + code + ' = ' +
        rateOf(code) + ' ' + state.trip.base + '）';
    }
    if (formMode === 'custom') refreshShareAmounts();
  }

  function saveSheet() {
    var amt = parseFloat(String($('fAmount').value).replace(/[^\d.]/g, ''));
    if (!(amt > 0)) { toast('请输入金额'); $('fAmount').focus(); return; }
    var title = $('fTitle').value.trim();
    if (!title) { toast('请输入项目名称'); $('fTitle').focus(); return; }
    if (!formParticipants.length) { toast('请选择参与分摊的人'); return; }
    if (!formPayer) { toast('请选择付款人'); return; }

    var data = {
      date: $('fDate').value || todayStr(),
      time: $('fTime').value || '',
      title: title,
      cat: formCat,
      amount: Math.round(amt * 100) / 100,
      currency: $('fCurrency').value,
      payer: formPayer,
      participants: formParticipants.slice(),
      splitMode: formMode,
      payMethod: formPay,
      note: $('fNote').value.trim()
    };
    if (formMode === 'custom') {
      data.shares = {};
      formParticipants.forEach(function (id) { data.shares[id] = Number(formShares[id]) || 0; });
      var sum = 0;
      formParticipants.forEach(function (id) { sum += data.shares[id]; });
      if (sum <= 0) { toast('自定义比例不能全为 0'); return; }
    }

    if (editingId) {
      state.expenses = state.expenses.map(function (e) {
        return e.id === editingId ? Object.assign({}, e, data) : e;
      });
    } else {
      data.id = uid();
      data.createdAt = Date.now();
      state.expenses.push(data);
    }
    persist();
    closeSheet();
    renderAll();
    toast(editingId ? '已保存' : '已记账');
  }

  /* ---------------- 结算文案 ---------------- */
  function settlementText() {
    var s = summarize(), plan = settlePlan();
    var L = [];
    L.push('【' + (state.trip.name || '旅行') + '】账目结算');
    if (state.trip.start) L.push(state.trip.start + ' ~ ' + (state.trip.end || '') + '，共 ' + days() + ' 天');
    L.push('');
    L.push('总支出 ' + money(s.total) + '（' + members().length + ' 人，人均 ' + money(s.total / members().length) + '）');
    members().forEach(function (m) {
      L.push(m.name + ' 已付 ' + money(s.paid[m.id] || 0) + '，应担 ' + money(s.bear[m.id] || 0));
    });
    L.push('');
    if (!s.count) L.push('还没有记录');
    else if (!plan.length) L.push('✅ 账目已平，无需转账');
    else {
      L.push('转账方案：');
      plan.forEach(function (p) {
        L.push('· ' + memberName(p.from) + ' → ' + memberName(p.to) + ' ' + money(p.amount));
      });
    }
    return L.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制，去粘贴吧'); },
        function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  /* ---------------- Excel ---------------- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    var enc = new TextEncoder();
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var nb = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new Uint8Array(30 + nb.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true); dv.setUint16(10, dosTime, true); dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
      dv.setUint16(26, nb.length, true); dv.setUint16(28, 0, true);
      lh.set(nb, 30);
      parts.push(lh, data);

      var ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      ch.set(nb, 46);
      central.push(ch);
      offset += lh.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    var total = offset + cdSize + 22, out = new Uint8Array(total), p = 0;
    parts.forEach(function (x) { out.set(x, p); p += x.length; });
    central.forEach(function (x) { out.set(x, p); p += x.length; });
    out.set(end, p);
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[m];
    });
  }
  function colName(n) {
    var s = '';
    while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function S(v, s) { return { v: v == null ? '' : String(v), t: 's', s: s || 2 }; }
  function H(v) { return { v: v, t: 's', s: 1 }; }
  function N(v, s) { return { v: Number(v) || 0, t: 'n', s: s || 3 }; }

  function sheetXml(rows, widths, freeze) {
    var body = '';
    for (var r = 0; r < rows.length; r++) {
      body += '<row r="' + (r + 1) + '">';
      for (var c = 0; c < rows[r].length; c++) {
        var cell = rows[r][c];
        if (cell == null) continue;
        var ref = colName(c + 1) + (r + 1);
        if (cell.t === 'n') {
          body += '<c r="' + ref + '" s="' + cell.s + '"><v>' + (isFinite(cell.v) ? cell.v : 0) + '</v></c>';
        } else {
          body += '<c r="' + ref + '" t="inlineStr" s="' + cell.s + '"><is><t xml:space="preserve">' +
            xmlEsc(cell.v) + '</t></is></c>';
        }
      }
      body += '</row>';
    }
    var cols = '';
    if (widths && widths.length) {
      cols = '<cols>' + widths.map(function (w, i) {
        return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      }).join('') + '</cols>';
    }
    var pane = freeze ? '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>' : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      pane + cols + '<sheetData>' + body + '</sheetData></worksheet>';
  }

  function buildXlsx() {
    var s = summarize(), trip = state.trip, ms = members(), plan = settlePlan();
    var enc = new TextEncoder();

    /* Sheet1 明细 */
    var head = ['日期', '时间', '项目', '分类', '币种', '金额', '汇率', '折合 ' + trip.base,
      '付款人', '支付方式', '分摊方式'];
    ms.forEach(function (m) { head.push(m.name + ' 承担'); });
    head.push('备注');
    var r1 = [head.map(H)];

    state.expenses.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var ta = a.time || '00:00', tb = b.time || '00:00';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return (a.createdAt || 0) - (b.createdAt || 0);
    }).forEach(function (e) {
      var base = expBase(e), bs = bears(e);
      var row = [S(e.date), S(e.time || ''), S(e.title), S((CATMAP[e.cat] || CATMAP.other).name),
        S(e.currency), N(e.amount), N(rateOf(e.currency), 6), N(base),
        S(memberName(e.payer)), S(payMethodName(e.payMethod) || ''),
        S(e.splitMode === 'custom' ? '自定义比例' : (participantsOf(e).length === 1 ? '全担' : '平摊'))];
      ms.forEach(function (m) { row.push(N(bs[m.id] || 0)); });
      row.push(S(e.note || ''));
      r1.push(row);
    });

    var blank = [];
    for (var i = 0; i < head.length; i++) blank.push(null);
    r1.push(blank);

    var totalRow = [S('合计', 5)];
    for (var j = 1; j < head.length; j++) totalRow.push(S(''));
    totalRow[7] = N(s.total, 5);
    ms.forEach(function (m, k) { totalRow[11 + k] = N(s.bear[m.id] || 0, 5); });
    r1.push(totalRow);

    var planText = plan.length
      ? plan.map(function (p) { return memberName(p.from) + ' 付给 ' + memberName(p.to) + ' ' + money(p.amount); }).join('；')
      : '账目已平，无需转账';
    var settleRow = [S('结算', 5), S(planText, 5)];
    for (var k2 = 2; k2 < head.length; k2++) settleRow.push(S(''));
    r1.push(settleRow);

    var w1 = [12, 8, 24, 10, 8, 12, 9, 13, 10, 12, 12];
    ms.forEach(function () { w1.push(12); });
    w1.push(20);

    /* Sheet2 结算汇总 */
    var r2 = [];
    r2.push([S('行程', 4), S(trip.name || '', 4)]);
    r2.push([S('目的地'), S(trip.destination || '')]);
    r2.push([S('日期'), S((trip.start || '') + ' ~ ' + (trip.end || '') + '（' + days() + ' 天）')]);
    r2.push([S('结算货币'), S(trip.base)]);
    r2.push([S('同行人数'), N(ms.length)]);
    r2.push(blank.slice(0, 4));
    r2.push([H('指标'), H('数值')]);
    r2.push([S('总支出'), N(s.total)]);
    r2.push([S('人均'), N(ms.length ? s.total / ms.length : 0)]);
    r2.push([S('笔数'), N(s.count)]);
    r2.push([S('日均'), N(s.total / days())]);
    r2.push(blank.slice(0, 4));
    r2.push([H('成员'), H('已付'), H('应承担'), H('结余')]);
    ms.forEach(function (m) {
      r2.push([S(m.name), N(s.paid[m.id] || 0), N(s.bear[m.id] || 0),
        N((s.paid[m.id] || 0) - (s.bear[m.id] || 0))]);
    });
    r2.push(blank.slice(0, 4));
    r2.push([H('转账方案'), H('金额')]);
    if (!plan.length) r2.push([S('账目已平，无需转账'), S('')]);
    else plan.forEach(function (p) {
      r2.push([S(memberName(p.from) + ' → ' + memberName(p.to)), N(p.amount)]);
    });

    /* Sheet3 分类 + 支付方式 + 币种 */
    var r3 = [[H('分类'), H('金额(' + trip.base + ')'), H('占比')]];
    CATS.map(function (c) { return { name: c.name, v: s.byCat[c.id] || 0 }; })
      .filter(function (x) { return x.v > 0; })
      .sort(function (a, b) { return b.v - a.v; })
      .forEach(function (c) {
        r3.push([S(c.name), N(c.v), S(s.total > 0 ? pct(c.v / s.total * 100) : '0%')]);
      });
    r3.push([S('合计', 5), N(s.total, 5), S('100%', 5)]);
    r3.push(blank.slice(0, 3));
    r3.push([H('支付方式'), H('金额(' + trip.base + ')'), H('占比')]);
    Object.keys(s.byPay).sort(function (a, b) { return s.byPay[b] - s.byPay[a]; }).forEach(function (k) {
      var name = k === '__none' ? '未指定' : (payMethodName(k) || '已删除');
      r3.push([S(name), N(s.byPay[k]), S(s.total > 0 ? pct(s.byPay[k] / s.total * 100) : '0%')]);
    });
    r3.push(blank.slice(0, 3));
    r3.push([H('币种'), H('原币金额'), H('折合 ' + trip.base)]);
    Object.keys(s.byCur).sort(function (a, b) { return s.byCur[b] - s.byCur[a]; }).forEach(function (k) {
      r3.push([S(k), N(s.byCur[k]), N(s.byCur[k] * rateOf(k))]);
    });

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/>' +
      '<numFmt numFmtId="165" formatCode="0.0000"/></numFmts>' +
      '<fonts count="4">' +
      '<font><sz val="11"/><color theme="1"/><name val="等线"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/></font>' +
      '<font><b/><sz val="14"/><color rgb="FF0F172A"/><name val="等线"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF0F172A"/><name val="等线"/></font>' +
      '</fonts>' +
      '<fills count="4">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF3B6EF6"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEEF3FF"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFDCE4F0"/></left><right style="thin"><color rgb="FFDCE4F0"/></right>' +
      '<top style="thin"><color rgb="FFDCE4F0"/></top><bottom style="thin"><color rgb="FFDCE4F0"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="7">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="3" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';

    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="支出明细" sheetId="1" r:id="rId1"/>' +
      '<sheet name="结算汇总" sheetId="2" r:id="rId2"/>' +
      '<sheet name="分类统计" sheetId="3" r:id="rId3"/>' +
      '</sheets></workbook>';

    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(ct) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'xl/workbook.xml', data: enc.encode(wb) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
      { name: 'xl/styles.xml', data: enc.encode(styles) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml(r1, w1, true)) },
      { name: 'xl/worksheets/sheet2.xml', data: enc.encode(sheetXml(r2, [16, 24, 16, 16], false)) },
      { name: 'xl/worksheets/sheet3.xml', data: enc.encode(sheetXml(r3, [16, 18, 14], true)) }
    ]);
  }

  /* ---------------- 导出 / 导入 ---------------- */
  function fileStamp() {
    var d = new Date();
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes());
  }
  function safeName(s) { return String(s || '旅行账单').replace(/[\\/:*?"<>|]/g, '_'); }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1200);
    try { localStorage.setItem(EXPORT_KEY, new Date().toLocaleString('zh-CN', { hour12: false }).slice(0, 16)); } catch (e) {}
  }

  function exportXlsx() {
    if (!state.expenses.length) { toast('还没有记录可以导出'); return; }
    try {
      var blob = new Blob([buildXlsx()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      download(blob, safeName(state.trip.name) + '_' + fileStamp() + '.xlsx');
      toast('Excel 已生成，去「文件/下载」里查看');
    } catch (e) { toast('导出失败：' + e.message); }
  }

  function exportCsv() {
    if (!state.expenses.length) { toast('还没有记录可以导出'); return; }
    var head = ['日期', '时间', '项目', '分类', '币种', '金额', '汇率', '折合' + state.trip.base, '付款人', '支付方式', '分摊方式'];
    members().forEach(function (m) { head.push(m.name + '承担'); });
    head.push('备注');
    var lines = [head.join(',')];
    state.expenses.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.time || '') < (b.time || '') ? -1 : 1;
    }).forEach(function (e) {
      var base = expBase(e), bs = bears(e);
      var row = [e.date, e.time || '', e.title, (CATMAP[e.cat] || CATMAP.other).name, e.currency,
        e.amount, rateOf(e.currency), base.toFixed(2), memberName(e.payer),
        payMethodName(e.payMethod) || '', e.splitMode === 'custom' ? '自定义比例' : '平摊'];
      members().forEach(function (m) { row.push((bs[m.id] || 0).toFixed(2)); });
      row.push(e.note || '');
      lines.push(row.map(function (v) {
        v = String(v == null ? '' : v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(','));
    });
    var s = summarize(), plan = settlePlan();
    lines.push('');
    var sum = ['合计', '', '', '', '', '', '', s.total.toFixed(2), '', '', ''];
    members().forEach(function (m) { sum.push((s.bear[m.id] || 0).toFixed(2)); });
    sum.push('');
    lines.push(sum.join(','));
    lines.push(['结算', '', '', '', '', '', '', '', '', '', '', '', plan.length
      ? plan.map(function (p) { return memberName(p.from) + '→' + memberName(p.to) + ' ' + money(p.amount); }).join('；')
      : '已结清'].join(','));

    download(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }),
      safeName(state.trip.name) + '_' + fileStamp() + '.csv');
    toast('CSV 已导出');
  }

  function exportJson() {
    download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json;charset=utf-8' }),
      safeName(state.trip.name) + '_备份_' + fileStamp() + '.json');
    toast('备份已导出');
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var s = normalize(JSON.parse(reader.result));
        if (!s) throw new Error('文件格式不正确');
        if (!window.confirm('导入将覆盖当前全部数据，确定继续？')) return;
        state = s;
        persist(); renderAll(); renderSettings();
        toast('导入成功');
      } catch (err) { toast('导入失败：' + err.message); }
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ---------------- 事件 ---------------- */
  function switchView(name) {
    currentView = name;
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
      v.classList.toggle('active', v.getAttribute('data-view') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('on', t.getAttribute('data-tab') === name);
    });
    if (name === 'settings') renderSettings();
    $('fab').classList.toggle('hide', name !== 'list');
    window.scrollTo(0, 0);
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { switchView(this.getAttribute('data-tab')); });
    });
    $('btnGoSettings').addEventListener('click', function () { switchView('settings'); });
    $('fab').addEventListener('click', function () { openSheet(null); });
    $('shCancel').addEventListener('click', closeSheet);
    $('shSave').addEventListener('click', saveSheet);

    $('fAmount').addEventListener('input', updateConv);
    $('fCurrency').addEventListener('change', updateConv);
    $('fTitle').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); saveSheet(); } });

    $('btnCopy').addEventListener('click', function () { copyText(settlementText()); });
    $('heroSettle').addEventListener('click', function () { switchView('settle'); });

    $('btnXlsx').addEventListener('click', exportXlsx);
    $('btnCsv').addEventListener('click', exportCsv);
    $('btnBackup').addEventListener('click', exportJson);
    $('btnRestore').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) importJson(this.files[0]);
      this.value = '';
    });

    $('btnDelete').addEventListener('click', function () {
      if (!editingId) return;
      var e = state.expenses.filter(function (x) { return x.id === editingId; })[0];
      if (!e) return;
      if (!window.confirm('删除「' + e.title + '」？')) return;
      state.expenses = state.expenses.filter(function (x) { return x.id !== editingId; });
      persist(); closeSheet(); renderAll(); toast('已删除');
    });

    $('btnClear').addEventListener('click', function () {
      if (!state.expenses.length) { toast('已经是空的了'); return; }
      if (!window.confirm('清空全部 ' + state.expenses.length + ' 条明细？此操作不可恢复，建议先导出备份。')) return;
      state.expenses = [];
      persist(); renderAll(); renderSettings(); toast('已清空');
    });

    $('btnAddCur').addEventListener('click', function () {
      var used = state.trip.currencies.map(function (c) { return c.code; });
      var pick = Object.keys(CUR).filter(function (k) { return used.indexOf(k) === -1; })[0];
      if (!pick) { toast('常用币种都加过了'); return; }
      state.trip.currencies.push({ code: pick, rate: 1 });
      renderCurRows();
    });

    $('btnAddMember').addEventListener('click', function () {
      var n = members().length;
      state.trip.members.push({ id: uid('m'), name: '成员' + (n + 1), color: PALETTE[n % PALETTE.length] });
      persist(); renderSettings(); renderAll(true);
      var rows = $('memberRows').querySelectorAll('.member-row input');
      if (rows.length) { rows[rows.length - 1].focus(); rows[rows.length - 1].select(); }
      toast('已添加成员，改个名字吧');
    });

    $('btnAddPay').addEventListener('click', function () {
      state.trip.payMethods = state.trip.payMethods || [];
      state.trip.payMethods.push({ id: uid('p'), name: '新方式', icon: '💳' });
      persist(); renderSettings();
      var rows = $('payRows').querySelectorAll('.pay-row input');
      if (rows.length) { rows[rows.length - 1].focus(); rows[rows.length - 1].select(); }
    });

    $('sBase').addEventListener('change', function () {
      state.trip.base = this.value;
      var found = state.trip.currencies.some(function (c) { return c.code === state.trip.base; });
      if (!found) state.trip.currencies.push({ code: state.trip.base, rate: 1 });
      state.trip.currencies.forEach(function (c) { if (c.code === state.trip.base) c.rate = 1; });
      renderCurRows();
    });

    $('btnSaveSettings').addEventListener('click', function () {
      applySettings(); renderSettings(); toast('设置已保存');
    });

    var stTimer = null;
    function queueSave() {
      clearTimeout(stTimer);
      stTimer = setTimeout(function () { applySettings(); }, 700);
    }
    ['sName', 'sDest', 'sStart', 'sEnd'].forEach(function (id) {
      $(id).addEventListener('input', queueSave);
      $(id).addEventListener('change', queueSave);
    });
    $('memberRows').addEventListener('input', queueSave);
    $('payRows').addEventListener('input', queueSave);
    $('curRows').addEventListener('input', queueSave);
    $('curRows').addEventListener('change', queueSave);
  }

  /* ---------------- 启动 ---------------- */
  function start(s) {
    state = normalize(s) || demoState();
    bind();
    renderAll();
    persist();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }

  (function boot() {
    var local = readLS();
    if (local) {
      start(local);
    } else {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return; settled = true; start(demoState());
      }, 1500);
      idbGet('state').then(function (v) {
        if (settled) return; settled = true; clearTimeout(timer); start(v || demoState());
      }).catch(function () {
        if (settled) return; settled = true; clearTimeout(timer); start(demoState());
      });
    }
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
  })();

  window.__app = {
    get state() { return state; },
    buildXlsx: buildXlsx,
    summarize: summarize,
    settlePlan: settlePlan,
    switchView: switchView,
    payLogos: function () { return PAY_LOGO; }
  };
})();
