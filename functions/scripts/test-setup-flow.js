// test-setup-flow.js — 展覧会作成 (申請 → メール確認 → 作成) と、マスター・スプレッドシート退役で
// Cloud Function に移した処理のテスト。本物の Firestore / メール送信の代わりに、記録するだけの
// ダミーを使う (Firestore エミュレータは Java が要るため)。
// 使用: node functions/scripts/test-setup-flow.js   (functions/node_modules が必要)
// 終了コード: 失敗数
"use strict";
const path = require("path");
const Module = require("module");
const assert = require("assert");

// ── ダミーの Firestore (必要な操作だけ) ──
const store = {}; // "coll/id" -> data
const clone = (v) => JSON.parse(JSON.stringify(v));
function docRef(coll, id) {
  const key = coll + "/" + id;
  const ref = {
    id, path: key,
    async get() { return snap(ref); },
    async set(data, opts) { store[key] = (opts && opts.merge && store[key]) ? Object.assign({}, store[key], clone(data)) : clone(data); },
    async update(data) { if (!store[key]) throw new Error("NOT_FOUND " + key); Object.assign(store[key], clone(data)); },
    async delete() { delete store[key]; },
  };
  return ref;
}
function snap(ref) {
  const d = store[ref.path];
  return { id: ref.id, ref, exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) };
}
function query(coll, filters) {
  return {
    where(f, op, v) { return query(coll, filters.concat([[f, op, v]])); },
    limit() { return query(coll, filters); },
    async get() {
      const docs = Object.keys(store).filter((k) => k.startsWith(coll + "/")).map((k) => snap(docRef(coll, k.slice(coll.length + 1))))
        .filter((s) => filters.every(([f, op, v]) => op === "==" && s.data()[f] === v));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}
const fakeDb = {
  collection(coll) {
    const q = query(coll, []);
    return Object.assign(q, {
      doc: (id) => docRef(coll, id),
      async add(data) { const id = "auto" + Object.keys(store).length; await docRef(coll, id).set(data); return docRef(coll, id); },
    });
  },
  async runTransaction(fn) {
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, d, o) => { ref.set(d, o); },
      update: (ref, d) => { ref.update(d); },
      create: (ref, d) => { if (store[ref.path]) throw new Error("ALREADY_EXISTS"); ref.set(d); },
    };
    return fn(tx);
  },
};
const fakeAdmin = {
  initializeApp() {},
  firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => "SERVER_TS", delete: () => null, increment: (n) => n } }),
  storage: () => ({ bucket: () => ({ getFiles: async () => [[]], deleteFiles: async () => {}, file: () => ({ delete: async () => {} }) }) }),
  auth: () => ({}),
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "firebase-admin") return fakeAdmin;
  return origLoad.call(this, req, ...rest);
};

// ── メール送信 (Resend) と GAS への通信を記録するだけにする ──
const mails = [];
const otherFetch = [];
global.fetch = async (url, opts) => {
  if (String(url).includes("api.resend.com")) {
    const b = JSON.parse(opts.body);
    mails.push({ to: b.to[0], subject: b.subject, text: b.text });
    return { ok: true, json: async () => ({ id: "m" + mails.length }), text: async () => "" };
  }
  otherFetch.push(String(url));
  return { ok: true, json: async () => ({ success: true }), text: async () => "" };
};
process.env.RESEND_API_KEY = "test";
process.env.ARTIST_TOKEN_SECRET = "test-secret";
process.env.GAS_ADMIN_SECRET = "test-admin";

