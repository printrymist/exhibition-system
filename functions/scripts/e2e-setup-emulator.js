// e2e-setup-emulator.js — 展覧会作成 (setup.html) を Firebase エミュレータ上で最初から最後まで通すテスト。
// 本物の setup.html をブラウザで操作し、本物の Cloud Function・Firestore (ルール込み)・Auth のエミュレータで動かす。
// メールは送らず、エミュレータ内の _emulator_mail に記録される (sendMailViaResend の分岐)。
//
// 使い方 (リポジトリ直下で):
//   1) functions/.secret.local にダミーの秘密の値 (RESEND_API_KEY=... 等、全 defineSecret 分)
//   2) firebase emulators:exec --config firebase.e2e.json --only auth,firestore,functions,hosting \
//        --project rohei-printer-system "node functions/scripts/e2e-setup-emulator.js"
//   (ポートは firebase.e2e.json。本番の firebase.json は変えない)
//   Firestore エミュレータには Java が必要。ブラウザ操作は playwright-core (NODE_PATH で指定) と
//   Playwright の Chromium (CHROME_PATH で指定可)。
"use strict";
const path = require("path");
const assert = require("assert");
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:18080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:19099";
const PROJECT = "rohei-printer-system";
const admin = require("firebase-admin");
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const { chromium } = require("playwright-core");

const HOSTING = "http://127.0.0.1:15000";
const FN = "http://127.0.0.1:15001/" + PROJECT + "/asia-northeast1/";
// ページの firebase をエミュレータにつなぐ (initializeApp の直後に useEmulator)
const CONNECT = `;(function(){
  var orig = firebase.initializeApp;
  firebase.initializeApp = function () {
    var app = orig.apply(this, arguments);
    try { app.functions('asia-northeast1').useEmulator('127.0.0.1', 15001); } catch (e) {}
    try { app.firestore().useEmulator('127.0.0.1', 18080); } catch (e) {}
    try { app.auth().useEmulator('http://127.0.0.1:19099', { disableWarnings: true }); } catch (e) {}
    return app;
  };
})();`;

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}
async function latestMail(to) {
  const s = await db.collection("_emulator_mail").where("to", "==", to).get();
  return s.docs.map((d) => d.data()).sort((a, b) => a.at.localeCompare(b.at)).pop();
}
async function callFn(name, data) {
  const r = await fetch(FN + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }) });
  return r.json();
}
const future = (days) => new Date(Date.now() + days * 86400000 + 9 * 3600000).toISOString().slice(0, 10);

