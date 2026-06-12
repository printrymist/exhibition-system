/**
 * 来場者識別 ID + 所有鍵の永続化 (Phase V1: 三重冗長化)
 *
 * sessionId: 「いいね・コメントの所有」を表す公開識別子。集計 (analytics) にも使う。
 *            likes は公開 read なので doc 上で誰でも見える前提の値。
 * ownerKey:  いいね・コメントの取消 / 削除 / 編集の本人確認に使う秘密鍵 (#3 対策)。
 *            doc には ownerKey そのものではなく sha256(ownerKey) の「指紋」だけを保存する。
 *            削除/編集時は CF に ownerKey を渡し、CF が指紋を照合してから admin SDK で処理する。
 *            これにより、公開される sessionId を拾っても他人のいいねは消せない。
 *
 * いずれも 3 つのストレージ (localStorage / cookie / IndexedDB) に同期保存する:
 *   1. localStorage (主、最速)
 *   2. cookie       (localStorage クリアでも残る、Safari ITP 7 日)
 *   3. IndexedDB    (一部の「閲覧データ消去」が触らない)
 *
 * 使い方:
 *   <script src="/sessionid.js"></script>
 *   await window.restoreSessionIdFromIDB();    // 起動時に 1 回 (sessionId + ownerKey を IDB から復元)
 *   const sid  = window.getOrCreateSessionId();
 *   const hash = await window.getOwnerKeyHash(); // like 作成時に doc へ保存する指紋
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'rohei_session_id';
  var COOKIE_NAME = 'rohei_sid';
  var OWNER_STORAGE_KEY = 'rohei_owner_key';
  var OWNER_COOKIE_NAME = 'rohei_ok';
  var IDB_NAME = 'rohei_session';
  var IDB_STORE = 'kv';
  var IDB_KEY_SESSION = 'sessionId';
  var IDB_KEY_OWNER = 'ownerKey';
  var COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 年 (Safari ITP は 7 日に縮める)

  function generateNewId() {
    return 's_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // 削除権限の鍵なので、sessionId の Math.random とは別水準で暗号学的に強い乱数を使う。
  function generateOwnerKey() {
    try {
      if (window.crypto && typeof crypto.randomUUID === 'function') {
        return 'ok_' + crypto.randomUUID().replace(/-/g, '');
      }
      if (window.crypto && crypto.getRandomValues) {
        var arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return 'ok_' + Array.prototype.map.call(arr, function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      }
    } catch (_e) { /* fall through */ }
    return 'ok_' + Date.now() + Math.random().toString(36).substr(2, 12);
  }

  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (_e) { return null; }
  }

  function writeCookie(name, val) {
    try {
      document.cookie = name + '=' + encodeURIComponent(val)
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

  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).catch(function () { /* ignore */ });
  }

  // 起動時に 1 回呼ぶ。localStorage が空なら cookie / IndexedDB から
  // sessionId / ownerKey の両方を復元する。
  function restoreSessionIdFromIDB() {
    var tasks = [];

    if (!localStorage.getItem(STORAGE_KEY)) {
      var sidCookie = readCookie(COOKIE_NAME);
      if (sidCookie) {
        try { localStorage.setItem(STORAGE_KEY, sidCookie); } catch (_e) {}
      } else {
        tasks.push(idbGet(IDB_KEY_SESSION).then(function (v) {
          if (v) { try { localStorage.setItem(STORAGE_KEY, v); } catch (_e) {} }
        }));
      }
    }

    if (!localStorage.getItem(OWNER_STORAGE_KEY)) {
      var okCookie = readCookie(OWNER_COOKIE_NAME);
      if (okCookie) {
        try { localStorage.setItem(OWNER_STORAGE_KEY, okCookie); } catch (_e) {}
      } else {
        tasks.push(idbGet(IDB_KEY_OWNER).then(function (v) {
          if (v) { try { localStorage.setItem(OWNER_STORAGE_KEY, v); } catch (_e) {} }
        }));
      }
    }

    return Promise.all(tasks).then(function () {});
  }

  // sync で sessionId を返す。3 ストレージに同期して書き戻す。
  function getOrCreateSessionId() {
    var sid = null;
    try { sid = localStorage.getItem(STORAGE_KEY); } catch (_e) {}
    if (!sid) {
      try { sid = sessionStorage.getItem(STORAGE_KEY); } catch (_e) {}
    }
    if (!sid) sid = readCookie(COOKIE_NAME);
    if (!sid) sid = generateNewId();

    try { localStorage.setItem(STORAGE_KEY, sid); } catch (_e) {}
    try { sessionStorage.setItem(STORAGE_KEY, sid); } catch (_e) {}
    writeCookie(COOKIE_NAME, sid);
    idbSet(IDB_KEY_SESSION, sid); // fire and forget
    return sid;
  }

  // sync で ownerKey (秘密鍵) を返す。3 ストレージに同期して書き戻す。
  // この値そのものは外部に送らない (送るのは指紋、または削除時に CF へ直接のみ)。
  function getOrCreateOwnerKey() {
    var key = null;
    try { key = localStorage.getItem(OWNER_STORAGE_KEY); } catch (_e) {}
    if (!key) key = readCookie(OWNER_COOKIE_NAME);
    if (!key) key = generateOwnerKey();

    try { localStorage.setItem(OWNER_STORAGE_KEY, key); } catch (_e) {}
    writeCookie(OWNER_COOKIE_NAME, key);
    idbSet(IDB_KEY_OWNER, key); // fire and forget
    return key;
  }

  // ownerKey の SHA-256 指紋 (hex 64 文字)。doc に保存し、削除時に CF が照合する。
  // crypto.subtle は安全コンテキスト (https / localhost) でのみ動く。
  function computeOwnerKeyHash(key) {
    var enc = new TextEncoder().encode(key);
    return crypto.subtle.digest('SHA-256', enc).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    });
  }

  // like / comment 作成時に doc へ入れる ownerKeyHash を返す (async)。
  function getOwnerKeyHash() {
    return computeOwnerKeyHash(getOrCreateOwnerKey());
  }

  window.restoreSessionIdFromIDB = restoreSessionIdFromIDB;
  window.getOrCreateSessionId = getOrCreateSessionId;
  window.getOrCreateOwnerKey = getOrCreateOwnerKey;
  window.getOwnerKeyHash = getOwnerKeyHash;
})();
