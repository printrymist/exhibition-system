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

  // 控えたメールアドレスが無い/一致しないときに、画面上にフォーム(モーダル)を出して
  // 本人に再入力してもらう。window.prompt() はスマホのメールアプリ内蔵ブラウザ
  // (Gmailアプリ内WebView等) の多くでブロック/無視され、何も表示されず失敗するだけに
  // なる (2026-09-20 実地報告で発覚)。completeSignInIfNeeded は 16 画面から呼ばれる
  // 共通関数なので、各画面に個別のフォームを作らせず、ここに1つだけ実装して
  // 呼び出し側の見た目・呼び方を一切変えずに直す。
  function showEmailConfirmModal(onSubmit) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99999;'
      + 'display:flex;align-items:center;justify-content:center;padding:16px;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:10px;padding:20px;max-width:360px;'
      + 'width:100%;box-shadow:0 4px 24px rgba(0,0,0,.25);';

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;margin-bottom:8px;';
    title.textContent = '📧 ログインの確認';

    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:.85em;color:#555;margin-bottom:12px;line-height:1.5;';
    desc.textContent = 'ログインを完了するため、メールリンクを送った先のメールアドレスをもう一度入力してください。';

    var input = document.createElement('input');
    input.type = 'email';
    input.autocomplete = 'email';
    input.placeholder = 'メールアドレス';
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;'
      + 'border-radius:6px;font-size:16px;margin-bottom:8px;';

    var errEl = document.createElement('div');
    errEl.style.cssText = 'color:#d93025;font-size:.85em;min-height:1.2em;margin-bottom:8px;';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.textContent = 'ログイン';
    submitBtn.style.cssText = 'flex:1;padding:10px;background:#1a73e8;color:#fff;border:none;'
      + 'border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer;';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '閉じる';
    closeBtn.style.cssText = 'padding:10px 14px;background:#eee;color:#555;border:none;'
      + 'border-radius:6px;font-size:14px;cursor:pointer;';

    row.appendChild(submitBtn);
    row.appendChild(closeBtn);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(input);
    card.appendChild(errEl);
    card.appendChild(row);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    input.focus();

    function remove() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function submit() {
      errEl.textContent = '';
      var addr = normalizeEmail(input.value);
      if (!addr) { errEl.textContent = 'メールアドレスを入力してください。'; return; }
      submitBtn.disabled = true;
      submitBtn.textContent = '確認中...';
      onSubmit(addr)
        .then(function () { remove(); })
        .catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'ログイン';
          errEl.textContent = friendlyErrForModal(err);
        });
    }
    submitBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    closeBtn.addEventListener('click', remove);
  }

  // このファイルは friendly-error.js に依存させたくない (読み込み順を各画面に強制しない)
  // ので、モーダル内だけの簡易な日本語化に留める。
  function friendlyErrForModal(err) {
    var code = (err && err.code) || '';
    if (code === 'auth/invalid-action-code') return 'リンクの有効期限が切れているか、既に使用済みです。';
    if (code === 'auth/invalid-email') return 'メールアドレスの形式が正しくありません。';
    return 'ログインできませんでした。メールアドレスをご確認のうえもう一度お試しください。';
  }

  // 現在の URL がメールリンクなら sign-in を完了させる。
  // 完了したら user オブジェクトを返し、URL から認証パラメータを除去する。
  // メールリンクでなければ null を返す。控えたアドレスが無い/失敗したときは
  // モーダルで本人に再入力してもらい、それでも入力されない (閉じるを押した) 場合は
  // ずっと解決しない = 呼び出し側の .then は呼ばれない (元々 prompt() をキャンセルした
  // ときも then が呼ばれなかったのと同じ挙動)。
  function completeSignInIfNeeded() {
    var auth = firebase.auth();
    var href = window.location.href;
    if (!auth.isSignInWithEmailLink(href)) {
      return Promise.resolve(null);
    }

    function askViaModal() {
      return new Promise(function (resolve) {
        showEmailConfirmModal(function (addr) {
          return auth.signInWithEmailLink(addr, href).then(function (result) {
            clearSignInEmail();
            cleanAuthParamsFromUrl();
            resolve(result.user);
            return result;
          });
        });
      });
    }

    var saved = loadSignInEmail();
    if (!saved) return askViaModal();
    // 控えたアドレスで試し、失敗したら (控えが別人のもの/古いもの) 破棄して
    // モーダルでの再入力を促す。ここで諦めるとログインできない。
    return auth.signInWithEmailLink(String(saved).trim(), href)
      .then(function (result) {
        clearSignInEmail();
        cleanAuthParamsFromUrl();
        return result.user;
      })
      .catch(function (_err) {
        clearSignInEmail();
        return askViaModal();
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
