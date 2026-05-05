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

  // メールリンクの送信 (Cloud Function 経由)
  // email: 送信先アドレス (string)
  // 返り値: Promise<void>
  function sendSignInLink(email) {
    var addr = normalizeEmail(email);
    if (!addr) return Promise.reject(new Error('email is required'));
    var fn = firebase.app().functions('asia-northeast1').httpsCallable('sendSignInLink');
    return fn({ email: addr, continueUrl: window.location.href })
      .then(function () {
        window.localStorage.setItem('emailForSignIn', addr);
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
    var email = window.localStorage.getItem('emailForSignIn');
    if (!email) {
      // 別端末でリンクを開いた場合などはここに来る。本人確認のため再入力を求める。
      email = window.prompt('確認のため、ログインに使用したメールアドレスを入力してください:');
      if (!email) {
        return Promise.reject(new Error('Email is required to complete sign-in'));
      }
    }
    return auth.signInWithEmailLink(email.trim(), href)
      .then(function (result) {
        window.localStorage.removeItem('emailForSignIn');
        cleanAuthParamsFromUrl();
        return result.user;
      });
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
