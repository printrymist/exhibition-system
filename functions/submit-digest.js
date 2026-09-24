// 作家の提出のお知らせ (主催者向けメール) の本体。index.js の scheduledSubmitDigest から毎時呼ぶ。
// テストから直接呼べるように index.js とは分けてある (Firestore とメール送信は引数で受け取る)。
//
// 知らせるのは「作家が提出した」「提出した後に作家が内容を変えた」だけ (登録しただけ・修正の依頼は対象外。
// 修正の依頼は requestArtworkEdit がその場でメールする)。印 (submitted_at / changed_after_submit_at) は
// submitArtwork がサーバー側でだけ付けるので、作家の画面から偽の知らせは作れない。
//
// 頻度は展覧会ごとの設定 exhibitions.submit_notify:
//   "daily" (既定) = 毎朝 7:00 (JST) に前回から今までの分を 1 通 / "hourly" = 毎時 / "off" = 送らない
// 展覧会ごとに submit_notify_cursor (前回どこまで知らせたか) を持ち、同じ出来事を二度知らせない。
"use strict";

const DAILY_HOUR_JST = 7;
const LOOKBACK_DAYS = 3; // 朝の実行が 1 回失敗しても翌朝に拾えるよう、3 日分さかのぼって探す

function jstHour(date) {
  return new Date(date.getTime() + 9 * 3600 * 1000).getUTCHours();
}

function artistKey(name) {
  return String(name == null ? "" : name).normalize("NFKC").replace(/\s+/g, "");
}

// 1 展覧会分のメール本文を組み立てる (純粋関数)
function buildDigestMail({ exCode, exName, events, totals }) {
  const byArtist = new Map();
  events.forEach((e) => {
    const k = artistKey(e.artist) || "(作家名なし)";
    if (!byArtist.has(k)) byArtist.set(k, { artist: e.artist || "(作家名なし)", submitted: [], changed: [] });
    byArtist.get(k)[e.kind === "changed" ? "changed" : "submitted"].push(e.title || e.artworkId);
  });
  const titles = (arr) => "「" + arr[0] + "」" + (arr.length > 1 ? "ほか " + (arr.length - 1) + " 点" : "");
  const lines = [];
  byArtist.forEach((a) => {
    if (a.submitted.length) lines.push("・" + a.artist + " — " + a.submitted.length + " 点を提出 (" + titles(a.submitted) + ")");
    if (a.changed.length) {
      lines.push("・" + a.artist + " — " + a.changed.length + " 点を提出後に変更 (" + titles(a.changed) + ")" +
        " … キャプションを印刷済みなら確認してください");
    }
  });
  const nSubmitted = events.filter((e) => e.kind !== "changed").length;
  const nChanged = events.length - nSubmitted;
  const allDone = totals.registered > 0 && totals.submitted === totals.registered;
  let subject;
  if (allDone) subject = "[提出のお知らせ] " + exName + " — 全作品の提出がそろいました";
  else if (nSubmitted && nChanged) subject = "[提出のお知らせ] " + exName + " — " + nSubmitted + " 点が提出、" + nChanged + " 点が変更されました";
  else if (nSubmitted) subject = "[提出のお知らせ] " + exName + " — " + nSubmitted + " 点が提出されました";
  else subject = "[提出のお知らせ] " + exName + " — " + nChanged + " 点が提出後に変更されました";
  const text = [
    exName + " (" + exCode + ") で、作家からの提出がありました。",
    "",
    ...lines,
    "",
    "提出済み " + totals.submitted + " / " + totals.registered + " 点 (入力済みの作品のうち)" +
      (allDone ? " — 全作品そろいました" : ""),
    "",
    "作品登録の画面を開く:",
    "https://qriine.com/register.html?ex=" + encodeURIComponent(exCode) + "&tab=artworks",
    "",
    "このお知らせの頻度 (毎朝まとめて / 1 時間ごと / 送らない) は、作品登録の画面の「④ 展覧会の設定」で変えられます。",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "Qriine",
  ].join("\n");
  return { subject, text, allDone };
}

// 毎時の実行。db = admin.firestore()、sendMail = ({to, subject, text}) => Promise、now = Date
// 戻り値: 送った展覧会コードの一覧 (テスト用)
async function runSubmitDigest({ db, sendMail, now, logger }) {
  const runAt = now || new Date();
  const runIso = runAt.toISOString();
  const since = new Date(runAt.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  const isDailyHour = jstHour(runAt) === DAILY_HOUR_JST;

  const [subSnap, chgSnap] = await Promise.all([
    db.collection("artworks").where("submitted_at", ">", since).get(),
    db.collection("artworks").where("changed_after_submit_at", ">", since).get(),
  ]);
  const byEx = new Map();
  [...subSnap.docs, ...chgSnap.docs].forEach((d) => {
    const a = d.data() || {};
    if (!a.exCode || a.seed === true) return;
    if (!byEx.has(a.exCode)) byEx.set(a.exCode, new Map());
    byEx.get(a.exCode).set(d.id, a);
  });

  const sent = [];
  for (const [exCode, arts] of byEx) {
    try {
      const exRef = db.collection("exhibitions").doc(exCode);
      const exSnap = await exRef.get();
      if (!exSnap.exists) continue;
      const ex = exSnap.data() || {};
      const mode = ["daily", "hourly", "off"].includes(ex.submit_notify) ? ex.submit_notify : "daily";
      const cursor = String(ex.submit_notify_cursor || "");
      const events = [];
      arts.forEach((a) => {
        if (String(a.status) !== "1") return;
        const chg = String(a.changed_after_submit_at || "");
        const sub = String(a.submitted_at || "");
        if (chg && chg > cursor && chg <= runIso) {
          events.push({ kind: "changed", artist: a.artist, title: a.title || a.title_en, artworkId: a.artwork_id });
        } else if (!chg && sub && sub > cursor && sub <= runIso) {
          events.push({ kind: "submitted", artist: a.artist, title: a.title || a.title_en, artworkId: a.artwork_id });
        }
      });
      if (!events.length) continue;
      if (mode === "off") {
        // 送らない設定の間の出来事は、あとでオンにしたときにまとめて届かないよう既読扱いにする
        await exRef.set({ submit_notify_cursor: runIso }, { merge: true });
        continue;
      }
      if (mode === "daily" && !isDailyHour) continue;
      const to = String(ex.email || "").trim();
      if (!to) continue;

      const all = await db.collection("artworks").where("exCode", "==", exCode).get();
      const totals = { registered: 0, submitted: 0 };
      all.docs.forEach((d) => {
        const a = d.data() || {};
        if (String(a.status) !== "1") return;
        totals.registered++;
        if (a.submitted_at && !a.changed_after_submit_at) totals.submitted++;
      });
      const mail = buildDigestMail({ exCode, exName: ex.ex_name || exCode, events, totals });
      await sendMail({ to, subject: mail.subject, text: mail.text });
      await exRef.set({ submit_notify_cursor: runIso }, { merge: true });
      sent.push(exCode);
    } catch (e) {
      if (logger) logger.warn("submit digest failed", { exCode, error: e && e.message });
    }
  }
  if (logger) logger.info("submit digest done", { candidates: byEx.size, sent: sent.length, isDailyHour });
  return sent;
}

module.exports = { runSubmitDigest, buildDigestMail, DAILY_HOUR_JST };
