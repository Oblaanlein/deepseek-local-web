/* 在官方 bundle 之前加载：只做「观察」，不改行为。
   目的：记录当前打开的会话 id（官方把 activeId 放在 React state 里，URL 里没有）。 */
(function () {
  'use strict';
  var state = { sessionId: null, updatedAt: 0 };
  window.__DS_LOCAL__ = state;

  try {
    var proto = IDBObjectStore.prototype;

    var origGet = proto.get;
    proto.get = function (key) {
      var req = origGet.apply(this, arguments);
      try {
        if (this.name === 'sessions' && typeof key === 'string') {
          req.addEventListener('success', function () {
            if (req.result) { state.sessionId = key; state.updatedAt = Date.now(); }
          });
        }
      } catch (e) {}
      return req;
    };

    var origPut = proto.put;
    proto.put = function (value) {
      var req = origPut.apply(this, arguments);
      try {
        if (this.name === 'sessions' && value && typeof value.id === 'string') {
          state.sessionId = value.id; state.updatedAt = Date.now();
        }
      } catch (e) {}
      return req;
    };
  } catch (e) {
    /* 拦截失败时 overlay 会退化为按文本匹配 */
  }
})();
