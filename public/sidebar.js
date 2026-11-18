/* ============================================================================
 * 侧边栏对话列表增强（注入层，不改官方 bundle）
 *
 *  1) 置顶：置顶的对话固定在列表最上方，原位置隐藏
 *  2) 多选：右上小图标进入选择态 → 顶部「选择对话 ✕」、圆形勾选、底部操作条
 *
 * 数据来源：官方 IndexedDB（chat-demo）；置顶状态存 localStorage，不污染导出文件。
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__DS_SIDEBAR__) return;
  window.__DS_SIDEBAR__ = true;

  var PIN_KEY = 'dsn-sidebar-pins';
  var DB_NAME = 'chat-demo';
  var DB_VERSION = 11;

  var SEL = {
    wrap: '.listWrap-ac14ac',
    item: '.item-ff6fc9',
    title: '.title-ff6fc9',
    action: '.action-ff6fc9',
    sider: '.sider-ac14ac'
  };

  var ICON = {
    ms: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M2 5.2h6.2M12.9 5.2H14M2 10.8h2.4M8.1 10.8H14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
      '<circle cx="10.4" cy="5.2" r="1.55" stroke="currentColor" stroke-width="1.3"/>' +
      '<circle cx="5.6" cy="10.8" r="1.55" stroke="currentColor" stroke-width="1.3"/></svg>',
    pin: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M9.6 1.8 14.2 6.4l-1.5.5-1 2.6-2.1-2.1-3.4 3.4 3.4-3.4L7.5 5.3l2.6-1 .5-1.5Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>' +
      '<path d="M6.2 9.8 2.6 13.4" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/></svg>'
  };

  var state = {
    pins: [],
    pinTitles: new Set(),
    rows: [],
    selecting: false,
    selected: new Set(),
    syncing: false,
    applying: false,
    pinSig: '',
    activeSyncing: false
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
  function toast(msg) {
    var t = document.getElementById('ds-toast');
    if (!t) { t = el('div', 'ds-toast'); t.id = 'ds-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ------------------------------------------------------------ IndexedDB */
  var dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
      r.onupgradeneeded = function (e) { e.target.transaction.abort(); rej(new Error('empty')); };
      r.onblocked = function () { rej(new Error('blocked')); };
    });
    return dbPromise;
  }
  function req(r) {
    return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; });
  }
  function txDone(tx) {
    return new Promise(function (res, rej) {
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error || new Error('aborted')); };
    });
  }
  async function readSummaries() {
    var db = await openDB();
    var list = await req(db.transaction('sessionSummaries', 'readonly').objectStore('sessionSummaries').getAll());
    return list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }
  async function deleteSessions(ids) {
    var db = await openDB();
    var tx = db.transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite');
    var sessions = tx.objectStore('sessions');
    var sums = tx.objectStore('sessionSummaries');
    var files = tx.objectStore('files');
    for (var i = 0; i < ids.length; i++) {
      var summary = await req(sums.get(ids[i]));
      sessions.delete(ids[i]);
      sums.delete(ids[i]);
      var fileIds = (summary && summary.fileIds) || [];
      for (var k = 0; k < fileIds.length; k++) {
        var still = await req(sums.index('fileIds').count(fileIds[k]));
        if (still === 0) files.delete(fileIds[k]);
      }
    }
    await txDone(tx);
  }

  /* ---------------------------------------------------------------- 置顶 */
  function loadPins() {
    try {
      var arr = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
      state.pins = Array.isArray(arr) ? arr.filter(function (p) { return p && typeof p.id === 'string'; }) : [];
    } catch (e) { state.pins = []; }
  }
  function savePins() {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(state.pins)); } catch (e) {}
  }
  function isPinned(id) { return state.pins.some(function (p) { return p.id === id; }); }
  function setPinned(id, title, on) {
    if (on) {
      if (isPinned(id)) return;
      state.pins.unshift({ id: id, title: title || '', at: Date.now() });
    } else {
      state.pins = state.pins.filter(function (p) { return p.id !== id; });
    }
    savePins();
  }

  /* --------------------------------------- 隐藏被置顶的原项（data 属性方案）
   * React 重新挂载节点时会重写 className（把我加的类冲掉），但不会动 dataset；
   * 而且属性选择器对「刚挂上来的新节点」立刻生效 —— 这就是重复项窗口的修法。
   */
  function itemTitle(item) {
    var t = $(SEL.title, item);
    return ((t && t.textContent) || '').trim();
  }

  // 返回 true 表示「处理了」，null 表示标题还没渲染出来（稍后整轮 sync 兜底）
  function applyPinMark(item) {
    if (!item || item.nodeType !== 1) return false;
    var title = itemTitle(item);
    if (!title) return null;
    if (state.pinTitles.has(title)) {
      if (item.dataset.dsnPinned !== '1') { item.dataset.dsnPinned = '1'; return true; }
      return false;
    }
    if (item.dataset.dsnPinned) { delete item.dataset.dsnPinned; return true; }
    return false;
  }

  // 对一棵新插入的子树做「同步、立即」的置顶隐藏（不等 180ms 的整轮 sync）
  function applyPinMarkDeep(root) {
    if (!root || root.nodeType !== 1) return null;
    var touched = false;
    var pending = false;
    if (root.matches && root.matches(SEL.item)) {
      var r = applyPinMark(root);
      if (r === null) pending = true; else touched = touched || r;
    }
    if (root.querySelectorAll) {
      var inner = $$(SEL.item, root);
      for (var i = 0; i < inner.length; i++) {
        var r2 = applyPinMark(inner[i]);
        if (r2 === null) pending = true; else touched = touched || r2;
      }
    }
    return pending ? null : touched;
  }

  // 置顶行自己承担高亮：官方 active 项是谁，同名置顶行就亮
  function syncActivePin() {
    if (!ui.pinList || state.activeSyncing) return;
    if (state.selecting) return;
    var rows = $$('.dsn-pinrow', ui.pinList);
    if (!rows.length) return;
    var activeTitles = new Set();
    $$(SEL.item).forEach(function (item) {
      if (!item.classList.contains('active-ff6fc9')) return;
      var t = itemTitle(item);
      if (t) activeTitles.add(t);
    });
    state.activeSyncing = true;
    try {
      rows.forEach(function (row) {
        row.classList.toggle('active', activeTitles.has((row.dataset.title || '').trim()));
      });
    } finally {
      state.activeSyncing = false;
    }
  }

  /* ------------------------------------------------ DOM 项 ↔ 会话 id */
  // 官方列表项没有 data-id：标题优先匹配，其次按 updatedAt 倒序回退
  async function mapRows() {
    var wrap = $(SEL.wrap);
    if (!wrap) { state.rows = []; return; }
    var items = $$(SEL.item, wrap);
    var summaries;
    try { summaries = await readSummaries(); } catch (e) { summaries = []; }

    var byTitle = new Map();
    summaries.forEach(function (s) {
      var t = (s.title || '').trim();
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(s);
    });

    var used = new Set();
    state.rows = items.map(function (itemEl, index) {
      var titleEl = $(SEL.title, itemEl);
      var title = (titleEl ? titleEl.textContent : '').trim();
      var pool = byTitle.get(title) || [];
      var hit = pool.filter(function (s) { return !used.has(s.id); })[0];
      if (!hit) hit = summaries.filter(function (s) { return !used.has(s.id); })[0] || null;
      if (hit) used.add(hit.id);
      return { el: itemEl, id: hit ? hit.id : null, title: title, index: index };
    });

    // 只有在确实读到会话列表时才清理失效置顶，
    // 否则「数据库尚未就绪 → 空列表」会把置顶全删掉（刷新时踩到过）
    if (summaries.length > 0) {
      var alive = new Set(summaries.map(function (s) { return s.id; }));
      var before = state.pins.length;
      state.pins = state.pins.filter(function (p) { return alive.has(p.id); });
      if (state.pins.length !== before) savePins();
    }
  }

  /* ------------------------------------------------------------ UI 构建 */
  var ui = {};

  function buildChrome() {
    if (!ui.pinBlock) {
      ui.pinBlock = el('div', 'dsn-pinblock');
      ui.pinBlock.id = 'dsn-pin-block';
      var head = el('div', 'dsn-pinhead');
      ui.pinHead = head;
      ui.pinLabel = el('span', 'dsn-pinhead-label', '置顶');
      var ms = el('button', 'dsn-msbtn');
      ms.type = 'button';
      ms.title = '选择对话';
      ms.setAttribute('aria-label', '选择对话');
      ms.innerHTML = ICON.ms;
      ms.addEventListener('click', function (e) { e.stopPropagation(); setSelecting(true); });
      ui.msBtn = ms;
      head.appendChild(ui.pinLabel);
      head.appendChild(ms);
      ui.pinList = el('div', 'dsn-pinlist');
      ui.pinBlock.appendChild(head);
      ui.pinBlock.appendChild(ui.pinList);
    }

    if (!ui.selHead) {
      ui.selHead = el('div', 'dsn-selhead');
      ui.selHead.id = 'dsn-selhead';
      ui.selTitle = el('span', 'dsn-selhead-title', '选择对话');
      var close = el('button', 'dsn-selhead-close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', '退出选择');
      close.addEventListener('click', function () { setSelecting(false); });
      ui.selHead.appendChild(ui.selTitle);
      ui.selHead.appendChild(close);
      document.body.appendChild(ui.selHead);
    }

    if (!ui.selBar) {
      ui.selBar = el('div', 'dsn-selbar');
      ui.selBar.id = 'dsn-selbar';

      var top = el('div', 'dsn-selbar-top');
      var allLabel = el('label', 'dsn-selall');
      ui.cbAll = document.createElement('input');
      ui.cbAll.type = 'checkbox';
      allLabel.appendChild(ui.cbAll);
      allLabel.appendChild(document.createTextNode('全选'));
      ui.selInfo = el('span', 'dsn-selinfo', '已选 0');
      ui.selInfo.id = 'dsn-selcount';
      top.appendChild(allLabel);
      top.appendChild(ui.selInfo);

      var actions = el('div', 'dsn-selbar-actions');
      ui.pinAct = el('button', 'dsn-actbtn', '置顶');
      ui.pinAct.type = 'button';
      ui.pinAct.dataset.act = 'pin';
      ui.unpinAct = el('button', 'dsn-actbtn', '取消置顶');
      ui.unpinAct.type = 'button';
      ui.unpinAct.dataset.act = 'unpin';
      ui.delAct = el('button', 'dsn-actbtn danger', '删除');
      ui.delAct.type = 'button';
      ui.delAct.dataset.act = 'del';
      actions.appendChild(ui.pinAct);
      actions.appendChild(ui.unpinAct);
      actions.appendChild(ui.delAct);

      ui.selBar.appendChild(top);
      ui.selBar.appendChild(actions);
      document.body.appendChild(ui.selBar);

      ui.cbAll.addEventListener('change', function () {
        if (ui.cbAll.checked) state.selected = new Set(state.rows.map(function (r) { return r.id; }).filter(Boolean));
        else state.selected.clear();
        render();
      });
      ui.selBar.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-act]');
        if (btn) handleAction(btn.dataset.act);
      });
    }
  }

  function positionChrome() {
    var sider = $(SEL.sider);
    if (!sider) {
      if (ui.selHead) ui.selHead.classList.remove('show');
      if (ui.selBar) ui.selBar.classList.remove('show');
      return false;
    }
    var r = sider.getBoundingClientRect();
    var left = Math.round(r.left + 12);
    var width = Math.round(r.width - 24);

    ui.selHead.style.left = left + 'px';
    ui.selHead.style.width = width + 'px';
    ui.selHead.style.top = Math.round(r.top + 6) + 'px';

    ui.selBar.style.left = left + 'px';
    ui.selBar.style.width = width + 'px';
    ui.selBar.style.bottom = Math.round(window.innerHeight - r.bottom + 4) + 'px';
    return true;
  }

  /* 清掉「菜单打开中」的标记（菜单关闭、行被卸载或超时都走这里） */
  function clearMenuSource() {
    if (state.menuPoll) { clearInterval(state.menuPoll); state.menuPoll = null; }
    if (state.menuSrc) {
      state.menuSrc.classList.remove('dsn-menu-src');
      state.menuSrc = null;
    }
  }

  function pinSignature() {
    return state.pins.map(function (p) { return p.id + '\u0001' + (p.title || ''); }).join('\u0002') +
      '\u0003' + (state.selecting ? '1' : '0') +
      '\u0003' + (state.selecting ? Array.from(state.selected).sort().join(',') : '');
  }

  function renderPinList() {
    ui.pinBlock.classList.toggle('has-pins', state.pins.length > 0);

    // 签名没变就只做属性校正，不重建 DOM（避免每次 sync 都闪一下）
    var sig = pinSignature();
    if (sig !== state.pinSig) {
      state.pinSig = sig;
      ui.pinList.innerHTML = '';

      state.pins.forEach(function (p) {
        var row = el('div', 'dsn-pinrow');
        row.dataset.id = p.id;
        row.dataset.title = p.title || '';

        if (state.selecting) {
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'dsn-itemcb';
          cb.checked = state.selected.has(p.id);
          cb.addEventListener('click', function (e) { e.stopPropagation(); });
          cb.addEventListener('change', function () {
            if (cb.checked) state.selected.add(p.id); else state.selected.delete(p.id);
            syncBars();
            row.classList.toggle('dsn-item-selected', cb.checked);
          });
          row.appendChild(cb);
        }

        var title = el('div', 'dsn-pintitle', p.title || '(未命名对话)');
        row.appendChild(title);

        var un = el('button', 'dsn-unpin', '✕');
        un.type = 'button';
        un.title = '取消置顶';
        un.addEventListener('click', function (e) {
          e.stopPropagation();
          setPinned(p.id, '', false);
          render();
          toast('已取消置顶');
        });
        row.appendChild(un);

        row.classList.toggle('dsn-item-selected', state.selecting && state.selected.has(p.id));

        row.addEventListener('click', function () {
          if (state.selecting) {
            if (state.selected.has(p.id)) state.selected.delete(p.id); else state.selected.add(p.id);
            render();
            return;
          }
          // 转发给官方隐藏项仍然是唯一可靠的触发 React 的路径；
          // 高亮由 syncActivePin() 立刻补到置顶行上。
          var target = state.rows.filter(function (r2) { return r2.id === p.id; })[0];
          if (target && target.el) {
            target.el.click();
            setTimeout(syncActivePin, 0);
          } else {
            toast('找不到这条对话，可能已被删除');
          }
        });

        ui.pinList.appendChild(row);
      });
    }

    syncActivePin();
  }

  function ensureItemControls(row) {
    var item = row.el;
    if (!item) return;
    item.dataset.dsnId = row.id || '';

    if (!item.querySelector('.dsn-itemcb')) {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'dsn-itemcb';
      cb.addEventListener('click', function (e) { e.stopPropagation(); });
      cb.addEventListener('change', function () {
        if (cb.checked) state.selected.add(row.id); else state.selected.delete(row.id);
        item.classList.toggle('dsn-item-selected', cb.checked);
        syncBars();
      });
      item.insertBefore(cb, item.firstChild);
    }
    var box = item.querySelector('.dsn-itemcb');
    if (box) box.checked = !!row.id && state.selected.has(row.id);

    var action = $(SEL.action, item) || item;
    var btn = action.querySelector('.dsn-pinbtn');
    if (!btn) {
      btn = el('button', 'dsn-pinbtn');
      btn.type = 'button';
      btn.innerHTML = ICON.pin;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
        togglePin(row.id, row.title);
      });
      action.insertBefore(btn, action.firstChild);
    }
    // 置顶判定：id 命中，或标题命中（同名对话一起抽离，避免下方重复出现）
    var pinned = (!!row.id && isPinned(row.id)) || state.pinTitles.has(row.title);
    btn.classList.toggle('on', pinned);
    btn.title = pinned ? '取消置顶' : '置顶这条对话';

    item.classList.toggle('dsn-item-selected', !!row.id && state.selected.has(row.id));

    // 隐藏判定只看标题（同名对话一起抽离），并且写 data 属性而不是 class
    applyPinMark(item);
  }

  function syncBars() {
    var n = state.selected.size;
    var total = state.rows.filter(function (r) { return r.id; }).length;
    ui.selInfo.textContent = '已选 ' + n;
    [ui.pinAct, ui.unpinAct, ui.delAct].forEach(function (b) { b.disabled = n === 0; });
    ui.cbAll.checked = total > 0 && n === total;
    ui.cbAll.indeterminate = n > 0 && n < total;
  }

  function render() {
    var wrap = $(SEL.wrap);
    var sider = $(SEL.sider);
    if (!wrap || !sider) {
      if (ui.selHead) ui.selHead.classList.remove('show');
      if (ui.selBar) ui.selBar.classList.remove('show');
      return;
    }
    buildChrome();
    if (ui.pinBlock.parentElement !== wrap) wrap.insertBefore(ui.pinBlock, wrap.firstChild);

    sider.classList.toggle('dsn-sel', state.selecting);
    wrap.classList.toggle('dsn-selecting', state.selecting);

    if (!positionChrome()) return;

    // 置顶标题集合：同名对话一起从下方列表抽离
    state.pinTitles = new Set(state.pins.map(function (p) { return (p.title || '').trim(); }).filter(Boolean));

    renderPinList();
    state.rows.forEach(ensureItemControls);
    placeMsButton();

    ui.selHead.classList.toggle('show', state.selecting);
    ui.selBar.classList.toggle('show', state.selecting);
    if (state.selecting) syncBars();
  }

  // 多选入口的落点：
  //  - 有置顶 → 放在「置顶」行右侧（官方位置）
  //  - 无置顶 → 放在第一个分组标题（如「今天」）右侧，不额外占一行（官方无置顶时就是这样）
  function placeMsButton() {
    var hasPins = state.pins.length > 0;
    ui.pinBlock.classList.toggle('has-pins', hasPins);
    ui.pinBlock.style.display = hasPins ? '' : 'none';

    var target = null;
    if (hasPins) {
      target = ui.pinHead;
    } else {
      var firstSection = $(SEL.wrap + ' .section-ac14ac');
      target = firstSection ? firstSection.querySelector('.sectionHeader-ac14ac') : null;
    }

    // 清掉旧的挂载点样式
    $$('.sectionHeader-ac14ac.dsn-has-ms').forEach(function (h) {
      if (h !== target) h.classList.remove('dsn-has-ms');
    });

    if (!target) {
      if (ui.msBtn.parentElement) ui.msBtn.parentElement.removeChild(ui.msBtn);
      return;
    }
    if (target !== ui.pinHead) target.classList.add('dsn-has-ms');
    if (ui.msBtn.parentElement !== target) target.appendChild(ui.msBtn);
  }

  /* ------------------------------------------------------------- 交互 */
  function togglePin(id, title) {
    if (!id) { toast('这条对话还没保存到本机'); return; }
    var on = !isPinned(id);
    setPinned(id, title, on);
    render();
    toast(on ? '已置顶' : '已取消置顶');
  }

  function setSelecting(on) {
    state.selecting = !!on;
    if (!state.selecting) state.selected.clear();
    render();
  }

  async function handleAction(act) {
    var ids = Array.from(state.selected);
    if (!ids.length) return;
    if (act === 'pin' || act === 'unpin') {
      ids.forEach(function (id) {
        var row = state.rows.filter(function (r) { return r.id === id; })[0];
        var meta = state.pins.filter(function (p) { return p.id === id; })[0];
        setPinned(id, row ? row.title : (meta ? meta.title : ''), act === 'pin');
      });
      render();
      toast((act === 'pin' ? '已置顶 ' : '已取消置顶 ') + ids.length + ' 条');
      return;
    }
    if (act === 'del') confirmDelete(ids);
  }

  function confirmDelete(ids) {
    var mask = el('div', 'dsm-mask');
    var box = el('div', 'dsm-box');
    box.appendChild(el('div', 'dsm-title', '删除 ' + ids.length + ' 条对话？'));
    var desc = el('div', 'dsm-desc');
    desc.textContent = '会连同它们的附件一起删除，无法撤销。建议先在管理页导出备份。';
    box.appendChild(desc);
    var row = el('div', 'dsm-row');
    var cancel = el('button', 'dsn-btn', '取消');
    var ok = el('button', 'dsn-btn dsn-danger-solid', '确认删除');
    cancel.type = 'button'; ok.type = 'button';
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    mask.appendChild(box);
    document.body.appendChild(mask);

    cancel.addEventListener('click', function () { mask.remove(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    ok.addEventListener('click', async function () {
      ok.disabled = true;
      ok.textContent = '删除中…';
      try {
        await deleteSessions(ids);
        state.pins = state.pins.filter(function (p) { return ids.indexOf(p.id) < 0; });
        savePins();
        mask.remove();
        toast('已删除 ' + ids.length + ' 条，正在刷新…');
        setTimeout(function () { location.reload(); }, 600);
      } catch (e) {
        ok.disabled = false;
        ok.textContent = '确认删除';
        toast('删除失败：' + (e && e.message ? e.message : e));
      }
    });
  }

  // 选择态下点整行 = 勾选，不打开对话
  document.addEventListener('click', function (e) {
    if (!state.selecting) return;
    if (!e.target.closest) return;
    if (e.target.closest('.dsn-itemcb') || e.target.closest('.dsn-msbtn') ||
      e.target.closest('.dsn-selbar') || e.target.closest('.dsn-selhead')) return;
    var item = e.target.closest(SEL.item);
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    var id = item.dataset.dsnId;
    if (!id) return;
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    render();
  }, true);

  /* ------------------------------------------------------------- 同步 */
  var syncTimer = null;
  async function sync() {
    if (state.syncing) return;
    state.syncing = true;
    state.applying = true;
    try {
      await mapRows();
      render();
    } catch (e) {
      /* ignore */
    } finally {
      state.syncing = false;
      setTimeout(function () { state.applying = false; }, 80);
    }
  }
  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay == null ? 180 : delay);
  }

  function boot() {
    loadPins();
    sync();

    var wrap = $(SEL.wrap);
    if (wrap) {
      var mo = new MutationObserver(function (records) {
        // 自己也改了 DOM 的那一小段窗口里不要回环，但「新会话项插进来」必须当帧处理
        var applying = state.applying;
        var needSync = false;
        for (var i = 0; i < records.length; i++) {
          var rec = records[i];
          if (rec.type === 'attributes') {
            // 官方切 active 类 → 立刻把高亮补到置顶行，不等 180ms
            if (!applying) syncActivePin();
            continue;
          }
          if (rec.type !== 'childList') continue;
          var nodes = rec.addedNodes;
          for (var k = 0; k < nodes.length; k++) {
            var n = nodes[k];
            if (n.nodeType !== 1) continue;
            if (/^dsn-/.test(n.className || '')) continue;   // 我自己的节点
            // ★ 关键：新挂上来的会话项当帧就打隐藏标记（跨分组重挂不会再露出重复项）
            var marked = applyPinMarkDeep(n);
            if (marked === null) needSync = true;            // 标题还没出来，交给整轮 sync
            else if (marked) syncActivePin();
            if (n.querySelector && n.querySelector(SEL.item)) needSync = true;
            else if (n.matches && n.matches(SEL.item)) needSync = true;
          }
          if (rec.removedNodes && rec.removedNodes.length) needSync = true;
        }
        if (needSync && !applying) scheduleSync();
      });
      mo.observe(wrap, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }

    window.addEventListener('resize', positionChrome);
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var b = e.target.closest('button[aria-label="收起边栏"],button[aria-label="打开边栏"]');
      if (b) setTimeout(function () { scheduleSync(280); }, 60);
    }, true);

    /* 官方「⋯」菜单打开期间，给所属会话行加 .dsn-menu-src（见 sidebar.css）：
     * 菜单 portal 到 body，鼠标移上去行就失去 :hover，官方随即把 .action-ff6fc9 隐藏，
     * 触发按钮 rect 归零 → 官方迷你 floating hook 重测后把菜单挪到左上角。撑住就没事。 */
    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      if (!e.target.closest('.action-ff6fc9')) return;
      var item = e.target.closest('.item-ff6fc9');
      if (!item) return;
      clearMenuSource();
      state.menuSrc = item;
      item.classList.add('dsn-menu-src');
      var n = 0;
      state.menuPoll = setInterval(function () {
        n++;
        if (!document.querySelector('[role="menu"]') || !document.contains(item) || n > 120) clearMenuSource();
      }, 120);
    }, true);

    // 兜底：官方重渲染可能把我加的类/节点冲掉，定期校正一次（只在确实不一致时动作）
    setInterval(function () {
      if (state.selecting || state.syncing) return;
      var need = false;
      if (state.pins.length) {
        $$(SEL.item).forEach(function (item) {
          if (state.pinTitles.has(itemTitle(item)) && item.dataset.dsnPinned !== '1') need = true;
        });
      }
      var firstHeader = $(SEL.wrap + ' .section-ac14ac .sectionHeader-ac14ac');
      if (!state.pins.length && firstHeader && ui.msBtn && ui.msBtn.parentElement !== firstHeader) need = true;
      if (need) render(); else syncActivePin();
    }, 1500);
  }

  var timer = setInterval(function () {
    if ($(SEL.wrap)) { clearInterval(timer); boot(); }
  }, 300);
  setTimeout(function () { clearInterval(timer); if (!ui.pinBlock) boot(); }, 12000);
})();
