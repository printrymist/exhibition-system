/**
 * 来場者識別 ID の永続化 (Phase V1: 三重冗長化)
 *
 * 同一ブラウザでの「いいね・コメントの所有」を維持するための識別子を
 * 3 つのストレージに同期して保存する:
 *   1. localStorage (主、最速、最も使われる)
 *   2. cookie       (localStorage クリアでも残る、Safari ITP 7 日)
 *   3. IndexedDB    (一部の「閲覧データ消去」が触らない)
 *
 * いずれか 1 つにでも残っていれば identity を復元する。
 * 完全クロス端末ではない (それは将来の visitor アカウント機能で対応)。
 *
 * 使い方:
 *   <script src="/sessionid.js"></script>
 *   await window.restoreSessionIdFromIDB();   // 起動時に 1 回
 *   const sid = window.getOrCreateSessionId();
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'rohei_session_id';
  var COOKIE_NAME = 'rohei_sid';
  var IDB_NAME = 'rohei_session';
  var IDB_STORE = 'kv';
  var IDB_KEY = 'sessionId';
  var COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 年 (Safari ITP は 7 日に縮める)

  function generateNewId() {
    return 's_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function readCookie() {
    try {
      var m = document.cookie.match(
        new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'),
      );
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_e) { return null; }
  }

  function writeCookie(sid) {
    try {
      document.cookie = COOKIE_NAME + '=' + encodeURIComponent(sid)
        + '; Max-Age=' + COOKIE_MAX_AGE + '; Path=/; SameSite=Lax';
    } catch (_e) { /* ignore */ }
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no-idb')); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore(IDB_STORE); } catch (_e) {}
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  function idbSet(sid) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(sid, IDB_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () { /* ignore */ });
  }

  // 起動時に 1 回呼ぶ。localStorage が空なら cookie / IndexedDB から復元する。
  // (cookie は sync で読めるので getOrCreateSessionId 内でも処理しているが、
  //  IndexedDB は async なので事前 await が必要。)
  function restoreSessionIdFromIDB() {
    if (localStorage.getItem(STORAGE_KEY)) return Promise.resolve();
    var fromCookie = readCookie();
    if (fromCookie) {
      try { localStorage.setItem(STORAGE_KEY, fromCookie); } catch (_e) {}
      return Promise.resolve();
    }
    return idbGet().then(function (fromIdb) {
      if (fromIdb) {
        try { localStorage.setItem(STORAGE_KEY, fromIdb); } catch (_e) {}
      }
    });
  }

  // sync で sessionId を返す。3 ストレージに同期して書き戻す。
  function getOrCreateSessionId() {
    var sid = null;
    try { sid = localStorage.getItem(STORAGE_KEY); } catch (_e) {}
    if (!sid) {
      try { sid = sessionStorage.getItem(STORAGE_KEY); } catch (_e) {}
    }
    if (!sid) sid = readCookie();
    if (!sid) sid = generateNewId();

    try { localStorage.setItem(STORAGE_KEY, sid); } catch (_e) {}
    try { sessionStorage.setItem(STORAGE_KEY, sid); } catch (_e) {}
    writeCookie(sid);
    idbSet(sid); // fire and forget
    return sid;
  }

  window.restoreSessionIdFromIDB = restoreSessionIdFromIDB;
  window.getOrCreateSessionId = getOrCreateSessionId;
})();