(async () => {
  const exe = process.env.CHROME_PATH || path.join(process.env.LOCALAPPDATA || "", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe");
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext();
  await ctx.route("**/firebase-firestore-compat.js", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()) + CONNECT });
  });
  const pageErrors = [];
  const open = async (url) => {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => pageErrors.push(url + ": " + e.message));
    await p.goto(HOSTING + url);
    return p;
  };
  const email = "e2e-org-" + Date.now() + "@example.com";
  let token = ""; let exCode = "";

  console.log("setup.html を画面で操作 (申請 → 確認 → 作成)");
  await test("申請フォームから送信 → 受付画面、確認メール (token 付き) が記録される", async () => {
    const p = await open("/setup.html");
    await p.waitForSelector("#applyView", { state: "visible" });
    await p.fill("#applyExName", "E2E Test Exhibition 2026");
    await p.fill("#applyVenue", "テスト会場");
    await p.fill("#applyStartDate", future(20));
    await p.fill("#applyOrganizer", "テスト主催者");
    await p.fill("#applyEmail", email);
    await p.evaluate(() => submitApplication());
    await p.waitForSelector("#appliedView", { state: "visible", timeout: 30000 });
    const m = await latestMail(email.toLowerCase());
    assert.ok(m && /メールアドレスの確認/.test(m.subject), "確認メール");
    token = (m.text.match(/token=([0-9a-f-]{36})/) || [])[1];
    assert.ok(token);
    await p.close();
  });
  await test("確認メールのリンク → フォーム → 作成 → 完了画面", async () => {
    const p = await open("/setup.html?token=" + token);
    await p.waitForSelector("#formView", { state: "visible", timeout: 30000 });
    assert.strictEqual(await p.inputValue("#exName"), "E2E Test Exhibition 2026");
    await p.fill("#workCount", "3");
    await p.evaluate(() => submitForm());
    await p.waitForSelector("#doneView", { state: "visible", timeout: 60000 });
    const info = await p.textContent("#infoBox");
    exCode = (info.match(/展覧会コード\s*([A-Z0-9]+)/) || [])[1];
    assert.ok(exCode && /^E2E/.test(exCode), "展覧会コード " + exCode + " / " + info);
    await p.close();
  });
  await test("Firestore の中身: 展覧会データ・作品枠3・短縮QR3・申請に作成済みの印・完了メール", async () => {
    const ex = (await db.collection("exhibitions").doc(exCode).get()).data();
    assert.ok(ex, "展覧会データ");
    assert.strictEqual(ex.email, email.toLowerCase());
    assert.strictEqual(ex.is_sandbox, true); // 申請フォームの練習モードは既定でオン
    assert.ok(ex.expire_at && ex.last_artwork_seq === 3 && ex.registration_fields);
    const arts = await db.collection("artworks").where("exCode", "==", exCode).get();
    assert.strictEqual(arts.size, 3);
    assert.strictEqual(arts.docs[0].data().organizerEmail, email.toLowerCase());
    const qrs = await db.collection("qr_codes").where("exCode", "==", exCode).get();
    assert.strictEqual(qrs.size, 3);
    const app = (await db.collection("applications").doc(token).get()).data();
    assert.ok(app.confirmed === true && app.ex_code === exCode && app.setup_at);
    const m = await latestMail(email.toLowerCase());
    assert.ok(/Setup Complete/.test(m.subject) && m.text.includes(exCode));
  });
  await test("同じ申請のリンクをもう一度開く → 作成済みの案内", async () => {
    const p = await open("/setup.html?token=" + token);
    await p.waitForSelector("#alreadyView", { state: "visible", timeout: 30000 });
    assert.ok((await p.getAttribute("#alreadyRegisterLink", "href")).endsWith("ex=" + exCode));
    await p.close();
  });
  await test("Firestore に無い token (切り替え前の申請) → 再申請の案内", async () => {
    const p = await open("/setup.html?token=00000000-1111-2222-3333-444444444444");
    await p.waitForSelector("#confirmErrorView", { state: "visible", timeout: 30000 });
    assert.ok(/もう一度申請/.test(await p.textContent("#confirmErrorMsg")));
    await p.close();
  });

  console.log("トランザクション (本物の Firestore)");
  await test("同じ申請で作成を同時に5回呼んでも展覧会は1つだけ", async () => {
    await callFn("submitApplication", { exName: "Race", venue: "v", startDate: future(5), organizer: "o", email: "race@example.com", sandbox: false });
    const t = ((await latestMail("race@example.com")).text.match(/token=([0-9a-f-]{36})/) || [])[1];
    await callFn("confirmApplication", { token: t });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => callFn("createExhibition", { token: t, workCount: 1 })));
    const codes = new Set(rs.map((r) => r.result && r.result.exCode).filter(Boolean));
    assert.strictEqual(codes.size, 1, "返ってきたコード " + JSON.stringify(rs));
    const exs = await db.collection("exhibitions").where("application_id", "==", t).get();
    assert.strictEqual(exs.size, 1);
  });

  console.log("Firestore のルール (applications)");
  const ruleCheck = async (who) => {
    const p = await open("/setup.html");
    await p.waitForFunction(() => window.firebase && firebase.apps.length > 0);
    return p.evaluate(async ({ who, token, pw }) => {
      if (who) await firebase.auth().signInWithEmailAndPassword(who, pw);
      const out = {};
      try { await firebase.firestore().collection("applications").doc(token).get(); out.get = "ok"; } catch (e) { out.get = e.code; }
      try { await firebase.firestore().collection("applications").get(); out.list = "ok"; } catch (e) { out.list = e.code; }
      try { await firebase.firestore().collection("applications").doc("x").set({ a: 1 }); out.write = "ok"; } catch (e) { out.write = e.code; }
      return out;
    }, { who, token, pw: "pass1234" });
  };
  for (const u of [email.toLowerCase(), "rymist1@gmail.com"]) {
    try { await admin.auth().createUser({ email: u, password: "pass1234", emailVerified: true }); } catch (e) { /* 既存 */ }
  }
  await test("未ログイン: 申請データは読めない・書けない", async () => {
    const r = await ruleCheck(null);
    assert.deepStrictEqual(r, { get: "permission-denied", list: "permission-denied", write: "permission-denied" });
  });
  await test("主催者 (申請した本人でも): 読めない・書けない", async () => {
    const r = await ruleCheck(email.toLowerCase());
    assert.deepStrictEqual(r, { get: "permission-denied", list: "permission-denied", write: "permission-denied" });
  });
  await test("運営者: 読める (台帳)、書けない", async () => {
    const r = await ruleCheck("rymist1@gmail.com");
    assert.deepStrictEqual(r, { get: "ok", list: "ok", write: "permission-denied" });
  });

  await test("ページエラーなし", async () => { assert.deepStrictEqual(pageErrors, []); });
  await browser.close();
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed);
})().catch((e) => { console.error(e); process.exit(99); });
