// Firebase Email Link 認証 (運営者用) のヘルパ
// 前提: firebase-app-compat / firebase-auth-compat / firebase-functions-compat が先に読み込まれていること
// メール送信は asia-northeast1 にデプロイした Cloud Function `sendSignInLink` 経由 (= 自前 SMTP)。
// Firebase 標準の sendSignInLinkToEmail は Email Link テンプレが日本語非対応のため使わない。

(function () {
  'use strict';

  // 運営者として認める email リスト (将来増やしたい場合はここに追加)
  // Firestore セキュリティルール側 (isOperator) と内容を一致させる必要がある。
  const OPERATOR_EMAILS = ['rymist1@gmail.com'];

  function normalizeEmail(s) {
    return (s || '').trim().toLowerCase();
  }

  function isOperatorEmail(email) {
    return OPERATOR_EMAILS.indexOf(normalizeEmail(email)) !== -1;
  }

  function isOperatorUser(user) {
    return !!(user && user.email && isOperatorEmail(user.email));
  }

  // 現在のページ URL から Firebase が付加する認証パラメータを取り除く
  function cleanAuthParamsFromUrl() {
    try {
      var url = new URL(window.location.href);
      ['apiKey', 'oobCode', 'mode', 'continueUrl', 'lang'].forEach(function (k) {
        url.searchParams.delete(k);
      });
      window.history.replaceState({}, '', url.toString());
    } catch (e) {
      // URL constructor が使えない極端に古いブラウザは何もしない
    }
  }

  // メールリンクを開いたときの本人確認用に、送信先アドレスを端末に控えておく。
  // 期限を切らないと、共用 PC で前の人のアドレスが残り続け、次の人が自分のリンクを
  // 開いたときに他人のアドレスでサインインを試みて不可解なエラーになる。
  const EMAIL_KEY = 'emailForSignIn';
  const EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

  function saveSignInEmail(addr) {
    try {
      window.localStorage.setItem(EMAIL_KEY, JSON.stringify({ email: addr, ts: Date.now() }));
    } catch (_e) {}
  }

  function clearSignInEmail() {
    try { window.localStorage.removeItem(EMAIL_KEY); } catch (_e) {}
  }

  // 期限内なら控えたアドレスを返す。期限切れ・壊れた値は破棄して null。
  function loadSignInEmail() {
    var raw = null;
    try { raw = window.localStorage.getItem(EMAIL_KEY); } catch (_e) {}
    if (!raw) return null;
    var o = null;
    try {
      o = JSON.parse(raw);
    } catch (_e) {
      // 旧形式 (アドレスの生文字列)。この修正の直前にリンクを送った人を弾かないよう
      // そのまま使う。他人の残骸だった場合はサインインに失敗し、下で破棄 + 再入力になる。
      return raw;
    }
    if (o && typeof o.email === 'string' && typeof o.ts === 'number') {
      // 端末の時計が進んでいると経過時間が負になる。軽い進み (5 分) だけ許容する。
      var age = Date.now() - o.ts;
      if (age > -5 * 60 * 1000 && age < EMAIL_TTL_MS) return o.email;
    }
    clearSignInEmail();
    return null;
  }

  // メールリンクの送信 (Cloud Function 経由)
  // email: 送信先アドレス (string)
  // 返り値: Promise<void>
  function sendSignInLink(email) {
    var addr = normalizeEmail(email);
    if (!addr) return Promise.reject(new Error('email is required'));
    var fn = firebase.app().functions('asia-northeast1').httpsCallable('sendSignInLink');
    return fn({ email: addr, continueUrl: window.location.href })
      .then(function () {
        saveSignInEmail(addr);
      });
  }

  // 現在の URL がメールリンクなら sign-in を完了させる。
  // 完了したら user オブジェクトを返し、URL から認証パラメータを除去する。
  // メールリンクでなければ null を返す。
  function completeSignInIfNeeded() {
    var auth = firebase.auth();
    var href = window.location.href;
    if (!auth.isSignInWithEmailLink(href)) {
      return Promise.resolve(null);
    }
    // 控えたアドレスで試し、失敗したらそれを破棄して本人に再入力してもらう。
    // (控えが別人のもの / 古いものだったケース。ここで諦めるとログインできない)
    function signInWith(email, fromStorage) {
      return auth.signInWithEmailLink(String(email).trim(), href)
        .then(function (result) {
          clearSignInEmail();
          cleanAuthParamsFromUrl();
          return result.user;
        })
        .catch(function (err) {
          clearSignInEmail();
          if (!fromStorage) throw err;
          return askEmailAndSignIn();
        });
    }

    // 別端末でリンクを開いた場合などはここに来る。本人確認のため入力を求める。
    function askEmailAndSignIn() {
      var typed = window.prompt('確認のため、ログインに使用したメールアドレスを入力してください:');
      if (!typed) {
        return Promise.reject(new Error('Email is required to complete sign-in'));
      }
      return signInWith(typed, false);
    }

    var saved = loadSignInEmail();
    return saved ? signInWith(saved, true) : askEmailAndSignIn();
  }

  // 現在ログイン中の運営者ユーザを返す。未ログインまたは非運営者なら null。
  function currentOperator() {
    var u = firebase.auth().currentUser;
    return isOperatorUser(u) ? u : null;
  }

  // 認証状態の購読。コールバックは (user, isOperator) を受け取る。
  // unsubscribe 関数を返す。
  function onAuthChange(callback) {
    return firebase.auth().onAuthStateChanged(function (user) {
      callback(user, isOperatorUser(user));
    });
  }

  function signOut() {
    return firebase.auth().signOut();
  }

  window.operatorAuth = {
    OPERATOR_EMAILS: OPERATOR_EMAILS.slice(),
    isOperatorEmail: isOperatorEmail,
    isOperatorUser: isOperatorUser,
    sendSignInLink: sendSignInLink,
    completeSignInIfNeeded: completeSignInIfNeeded,
    currentOperator: currentOperator,
    onAuthChange: onAuthChange,
    signOut: signOut,
  };
})();
