// ログイン必須の GAS 操作を「受付」Cloud Function (callGasAuthed) 経由で呼ぶ共通口。
//
// 従来は各画面が GAS Web App (ANYONE_ANONYMOUS) に fetch で直接 POST していたため、
// exCode さえ知れば誰でも運営者権限で操作・メール送信できる状態だった。
// この共通口を通すことで、Firebase Auth + organizer/operator 認可を CF 側で
// 検証してから ADMIN_SECRET 付きで GAS に中継する。
//
// 前提: firebase-app-compat / firebase-functions-compat が先に読み込まれ、
//       firebase.initializeApp 済みであること。
//
// 使い方:
//   const res = await gasCallAuthed('sendArtistGuide', { ex: currentEx, subject, body });
//   // res は GAS doPost の JSON (例: { success: true, to: '...' }) がそのまま返る。
(function () {
  'use strict';

  function gasCallAuthed(action, params) {
    var fn = firebase.app().functions('asia-northeast1').httpsCallable('callGasAuthed');
    return fn({ action: action, params: params || {} }).then(function (res) {
      return (res && res.data) || {};
    });
  }

  window.gasCallAuthed = gasCallAuthed;
})();
