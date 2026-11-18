/* ============================================================================
 * DeepSeek 本地版 · 注入层（不改官方 bundle）
 *
 *  1) 会话导航侧栏：列出当前对话里所有轮次，带「分支计数」，点击跳转
 *  2) 按轮删除：多选 / 全选，从上下文里移除指定问答轮（保留其它轮与分支）
 *  3) 侧边栏收起/展开动效（官方是把侧栏整体卸载，所以用 FLIP 补间）
 *  4) 每条回答下方显示 token 用量与估算花费
 *
 * 数据一律读写官方同一个 IndexedDB（库 chat-demo），不另存一份。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__DS_LOCAL_OVERLAY__) return;
  window.__DS_LOCAL_OVERLAY__ = true;

  /* ---------------------------------------------------------------- 配置 */
  // 官方价目表是美元 / 百万 token，界面上折成人民币显示。
  var PRICING = window.__DS_LOCAL_PRICING__ || {};
  var DEFAULT_PRICING = {
    currency: '¥',
    usdToCny: 7.1,
    models: {
      'deepseek-flash': { hit: 0.006, miss: 0.30, out: 1.20 },
      'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96 }
    }
  };
  var models = Object.assign({}, DEFAULT_PRICING.models, PRICING.models || {});
  var CURRENCY = PRICING.currency || DEFAULT_PRICING.currency;
  var FX = Number(PRICING.usdToCny) > 0 ? Number(PRICING.usdToCny) : DEFAULT_PRICING.usdToCny;

  var DB_NAME = 'chat-demo';
  var DB_VERSION = 11;

  var SEL = {
    asst: '.message-e1faee',
    user: '.container-_4cfe7',
    actions: '.actions-e1faee',
    column: '.column-_7ccaf',
    main: '.main-_9fdf5'
  };

  /* ------------------------------------------------------------- 小工具 */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fmtTokens(n) {
    if (!n) return '0';
    if (n < 1000) return String(n);
    if (n < 100000) return (n / 1000).toFixed(2).replace(/\.?0+$/, '') + 'k';
    return Math.round(n / 1000) + 'k';
  }
  // 入参是美元，按 FX 折成人民币显示
  function fmtCost(usd) {
    if (usd == null) return '';
    var cny = usd * FX;
    if (cny === 0) return CURRENCY + '0';
    if (cny < 0.00005) return '<' + CURRENCY + '0.0001';
    if (cny < 0.01) return CURRENCY + cny.toFixed(4);
    if (cny < 1) return CURRENCY + cny.toFixed(3);
    return CURRENCY + cny.toFixed(2);
  }
  function preview(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
  }

  /* ------------------------------------------------------------ IndexedDB */
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.onupgradeneeded = function (e) {
        e.target.transaction.abort();
        rej(new Error('empty'));
      };
      r.onblocked = function () { rej(new Error('blocked')); };
    });
    return dbPromise;
  }
  function idbReq(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function txDone(tx) {
    return new Promise(function (res, rej) {
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error || new Error('aborted')); };
    });
  }
  async function readSession(id) {
    var db = await openDB();
    return idbReq(db.transaction('sessions', 'readonly').objectStore('sessions').get(id));
  }
  async function readAllSessions() {
    var db = await openDB();
    return idbReq(db.transaction('sessions', 'readonly').objectStore('sessions').getAll());
  }

  /* ------------------------------------------------- 会话 / 轮次 / 分支 */
  // 官方模型：messages 是树，rootMessageId 起沿 selectedChildId 走 = 可见链
  function chainOf(session) {
    if (!session || !Array.isArray(session.messages)) return [];
    if (!session.rootMessageId) return session.messages.slice();
    var map = new Map(session.messages.map(function (m) { return [m.id, m]; }));
    var out = [];
    var cur = session.rootMessageId;
    var guard = 0;
    while (cur && guard++ < 5000) {
      var m = map.get(cur);
      if (!m) break;
      out.push(m);
      map.delete(cur);
      cur = m.selectedChildId || null;
    }
    return out;
  }

  // 每一轮 = 一条 user + 紧随其后的 assistant（可能缺失）
  function turnsOf(chain) {
    var turns = [];
    var cur = null;
    chain.forEach(function (m) {
      if (m.role === 'user') {
        cur = { user: m, assistant: null };
        turns.push(cur);
      } else if (m.role === 'assistant') {
        if (cur && !cur.assistant) cur.assistant = m;
        else { cur = { user: null, assistant: m }; turns.push(cur); }
      }
    });
    return turns;
  }

  // 兄弟节点：同一 parentId 下的兄弟（改写的提问 / 重新生成的回答）
  function siblingInfo(session) {
    var groups = new Map();
    (session.messages || []).forEach(function (m) {
      var key = String(m.parentId || '__root__');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    });
    groups.forEach(function (list) {
      list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    });
    return groups;
  }

  /* --------------------------------------------------------- 定价与花费 */
  function isPeak(ts) {
    var d = new Date(ts || Date.now());
    var day = d.getUTCDay();
    if (day === 0 || day === 6) return false;         // 周末全天低谷
    var h = d.getUTCHours() + d.getUTCMinutes() / 60;
    return (h >= 1 && h < 4) || (h >= 6 && h < 10);   // UTC 01-04 / 06-10
  }
  function usageOf(msg) {
    var u = msg && msg.usage;
    if (!u) return null;
    var hit = u.cache_read_input_tokens || 0;
    var miss = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    var out = u.output_tokens || 0;
    if (!hit && !miss && !out) return null;
    var price = models[msg.model] || models['deepseek-flash'];
    var peak = isPeak(msg.createdAt);
    var factor = peak ? 1 : 0.5;                      // 低谷价 = 高峰价的一半
    var usd = (hit * price.hit + miss * price.miss + out * price.out) / 1e6 * factor;
    return { hit: hit, miss: miss, out: out, total: hit + miss + out, usd: usd, peak: peak };
  }

  /* ------------------------------------------------------- 页面状态/节点 */
  function findColumn() {
    var first = $(SEL.asst) || $(SEL.user);
    return first ? first.parentElement : null;
  }
  function classify(node) {
    if (node.classList && node.classList.contains('message-e1faee')) return 'assistant';
    if (node.classList && node.classList.contains('container-_4cfe7')) return 'user';
    if (node.querySelector('button[aria-label="编辑消息"]')) return 'user';
    if (node.querySelector('button[aria-label="朗读"],button[aria-label="重新生成"]')) return 'assistant';
    return null;
  }
  // 返回 [{type:'user'|'assistant', node}] 按 DOM 顺序
  function domMessages() {
    var col = findColumn();
    if (!col) return [];
    var out = [];
    Array.prototype.forEach.call(col.children, function (child) {
      var t = classify(child);
      if (t) out.push({ type: t, node: child });
    });
    return out;
  }
  function firstUserText() {
    var u = $(SEL.user);
    if (!u) return '';
    var bubble = $('.bubble-_4cfe7', u);
    return (bubble ? bubble.textContent : u.textContent || '').trim().slice(0, 60);
  }

  /* --------------------------------------------------------- 当前会话 */
  var state = {
    session: null,
    chain: [],
    turns: [],
    siblings: null,
    dom: [],
    activeTurn: -1,
    managing: false,
    selected: new Set()
  };

  async function resolveSession() {
    var hinted = window.__DS_LOCAL__ && window.__DS_LOCAL__.sessionId;
    if (hinted) {
      try {
        var s = await readSession(hinted);
        if (s) return s;
      } catch (e) {}
    }
    // 退路：用首条提问文本在本地会话里找
    var want = firstUserText();
    if (!want) return null;
    try {
      var all = await readAllSessions();
      for (var i = 0; i < all.length; i++) {
        var ch = chainOf(all[i]);
        var firstUser = ch.filter(function (m) { return m.role === 'user'; })[0];
        if (firstUser && (firstUser.content || '').trim().slice(0, 60) === want) return all[i];
      }
    } catch (e) {}
    return null;
  }

  /* ------------------------------------------------------------ 导航 UI */
  var ui = {};

  function buildUI() {
    var root = el('div', 'dsn');
    root.id = 'ds-nav';

    // 导轨：平时只有几条短线（一轮一条），鼠标移上去才展开卡片
    var rail = el('div', 'dsn-rail');
    rail.title = '悬停展开会话导航';

    var panel = el('div', 'dsn-panel');

    var head = el('div', 'dsn-head');
    var title = el('span', 'dsn-title', '会话导航');
    var count = el('span', 'dsn-count', '');
    var spacer = el('span', 'dsn-spacer');
    var manageBtn = el('button', 'dsn-btn', '管理');
    manageBtn.type = 'button';
    head.appendChild(title); head.appendChild(count); head.appendChild(spacer);
    head.appendChild(manageBtn);

    var list = el('div', 'dsn-list');

    var foot = el('div', 'dsn-foot');
    var checkAll = el('label', 'dsn-all');
    var cbAll = document.createElement('input');
    cbAll.type = 'checkbox';
    checkAll.appendChild(cbAll);
    checkAll.appendChild(document.createTextNode(' 全选'));
    var selInfo = el('span', 'dsn-selinfo', '');
    var delBtn = el('button', 'dsn-btn dsn-danger', '删除选中');
    delBtn.type = 'button';
    delBtn.disabled = true;
    foot.appendChild(checkAll); foot.appendChild(selInfo);
    foot.appendChild(el('span', 'dsn-spacer'));
    foot.appendChild(delBtn);

    panel.appendChild(head); panel.appendChild(list); panel.appendChild(foot);
    root.appendChild(rail); root.appendChild(panel);
    document.body.appendChild(root);

    ui.root = root; ui.rail = rail; ui.panel = panel; ui.list = list;
    ui.count = count; ui.foot = foot; ui.cbAll = cbAll;
    ui.selInfo = selInfo; ui.delBtn = delBtn; ui.manageBtn = manageBtn;

    // ---- 悬停展开 / 移开收起（管理态保持钉住，方便勾选） ----
    var hoverTimer = null;
    function openCard() {
      clearTimeout(hoverTimer);
      root.classList.add('hot');
    }
    function closeCard(delay) {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        if (!state.managing) root.classList.remove('hot');
      }, delay == null ? 200 : delay);
    }
    root.addEventListener('mouseenter', openCard);
    root.addEventListener('mouseleave', function () { closeCard(200); });
    rail.addEventListener('focusin', openCard);
    // 触屏/键盘也能开：点导轨时钉住
    rail.addEventListener('click', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('dsn-tick')) return;
      root.classList.toggle('pinned');
      if (root.classList.contains('pinned')) openCard();
    });

    manageBtn.addEventListener('click', function () { setManaging(!state.managing); });
    cbAll.addEventListener('change', function () {
      state.selected = cbAll.checked ? new Set(state.turns.map(function (_, i) { return i; })) : new Set();
      renderList();
      updateFoot();
    });
    delBtn.addEventListener('click', function () { confirmDelete(); });

    setManaging(false);
  }

  function setManaging(on) {
    state.managing = !!on;
    ui.root.classList.toggle('managing', state.managing);
    // 管理态钉住面板，否则鼠标一移开就没法勾选
    ui.root.classList.toggle('pinned', state.managing);
    if (state.managing) ui.root.classList.add('hot');
    ui.manageBtn.textContent = state.managing ? '完成' : '管理';
    ui.foot.hidden = !state.managing;
    if (!state.managing) { state.selected.clear(); }
    renderList();
    updateFoot();
  }
  function updateFoot() {
    var n = state.selected.size;
    ui.delBtn.disabled = n === 0;
    ui.delBtn.textContent = n ? '删除选中 (' + n + ')' : '删除选中';
    ui.selInfo.textContent = n ? '已选 ' + n + ' 轮' : '';
    var all = state.turns.length > 0 && n === state.turns.length;
    ui.cbAll.checked = all;
    ui.cbAll.indeterminate = n > 0 && !all;
  }

  function branchPill(kind, msg, groups) {
    if (!msg) return null;
    var list = groups.get(String(msg.parentId || '__root__')) || [];
    if (kind === 'assistant') {
      // 回答的兄弟 = 同一个提问下的所有 assistant
      list = list.filter(function (m) { return m.role === 'assistant'; });
    } else {
      list = list.filter(function (m) { return m.role === 'user'; });
    }
    if (list.length <= 1) return null;
    var idx = list.findIndex(function (m) { return m.id === msg.id; });
    var span = el('span', 'dsn-pill');
    span.textContent = (kind === 'assistant' ? '回答 ' : '提问 ') + (idx + 1) + '/' + list.length;
    return span;
  }

  // 导轨：一轮一条短线；当前轮高亮；轮次太多时均匀抽样，避免溢出
  var MAX_TICKS = 36;
  function renderRail() {
    if (!ui.rail) return;
    ui.rail.innerHTML = '';
    var turns = state.turns;
    if (!turns.length) return;

    var idxs = [];
    if (turns.length <= MAX_TICKS) {
      for (var i = 0; i < turns.length; i++) idxs.push(i);
    } else {
      var step = (turns.length - 1) / (MAX_TICKS - 1);
      for (var k = 0; k < MAX_TICKS; k++) idxs.push(Math.round(k * step));
    }

    idxs.forEach(function (i) {
      var tick = el('div', 'dsn-tick');
      tick.dataset.turn = String(i);
      if (state.activeTurn === i) tick.classList.add('active');
      tick.title = (i + 1) + '. ' + (turns[i].user ? preview(turns[i].user.content || '[附件]', 40) : '（无提问）');
      tick.addEventListener('click', function (e) {
        e.stopPropagation();
        jumpToTurn(i);
      });
      ui.rail.appendChild(tick);
    });
  }

  // 只更新「当前轮」高亮，不重建 DOM
  function syncActiveUI(i) {
    if (ui.list) {
      $$('.dsn-item', ui.list).forEach(function (n) {
        n.classList.toggle('active', Number(n.dataset.turn) === i);
      });
    }
    if (ui.rail) {
      var ticks = $$('.dsn-tick', ui.rail);
      ticks.forEach(function (n) {
        n.classList.toggle('active', Number(n.dataset.turn) === i);
      });
      // 抽样时当前轮可能没有对应短线，就近补一条
      if (ticks.length && !ticks.some(function (n) { return n.classList.contains('active'); })) {
        var best = 0; var dist = Infinity;
        ticks.forEach(function (n, k) {
          var d = Math.abs(Number(n.dataset.turn) - i);
          if (d < dist) { dist = d; best = k; }
        });
        ticks[best].classList.add('active');
      }
    }
  }

  function renderList() {
    if (!ui.list) return;
    var list = ui.list;
    list.innerHTML = '';

    if (!state.turns.length) {
      var empty = el('div', 'dsn-empty');
      empty.textContent = state.session ? '这条对话还没有内容' : '当前对话还没有消息';
      list.appendChild(empty);
      ui.count.textContent = '';
      renderRail();
      return;
    }

    ui.count.textContent = state.turns.length + ' 轮';

    state.turns.forEach(function (turn, i) {
      var item = el('div', 'dsn-item');
      item.dataset.turn = String(i);
      if (state.activeTurn === i) item.classList.add('active');

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dsn-cb';
      cb.checked = state.selected.has(i);
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected.add(i); else state.selected.delete(i);
        updateFoot();
      });
      item.appendChild(cb);

      var idx = el('div', 'dsn-idx', String(i + 1));
      item.appendChild(idx);

      var body = el('div', 'dsn-body');
      var q = el('div', 'dsn-q');
      q.textContent = turn.user ? preview(turn.user.content || '[附件]', 64) : '（无提问）';
      body.appendChild(q);

      var meta = el('div', 'dsn-meta');
      if (turn.assistant) {
        var u = usageOf(turn.assistant);
        if (u) {
          var tk = el('span', 'dsn-tk', fmtTokens(u.total) + ' tk');
          meta.appendChild(tk);
        }
        if (turn.assistant.status === 'stopped') meta.appendChild(el('span', 'dsn-badge', '已停止'));
        if (turn.assistant.status === 'error') meta.appendChild(el('span', 'dsn-badge err', '出错'));
      } else {
        meta.appendChild(el('span', 'dsn-badge', '无回答'));
      }
      var p1 = branchPill('user', turn.user, state.siblings || new Map());
      if (p1) meta.appendChild(p1);
      var p2 = branchPill('assistant', turn.assistant, state.siblings || new Map());
      if (p2) meta.appendChild(p2);
      body.appendChild(meta);

      item.appendChild(body);
      item.addEventListener('click', function (e) {
        if (state.managing) {
          if (e.target === cb) return;
          cb.checked = !cb.checked;
          if (cb.checked) state.selected.add(i); else state.selected.delete(i);
          updateFoot();
          return;
        }
        jumpToTurn(i);
      });
      list.appendChild(item);
    });

    renderRail();
  }

  /* ------------------------------------------------------------- 跳转 */
  function nodeForTurn(i, type) {
    var asstNodes = state.dom.filter(function (d) { return d.type === 'assistant'; });
    var userNodes = state.dom.filter(function (d) { return d.type === 'user'; });
    if (type === 'assistant') {
      // 第 i 轮的 assistant 是第 i 个 assistant 节点（链上 assistant 与 DOM 顺序一致）
      return asstNodes[i] ? asstNodes[i].node : null;
    }
    return userNodes[i] ? userNodes[i].node : null;
  }

  /* 只滚真正的消息滚动容器。
     绝不能用 node.scrollIntoView()：它会逐级把每个可滚动祖先都滚一遍，包括官方
     .frame-_9fdf5（overflow:hidden 但仍是滚动容器），结果整块 frame 连同左侧品牌行、
     设置按钮一起被顶出视口——这就是「用久了整个界面上滑且下不来」。 */
  function scrollBoxFor(node) {
    var p = node.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      var cs = window.getComputedStyle(p);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight - p.clientHeight > 2) return p;
      p = p.parentElement;
    }
    return null;
  }

  function jumpToTurn(i) {
    var node = nodeForTurn(i, 'user') || nodeForTurn(i, 'assistant');
    if (!node) return;
    var box = scrollBoxFor(node);
    if (box) {
      var br = box.getBoundingClientRect();
      var nr = node.getBoundingClientRect();
      var top = box.scrollTop + (nr.top - br.top) - Math.max(0, (box.clientHeight - nr.height) / 2);
      top = Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight));
      try {
        box.scrollTo({ top: top, behavior: 'smooth' });
      } catch (e) {
        box.scrollTop = top;
      }
    }
    node.classList.remove('dsn-flash');
    void node.offsetWidth;
    node.classList.add('dsn-flash');
    setTimeout(function () { node.classList.remove('dsn-flash'); }, 1200);
    state.activeTurn = i;
    syncActiveUI(i);
  }

  /* --------------------------------------------------- token / 花费角标 */
  function syncBadges() {
    var asstNodes = state.dom.filter(function (d) { return d.type === 'assistant'; });
    state.turns.forEach(function (turn, i) {
      var node = asstNodes[i] && asstNodes[i].node;
      if (!node) return;
      var actions = $(SEL.actions, node);
      if (!actions) return;
      var exist = actions.querySelector('.dsu-badge');
      var u = usageOf(turn.assistant);
      if (!u) {
        if (exist) exist.remove();
        return;
      }
      var badge = exist;
      if (!badge) {
        badge = el('span', 'dsu-badge');
        actions.appendChild(badge);
      }
      badge.textContent = fmtTokens(u.total) + ' tokens · ' + fmtCost(u.usd);
      badge.title = '本次调用（' + (u.peak ? '高峰价' : '低谷价') + '）\n' +
        '输入（缓存命中）：' + u.hit.toLocaleString() + ' tokens\n' +
        '输入（缓存未命中）：' + u.miss.toLocaleString() + ' tokens\n' +
        '输出：' + u.out.toLocaleString() + ' tokens\n' +
        '合计：' + u.total.toLocaleString() + ' tokens ≈ ' + fmtCost(u.usd) +
        '（$' + u.usd.toFixed(5) + ' × ' + FX + '）' +
        '\n按 deepseek 官方价目表（美元）折算人民币（' + (turn.assistant.model || 'deepseek-flash') + '）';
    });
    // 清掉多余的角标
    $$('.dsu-badge').forEach(function (b) {
      var parent = b.parentElement;
      var known = false;
      state.turns.forEach(function (t, i) {
        var n = asstNodes[i] && asstNodes[i].node;
        if (n && parent === $(SEL.actions, n)) known = true;
      });
      if (!known) b.remove();
    });
  }

  /* --------------------------------------------------------- 删除轮次 */
  function computeDeleted(session, indexes) {
    var chain = chainOf(session);
    var turns = turnsOf(chain);
    var removed = new Set();
    indexes.forEach(function (i) {
      var t = turns[i];
      if (!t) return;
      if (t.user) removed.add(t.user.id);
      if (t.assistant) removed.add(t.assistant.id);
    });
    if (!removed.size) return null;

    var kept = chain.filter(function (m) { return !removed.has(m.id); });
    var keptSet = new Set(kept.map(function (m) { return m.id; }));

    // 被删节点下的子树（分支）也要清掉，但保持在链上的续接节点
    var childrenOf = new Map();
    (session.messages || []).forEach(function (m) {
      var k = String(m.parentId || '__root__');
      if (!childrenOf.has(k)) childrenOf.set(k, []);
      childrenOf.get(k).push(m.id);
    });
    var toDelete = new Set(removed);
    removed.forEach(function (rid) {
      var stack = (childrenOf.get(rid) || []).slice();
      while (stack.length) {
        var id = stack.pop();
        if (keptSet.has(id)) continue;          // 链上的续接点保留，且不往下删
        toDelete.add(id);
        stack = stack.concat(childrenOf.get(id) || []);
      }
    });

    var next = new Map();
    kept.forEach(function (m, i) {
      next.set(m.id, Object.assign({}, m, {
        parentId: i === 0 ? null : kept[i - 1].id,
        selectedChildId: i === kept.length - 1 ? null : kept[i + 1].id
      }));
    });

    var messages = [];
    (session.messages || []).forEach(function (m) {
      if (toDelete.has(m.id)) return;
      messages.push(next.get(m.id) || m);
    });

    return {
      messages: messages,
      removedIds: toDelete,
      removedCount: removed.size,
      remaining: kept.length,
      rootMessageId: kept.length ? kept[0].id : null
    };
  }

  async function applyDelete(indexes) {
    var session = state.session;
    if (!session) return { ok: false, reason: 'no-session' };
    if (isStreaming()) return { ok: false, reason: 'streaming' };

    var plan = computeDeleted(session, indexes);
    if (!plan) return { ok: false, reason: 'empty-plan' };

    var db = await openDB();
    if (!plan.remaining) {
      var tx0 = db.transaction(['sessions', 'sessionSummaries'], 'readwrite');
      tx0.objectStore('sessions').delete(session.id);
      tx0.objectStore('sessionSummaries').delete(session.id);
      await txDone(tx0);
      return { ok: true, whole: true };
    }

    var updated = Object.assign({}, session, {
      messages: plan.messages,
      rootMessageId: plan.rootMessageId,
      updatedAt: Date.now()
    });

    var tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite');
    tx.objectStore('sessions').put(updated);
    var summary = {
      id: updated.id,
      title: updated.title || '',
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      fileIds: (function () {
        var ids = [];
        plan.messages.forEach(function (m) {
          if (m.role === 'user' && Array.isArray(m.files)) {
            m.files.forEach(function (f) { if (f && f.id) ids.push(f.id); });
          }
        });
        return Array.from(new Set(ids));
      })()
    };
    tx.objectStore('sessionSummaries').put(summary);
    await txDone(tx);
    return { ok: true, removed: plan.removedCount };
  }

  function isStreaming() {
    return !!($('button[aria-label="停止生成"]') || $('#stop-generation'));
  }

  /* ------------------------------------------------------------- 确认框 */
  function confirmDelete() {
    var n = state.selected.size;
    if (!n) return;
    var target = state.session;      // 先抓住，重载后还要用它把对话点回来
    var mask = el('div', 'dsm-mask');
    var box = el('div', 'dsm-box');
    box.appendChild(el('div', 'dsm-title', '删除 ' + n + ' 轮问答？'));
    var desc = el('div', 'dsm-desc');
    desc.innerHTML = '被选中的提问与回答会从这条对话的<strong>上下文</strong>中移除，' +
      '其后的对话仍然保留；这些轮次里「重新生成」出的其它分支也会一并删除。<br>' +
      '此操作不可撤销，建议先在 <a href="/manage" target="_blank">管理页</a> 导出备份。';
    box.appendChild(desc);

    var row = el('div', 'dsm-row');
    var cancel = el('button', 'dsn-btn', '取消');
    var ok = el('button', 'dsn-btn dsn-danger-solid', '确认删除');
    cancel.type = 'button'; ok.type = 'button';
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    mask.appendChild(box);
    document.body.appendChild(mask);

    function close() { mask.remove(); }
    cancel.addEventListener('click', close);
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    ok.addEventListener('click', async function () {
      ok.disabled = true;
      ok.textContent = '删除中…';
      try {
        var r = await applyDelete(Array.from(state.selected));
        if (!r.ok) {
          close();
          toast(r.reason === 'streaming' ? '正在生成回答，等结束后再删除' : '删除失败，请重试');
          return;
        }
        close();
        toast('已删除 ' + n + ' 轮，正在重新载入…');
        try {
          if (target) {
            localStorage.setItem(REOPEN_KEY, JSON.stringify({ id: target.id, title: target.title || '' }));
          }
        } catch (e) {}
        setTimeout(function () { location.reload(); }, 600);
      } catch (e) {
        close();
        toast('删除失败：' + (e && e.message ? e.message : e));
      }
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('#ds-toast');
    if (!t) {
      t = el('div', 'ds-toast');
      t.id = 'ds-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  }

  /* ----------------------------------------------- 侧栏展开/收起动效 */
  function animateSider() {
    var main = $(SEL.main);
    if (!main) return;
    var before = main.getBoundingClientRect();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var after = main.getBoundingClientRect();
        if (Math.abs(after.left - before.left) < 1 && Math.abs(after.width - before.width) < 1) return;
        // 从「旧几何」补间到「新几何」：位移 + 宽度同时变化，视觉上就是侧栏在展开/收起
        main.style.transition = 'none';
        main.style.flex = 'none';
        main.style.marginLeft = before.left + 'px';
        main.style.width = before.width + 'px';
        void main.offsetWidth;
        main.style.transition = 'margin-left 260ms cubic-bezier(.4,0,.2,1), width 260ms cubic-bezier(.4,0,.2,1)';
        main.style.marginLeft = after.left + 'px';
        main.style.width = after.width + 'px';
        var done = function () {
          main.style.transition = '';
          main.style.flex = '';
          main.style.marginLeft = '';
          main.style.width = '';
          main.removeEventListener('transitionend', done);
        };
        main.addEventListener('transitionend', done);
        setTimeout(done, 420);
      });
    });
  }

  function hookSider() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('button[aria-label="收起边栏"],button[aria-label="打开边栏"]');
      if (btn) animateSider();
    }, true);
  }

  /* --------------------------------------------------------- 删除后重开 */
  // 删除要落库再刷新，刷新后官方会回到首页；这里用标题把刚编辑的对话点回来。
  var REOPEN_KEY = 'ds-nav-reopen';

  function findSidebarItem(title) {
    if (!title) return null;
    var scope = $('.sider-ac14ac') || document;
    var nodes = $$('*', scope);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.children.length <= 3 && (n.textContent || '').trim() === title) return n;
    }
    return null;
  }

  function maybeReopen() {
    var raw = null;
    try { raw = localStorage.getItem(REOPEN_KEY); } catch (e) {}
    if (!raw) return;
    var info;
    try { info = JSON.parse(raw); } catch (e) { localStorage.removeItem(REOPEN_KEY); return; }
    var started = Date.now();
    var timer = setInterval(function () {
      var hit = findSidebarItem(info.title);
      if (hit) {
        clearInterval(timer);
        try { localStorage.removeItem(REOPEN_KEY); } catch (e) {}
        hit.click();
        setTimeout(function () { if (window.__DS_LOCAL__) window.__DS_LOCAL__.sessionId = info.id; scheduleSync(400); }, 500);
      } else if (Date.now() - started > 6000) {
        clearInterval(timer);
        try { localStorage.removeItem(REOPEN_KEY); } catch (e) {}
      }
    }, 250);
  }

  /* ------------------------------------------------------------- 同步 */
  var syncing = false;
  var syncQueued = false;
  async function sync() {
    if (syncing) { syncQueued = true; return; }
    syncing = true;
    try {
      state.dom = domMessages();
      var session = await resolveSession();
      if (session) {
        state.session = session;
        state.chain = chainOf(session);
        state.turns = turnsOf(state.chain);
        state.siblings = siblingInfo(session);
        // 选中的轮次超出范围就丢弃
        state.selected.forEach(function (i) { if (i >= state.turns.length) state.selected.delete(i); });
        if (state.activeTurn >= state.turns.length) state.activeTurn = -1;
      } else {
        state.session = null; state.chain = []; state.turns = [];
        state.siblings = null;
      }
      if (ui.list) { renderList(); updateFoot(); }
      syncBadges();
      // 打开对话时先定位一次「当前轮」，让导轨/列表马上有高亮
      if (state.turns.length) requestAnimationFrame(updateActiveByScroll);
    } catch (e) {
      /* 数据库尚未就绪等情况，忽略并等下一次 */
    } finally {
      syncing = false;
      if (syncQueued) { syncQueued = false; setTimeout(sync, 60); }
    }
  }

  var syncTimer = null;
  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay == null ? 220 : delay);
  }

  function observe() {
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        if (t && t.closest && t.closest('#ds-nav')) continue;   // 自己的 UI 不算
        scheduleSync();
        return;
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });

    // 生成过程中定期刷新（用量在流结束后才落库）
    setInterval(function () { if (isStreaming()) scheduleSync(0); }, 2000);

    // 残留遮罩巡检（孤儿遮罩只在出现后 1.5s 才清，见 healStuck）
    setInterval(healStuck, 2500);

    // 滚动：① 兜底把 .frame 的非法滚动拉回 0（不支持 overflow:clip 的浏览器）② 高亮当前轮
    var ticking = false;
    window.addEventListener('scroll', function (e) {
      var t = e.target;
      if (t && t.nodeType === 1 && t.classList && t.classList.contains('frame-_9fdf5') && t.scrollTop) {
        t.scrollTop = 0;
      }
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; updateActiveByScroll(); });
    }, true);
  }

  function updateActiveByScroll() {
    if (!state.dom.length || !ui.list) return;
    var mid = window.innerHeight / 2;
    var best = -1; var bestDist = Infinity;
    var userNodes = state.dom.filter(function (d) { return d.type === 'user'; });
    userNodes.forEach(function (d, i) {
      var r = d.node.getBoundingClientRect();
      var c = r.top + r.height / 2;
      var dist = Math.abs(c - mid);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    if (best !== -1 && best !== state.activeTurn) {
      state.activeTurn = best;
      syncActiveUI(best);
    }
  }

  /* --------------------------------------------------- 品牌文案 / 自愈 */
  // 官方品牌文案来自 bundle 里的 i18n 表（appName:"API 使用 demo"），DOM 只是它的投影。
  // React 重渲染会把文本写回原文，所以要盯着 DOM 逐帧复写，而不是改一次了事。
  var BRAND_TEXT = 'Deepseek网页端本地版';

  function applyBrand() {
    var nodes = document.querySelectorAll('.appName-ac14ac');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].textContent !== BRAND_TEXT) nodes[i].textContent = BRAND_TEXT;
    }
  }

  function hookBrand() {
    applyBrand();
    var queued = false;
    var mo = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      Promise.resolve().then(function () { queued = false; applyBrand(); });
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  /* 残留物自愈：任何「铺满屏幕又没人用」的遮罩都会让左下角设置等按钮点不动。
     只在确认无主（对话框内容缺失 / 多选操作条没显示）时才清，绝不伤到正常打开的弹窗。 */
  function healStuck() {
    var sider = document.querySelector('.sider-ac14ac.dsn-sel');
    if (sider) {
      var bar = document.getElementById('dsn-selbar');
      if (!bar || !bar.classList.contains('show')) sider.classList.remove('dsn-sel');
    }
    var masks = document.querySelectorAll('.dsm-mask');
    for (var i = 0; i < masks.length; i++) {
      if (!masks[i].querySelector('.dsm-box')) masks[i].remove();
    }
    var ovs = document.querySelectorAll('.overlay-_83af2');
    var now = Date.now();
    for (var j = 0; j < ovs.length; j++) {
      var ov = ovs[j];
      if (ov.querySelector('.content-_83af2')) { ov.removeAttribute('data-dsn-orphan'); continue; }
      // 空遮罩一定是孤儿（官方的遮罩和对话框在同一次提交里出现）
      if (!ov.firstElementChild) { ov.remove(); continue; }
      var at = Number(ov.getAttribute('data-dsn-orphan') || 0);
      if (!at) { ov.setAttribute('data-dsn-orphan', String(now)); continue; }
      if (now - at > 1500) ov.remove();   // 遮罩在、对话框不在超过 1.5s ⇒ 孤儿
    }
  }

  /* 设置按钮兜底：两条路都要保证「点左下角就开」。
     A) 正常点在按钮上、但 420ms 内没弹出对话框 → 补一次点击（每 800ms 最多一次，绝不循环）；
     B) 点在按钮所在的坐标范围内、但命中的是别的东西（残留遮罩 / 官方漏关的 portal / 别人的
        pointer-events 黑洞）→ 立刻补一次按钮点击。用户实际遇到的就是 B：按钮画在那里，
        但点击被上层某个看不见的节点吃掉了。 */
  function hookSettings() {
    var lastRetry = 0;
    var dialogOpen = function () { return !!document.querySelector('.overlay-_83af2 .content-_83af2'); };
    var retry = function () {
      var now = Date.now();
      if (now - lastRetry < 800) return;
      lastRetry = now;
      var btn = document.querySelector('button.settings-ac14ac');
      if (btn) { try { btn.click(); } catch (err) { } }
    };
    document.addEventListener('click', function (e) {
      if (dialogOpen()) return;
      var btn = document.querySelector('button.settings-ac14ac');
      if (!btn) return;
      var direct = !!(e.target && e.target.closest && e.target.closest('button.settings-ac14ac'));
      if (direct) {
        setTimeout(function () { if (!dialogOpen()) retry(); }, 420);
        return;
      }
      var r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var pad = 6;
      if (e.clientX < r.left - pad || e.clientX > r.right + pad) return;
      if (e.clientY < r.top - pad || e.clientY > r.bottom + pad) return;
      retry();
    }, true);

    /* 悬停兜底：指针落在「设置」那一行里、但命中的是别的节点（同一个吃掉点击的透明层也会吃掉
       :hover）→ 自己给按钮加 .dsn-hover，让底色照常变深。用 rAF 节流，避免 mousemove 里读布局。 */
    var hoverPending = false;
    var lastPt = null;
    document.addEventListener('mousemove', function (e) {
      lastPt = e;
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(function () {
        hoverPending = false;
        var btn = document.querySelector('button.settings-ac14ac');
        var row = document.querySelector('.bottom-ac14ac');
        if (!btn) return;
        var box = row || btn;
        var r = box.getBoundingClientRect();
        var pt = lastPt;
        var inRow = !!r.width && pt &&
          pt.clientX >= r.left && pt.clientX <= r.right &&
          pt.clientY >= r.top && pt.clientY <= r.bottom;
        var hitSelf = !!(pt && pt.target && pt.target.closest &&
          (pt.target.closest('button.settings-ac14ac') || pt.target.closest('.bottom-ac14ac')));
        btn.classList.toggle('dsn-hover', inRow && !hitSelf);
      });
    }, true);
  }

  /* --------------------------------------------------------------- 启动 */
  function ready() {
    var ta = $('textarea');
    var col = findColumn();
    return !!(ta && (col || $('button[aria-label="发送"]')));
  }

  function boot() {
    if (ui.root) return;
    buildUI();
    hookSider();
    hookBrand();
    hookSettings();
    healStuck();
    observe();
    sync();
    maybeReopen();
    // 首屏可能还没渲染完，补几次
    var tries = 0;
    var timer = setInterval(function () {
      if (ready() || ++tries > 40) {
        clearInterval(timer);
        scheduleSync(0);
      }
    }, 250);
  }

  var bootTimer = setInterval(function () {
    if (ready()) {
      clearInterval(bootTimer);
      boot();
    }
  }, 300);
  setTimeout(function () { clearInterval(bootTimer); if (!ui.root) boot(); }, 12000);
})();