const F = require(path.join(__dirname, "..", "index.js"));

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n      " + (e && e.message)); }
}
async function rejects(p, code, re) {
  try { await p; } catch (e) {
    if (code) assert.strictEqual(e.code, code, "code " + e.code + " (" + e.message + ")");
    if (re) assert.ok(re.test(e.message), "message: " + e.message);
    return;
  }
  throw new Error("失敗するはずが成功した");
}
const call = (fn, data, email) => fn.run({ data, auth: email ? { uid: "u", token: { email } } : undefined, rawRequest: {} });
const future = (days) => new Date(Date.now() + days * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
const tokenFrom = (m) => (m.text.match(/token=([0-9a-f-]{36})/) || [])[1];

(async () => {
  console.log("申請 (submitApplication)");
  let token = "";
  await test("正しい申請 → Firestore に記録し、token 付きの確認メールを送る", async () => {
    const r = await call(F.submitApplication, { exName: "Tokyo Art Fair 2026", venue: "東京", startDate: future(30), organizer: "宮川", email: "Org@Example.com", sandbox: false });
    assert.strictEqual(r.success, true);
    const m = mails[mails.length - 1];
    assert.strictEqual(m.to, "org@example.com");
    assert.ok(/メールアドレスの確認/.test(m.subject));
    token = tokenFrom(m);
    assert.ok(token, "メールに token");
    const app = store["applications/" + token];
    assert.ok(app && app.confirmed === false && app.ex_code === "" && app.email === "org@example.com");
  });
  await test("開催予定日が今日以前なら断る", () => rejects(call(F.submitApplication, { exName: "A", venue: "B", startDate: future(0), organizer: "C", email: "a@b.jp" }), "invalid-argument", /今日より後/));
  await test("メールアドレスの形式が違えば断る", () => rejects(call(F.submitApplication, { exName: "A", venue: "B", startDate: future(3), organizer: "C", email: "abc" }), "invalid-argument", /形式/));
  await test("同じメールは5分に3回まで (4回目は断る)", async () => {
    for (let i = 0; i < 3; i++) await call(F.submitApplication, { exName: "連投" + i, venue: "B", startDate: future(3), organizer: "C", email: "spam@x.jp" });
    await rejects(call(F.submitApplication, { exName: "連投4", venue: "B", startDate: future(3), organizer: "C", email: "spam@x.jp" }), "resource-exhausted", /集中/);
  });
  await test("ハニーポットに値があれば何もしない (bot)", async () => {
    const n = mails.length;
    await call(F.submitApplication, { exName: "bot", venue: "B", startDate: future(3), organizer: "C", email: "bot@x.jp", hp: "x" });
    assert.strictEqual(mails.length, n);
  });

  console.log("メール確認 (confirmApplication)");
  await test("確認前に作成しようとしたら断る", () => rejects(call(F.createExhibition, { token, workCount: 5 }), "permission-denied"));
  await test("token を確かめて申請内容を返し、確認済みにする", async () => {
    const r = await call(F.confirmApplication, { token });
    assert.strictEqual(r.exName, "Tokyo Art Fair 2026");
    assert.strictEqual(r.email, "org@example.com");
    assert.strictEqual(r.alreadySetup, false);
    assert.strictEqual(store["applications/" + token].confirmed, true);
  });
  await test("見つからない token (切り替え前の申請を含む) は再申請を案内", () =>
    rejects(call(F.confirmApplication, { token: "11111111-2222-3333-4444-555555555555" }), "not-found", /もう一度申請/));
  await test("形式の違う token も同じ案内", () => rejects(call(F.confirmApplication, { token: "abc" }), "not-found", /もう一度申請/));

  console.log("作成 (createExhibition)");
  let exCode = "";
  await test("展覧会データ・作品枠・短縮QR を作り、申請に作成済みの印を付け、完了メールを送る", async () => {
    const r = await call(F.createExhibition, { token, workCount: 5 });
    assert.strictEqual(r.success, true);
    exCode = r.exCode;
    assert.ok(/^TOKYO2[A-Z2-9]{4}$/.test(exCode), "展覧会名から作ったコード: " + exCode);
    const ex = store["exhibitions/" + exCode];
    assert.strictEqual(ex.email, "org@example.com");
    assert.strictEqual(ex.ex_name, "Tokyo Art Fair 2026");
    assert.strictEqual(ex.is_sandbox, false);
    assert.strictEqual(ex.expire_at, "");
    assert.strictEqual(ex.last_artwork_seq, 5);
    assert.ok(ex.createdAt && ex.registration_fields && ex.caption_fields);
    const arts = Object.keys(store).filter((k) => k.startsWith("artworks/" + exCode + "_"));
    assert.strictEqual(arts.length, 5);
    assert.strictEqual(store[arts[0]].organizerEmail, "org@example.com");
    assert.strictEqual(Object.keys(store).filter((k) => k.startsWith("qr_codes/") && store[k].exCode === exCode).length, 5);
    assert.strictEqual(store["applications/" + token].ex_code, exCode);
    const m = mails[mails.length - 1];
    assert.ok(m.to === "org@example.com" && m.subject.includes(exCode) && m.text.includes("register.html?ex=" + exCode));
  });
  await test("同じ申請でもう一度呼ばれても二重に作らない (作成済みを返す)", async () => {
    const nMail = mails.length;
    const nDocs = Object.keys(store).length;
    const r = await call(F.createExhibition, { token, workCount: 5 });
    assert.strictEqual(r.exCode, exCode);
    assert.strictEqual(r.already, true);
    assert.strictEqual(mails.length, nMail);
    assert.strictEqual(Object.keys(store).length, nDocs);
  });
  await test("作成済みの申請のリンクをもう一度開いたら作成済みと返す", async () => {
    const r = await call(F.confirmApplication, { token });
    assert.strictEqual(r.alreadySetup, true);
    assert.strictEqual(r.exCode, exCode);
  });
  await test("作品数が範囲外なら断る", () => rejects(call(F.createExhibition, { token, workCount: 0 }), "invalid-argument"));
  await test("日本語だけの展覧会名は EX + ランダム、練習モードは14日後の削除予定日", async () => {
    await call(F.submitApplication, { exName: "春の個展", venue: "京都", startDate: future(10), organizer: "山田", email: "yamada@x.jp", sandbox: true });
    const t2 = tokenFrom(mails[mails.length - 1]);
    await call(F.confirmApplication, { token: t2 });
    const r = await call(F.createExhibition, { token: t2, workCount: 2 });
    assert.ok(/^EX[A-Z2-9]{4}$/.test(r.exCode), r.exCode);
    const ex = store["exhibitions/" + r.exCode];
    assert.strictEqual(ex.is_sandbox, true);
    const days = (Date.parse(ex.expire_at) - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days < 14.1, "expire " + days);
    assert.ok(/練習モード/.test(mails[mails.length - 1].subject));
  });

  console.log("練習モードの通知 (scheduledSandboxCleanup)");
  await test("期限まで24時間を切った練習展覧会に「明日削除されます」を1回だけ送る", async () => {
    await fakeDb.collection("exhibitions").doc("SOON1").set({ ex_name: "もうすぐ", email: "soon@x.jp", is_sandbox: true, expire_at: new Date(Date.now() + 12 * 3600000).toISOString() });
    const n = mails.length;
    await F.scheduledSandboxCleanup.run({});
    const sent = mails.slice(n).filter((m) => m.to === "soon@x.jp");
    assert.strictEqual(sent.length, 1);
    assert.ok(/明日削除されます/.test(sent[0].subject));
    assert.ok(store["exhibitions/SOON1"].sandbox_warned_at);
    await F.scheduledSandboxCleanup.run({});
    assert.strictEqual(mails.filter((m) => m.to === "soon@x.jp").length, 1, "2回目は送らない");
  });
  await test("期限を過ぎた練習展覧会は削除して「削除しました」を送る", async () => {
    await fakeDb.collection("exhibitions").doc("OLD1").set({ ex_name: "期限切れ", email: "old@x.jp", is_sandbox: true, expire_at: new Date(Date.now() - 3600000).toISOString() });
    await fakeDb.collection("artworks").doc("OLD1_w001").set({ exCode: "OLD1" });
    await F.scheduledSandboxCleanup.run({});
    assert.strictEqual(store["exhibitions/OLD1"], undefined);
    assert.strictEqual(store["artworks/OLD1_w001"], undefined);
    const m = mails.filter((x) => x.to === "old@x.jp");
    assert.ok(m.length === 1 && /削除しました/.test(m[0].subject));
  });
  await test("本番の展覧会・期限が先の練習展覧会には何もしない", async () => {
    assert.ok(store["exhibitions/" + exCode]);
    assert.strictEqual(mails.filter((m) => m.to === "yamada@x.jp" && /削除/.test(m.subject)).length, 0);
  });

  console.log("作家への案内メール・写しだけの操作 (callGasAuthed)");
  await test("主催者なら、展覧会データの主催者メール宛に Cloud Function から送る (GAS に送らない)", async () => {
    const n = otherFetch.length;
    const r = await call(F.callGasAuthed, { action: "sendArtistGuide", params: { ex: exCode, subject: "作品情報のご入力のお願い", body: "本文" } }, "org@example.com");
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.to, "org@example.com");
    const m = mails[mails.length - 1];
    assert.ok(m.to === "org@example.com" && m.subject === "作品情報のご入力のお願い");
    assert.strictEqual(otherFetch.length, n, "GAS への通信なし");
  });
  await test("主催者でなければ断る", () => rejects(call(F.callGasAuthed, { action: "sendArtistGuide", params: { ex: exCode, subject: "s", body: "b" } }, "other@x.jp"), "permission-denied"));
  await test("写しだけだった操作は GAS に送らず成功だけ返す (古い画面対策)", async () => {
    const n = otherFetch.length;
    for (const action of ["updateExName", "saveRegistrationFields", "bumpArtworkCount", "graduateExhibition"]) {
      const r = await call(F.callGasAuthed, { action, params: { ex: exCode } }, "org@example.com");
      assert.ok(r.success && r.retired, action);
    }
    assert.strictEqual(otherFetch.length, n);
  });
  await test("ログインしていなければ断る", () => rejects(call(F.callGasAuthed, { action: "updateExName", params: { ex: exCode } }), "permission-denied"));
  await test("廃止した関数 (finalizeExhibitionSetup / adminRecoverExhibitionDoc) は無い", async () => {
    assert.strictEqual(F.finalizeExhibitionSetup, undefined);
    assert.strictEqual(F.adminRecoverExhibitionDoc, undefined);
  });

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed);
})();
