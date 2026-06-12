/**
 * Cloud Functions for Rohei Printer System
 *
 * - sendSignInLink:
 *   Firebase Auth の Email Link テンプレートが日本語非対応かつ本文編集不可な
 *   ため、Admin SDK でサインイン URL を生成して、自前で nodemailer 経由で
 *   日本語 HTML+プレーンテキスト両方の本文を送信する。
 *   呼び出し側 (operator-auth.js) は firebase.functions().httpsCallable("sendSignInLink")
 *   から呼ぶ。
 *
 * - finalizeExhibitionSetup:
 *   setup.html から runSetup 完了後に呼ばれ、Admin SDK で
 *   exhibitions/{exCode} doc を書き込む。Firestore Security Rules は
 *   Firebase Auth (organizer email) を要求するが、setup.html フローでは
 *   GAS 確認トークンしか持たないためルールをパスできない。ここで GAS に
 *   token + exCode の整合性を問い合わせて検証 → admin で書き込み。
 */

const { setGlobalOptions } = require("firebase-functions");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

admin.initializeApp();

// GAS Exhibition Register Web App の exec URL。
// 公開エンドポイントなのでクライアントに見えてもよい (token は UUID で
// 推測不能なので、エンドポイントの秘匿には依存しない)。
// `clasp deploy --deploymentId` で同じデプロイにリビジョンを上書きする
// 運用なので URL は基本的に変わらないが、入れ替えのときに 1 箇所で済むよう
// defineString に外出し。デプロイ時に `--set-config` か Functions の
// 構成パラメータで上書き可能。
const GAS_EXEC_URL = defineString("GAS_EXEC_URL", {
  default:
    "https://script.google.com/macros/s/AKfycbyZgi8PuS8aq7empliidJahNwYRjm_bWYi6cdLI0tugEH91Gtk7NAJxDKwzn7JPacnF/exec",
});

// Caption Manager GAS の exec URL。callGasAuthed (受付 CF) が
// ログイン必須の操作をここに中継する。クライアントが直叩きしていた経路を
// Firebase Auth + organizer/operator 認可 + ADMIN_SECRET の後ろに移すため。
const GAS_CAPTION_EXEC_URL = defineString("GAS_CAPTION_EXEC_URL", {
  default:
    "https://script.google.com/macros/s/AKfycbzeGn_XAE3yeit9GOt9QKCWXi5tR_knuYZTlE_Bhwk_02AzB2ZEMu3RmW0dvGKzIpnA/exec",
});

// 全関数共通: 東京リージョン + 最大同時実行数 10 (暴走防止)
setGlobalOptions({ maxInstances: 10, region: "asia-northeast1" });

// SMTP パスワードは Secret Manager で管理 (デプロイ時に注入)
const SMTP_PASSWORD = defineSecret("SMTP_PASSWORD");

// adminRecoverExhibitionDoc 専用: GAS の getCanonicalExhibitionDocAdmin を
// 叩く際に必要な共有秘密。Script Property `ADMIN_SECRET` と同じ値を入れる。
const GAS_ADMIN_SECRET = defineSecret("GAS_ADMIN_SECRET");

// gallery.html (web 展覧会) の会場 QR token 用 HMAC 鍵。
// mintGalleryQrToken で発行 / issueGalleryToken で検証。
// 32 バイト相当のランダム hex を `firebase functions:secrets:set GALLERY_TOKEN_SECRET`
// で投入する。鍵をローテートすると既発行の QR は全失効する (per-exhibition の
// 個別失効は不要、運用は visibility=closed への切替でカバー)。
const GALLERY_TOKEN_SECRET = defineSecret("GALLERY_TOKEN_SECRET");

// 作品書き込みアクセストークン用の HMAC 鍵 (Plan 5-A: artworks security_key の置換)。
// mintExhibitionAccessToken / mintArtworkQrToken で発行 → submitArtwork で検証。
// 32 バイト相当のランダム hex を `firebase functions:secrets:set ARTIST_TOKEN_SECRET` で投入。
// 鍵ローテートすると既発行の招待 URL / QR が全失効するので、既存展覧会への影響を考慮して運用する。
const ARTIST_TOKEN_SECRET = defineSecret("ARTIST_TOKEN_SECRET");

// Claude API (Anthropic) の API key。caption.html の作品自動分類で使う。
// 旧 GAS Script Property `CLAUDE_API_KEY` から移行 (Phase 6 後の整理)。
// `firebase functions:secrets:set CLAUDE_API_KEY` で投入。trailing newline に注意
// (feedback_firebase_secrets_set_newline.md)。
const CLAUDE_API_KEY = defineSecret("CLAUDE_API_KEY");

// 運営者メールアドレス。public/js/operator-auth.js の OPERATOR_EMAILS と
// 一致させること。Cloud Function 側でも email auth を二重チェックする。
const OPERATOR_EMAILS = ["rymist1@gmail.com"];

const SMTP_FROM_NAME = "Rohei Printer System";
const SMTP_FROM_ADDR = "noreply.rohei.printer@gmail.com";
const SMTP_REPLY_TO = "\"Rohei Printer Support\" <noreply.rohei.printer+contact@gmail.com>";

// continueUrl からサインインリンクの目的を推定して、
// 件名 / 本文 / ボタン文言を文脈ごとに切り替える。
// 後でメールを見返したときに「どの操作のためのリンクか」が一目で分かるようにする。
const SIGN_IN_LINK_CONTEXTS = {
  "/setup.html": {
    label: "展覧会セットアップの確認",
    intro: "展覧会セットアップを続けるため、下のボタンを押して確認を完了してください。",
    button: "確認を完了する",
  },
  "/register.html": {
    label: "作品登録/設定 のログイン",
    intro: "作品登録/設定 画面にログインするため、下のボタンを押してください。",
    button: "作品登録/設定 にログイン",
  },
  "/caption.html": {
    label: "キャプション印刷 のログイン",
    intro: "キャプション印刷 画面にログインするため、下のボタンを押してください。",
    button: "キャプション印刷 にログイン",
  },
  "/reports.html": {
    label: "出力・レポート のログイン",
    intro: "出力・レポート画面にログインするため、下のボタンを押してください。",
    button: "出力・レポート にログイン",
  },
  "/dashboard.html": {
    label: "ダッシュボード のログイン",
    intro: "ダッシュボード画面にログインするため、下のボタンを押してください。",
    button: "ダッシュボード にログイン",
  },
  "/web-exhibition.html": {
    label: "Web 展覧会設定 のログイン",
    intro: "Web 展覧会設定 画面にログインするため、下のボタンを押してください。",
    button: "Web 展覧会設定 にログイン",
  },
  "/admin/exports.html": {
    label: "データダウンロード のログイン",
    intro: "データダウンロード画面にログインするため、下のボタンを押してください。",
    button: "データダウンロード にログイン",
  },
};

const SIGN_IN_LINK_DEFAULT = {
  label: "ログインの確認",
  intro: "下のボタンを押してログインを完了してください。",
  button: "ログインを完了する",
};

function escapeHtmlText(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function deriveSignInLinkContext(continueUrl) {
  let pathname = "";
  let exCode = "";
  try {
    const u = new URL(continueUrl);
    pathname = u.pathname || "";
    const ex = u.searchParams.get("ex");
    if (ex && /^[A-Za-z0-9_-]+$/.test(ex)) exCode = ex;
  } catch (_e) {
    /* 無効な URL でも下のデフォルトでフォールバックする */
  }

  const ctx = SIGN_IN_LINK_CONTEXTS[pathname] || SIGN_IN_LINK_DEFAULT;

  // 展覧会名を Firestore から best-effort で引いて件名に含める。
  // 失敗しても件名生成は続行 (展覧会コードのみ表示)。
  let exName = "";
  if (exCode) {
    try {
      const snap = await admin.firestore()
        .collection("exhibitions").doc(exCode).get();
      if (snap.exists) {
        const d = snap.data() || {};
        exName = String(d.ex_name || "").trim();
      }
    } catch (e) {
      logger.warn("exhibitions lookup for sign-in link subject failed", {
        exCode, msg: e && e.message,
      });
    }
  }

  let subjectExPart = "";
  if (exCode && exName) {
    subjectExPart = "「" + exName + "」(" + exCode + ") — ";
  } else if (exCode) {
    subjectExPart = "(" + exCode + ") — ";
  }
  const subject = "[Rohei Printer System] " + subjectExPart + ctx.label;

  return {
    subject,
    intro: ctx.intro,
    button: ctx.button,
  };
}

// sendSignInLink の per-email rate limit。
// 任意 email 宛にサインインリンクを誰でも投げられる構造なので、
// inbox flooding / 送信元 Gmail SMTP 100/day 制限の被害を防ぐ。
// email_throttle/{sha256(email)[:32]} に最近の送信時刻配列を保持。
// 5 分以内に 3 回を超えると resource-exhausted で reject。
// fail-open (Firestore 障害時は throttle を諦めて送信は続行する)。
async function checkSendLinkThrottle(email) {
  const RATE_LIMIT_WINDOW_SEC = 5 * 60;
  const RATE_LIMIT_MAX = 3;
  const now = Math.floor(Date.now() / 1000);
  const emailHash = crypto.createHash("sha256")
    .update(email).digest("hex").slice(0, 32);
  const docRef = admin.firestore().collection("email_throttle").doc(emailHash);

  let rateLimited = false;
  try {
    await admin.firestore().runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const prev = snap.exists ? (snap.data().attempts || []) : [];
      const recent = prev.filter((t) =>
        typeof t === "number" && (now - t) < RATE_LIMIT_WINDOW_SEC,
      );
      if (recent.length >= RATE_LIMIT_MAX) {
        rateLimited = true;
        return;
      }
      recent.push(now);
      tx.set(docRef, { attempts: recent, updatedAt: now });
    });
  } catch (e) {
    logger.warn("sendSignInLink throttle txn failed (fail-open)", {
      emailHash, error: e && e.message,
    });
    return;
  }
  if (rateLimited) {
    throw new HttpsError(
      "resource-exhausted",
      "メール送信が短時間に集中しています。" +
        Math.ceil(RATE_LIMIT_WINDOW_SEC / 60) +
        " 分ほど待ってから再度お試しください",
    );
  }
}

exports.sendSignInLink = onCall(
  { secrets: [SMTP_PASSWORD] },
  async (request) => {
    const email = String((request.data && request.data.email) || "").trim().toLowerCase();
    const continueUrl = String((request.data && request.data.continueUrl) || "").trim();

    if (!email || !continueUrl) {
      throw new HttpsError("invalid-argument", "email と continueUrl が必要です");
    }

    await checkSendLinkThrottle(email);

    // Admin SDK でサインイン URL を生成 (Firebase Auth 標準フローと互換)
    let link;
    try {
      link = await admin.auth().generateSignInWithEmailLink(email, {
        url: continueUrl,
        handleCodeInApp: true,
      });
    } catch (err) {
      logger.error("generateSignInWithEmailLink failed", { email, error: err.message });
      throw new HttpsError("internal", "サインインリンクの生成に失敗しました: " + err.message);
    }

    // continueUrl から目的・展覧会コードを推定して、件名と本文を出し分ける。
    // 旧実装はすべて「展覧会セットアップの確認」だったため、
    // 後でメールを見返したときどれがどの操作のリンクか分からなくなる問題を解消する。
    const ctx = await deriveSignInLinkContext(continueUrl);

    // Gmail SMTP 経由で送信
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: SMTP_FROM_ADDR,
        pass: SMTP_PASSWORD.value(),
      },
    });

    const subject = ctx.subject;

    // プレーンテキスト版: URL をそのまま含める (テキスト表示でも見える)
    const text = [
      "Rohei Printer System をご利用いただきありがとうございます。",
      "",
      ctx.intro,
      "",
      link,
      "",
      "このメールに心当たりがない場合は破棄してください。",
      "",
      "──",
      "Rohei Printer System",
    ].join("\n");

    // HTML 版: ボタン + URL の二重表示 (どちらでも到達できる)
    const html = "<!doctype html>\n" +
      "<html lang=\"ja\">\n" +
      "<body style=\"font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #222; line-height: 1.6;\">\n" +
      "  <p>Rohei Printer System をご利用いただきありがとうございます。</p>\n" +
      "  <p>" + escapeHtmlText(ctx.intro) + "</p>\n" +
      "  <p>\n" +
      "    <a href=\"" + link + "\" style=\"display:inline-block;padding:12px 24px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;\">" + escapeHtmlText(ctx.button) + "</a>\n" +
      "  </p>\n" +
      "  <p style=\"color:#555;\">もしボタンが押せない場合は、以下の URL をブラウザに貼り付けて開いてください:</p>\n" +
      "  <p style=\"word-break:break-all;color:#555;font-size:0.9em;\">" + link + "</p>\n" +
      "  <hr style=\"border:none;border-top:1px solid #eee;margin-top:32px;\">\n" +
      "  <p style=\"color:#888;font-size:0.85em;\">このメールに心当たりがない場合は破棄してください。</p>\n" +
      "  <p style=\"color:#888;font-size:0.85em;\">── Rohei Printer System</p>\n" +
      "</body>\n" +
      "</html>";

    try {
      await transporter.sendMail({
        from: "\"" + SMTP_FROM_NAME + "\" <" + SMTP_FROM_ADDR + ">",
        to: email,
        replyTo: SMTP_REPLY_TO,
        subject: subject,
        text: text,
        html: html,
      });
      logger.info("sign-in link sent", { email: email });
    } catch (err) {
      logger.error("sendMail failed", { email: email, error: err.message });
      throw new HttpsError("internal", "メール送信に失敗しました: " + err.message);
    }

    return { ok: true };
  },
);

// =========================================================
// finalizeExhibitionSetup
// =========================================================
async function verifyTokenWithGas(token, exCode) {
  const params = new URLSearchParams({
    action: "verifyTokenForFinalize",
    token: token,
    exCode: exCode,
  });
  const res = await fetch(GAS_EXEC_URL.value(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error("GAS verify HTTP " + res.status);
  }
  return res.json();
}

exports.finalizeExhibitionSetup = onCall(async (request) => {
  const data = request.data || {};
  const token = String(data.token || "").trim();
  const exCode = String(data.exCode || "").trim();

  if (!token) throw new HttpsError("invalid-argument", "token が必要です");
  if (!exCode) throw new HttpsError("invalid-argument", "exCode が必要です");

  // GAS 側で token + exCode を検証し、authoritative な email + canonical な
  // exhibitionDoc を得る。クライアントから受け取った doc は採用しない
  // (クライアントは exhibitionDoc を渡す必要がない)。
  let verify;
  try {
    verify = await verifyTokenWithGas(token, exCode);
  } catch (err) {
    logger.error("verifyTokenWithGas threw", { exCode, error: err.message });
    throw new HttpsError(
      "internal",
      "GAS との通信に失敗しました: " + err.message,
    );
  }
  if (!verify || !verify.success) {
    logger.warn("token verification rejected", {
      exCode,
      error: verify && verify.error,
    });
    throw new HttpsError(
      "permission-denied",
      (verify && verify.error) || "token verification failed",
    );
  }
  const verifiedEmail = String(verify.email || "").trim().toLowerCase();
  if (!verifiedEmail) {
    throw new HttpsError("internal", "GAS から email が返されませんでした");
  }
  const canonicalDoc = verify.exhibitionDoc;
  if (!canonicalDoc || typeof canonicalDoc !== "object") {
    throw new HttpsError(
      "internal",
      "GAS から exhibitionDoc が返されませんでした",
    );
  }

  // Admin SDK で書き込み (Security Rules はバイパス)。
  // ex_code / email は GAS の authoritative 値で上書き。
  // skipExhibitionWrite=true の場合は exhibition doc を再書き込みせず、
  // artworks のみ書き込む (setup.html の追加スロット作成用)。
  const db = admin.firestore();
  const exRef = db.collection("exhibitions").doc(exCode);
  const ts = new Date().toISOString();
  if (!data.skipExhibitionWrite) {
    const exDoc = Object.assign({}, canonicalDoc, {
      ex_code: exCode,
      email: verifiedEmail,
      createdAt: ts,
    });
    try {
      await exRef.set(exDoc, { merge: true });
    } catch (err) {
      logger.error("exhibitions write failed", { exCode, error: err.message });
      throw new HttpsError(
        "internal",
        "Firestore 書き込みに失敗しました: " + err.message,
      );
    }
  }
  // 空き artwork スロットも一緒に書き込む。クライアントから受け取った配列だが、
  // 同じ setup フロー内で GAS から生成されたものが渡ってくる前提で、exCode 一致と
  // artwork_id / security_key の非空だけ簡易検証する。
  let artworkCount = 0;
  if (Array.isArray(data.artworks) && data.artworks.length > 0) {
    const writes = [];
    for (const a of data.artworks) {
      if (!a || typeof a !== "object") continue;
      const aId = String(a.artwork_id || "").trim();
      const aEx = String(a.exCode || "").trim();
      const aSk = String(a.security_key || "").trim();
      if (!aId || !aEx || aEx !== exCode || !aSk) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(aId)) continue;
      const docId = exCode + "_" + aId;
      const docData = Object.assign({}, a, {
        artworkId: aId,
        exCode: exCode,
        createdAt: ts,
        // β-3 server-managed: empty slot は初期 _published=false。
        // organizerEmail は denormalize (Rules で organizer 直 read 用)。
        _published: false,
        organizerEmail: verifiedEmail,
      });
      writes.push(
        db.collection("artworks").doc(docId).set(docData, { merge: true }),
      );
    }
    try {
      await Promise.all(writes);
      artworkCount = writes.length;
    } catch (err) {
      logger.warn("partial artwork write failed", {
        exCode,
        error: err.message,
      });
    }
  }

  logger.info("exhibition finalized", {
    exCode,
    email: verifiedEmail,
    artworkCount,
  });
  return { success: true, exCode, artworkCount };
});

// =========================================================
// adminRecoverExhibitionDoc
//   GAS 認証は通ったが Firestore 書き込みが取りこぼされた展覧会を、
//   ex_code だけで Firestore に再書き込みする復旧用 Function。
//   呼び出し側 (admin/recover-exhibition.html) は operator email で
//   Firebase Auth 済みであることが前提。ここでも request.auth.token.email
//   を OPERATOR_EMAILS と照合する二重チェック。
//   GAS 側は ADMIN_SECRET (= GAS_ADMIN_SECRET) でゲート。
// =========================================================
async function fetchCanonicalDocFromGas(exCode, adminSecret) {
  const params = new URLSearchParams({
    action: "getCanonicalExhibitionDocAdmin",
    exCode: exCode,
    adminSecret: adminSecret,
  });
  const res = await fetch(GAS_EXEC_URL.value(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error("GAS HTTP " + res.status);
  }
  return res.json();
}

exports.adminRecoverExhibitionDoc = onCall(
  { secrets: [GAS_ADMIN_SECRET] },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail || OPERATOR_EMAILS.indexOf(authEmail) === -1) {
      throw new HttpsError(
        "permission-denied",
        "運営者管理者の Firebase Auth が必要です",
      );
    }

    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    if (!exCode) {
      throw new HttpsError("invalid-argument", "exCode が必要です");
    }

    const adminSecret = GAS_ADMIN_SECRET.value();
    if (!adminSecret) {
      throw new HttpsError("internal", "GAS_ADMIN_SECRET が未設定です");
    }

    let result;
    try {
      result = await fetchCanonicalDocFromGas(exCode, adminSecret);
    } catch (err) {
      logger.error("fetchCanonicalDocFromGas threw", {
        exCode,
        error: err.message,
      });
      throw new HttpsError(
        "internal",
        "GAS との通信に失敗しました: " + err.message,
      );
    }
    if (!result || !result.success) {
      logger.warn("GAS rejected admin recovery", {
        exCode,
        error: result && result.error,
      });
      throw new HttpsError(
        "failed-precondition",
        (result && result.error) || "GAS から canonical doc を取得できませんでした",
      );
    }

    const canonicalDoc = result.exhibitionDoc;
    const verifiedEmail = String(result.email || "").trim().toLowerCase();
    if (!canonicalDoc || typeof canonicalDoc !== "object") {
      throw new HttpsError("internal", "GAS から exhibitionDoc が返されませんでした");
    }

    const db = admin.firestore();
    const exRef = db.collection("exhibitions").doc(exCode);
    const ts = new Date().toISOString();
    const exDoc = Object.assign({}, canonicalDoc, {
      ex_code: exCode,
      email: verifiedEmail || canonicalDoc.email,
      recoveredAt: ts,
    });
    if (!canonicalDoc.createdAt) {
      exDoc.createdAt = ts;
    }
    try {
      await exRef.set(exDoc, { merge: true });
    } catch (err) {
      logger.error("admin recover write failed", { exCode, error: err.message });
      throw new HttpsError(
        "internal",
        "Firestore 書き込みに失敗しました: " + err.message,
      );
    }

    logger.info("exhibition recovered by admin", {
      exCode,
      operator: authEmail,
    });
    return { success: true, exCode, exhibitionDoc: exDoc };
  },
);

// =========================================================
// Gallery (web 展覧会) 関連
//
// mintGalleryQrToken:
//   主催者が web-exhibition.html から会場 QR を発行するときに呼ぶ。
//   exCode + 有効期限 (exp) を HMAC-SHA256 で署名し、URL に埋める用の
//   { exp, sig } を返す。operator email または対象 exCode の主催者 email で gate。
//
// issueGalleryToken:
//   visitor が gallery.html を開いたときに呼ぶ (認証なし callable)。
//   exhibitions/{exCode}.gallery_visibility を見て:
//     - closed         → 拒否
//     - public         → sig 検証スキップ (短い URL でアクセス可)
//     - visitor_only   → sig + exp を検証
//   合格すれば signInWithCustomToken 用の token を返す。
//   custom claims: { role: "visitor", exCode: <ex> }
//   Firestore Rules はこの claims を見て artworks/likes へのアクセスを許可する。
// =========================================================

function computeGallerySig(secret, exCode, exp) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${exCode}:${exp}`)
    .digest("hex");
}

exports.mintGalleryQrToken = onCall(
  { secrets: [GALLERY_TOKEN_SECRET] },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError(
        "permission-denied",
        "Firebase Auth が必要です",
      );
    }

    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    if (!exCode) {
      throw new HttpsError("invalid-argument", "exCode が必要です");
    }

    // 運営者 OR この展覧会の主催者本人なら通す。
    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    let isOrganizer = false;
    if (!isOperator) {
      const exSnap = await admin.firestore()
        .collection("exhibitions").doc(exCode).get();
      if (!exSnap.exists) {
        throw new HttpsError(
          "not-found",
          `展覧会 ${exCode} が見つかりません`,
        );
      }
      const organizerEmail = String((exSnap.data() || {}).email || "")
        .trim().toLowerCase();
      isOrganizer = !!organizerEmail && organizerEmail === authEmail;
    }
    if (!isOperator && !isOrganizer) {
      throw new HttpsError(
        "permission-denied",
        "この展覧会の主催者または運営者の Firebase Auth が必要です",
      );
    }

    // expDays: 1〜365 で受け付ける。会期 + 余裕を主催者が指定する想定。
    const expDays = Number(data.expDays);
    if (!Number.isFinite(expDays) || expDays < 1 || expDays > 365) {
      throw new HttpsError(
        "invalid-argument",
        "expDays は 1〜365 の整数で指定してください",
      );
    }

    const secret = GALLERY_TOKEN_SECRET.value();
    if (!secret) {
      throw new HttpsError("internal", "GALLERY_TOKEN_SECRET が未設定です");
    }

    const exp = Math.floor(Date.now() / 1000) + Math.floor(expDays) * 86400;
    const sig = computeGallerySig(secret, exCode, exp);
    logger.info("gallery QR token minted", {
      exCode,
      caller: authEmail,
      role: isOperator ? "operator" : "organizer",
      expDays: Math.floor(expDays),
    });
    return { exCode, exp, sig };
  },
);

exports.issueGalleryToken = onCall(
  { secrets: [GALLERY_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    if (!exCode) {
      throw new HttpsError("invalid-argument", "exCode が必要です");
    }

    // exhibition doc を読んで visibility / interactions を判定。
    const db = admin.firestore();
    const exSnap = await db.collection("exhibitions").doc(exCode).get();
    if (!exSnap.exists) {
      throw new HttpsError("not-found", "exhibition が見つかりません");
    }
    const exData = exSnap.data() || {};
    const visibility = String(exData.gallery_visibility || "closed");
    const interactions = String(exData.gallery_interactions || "none");

    // visibility は "closed" / "visitor_only" / "public" のいずれか。
    // 未知値 (手動編集・typo・将来追加) は fail-closed で拒否する。
    if (visibility === "closed") {
      throw new HttpsError(
        "permission-denied",
        "この展覧会は現在公開されていません",
      );
    }
    if (visibility !== "visitor_only" && visibility !== "public") {
      logger.warn("issueGalleryToken: unknown visibility rejected", {
        exCode, visibility,
      });
      throw new HttpsError(
        "permission-denied",
        "gallery_visibility が不明な値です",
      );
    }

    // visitor_only のときだけ sig を検証する。public は sig 不要 (SNS シェア想定)。
    if (visibility === "visitor_only") {
      const exp = Number(data.exp);
      const sig = String(data.sig || "");
      if (!Number.isFinite(exp) || !sig) {
        throw new HttpsError(
          "invalid-argument",
          "visitor_only 展覧会には exp + sig が必要です",
        );
      }
      const now = Math.floor(Date.now() / 1000);
      if (exp <= now) {
        throw new HttpsError("deadline-exceeded", "QR コードの有効期限が切れています");
      }
      const secret = GALLERY_TOKEN_SECRET.value();
      if (!secret) {
        throw new HttpsError("internal", "GALLERY_TOKEN_SECRET が未設定です");
      }
      const expected = computeGallerySig(secret, exCode, exp);
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(sig, "hex");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new HttpsError("permission-denied", "QR の署名が一致しません");
      }
    }

    // Custom token を発行。uid は予測不能な乱数で、claims に exCode / role / sessionId を入れる。
    // Firestore Rules で request.auth.token.role / exCode / sessionId を見て gate する。
    // sessionId はクライアントが localStorage で生成・保持する識別子で、いいね取消し / コメント
    // 削除のとき「自分が書いた doc」を確認するための owner key として token に焼き込む。
    const randomId = crypto.randomBytes(8).toString("hex");
    const uid = `gallery_${exCode}_${randomId}`;
    const claims = {
      role: "visitor",
      exCode: exCode,
    };
    // クライアントから渡された sessionId を claims に同梱 (任意、未指定なら従来どおり)
    const reqSessionId = String(data.sessionId || "").trim();
    if (reqSessionId) {
      if (reqSessionId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(reqSessionId)) {
        throw new HttpsError("invalid-argument", "sessionId が不正です");
      }
      claims.sessionId = reqSessionId;
    }
    const customToken = await admin.auth().createCustomToken(uid, claims);

    logger.info("gallery visitor token issued", {
      exCode,
      visibility,
      uid,
      hasSessionId: !!reqSessionId,
    });
    return {
      token: customToken,
      exCode,
      visibility,
      interactions,
    };
  },
);


// =========================================================
// issueVisitorToken (Phase A-2):
//   index.html (物理 QR スキャン経路) の anon visitor を Firebase Auth Custom Token に
//   昇格させて、いいね・コメントの取消し / 削除を Firestore Rules で sessionId 一致 gate
//   で許可できるようにする。
//
//   入力: { exCode, artworkId, exp, sig, sessionId }
//   - artwork_token (HMAC) を検証 (= 物理 QR を持っている人) して
//   - sessionId を claims に焼き込んだ custom token を返す
//
//   gallery と同じく claims は { role: 'visitor', exCode, sessionId } で、
//   既存の Firestore Rules (Phase A-1 で追加) はそのまま使える。
// =========================================================
exports.issueVisitorToken = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    const exp = Number(data.exp);
    const sig = String(data.sig || "");
    const sessionId = String(data.sessionId || "").trim();

    if (!exCode || !artworkId) {
      throw new HttpsError("invalid-argument", "exCode と artworkId が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      throw new HttpsError("invalid-argument", "exCode / artworkId が不正です");
    }
    if (!Number.isFinite(exp) || !sig) {
      throw new HttpsError("invalid-argument", "exp / sig が必要です");
    }
    if (!sessionId) {
      throw new HttpsError("invalid-argument", "sessionId が必要です");
    }
    if (sessionId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new HttpsError("invalid-argument", "sessionId が不正です (英数 / - / _ のみ、200 文字以内)");
    }
    if (exp <= Math.floor(Date.now() / 1000)) {
      throw new HttpsError("deadline-exceeded", "QR コードの有効期限が切れています");
    }

    const secret = ARTIST_TOKEN_SECRET.value();
    if (!secret) {
      throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
    }
    const expected = computeArtworkSig(secret, exCode, artworkId, exp);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new HttpsError("permission-denied", "QR の署名が一致しません");
    }

    const randomId = crypto.randomBytes(8).toString("hex");
    const uid = `visitor_${exCode}_${randomId}`;
    const customToken = await admin.auth().createCustomToken(uid, {
      role: "visitor",
      exCode: exCode,
      sessionId: sessionId,
    });

    logger.info("visitor token issued", { exCode, artworkId, uid });
    return { token: customToken, exCode };
  },
);

// =========================================================
// galleryPage:
//   Hosting rewrite で /gallery.html へのリクエストを受け、
//   exhibitions/{ex} を読んで OG meta タグを差し替えた HTML を返す。
//   テンプレート (gallery.template.html) はビルド時に functions/ に
//   同梱され、起動時にメモリにキャッシュ。Cache-Control で CDN にも
//   5 分置く (cold start 低減)。
//
//   gallery 本体の動的処理 (auth / 作品取得 / likes / コメント) は
//   従来通りクライアント側で動く。SSR するのは OG タグだけ。
// =========================================================

let _galleryTemplate = null;
function loadGalleryTemplate() {
  if (_galleryTemplate) return _galleryTemplate;
  _galleryTemplate = fs.readFileSync(
    path.join(__dirname, "gallery.template.html"),
    "utf8",
  );
  return _galleryTemplate;
}

function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const GALLERY_DEFAULT_TITLE = "Web 展覧会 - My Art Fair";
const GALLERY_DEFAULT_DESC = "オンラインで作品を観覧できるバーチャル展覧会です。";
const HOSTING_ORIGIN = "https://rohei-printer-system.web.app";

exports.galleryPage = onRequest(async (req, res) => {
  const exRaw = String((req.query && req.query.ex) || "").trim();
  const ex = /^[A-Za-z0-9_-]+$/.test(exRaw) ? exRaw : "";

  let title = GALLERY_DEFAULT_TITLE;
  let description = GALLERY_DEFAULT_DESC;
  let image = "";

  if (ex) {
    try {
      const snap = await admin.firestore()
        .collection("exhibitions").doc(ex).get();
      if (snap.exists) {
        const d = snap.data() || {};
        const t = (d.gallery_title || d.ex_name || "").toString().trim();
        if (t) title = t;
        const desc = (d.gallery_subtitle || "").toString().trim();
        if (desc) description = desc;
        const img = (d.gallery_hero_url || "").toString().trim();
        if (/^https?:\/\//i.test(img)) image = img;
      }
    } catch (e) {
      logger.warn("galleryPage exhibition lookup failed", {
        ex,
        msg: e && e.message,
      });
    }
  }

  // 共有 URL: クエリ込みでないと別の展覧会と判別できないので ex を含める。
  // exp / sig は visitor 用の一時パラメータなので OG URL からは外す。
  const ogUrl = ex ?
    `${HOSTING_ORIGIN}/gallery.html?ex=${encodeURIComponent(ex)}` :
    `${HOSTING_ORIGIN}/gallery.html`;

  let html = loadGalleryTemplate()
    .replace(/__OG_TITLE__/g, escapeAttr(title))
    .replace(/__OG_DESCRIPTION__/g, escapeAttr(description))
    .replace(/__OG_URL__/g, escapeAttr(ogUrl));

  if (image) {
    html = html.replace(/__OG_IMAGE__/g, escapeAttr(image));
  } else {
    // 画像が無いときは og:image / twitter:image 行を丸ごと削除。
    // 空 URL を返すと一部クローラが警告を出すため。
    html = html.replace(/^.*__OG_IMAGE__.*\r?\n?/gm, "");
  }

  res.set("Cache-Control", "public, max-age=300, s-maxage=300");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
});

// =========================================================
// imageProxy:
//   /img/artworks/{file} などのリクエストを Storage に橋渡しする。
//   目的は **Firebase Hosting CDN を画像配信に効かせる** こと。
//   Storage download URL を直接 <img src> に使うと CDN がほぼ効かず、
//   Storage egress ($0.12/GB) が visitor 数に比例して跳ねる。
//   Hosting 経由なら CDN egress は無料、CF 起動も CDN ヒット時はゼロ。
//
//   キャッシュ戦略:
//     Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable
//     再アップロード反映は呼び出し側 (?v=<updatedAt>) に任せる。
//
//   許可するパス: artworks/, gallery/ の画像のみ (Storage Rules と一致)
// =========================================================

const IMG_PATH_RE = /^\/img\/((?:artworks|gallery)\/[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp))$/i;

exports.imageProxy = onRequest(
  { memory: "256MiB", timeoutSeconds: 30 },
  async (req, res) => {
    const m = req.path.match(IMG_PATH_RE);
    if (!m) {
      res.status(400).send("bad path");
      return;
    }
    const objPath = m[1];
    try {
      const file = admin.storage().bucket().file(objPath);
      const [exists] = await file.exists();
      if (!exists) {
        res.status(404).send("not found");
        return;
      }
      const [meta] = await file.getMetadata();
      res.set(
        "Cache-Control",
        "public, max-age=31536000, s-maxage=31536000, immutable",
      );
      res.set("Content-Type", meta.contentType || "image/jpeg");
      if (meta.etag) res.set("ETag", meta.etag);
      file.createReadStream()
        .on("error", (err) => {
          logger.error("imageProxy stream error", {
            objPath,
            msg: err && err.message,
          });
          if (!res.headersSent) res.status(500).end();
        })
        .pipe(res);
    } catch (err) {
      logger.error("imageProxy error", {
        objPath,
        msg: err && err.message,
      });
      if (!res.headersSent) res.status(500).send("error");
    }
  },
);

// =========================================================
// Artwork access tokens (Plan 5-A: security_key の置換)
//
// 4 種類の認証経路をサポートする。
//   1. operator email (OPERATOR_EMAILS にあれば常時 OK)
//   2. organizer email (exhibitions/{ex}.email と auth.token.email が一致)
//   3. exhibition access token (input.html 招待 URL: ex 全体の作品に書ける)
//   4. artwork QR token (index.html QR: 特定 artworkId にだけ書ける)
//
// 全経路 admin SDK で書き込みする。Firestore Rules は artworks の
// create/update を false にしてあり、Cloud Function 経由のみ通る。
// security_key は doc に残置しているが認可には使わない (DB の遺物)。
// =========================================================

function computeExhibitionSig(secret, exCode, exp) {
  return crypto.createHmac("sha256", secret)
    .update("exhibition:" + exCode + ":" + exp)
    .digest("hex");
}

function computeArtworkSig(secret, exCode, artworkId, exp) {
  return crypto.createHmac("sha256", secret)
    .update("artwork:" + exCode + ":" + artworkId + ":" + exp)
    .digest("hex");
}

// 作家別 URL 用 HMAC (B-1)
// exhibition_token と違い artistName を sig に含める。
// 同 token で他作家の作品は編集できない (submitArtwork で artist 値検証)。
function computeArtistSig(secret, exCode, artistName, exp) {
  return crypto.createHmac("sha256", secret)
    .update("artist:" + exCode + ":" + artistName + ":" + exp)
    .digest("hex");
}

// HMAC access token (exhibition / artwork / artist) を検証する共通ヘルパ。
// 戻り値: 'exhibition_token' / 'artwork_token' / 'artist_token' (検証成功時) または null。
// 不正な形式は HttpsError を投げる。
// 呼出側で operator/organizer 認可と組み合わせる前提。
// β-3 で getArtwork / listArtworksByArtist にも同じ検証が必要になったため共通化。
// (既存 submitArtwork / uploadArtworkImage は重複コードを残しているが、リスクを避けて
// 今は触らない。将来的に揃える方向で。)
function verifyHmacAccessToken(tok, exCode, artworkId, secret) {
  if (!tok || !tok.kind) return null;
  const exp = Number(tok.exp);
  const sig = String(tok.sig || "");
  if (!Number.isFinite(exp) || !sig) {
    throw new HttpsError(
      "invalid-argument",
      tok.kind + " token に exp/sig が必要です",
    );
  }
  if (exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpsError(
      "deadline-exceeded",
      "アクセストークンの有効期限が切れています",
    );
  }
  let expected;
  if (tok.kind === "exhibition") {
    expected = computeExhibitionSig(secret, exCode, exp);
  } else if (tok.kind === "artwork") {
    if (!artworkId) {
      throw new HttpsError(
        "invalid-argument",
        "artwork token は artworkId が必要です",
      );
    }
    expected = computeArtworkSig(secret, exCode, artworkId, exp);
  } else if (tok.kind === "artist") {
    const tokArtist = String(tok.artist || "").trim();
    if (!tokArtist) {
      throw new HttpsError(
        "invalid-argument",
        "artist token に artist が必要です",
      );
    }
    expected = computeArtistSig(secret, exCode, tokArtist, exp);
  } else {
    return null;
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return tok.kind + "_token";
  }
  return null;
}

async function isOrganizerForEx(authEmail, exCode) {
  if (!authEmail || !exCode) return false;
  const exSnap = await admin.firestore()
    .collection("exhibitions").doc(exCode).get();
  if (!exSnap.exists) return false;
  const exEmail = String((exSnap.data() || {}).email || "").trim().toLowerCase();
  return !!exEmail && exEmail === authEmail;
}

exports.mintExhibitionAccessToken = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError("permission-denied", "Firebase Auth が必要です");
    }

    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    if (!exCode) {
      throw new HttpsError("invalid-argument", "exCode が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
      throw new HttpsError("invalid-argument", "exCode が不正です");
    }

    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    if (!isOperator) {
      const ok = await isOrganizerForEx(authEmail, exCode);
      if (!ok) {
        throw new HttpsError(
          "permission-denied",
          "この展覧会の主催者または運営者の Firebase Auth が必要です",
        );
      }
    }

    const expDays = Number(data.expDays);
    if (!Number.isFinite(expDays) || expDays < 1 || expDays > 365) {
      throw new HttpsError(
        "invalid-argument",
        "expDays は 1〜365 の整数で指定してください",
      );
    }

    const secret = ARTIST_TOKEN_SECRET.value();
    if (!secret) {
      throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
    }

    const exp = Math.floor(Date.now() / 1000) + Math.floor(expDays) * 86400;
    const sig = computeExhibitionSig(secret, exCode, exp);
    logger.info("exhibition access token minted", {
      exCode,
      caller: authEmail,
      role: isOperator ? "operator" : "organizer",
      expDays: Math.floor(expDays),
    });
    return { exCode, exp, sig };
  },
);

// 作家別 URL 発行 (B-1)
// 主催者が register.html から「作家ごとに URL を発行」する用途。
// 発行された URL は ?ex=...&artist=...&exp=...&sig=... で input.html を開き、
// submitArtwork CF が artist 値の一致を検証する。
exports.mintArtistAccessToken = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError("permission-denied", "Firebase Auth が必要です");
    }

    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artistName = String(data.artistName || "").trim();
    if (!exCode) {
      throw new HttpsError("invalid-argument", "exCode が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
      throw new HttpsError("invalid-argument", "exCode が不正です");
    }
    if (!artistName) {
      throw new HttpsError("invalid-argument", "artistName が必要です");
    }
    if (artistName.length > 200) {
      throw new HttpsError("invalid-argument", "artistName が長すぎます");
    }

    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    if (!isOperator) {
      const ok = await isOrganizerForEx(authEmail, exCode);
      if (!ok) {
        throw new HttpsError(
          "permission-denied",
          "この展覧会の主催者または運営者の Firebase Auth が必要です",
        );
      }
    }

    const expDays = Number(data.expDays);
    if (!Number.isFinite(expDays) || expDays < 1 || expDays > 365) {
      throw new HttpsError(
        "invalid-argument",
        "expDays は 1〜365 の整数で指定してください",
      );
    }

    const secret = ARTIST_TOKEN_SECRET.value();
    if (!secret) {
      throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
    }

    const exp = Math.floor(Date.now() / 1000) + Math.floor(expDays) * 86400;
    const sig = computeArtistSig(secret, exCode, artistName, exp);
    logger.info("artist access token minted", {
      exCode,
      artistName,
      caller: authEmail,
      role: isOperator ? "operator" : "organizer",
      expDays: Math.floor(expDays),
    });
    return { exCode, artistName, exp, sig };
  },
);

exports.mintArtworkQrToken = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError("permission-denied", "Firebase Auth が必要です");
    }

    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    if (!exCode || !artworkId) {
      throw new HttpsError("invalid-argument", "exCode と artworkId が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      throw new HttpsError("invalid-argument", "exCode / artworkId が不正です");
    }

    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    if (!isOperator) {
      const ok = await isOrganizerForEx(authEmail, exCode);
      if (!ok) {
        throw new HttpsError(
          "permission-denied",
          "この展覧会の主催者または運営者の Firebase Auth が必要です",
        );
      }
    }

    const expDays = Number(data.expDays);
    if (!Number.isFinite(expDays) || expDays < 1 || expDays > 365) {
      throw new HttpsError(
        "invalid-argument",
        "expDays は 1〜365 の整数で指定してください",
      );
    }

    const secret = ARTIST_TOKEN_SECRET.value();
    if (!secret) {
      throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
    }

    const exp = Math.floor(Date.now() / 1000) + Math.floor(expDays) * 86400;
    const sig = computeArtworkSig(secret, exCode, artworkId, exp);
    logger.info("artwork QR token minted", {
      exCode,
      artworkId,
      caller: authEmail,
      role: isOperator ? "operator" : "organizer",
    });
    return { exCode, artworkId, exp, sig };
  },
);

// mintArtworkQrTokenFromGas:
//   GAS から呼ばれる HTTP エンドポイント。GAS_ADMIN_SECRET で認証して、
//   GAS の addArtworks / regenerateQrUrls から作品単位 HMAC を発行する。
//   レスポンスは { success, exp, sig }。
exports.mintArtworkQrTokenFromGas = onRequest(
  { secrets: [ARTIST_TOKEN_SECRET, GAS_ADMIN_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "POST only" });
      return;
    }
    const body = req.body || {};
    const adminSecret = String(body.adminSecret || "");
    const expected = GAS_ADMIN_SECRET.value();
    if (!expected || adminSecret !== expected) {
      res.status(403).json({ success: false, error: "invalid admin secret" });
      return;
    }
    const exCode = String(body.exCode || "").trim();
    const artworkId = String(body.artworkId || "").trim();
    if (!exCode || !artworkId) {
      res.status(400).json({ success: false, error: "exCode/artworkId required" });
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      res.status(400).json({ success: false, error: "exCode/artworkId invalid" });
      return;
    }
    const expDays = Number(body.expDays);
    if (!Number.isFinite(expDays) || expDays < 1 || expDays > 730) {
      res.status(400).json({ success: false, error: "expDays must be 1-730" });
      return;
    }
    const secret = ARTIST_TOKEN_SECRET.value();
    if (!secret) {
      res.status(500).json({ success: false, error: "ARTIST_TOKEN_SECRET not configured" });
      return;
    }
    const exp = Math.floor(Date.now() / 1000) + Math.floor(expDays) * 86400;
    const sig = computeArtworkSig(secret, exCode, artworkId, exp);
    logger.info("artwork QR token minted (from GAS)", {
      exCode,
      artworkId,
      expDays: Math.floor(expDays),
    });
    res.status(200).json({ success: true, exp, sig });
  },
);

// =========================================================
// purgeExhibition / scheduledSandboxCleanup
//
// 展覧会単位で Firestore + Storage を完全削除する Cloud Function。
//   - artworks / likes / exhibitions ドキュメント
//   - Storage の artworks/{ex}_* と gallery/{ex}_* (admin SDK で
//     Storage Rules をバイパス)
// inquiries は意図的に残置 (運用ポリシー)。
//
// GAS の dailySandboxMaintenance は Master SS 行 / Drive フォルダ /
// 通知メール担当でそのまま併存。
// =========================================================

async function purgeExhibitionInternal(exCode) {
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const stats = {
    artworks: 0,
    likes: 0,
    exhibitionDeleted: false,
    artworkImages: 0,
    galleryImages: 0,
  };

  // artworks
  const aSnap = await db.collection("artworks").where("exCode", "==", exCode).get();
  await Promise.all(aSnap.docs.map((d) => d.ref.delete()));
  stats.artworks = aSnap.size;

  // likes
  const lSnap = await db.collection("likes").where("exCode", "==", exCode).get();
  await Promise.all(lSnap.docs.map((d) => d.ref.delete()));
  stats.likes = lSnap.size;

  // exhibitions
  try {
    const exDoc = await db.collection("exhibitions").doc(exCode).get();
    if (exDoc.exists) {
      await db.collection("exhibitions").doc(exCode).delete();
      stats.exhibitionDeleted = true;
    }
  } catch (e) {
    logger.warn("purgeExhibitionInternal: exhibition delete failed", {
      exCode, error: e.message,
    });
  }

  // Storage artworks/{ex}_*
  try {
    const [files] = await bucket.getFiles({ prefix: "artworks/" + exCode + "_" });
    await Promise.all(files.map((f) => f.delete()));
    stats.artworkImages = files.length;
  } catch (e) {
    logger.warn("purgeExhibitionInternal: artwork storage delete failed", {
      exCode, error: e.message,
    });
  }

  // Storage gallery/{ex}_*
  try {
    const [files] = await bucket.getFiles({ prefix: "gallery/" + exCode + "_" });
    await Promise.all(files.map((f) => f.delete()));
    stats.galleryImages = files.length;
  } catch (e) {
    logger.warn("purgeExhibitionInternal: gallery storage delete failed", {
      exCode, error: e.message,
    });
  }

  return stats;
}

// =========================================================
// graduateExhibition (sandbox → real への切替)
//   organizer 本人 (or operator) が呼べる onCall。
//   purge と違って exhibitions ドキュメントは消さず、
//   is_sandbox=false / expire_at=null に更新する。
//   client (register.html) がこれを呼ぶ前に、GAS 側で Master SS の
//   is_sandbox を FALSE に更新しておく必要がある。
// =========================================================
exports.graduateExhibition = onCall(async (request) => {
  const authEmail = String(
    (request.auth && request.auth.token && request.auth.token.email) || "",
  ).trim().toLowerCase();
  if (!authEmail) {
    throw new HttpsError("permission-denied", "認証が必要です");
  }
  const exCode = String((request.data || {}).exCode || "").trim();
  if (!exCode) throw new HttpsError("invalid-argument", "exCode が必要です");
  if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
    throw new HttpsError("invalid-argument", "exCode が不正です");
  }

  const db = admin.firestore();
  const exDoc = await db.collection("exhibitions").doc(exCode).get();
  if (!exDoc.exists) {
    throw new HttpsError("not-found", "exhibition not found");
  }
  const exData = exDoc.data() || {};
  const exEmail = String(exData.email || "").trim().toLowerCase();
  const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
  if (!isOperator && authEmail !== exEmail) {
    throw new HttpsError("permission-denied", "この展覧会の主催者ではありません");
  }

  const bucket = admin.storage().bucket();
  const stats = { artworks: 0, likes: 0, artworkImages: 0, galleryImages: 0 };

  // artworks 全削除
  const aSnap = await db.collection("artworks").where("exCode", "==", exCode).get();
  await Promise.all(aSnap.docs.map((d) => d.ref.delete()));
  stats.artworks = aSnap.size;

  // likes 全削除
  const lSnap = await db.collection("likes").where("exCode", "==", exCode).get();
  await Promise.all(lSnap.docs.map((d) => d.ref.delete()));
  stats.likes = lSnap.size;

  // Storage artworks/{ex}_*
  try {
    const [files] = await bucket.getFiles({ prefix: "artworks/" + exCode + "_" });
    await Promise.all(files.map((f) => f.delete()));
    stats.artworkImages = files.length;
  } catch (e) {
    logger.warn("graduateExhibition: artwork storage delete failed", {
      exCode, error: e.message,
    });
  }

  // Storage gallery/{ex}_*
  try {
    const [files] = await bucket.getFiles({ prefix: "gallery/" + exCode + "_" });
    await Promise.all(files.map((f) => f.delete()));
    stats.galleryImages = files.length;
  } catch (e) {
    logger.warn("graduateExhibition: gallery storage delete failed", {
      exCode, error: e.message,
    });
  }

  // is_sandbox = false にして自動削除予定をクリア
  const updatedAt = new Date().toISOString();
  await db.collection("exhibitions").doc(exCode).set({
    is_sandbox: false,
    expire_at: null,
    updatedAt,
  }, { merge: true });

  // audit log に削除内容を記録 (submitArtwork と同 collection)。
  // graduate は破壊的操作なので運用透明性のため必ず痕跡を残す。
  // audit 書込み失敗は本処理を止めない (logger.warn に降ろす)。
  try {
    await db.collection("audit").add({
      exCode,
      artworkId: "",
      timestamp: updatedAt,
      authMode: isOperator ? "operator" : "organizer",
      callerEmail: authEmail,
      action: "graduateExhibition",
      changedFields: ["卒業時統計"],
      before: {
        "卒業時統計":
          "artworks " + stats.artworks + " 件 / " +
          "likes " + stats.likes + " 件 / " +
          "作品画像 " + stats.artworkImages + " 枚 / " +
          "ギャラリー画像 " + stats.galleryImages + " 枚",
      },
      after: { "卒業時統計": "全削除" },
      isNew: false,
    });
  } catch (auditErr) {
    logger.warn("graduateExhibition audit write failed", {
      exCode,
      error: auditErr && auditErr.message ? auditErr.message : String(auditErr),
    });
  }

  logger.info("graduateExhibition success", { exCode, caller: authEmail, stats });
  return Object.assign({ success: true, exCode }, stats);
});

exports.purgeExhibition = onCall(async (request) => {
  const authEmail = String(
    (request.auth && request.auth.token && request.auth.token.email) || "",
  ).trim().toLowerCase();
  if (!authEmail || OPERATOR_EMAILS.indexOf(authEmail) === -1) {
    throw new HttpsError("permission-denied", "運営者管理者の Firebase Auth が必要です");
  }
  const exCode = String((request.data || {}).exCode || "").trim();
  if (!exCode) {
    throw new HttpsError("invalid-argument", "exCode が必要です");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
    throw new HttpsError("invalid-argument", "exCode が不正です");
  }
  const stats = await purgeExhibitionInternal(exCode);
  logger.info("purgeExhibition success", { exCode, caller: authEmail, stats });
  return Object.assign({ success: true, exCode }, stats);
});

// 毎日 5:00 JST に sandbox 展覧会の Firestore + Storage 残骸を掃除。
// GAS dailySandboxMaintenance (4:00 JST) で Master SS 行 / Drive が消えた直後に走る。
exports.scheduledSandboxCleanup = onSchedule(
  { schedule: "0 5 * * *", timeZone: "Asia/Tokyo" },
  async () => {
    const db = admin.firestore();
    const now = new Date();
    const snap = await db.collection("exhibitions")
      .where("is_sandbox", "==", true).get();
    let purged = 0;
    let failed = 0;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const expireAtStr = String(data.expire_at || "");
      if (!expireAtStr) continue;
      const expireAt = new Date(expireAtStr);
      if (isNaN(expireAt.getTime()) || expireAt > now) continue;
      try {
        const stats = await purgeExhibitionInternal(doc.id);
        logger.info("scheduledSandboxCleanup purged", { exCode: doc.id, stats });
        purged++;
      } catch (e) {
        logger.error("scheduledSandboxCleanup failed", {
          exCode: doc.id, error: e.message,
        });
        failed++;
      }
    }
    logger.info("scheduledSandboxCleanup complete", { purged, failed });
  },
);

exports.submitArtwork = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    const fields = data.fields || {};
    const tok = data.accessToken || {};
    // β-3 Phase 2 (b): artwork_token (1 枚の QR) で同作家の他作品に fan-out write
    // するときに、HMAC 検証用の "元 artwork" を指定するためのパラメータ。
    // sourceArtworkId !== artworkId のとき = fan-out mode、追加制約を課す。
    const sourceArtworkId = String(data.sourceArtworkId || "").trim();

    if (!exCode || !artworkId) {
      throw new HttpsError("invalid-argument", "exCode と artworkId が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      throw new HttpsError("invalid-argument", "exCode / artworkId が不正です");
    }
    if (sourceArtworkId && !/^[A-Za-z0-9_-]+$/.test(sourceArtworkId)) {
      throw new HttpsError("invalid-argument", "sourceArtworkId が不正です");
    }
    if (typeof fields !== "object" || Array.isArray(fields)) {
      throw new HttpsError("invalid-argument", "fields は object である必要があります");
    }

    // クライアントが上書き不可のフィールド (システム管理) を除外。
    // _published / organizerEmail は β-3 で Rules による read 認可に使う server-managed
    // フィールド。client から書き換えられると Rules チェックが意味を失う。
    const FORBIDDEN = new Set([
      "security_key", "exCode", "artworkId", "artwork_id",
      "createdAt", "migratedAt", "backfilledAt", "updatedAt",
      "_published", "organizerEmail",
    ]);
    const cleanFields = {};
    for (const k of Object.keys(fields)) {
      if (FORBIDDEN.has(k)) continue;
      const v = fields[k];
      if (typeof v === "string" && v.length > 5000) {
        throw new HttpsError("invalid-argument", k + " が長すぎます");
      }
      cleanFields[k] = v;
    }

    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    let authMode = null;

    if (authEmail) {
      if (OPERATOR_EMAILS.indexOf(authEmail) !== -1) {
        authMode = "operator";
      } else if (await isOrganizerForEx(authEmail, exCode)) {
        authMode = "organizer";
      }
    }

    const docRef = admin.firestore()
      .collection("artworks").doc(exCode + "_" + artworkId);
    const existingSnap = await docRef.get();

    if (!authMode && tok.kind) {
      const secret = ARTIST_TOKEN_SECRET.value();
      if (!secret && (tok.kind === "exhibition" || tok.kind === "artwork")) {
        throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
      }

      if (tok.kind === "exhibition") {
        const exp = Number(tok.exp);
        const sig = String(tok.sig || "");
        if (!Number.isFinite(exp) || !sig) {
          throw new HttpsError("invalid-argument", "exhibition token に exp/sig が必要です");
        }
        if (exp <= Math.floor(Date.now() / 1000)) {
          throw new HttpsError("deadline-exceeded", "アクセストークンの有効期限が切れています");
        }
        const expected = computeExhibitionSig(secret, exCode, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "exhibition_token";
        }
      } else if (tok.kind === "artwork") {
        const exp = Number(tok.exp);
        const sig = String(tok.sig || "");
        if (!Number.isFinite(exp) || !sig) {
          throw new HttpsError("invalid-argument", "artwork token に exp/sig が必要です");
        }
        if (exp <= Math.floor(Date.now() / 1000)) {
          throw new HttpsError("deadline-exceeded", "アクセストークンの有効期限が切れています");
        }
        // Phase 2 (b): fan-out のとき HMAC は sourceArtworkId (= QR の元作品) で検証する。
        // 後段で「target = 同作家」「fields = artist 情報のみ」制約を別途課す。
        const verifyArtworkId = sourceArtworkId || artworkId;
        const expected = computeArtworkSig(secret, exCode, verifyArtworkId, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "artwork_token";
        }
      } else if (tok.kind === "artist") {
        // B-1: 作家別 URL の token。HMAC sig には artistName が含まれるので、
        // 同 exhibition でも他作家の token とは別物。submitArtwork 後段で
        // 既存 doc の artist と書き込もうとしている artist の一致を強制する。
        const tokArtist = String(tok.artist || "").trim();
        const exp = Number(tok.exp);
        const sig = String(tok.sig || "");
        if (!tokArtist || !Number.isFinite(exp) || !sig) {
          throw new HttpsError("invalid-argument", "artist token に artist/exp/sig が必要です");
        }
        if (exp <= Math.floor(Date.now() / 1000)) {
          throw new HttpsError("deadline-exceeded", "アクセストークンの有効期限が切れています");
        }
        const expected = computeArtistSig(secret, exCode, tokArtist, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "artist_token";
        }
      }
      // legacy_key 経路は削除 (artwork doc が公開読み取り可なので key を取れて
      // しまえば誰でも書ける状態だった。本来の安全性確保が目的なので閉じる)
    }

    if (!authMode) {
      throw new HttpsError(
        "permission-denied",
        "書き込み権限がありません (operator / organizer auth または有効なアクセストークンが必要)",
      );
    }

    if (!existingSnap.exists) {
      // artist 経路 (exhibition_token / artwork_token / artist_token) は新規 doc 作成不可。
      // 通常の登録は fsSaveArtwork が status='0' の空きスロット (= 既存 doc) を埋める形で、
      // 任意 artworkId で新規 doc を作る正当な経路は存在しない (新規スロット追加は GAS 経由のみ)。
      // operator / organizer は救済目的で任意 ID 作成可のまま残す。
      if (
        authMode === "artwork_token" ||
        authMode === "exhibition_token" ||
        authMode === "artist_token"
      ) {
        throw new HttpsError("not-found", "対象の作品枠が見つかりません");
      }
    }

    if (existingSnap.exists) {
      const existingEx = String((existingSnap.data() || {}).exCode || "");
      if (existingEx && existingEx !== exCode) {
        throw new HttpsError("failed-precondition", "doc の exCode が一致しません");
      }
    }

    // 主催者主導 + ロックモデル (Phase 2):
    // - artist 経路 (exhibition_token / artwork_token / artist_token) は is_locked=false 不可
    // - 既にロック済の作品には他フィールドの書き込みも block (作家側からは編集不可)
    // operator / organizer は常に解除可・編集可。
    const isArtistAuth = (
      authMode === "exhibition_token" ||
      authMode === "artwork_token" ||
      authMode === "artist_token"
    );
    if (isArtistAuth) {
      if ("is_locked" in cleanFields && cleanFields.is_locked === false) {
        throw new HttpsError(
          "permission-denied",
          "ロック解除は主催者経由でのみ可能です",
        );
      }
      if (existingSnap.exists) {
        const existing = existingSnap.data() || {};
        if (existing.is_locked === true) {
          throw new HttpsError(
            "permission-denied",
            "この作品はロックされています。編集が必要な場合は主催者にご連絡ください",
          );
        }
      }
    }

    // B-1: artist_token は token に紐付いた artistName しか触れない。
    // - 既存 doc の artist が空でない場合、token の artist と一致すること
    //   (空きスロット status='0' / artist='' は初回登録なので通る)
    // - 書き込もうとしている artist 値が token の artist と一致すること
    //   (作家が登録時に他人の名前を入力しても弾かれる)
    if (authMode === "artist_token") {
      const tokArtist = String(tok.artist || "").trim();
      if (existingSnap.exists) {
        const existingArtist = String((existingSnap.data() || {}).artist || "").trim();
        if (existingArtist && existingArtist !== tokArtist) {
          throw new HttpsError(
            "permission-denied",
            "このトークンでは他の作家の作品を編集できません",
          );
        }
      }
      if ("artist" in cleanFields) {
        const writeArtist = String(cleanFields.artist || "").trim();
        if (writeArtist && writeArtist !== tokArtist) {
          throw new HttpsError(
            "permission-denied",
            "このトークンでは指定された作家名のみ書き込み可能です",
          );
        }
      }
    }

    // B-1.5 (ii): artwork_token (QR 経由) でも、既存 doc に artist が入っていて
    // 書き込み artist と違う場合は拒否。会場で他人の作品 QR を物理スキャンして
    // regWrapper で別作家名に上書きする経路を塞ぐ。
    // - 空きスロット (existingArtist='') からの初回登録は許可
    // - artist field を payload に含めない書き込み (UNLOCK の status='' だけ等) は通す
    // - artist 値クリア (writeArtist='') も通す (input.html の fsDeleteArtwork が
    //   artist を空文字に上書きする経路を維持するため)
    if (authMode === "artwork_token" && existingSnap.exists) {
      const existingArtist = String((existingSnap.data() || {}).artist || "").trim();
      if ("artist" in cleanFields) {
        const writeArtist = String(cleanFields.artist || "").trim();
        if (existingArtist && writeArtist && existingArtist !== writeArtist) {
          throw new HttpsError(
            "permission-denied",
            "この作品は既に別の作家のものです。書き換えはできません",
          );
        }
      }
    }

    // Phase 2 (b): artwork_token で sourceArtworkId !== artworkId のとき = fan-out write。
    //   1. source artwork doc が存在し、artist が空でない
    //   2. target artwork doc が存在し、artist が source と一致
    //   3. cleanFields は ARTIST_FANOUT_FIELDS の subset (= SNS 系のみ)
    //   どれか満たさないなら permission-denied。
    if (
      authMode === "artwork_token" &&
      sourceArtworkId &&
      sourceArtworkId !== artworkId
    ) {
      const ARTIST_FANOUT_FIELDS = new Set([
        "artist", "insta", "x", "facebook", "web",
      ]);
      for (const k of Object.keys(cleanFields)) {
        if (!ARTIST_FANOUT_FIELDS.has(k)) {
          throw new HttpsError(
            "permission-denied",
            "fan-out 書込みでは作家情報フィールドのみ許可されます (" + k + " は拒否)",
          );
        }
      }
      const sourceSnap = await admin.firestore()
        .collection("artworks").doc(exCode + "_" + sourceArtworkId).get();
      if (!sourceSnap.exists) {
        throw new HttpsError("not-found", "fan-out 元の作品が見つかりません");
      }
      const sourceArtist =
        String((sourceSnap.data() || {}).artist || "").trim();
      if (!sourceArtist) {
        throw new HttpsError(
          "failed-precondition",
          "fan-out 元の作品に作家名が設定されていません",
        );
      }
      if (!existingSnap.exists) {
        throw new HttpsError("not-found", "fan-out 先の作品が見つかりません");
      }
      const targetArtist =
        String((existingSnap.data() || {}).artist || "").trim();
      if (sourceArtist !== targetArtist) {
        throw new HttpsError(
          "permission-denied",
          "fan-out は同じ作家の作品にのみ可能です (" +
            sourceArtist + " ≠ " + targetArtist + ")",
        );
      }
    }

    const writePayload = Object.assign({}, cleanFields, {
      exCode: exCode,
      artworkId: artworkId,
      artwork_id: artworkId,
      updatedAt: new Date().toISOString(),
    });
    if (!existingSnap.exists) {
      writePayload.security_key = writePayload.security_key || "";
      // β-3 server-managed fields: create 時に必ず初期化。
      //   _published は最初 false (= visitor 直 read 不可)。後で
      //   syncArtworkPublishedFlags が gallery_visibility に応じて更新する。
      //   organizerEmail は exhibitions doc から denormalize。Rules が
      //   request.auth.token.email == resource.data.organizerEmail で
      //   organizer の直 read を許可するための鍵。
      writePayload._published = false;
      try {
        const exSnap = await admin.firestore()
          .collection("exhibitions").doc(exCode).get();
        const exData = exSnap.exists ? (exSnap.data() || {}) : {};
        writePayload.organizerEmail =
          String(exData.email || "").trim().toLowerCase();
      } catch (e) {
        logger.warn("submitArtwork: organizerEmail lookup failed", {
          exCode, error: e && e.message,
        });
        writePayload.organizerEmail = "";
      }
    }

    const existingDataForAudit = existingSnap.exists ?
      (existingSnap.data() || {}) :
      {};

    await docRef.set(writePayload, { merge: true });

    logger.info("artwork submitted", {
      exCode,
      artworkId,
      authMode,
      caller: authEmail || "(anon)",
      fieldKeys: Object.keys(cleanFields),
    });

    // Phase E (監査ログ): audit collection に変更内容を append。
    // - changedFields: 既存値と異なるフィールドのみ
    // - before / after: そのフィールドだけを抜粋 (doc サイズを抑える)
    // - callerSessionHash: visitor/artist 経路の sessionId を SHA-256 → 16 文字に切詰め
    //   (operator が同一セッションを集計するのに十分、生 sessionId は外部に漏れない)
    // - audit 書込み失敗は本処理を止めない (logger.warn に降ろす)
    try {
      const changedFields = [];
      const beforeFields = {};
      const afterFields = {};
      for (const k of Object.keys(cleanFields)) {
        const oldV = existingDataForAudit[k];
        const newV = cleanFields[k];
        if (oldV !== newV) {
          changedFields.push(k);
          beforeFields[k] = oldV !== undefined ? oldV : null;
          afterFields[k] = newV;
        }
      }
      // is_locked 単独の変更は audit に書かない (作品 doc の現在値で十分追跡可能、
      // 一括ロックで N 件のエントリが膨らむのを防ぐ)。複数フィールドの一部に
      // is_locked が含まれる場合は他のフィールドと合わせて記録する。
      const isLockOnly = changedFields.length === 1 && changedFields[0] === "is_locked";
      if (changedFields.length > 0 && !isLockOnly) {
        const auditEntry = {
          exCode,
          artworkId,
          timestamp: writePayload.updatedAt,
          authMode,
          callerEmail: authEmail || null,
          changedFields,
          before: beforeFields,
          after: afterFields,
          isNew: !existingSnap.exists,
        };
        if (tok && tok.kind) {
          auditEntry.tokenKind = tok.kind;
        }
        if (authMode === "artist_token" && tok && tok.artist) {
          auditEntry.callerArtist = String(tok.artist);
        }
        if (tok && tok.sessionId) {
          auditEntry.callerSessionHash = crypto
            .createHash("sha256")
            .update(String(tok.sessionId))
            .digest("hex")
            .slice(0, 16);
        }
        await admin.firestore().collection("audit").add(auditEntry);
      }
    } catch (auditErr) {
      logger.warn("audit log write failed", {
        exCode,
        artworkId,
        error: auditErr && auditErr.message ? auditErr.message : String(auditErr),
      });
    }

    return { success: true, exCode, artworkId, authMode };
  },
);

// =========================================================
// categorizeArtwork
//   Claude API による作品自動分類。caption.html (operator) から呼ぶ。
//   旧 GAS gas_Caption_maker categorizeArtwork を CF 化したもの。
//   GAS の 6 分制限を回避し、Anthropic SDK を Node で素直に使える。
// =========================================================
const CATEGORIZE_SYSTEM_PROMPT = "美術作品を分類するアシスタントです。\n" +
  "画像を見て、以下の4層で分類してください。\n\n" +
  "レイヤー1 メディア（複数選択可、形式）:\n" +
  "[絵画, 版画, 写真, 彫刻, インスタレーション, 映像, テキスタイル, 陶芸, ドローイング]\n\n" +
  "レイヤー2 モチーフ（複数選択可、内容）:\n" +
  "[人物, 風景, 静物, 抽象, 動物, 都市, 自然]\n\n" +
  "レイヤー3 スタイル（1つ選択）:\n" +
  "[具象, 抽象, アニメ・イラスト系, コンセプチュアル]\n\n" +
  "レイヤー4 キーワード（日本語で3〜5個、自由記述）\n\n" +
  "JSON のみ返答してください。説明文・コードブロック不要。\n" +
  "形式: {\"media\": [...], \"motif\": [...], \"style\": \"...\", \"keywords\": [...]}";

// =========================================================
// getAuditLog
//   admin/audit.html (主催者向け変更履歴画面) から呼ぶ。
//   audit collection は firestore.rules で operator のみ read 可になっているので、
//   organizer の閲覧は admin SDK 経由の本 CF で行う (organizer 認可は exhibitions doc
//   の email 一致で判定)。
//
//   入力: { exCode, limit? }
//   出力: { success: true, entries: [{ id, ...audit doc data }] } (timestamp 降順)
// =========================================================
exports.getAuditLog = onCall(async (request) => {
  const data = request.data || {};
  const exCode = String(data.exCode || "").trim();
  const limit = Math.min(Math.max(parseInt(data.limit, 10) || 100, 1), 500);

  if (!exCode) {
    throw new HttpsError("invalid-argument", "exCode が必要です");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
    throw new HttpsError("invalid-argument", "exCode が不正です");
  }

  const authEmail = String(
    (request.auth && request.auth.token && request.auth.token.email) || "",
  ).trim().toLowerCase();
  if (!authEmail) {
    throw new HttpsError("permission-denied", "Firebase Auth が必要です");
  }

  let authMode = null;
  if (OPERATOR_EMAILS.indexOf(authEmail) !== -1) {
    authMode = "operator";
  } else if (await isOrganizerForEx(authEmail, exCode)) {
    authMode = "organizer";
  }
  if (!authMode) {
    throw new HttpsError(
      "permission-denied",
      "この展覧会の主催者ではありません",
    );
  }

  let snap;
  try {
    snap = await admin.firestore()
      .collection("audit")
      .where("exCode", "==", exCode)
      .orderBy("timestamp", "desc")
      .limit(limit)
      .get();
  } catch (err) {
    // Firestore composite index がまだ構築中だと FAILED_PRECONDITION で落ちる。
    // INTERNAL ではなく原因が分かるメッセージに翻訳する。
    const msg = (err && err.message) || String(err);
    if (/index.*currently building|requires an index/i.test(msg)) {
      throw new HttpsError(
        "failed-precondition",
        "Firestore のインデックスが構築中です。数分待って再度お試しください。",
      );
    }
    logger.error("getAuditLog firestore query failed", { exCode, error: msg });
    throw new HttpsError("internal", "audit ログの取得に失敗しました: " + msg);
  }

  const entries = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  return { success: true, entries };
});

exports.categorizeArtwork = onCall(
  { secrets: [CLAUDE_API_KEY], timeoutSeconds: 120 },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError("permission-denied", "Firebase Auth が必要です");
    }

    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const imageUrl = String(data.imageUrl || "").trim();
    if (!exCode) {
      throw new HttpsError("invalid-argument", "exCode が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
      throw new HttpsError("invalid-argument", "exCode が不正です");
    }
    if (!imageUrl) {
      throw new HttpsError("invalid-argument", "imageUrl が必要です");
    }
    if (!/^https?:\/\//i.test(imageUrl)) {
      throw new HttpsError("invalid-argument", "imageUrl は http(s) URL である必要があります");
    }

    // 認可: operator OR 該当 exhibition の organizer。
    // (visitor custom token / その他 Firebase Auth 経由でも authEmail は非空に
    // なるため、role-aware なチェックが必要。Claude API 課金漏れ対策。)
    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    if (!isOperator) {
      const ok = await isOrganizerForEx(authEmail, exCode);
      if (!ok) {
        throw new HttpsError(
          "permission-denied",
          "この展覧会の主催者または運営者の Firebase Auth が必要です",
        );
      }
    }

    const apiKey = CLAUDE_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("internal", "CLAUDE_API_KEY が未設定です");
    }

    const requestBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system: [{
        type: "text",
        text: CATEGORIZE_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      }],
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          { type: "text", text: "この作品を分類してください。" },
        ],
      }],
    };

    let response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (e) {
      logger.error("Claude API fetch failed", { error: e.message });
      throw new HttpsError("internal", "Claude API への通信に失敗しました: " + e.message);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      logger.warn("Claude API error", { status: response.status, body: bodyText.slice(0, 500) });
      throw new HttpsError("internal", "Claude API " + response.status + ": " + bodyText.slice(0, 500));
    }

    let result;
    try {
      result = JSON.parse(bodyText);
    } catch (e) {
      throw new HttpsError("internal", "Claude API のレスポンスが JSON ではありません");
    }
    const textBlock = (result.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      throw new HttpsError("internal", "Claude のレスポンスに text ブロックがありません");
    }

    let jsonText = String(textBlock.text || "").trim();
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new HttpsError(
        "internal",
        "Claude の出力が JSON parse できません: " + jsonText.substring(0, 200),
      );
    }

    logger.info("categorizeArtwork success", {
      caller: authEmail,
      style: parsed.style,
      mediaCount: Array.isArray(parsed.media) ? parsed.media.length : 0,
      usage: result.usage || null,
    });

    return {
      success: true,
      media: Array.isArray(parsed.media) ? parsed.media : [],
      motif: Array.isArray(parsed.motif) ? parsed.motif : [],
      style: typeof parsed.style === "string" ? parsed.style : "",
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      usage: result.usage || null,
    };
  },
);

// =========================================================
// setLikesExcludedFromStats
//   analytics.html の異常検知パネル / 事後クリーンアップ UI から呼ぶ。
//   指定 sessionId 群の likes に excluded_from_stats フラグを立てる
//   (or 解除する)。ダッシュボードの集計はこのフラグを見て除外する。
//
//   AI-Native 原則 (CLAUDE.md): UI で「ボタンを押したらクライアントが
//   直接 Firestore.update」では認可を破られるので、必ず CF 経由で
//   operator/organizer auth を検証してから admin SDK で batch update する。
//
//   入力: { exCode, sessionIds: string[], excluded: boolean }
//   出力: { success: true, updated: number }
//   制限: sessionIds は最大 50 件まで
// =========================================================
// =========================================================
// uploadArtworkImage / uploadGalleryImage
//   画像アップロードを CF 経由に倒し、Storage Rules では
//   /artworks /gallery とも write:false にする。これにより
//   filename を当てて誰でも上書きできる D-1 脆弱性を塞ぐ。
//
//   - uploadArtworkImage: artist 経路 (token) も含めて受ける。
//       認可は submitArtwork と同じパターン (operator / organizer /
//       exhibition_token / artwork_token / artist_token)。
//       既存 doc が無い場合 artist 経路は拒否、is_locked / artist 不一致
//       も submitArtwork に揃える。
//   - uploadGalleryImage: operator / organizer のみ。
//
//   どちらも base64 で受け、admin SDK で Storage に書く。
//   firebaseStorageDownloadTokens を付けて返す URL は SDK の
//   getDownloadURL() と同じ形式 (translateImageUrl の正規表現と互換)。
// =========================================================

function constructDownloadUrl(bucketName, objPath, downloadToken) {
  return "https://firebasestorage.googleapis.com/v0/b/" +
    bucketName + "/o/" + encodeURIComponent(objPath) +
    "?alt=media&token=" + downloadToken;
}

function decodeImageBase64(imageBase64, maxBytes) {
  let raw = String(imageBase64 || "");
  const m = raw.match(/^data:image\/[^;]+;base64,(.+)$/);
  if (m) raw = m[1];
  if (!raw) {
    throw new HttpsError("invalid-argument", "画像データが必要です");
  }
  let buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch (e) {
    throw new HttpsError("invalid-argument", "画像データの形式が不正です");
  }
  if (!buffer || buffer.length === 0) {
    throw new HttpsError("invalid-argument", "画像データが空です");
  }
  if (buffer.length > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    throw new HttpsError("invalid-argument", "画像は " + mb + "MB 以下にしてください");
  }
  return buffer;
}

exports.uploadArtworkImage = onCall(
  { secrets: [ARTIST_TOKEN_SECRET], memory: "512MiB", timeoutSeconds: 60 },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    const tok = data.accessToken || {};

    if (!exCode || !artworkId) {
      throw new HttpsError("invalid-argument", "exCode と artworkId が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      throw new HttpsError("invalid-argument", "exCode / artworkId が不正です");
    }

    const buffer = decodeImageBase64(data.imageBase64, 1 * 1024 * 1024);

    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    let authMode = null;

    if (authEmail) {
      if (OPERATOR_EMAILS.indexOf(authEmail) !== -1) {
        authMode = "operator";
      } else if (await isOrganizerForEx(authEmail, exCode)) {
        authMode = "organizer";
      }
    }

    const docRef = admin.firestore()
      .collection("artworks").doc(exCode + "_" + artworkId);
    const existingSnap = await docRef.get();

    if (!authMode && tok.kind) {
      const secret = ARTIST_TOKEN_SECRET.value();
      if (!secret) {
        throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
      }
      if (tok.kind === "exhibition") {
        const exp = Number(tok.exp);
        const sig = String(tok.sig || "");
        if (!Number.isFinite(exp) || !sig) {
          throw new HttpsError("invalid-argument", "exhibition token に exp/sig が必要です");
        }
        if (exp <= Math.floor(Date.now() / 1000)) {
          throw new HttpsError("deadline-exceeded", "アクセストークンの有効期限が切れています");
        }
        const expected = computeExhibitionSig(secret, exCode, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "exhibition_token";
        }
      } else if (tok.kind === "artwork") {
        const exp = Number(tok.exp);
        const sig = String(tok.sig || "");
        if (!Number.isFinite(exp) || !sig) {
          throw new HttpsError("invalid-argument", "artwork token に exp/sig が必要です");
        }
        if (exp <= Math.floor(Date.now() / 1000)) {
          throw new HttpsError("deadline-exceeded", "アクセストークンの有効期限が切れています");
        }
        const expected = computeArtworkSig(secret, exCode, artworkId, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "artwork_token";
        }
      } else if (tok.kind === "artist") {
        const tokArtist = String(tok.artist || "").trim();
        const exp = Number(tok.exp);
        const sig = String(tok.sig || "");
        if (!tokArtist || !Number.isFinite(exp) || !sig) {
          throw new HttpsError("invalid-argument", "artist token に artist/exp/sig が必要です");
        }
        if (exp <= Math.floor(Date.now() / 1000)) {
          throw new HttpsError("deadline-exceeded", "アクセストークンの有効期限が切れています");
        }
        const expected = computeArtistSig(secret, exCode, tokArtist, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "artist_token";
        }
      }
    }

    if (!authMode) {
      throw new HttpsError(
        "permission-denied",
        "書き込み権限がありません (operator / organizer auth または有効なアクセストークンが必要)",
      );
    }

    const isArtistAuth = (
      authMode === "exhibition_token" ||
      authMode === "artwork_token" ||
      authMode === "artist_token"
    );

    if (!existingSnap.exists) {
      if (isArtistAuth) {
        throw new HttpsError("not-found", "対象の作品枠が見つかりません");
      }
    } else {
      const existing = existingSnap.data() || {};
      const existingEx = String(existing.exCode || "");
      if (existingEx && existingEx !== exCode) {
        throw new HttpsError("failed-precondition", "doc の exCode が一致しません");
      }
      if (isArtistAuth && existing.is_locked === true) {
        throw new HttpsError(
          "permission-denied",
          "この作品はロックされています。編集が必要な場合は主催者にご連絡ください",
        );
      }
      if (authMode === "artist_token") {
        const tokArtist = String(tok.artist || "").trim();
        const existingArtist = String(existing.artist || "").trim();
        if (existingArtist && existingArtist !== tokArtist) {
          throw new HttpsError(
            "permission-denied",
            "このトークンでは他の作家の作品を編集できません",
          );
        }
      }
      // artwork_token の artist 物理スキャン乗っ取り対策は image 単独では
      // 弱められない (image_url 自体は artist field を書き換えないため、
      // submitArtwork 側の artist 整合チェックで十分)。
    }

    const downloadToken = crypto.randomUUID();
    const objPath = "artworks/" + exCode + "_" + artworkId + ".jpg";
    const bucket = admin.storage().bucket();
    const file = bucket.file(objPath);
    await file.save(buffer, {
      metadata: {
        contentType: "image/jpeg",
        metadata: { firebaseStorageDownloadTokens: downloadToken },
      },
      resumable: false,
    });

    logger.info("artwork image uploaded", {
      exCode,
      artworkId,
      size: buffer.length,
      authMode,
      caller: authEmail || "(anon)",
    });

    return {
      success: true,
      url: constructDownloadUrl(bucket.name, objPath, downloadToken),
    };
  },
);

exports.uploadGalleryImage = onCall(
  { memory: "512MiB", timeoutSeconds: 60 },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const kind = String(data.kind || "").trim();

    if (!exCode || !/^[A-Za-z0-9_-]+$/.test(exCode)) {
      throw new HttpsError("invalid-argument", "exCode が不正です");
    }
    if (kind !== "hero" && kind !== "bg") {
      throw new HttpsError("invalid-argument", "kind は hero または bg のみです");
    }

    const buffer = decodeImageBase64(data.imageBase64, 3 * 1024 * 1024);

    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError("permission-denied", "Firebase Auth が必要です");
    }
    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    if (!isOperator) {
      const ok = await isOrganizerForEx(authEmail, exCode);
      if (!ok) {
        throw new HttpsError(
          "permission-denied",
          "この展覧会の主催者または運営者の Firebase Auth が必要です",
        );
      }
    }

    const downloadToken = crypto.randomUUID();
    const objPath = "gallery/" + exCode + "_" + kind + ".jpg";
    const bucket = admin.storage().bucket();
    const file = bucket.file(objPath);
    await file.save(buffer, {
      metadata: {
        contentType: "image/jpeg",
        metadata: { firebaseStorageDownloadTokens: downloadToken },
      },
      resumable: false,
    });

    logger.info("gallery image uploaded", {
      exCode,
      kind,
      size: buffer.length,
      caller: authEmail,
      role: isOperator ? "operator" : "organizer",
    });

    return {
      success: true,
      url: constructDownloadUrl(bucket.name, objPath, downloadToken),
    };
  },
);

// =========================================================
// β-3 mediation CFs (artworks read 経路の認可集中化)
//
//   firestore.rules で artworks の read を狭めた上で、anon (物理 QR) と
//   artist (招待 URL) の経路だけ CF 経由に倒す。operator / organizer は
//   Firebase Auth + Rules で直 read 可、visitor は Firebase Auth custom
//   token (role=visitor + exCode claim) + _published フィールドで直 read 可。
//
//   - getArtwork: 単一 doc。anon / artist / operator / organizer 受ける
//   - listArtworksByArtist: artist 経路で自分の作品一覧を取得
//   - syncArtworkPublishedFlags: web-exhibition.html の保存処理を mediate し、
//       exhibitions.gallery_visibility 更新と同時に artworks._published を
//       batch update する
// =========================================================

exports.getArtwork = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    const tok = data.accessToken || {};

    if (!exCode || !artworkId) {
      throw new HttpsError("invalid-argument", "exCode と artworkId が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      throw new HttpsError("invalid-argument", "exCode / artworkId が不正です");
    }

    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    let authMode = null;

    if (authEmail) {
      if (OPERATOR_EMAILS.indexOf(authEmail) !== -1) authMode = "operator";
      else if (await isOrganizerForEx(authEmail, exCode)) authMode = "organizer";
    }

    if (!authMode && tok && tok.kind) {
      const secret = ARTIST_TOKEN_SECRET.value();
      if (!secret) {
        throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
      }
      authMode = verifyHmacAccessToken(tok, exCode, artworkId, secret);
    }

    if (!authMode) {
      throw new HttpsError(
        "permission-denied",
        "読取り権限がありません (operator / organizer auth または有効なアクセストークンが必要)",
      );
    }

    const snap = await admin.firestore()
      .collection("artworks").doc(exCode + "_" + artworkId).get();
    if (!snap.exists) {
      throw new HttpsError("not-found", "対象の作品が見つかりません");
    }
    const docData = snap.data() || {};

    // artist_token: 既存 artist と token artist の一致を強制 (submitArtwork と同じポリシー)。
    if (authMode === "artist_token") {
      const tokArtist = String(tok.artist || "").trim();
      const docArtist = String(docData.artist || "").trim();
      if (docArtist && docArtist !== tokArtist) {
        throw new HttpsError(
          "permission-denied",
          "このトークンでは他の作家の作品を読めません",
        );
      }
    }

    return { success: true, artwork: docData };
  },
);

exports.listArtworksByArtist = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artistName = String(data.artistName || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    const tok = data.accessToken || {};

    if (!exCode || !artistName) {
      throw new HttpsError("invalid-argument", "exCode と artistName が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
      throw new HttpsError("invalid-argument", "exCode が不正です");
    }

    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    let authMode = null;

    if (authEmail) {
      if (OPERATOR_EMAILS.indexOf(authEmail) !== -1) authMode = "operator";
      else if (await isOrganizerForEx(authEmail, exCode)) authMode = "organizer";
    }

    // exhibition_token / artist_token: token kind に依らず list 用途で受ける。
    if (!authMode && tok && tok.kind && tok.kind !== "artwork") {
      const secret = ARTIST_TOKEN_SECRET.value();
      if (!secret) {
        throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
      }
      authMode = verifyHmacAccessToken(tok, exCode, "", secret);
    }

    // artwork_token (= 物理 QR 1 枚) も受ける。Phase 2 (b):
    //   QR 経由の anon 来場者が「自分の作品の作家として、他にも自作があるか」を
    //   index.html の案 C で確認するための経路。
    //   条件:
    //     - artworkId パラメータが必要 (= どの QR の話か CF が知る必要がある)
    //     - artwork_token の HMAC が exCode+artworkId に対して有効
    //     - artwork doc の現在の artist と要求された artistName が一致
    //   不一致 → permission-denied (他作家の一覧を覗き見されない)
    if (!authMode && tok && tok.kind === "artwork") {
      if (!artworkId || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
        throw new HttpsError(
          "invalid-argument",
          "artwork token 使用時は artworkId が必要です",
        );
      }
      const secret = ARTIST_TOKEN_SECRET.value();
      if (!secret) {
        throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
      }
      const tokAuthMode = verifyHmacAccessToken(tok, exCode, artworkId, secret);
      if (tokAuthMode === "artwork_token") {
        const artSnap = await admin.firestore()
          .collection("artworks").doc(exCode + "_" + artworkId).get();
        if (!artSnap.exists) {
          throw new HttpsError("not-found", "対象の作品が見つかりません");
        }
        const docArtist = String((artSnap.data() || {}).artist || "").trim();
        if (docArtist && docArtist === artistName) {
          authMode = "artwork_token";
        } else {
          // doc.artist が空 (= 新規スロット) や別作家の場合は拒否
          throw new HttpsError(
            "permission-denied",
            "この QR の作品の作家と異なる作家の一覧は読めません",
          );
        }
      }
    }

    if (!authMode) {
      throw new HttpsError(
        "permission-denied",
        "読取り権限がありません",
      );
    }

    // artist_token のときは token.artist と要求 artistName が一致しなければならない。
    if (authMode === "artist_token") {
      const tokArtist = String(tok.artist || "").trim();
      if (tokArtist !== artistName) {
        throw new HttpsError(
          "permission-denied",
          "このトークンでは指定された作家以外の一覧を読めません",
        );
      }
    }

    const snap = await admin.firestore().collection("artworks")
      .where("exCode", "==", exCode)
      .where("artist", "==", artistName)
      .get();
    const artworks = snap.docs.map((d) => d.data());
    return { success: true, artworks: artworks };
  },
);

exports.findEmptyArtworkSlot = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const tok = data.accessToken || {};

    if (!exCode || !/^[A-Za-z0-9_-]+$/.test(exCode)) {
      throw new HttpsError("invalid-argument", "exCode が不正です");
    }

    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    let authMode = null;

    if (authEmail) {
      if (OPERATOR_EMAILS.indexOf(authEmail) !== -1) authMode = "operator";
      else if (await isOrganizerForEx(authEmail, exCode)) authMode = "organizer";
    }

    // artwork_token は単一 doc 用なので list には使えない。
    // exhibition_token / artist_token / operator / organizer のみ受ける。
    if (!authMode && tok && tok.kind && tok.kind !== "artwork") {
      const secret = ARTIST_TOKEN_SECRET.value();
      if (!secret) {
        throw new HttpsError("internal", "ARTIST_TOKEN_SECRET が未設定です");
      }
      authMode = verifyHmacAccessToken(tok, exCode, "", secret);
    }

    if (!authMode) {
      throw new HttpsError("permission-denied", "読取り権限がありません");
    }

    // 空きスロット = status='0' or status=''。artwork_id でソートして先頭を返す。
    // (artist 経路で並列に 2 人が同じスロットを取る race は残るが、これは β-3 で
    // 直すべき問題ではなく submitArtwork 側で原子的に解決する別課題。Phase 2 候補。)
    const snap = await admin.firestore().collection("artworks")
      .where("exCode", "==", exCode)
      .get();
    const candidates = [];
    snap.docs.forEach((d) => {
      const data = d.data() || {};
      if (!data.artwork_id) return;
      const status = String(data.status || "").trim();
      if (status === "0" || status === "") candidates.push(data);
    });
    candidates.sort((a, b) => String(a.artwork_id).localeCompare(String(b.artwork_id)));
    if (candidates.length === 0) {
      return { success: false, error: "登録可能な空きがありません。すべての作品枠が埋まっています。" };
    }
    return { success: true, artworkId: candidates[0].artwork_id };
  },
);

exports.syncArtworkPublishedFlags = onCall(async (request) => {
  const data = request.data || {};
  const exCode = String(data.exCode || "").trim();
  const visibility = String(data.gallery_visibility || "").trim();
  const interactions = String(data.gallery_interactions || "").trim();

  if (!exCode || !/^[A-Za-z0-9_-]+$/.test(exCode)) {
    throw new HttpsError("invalid-argument", "exCode が不正です");
  }
  const VALID_VIS = ["closed", "visitor_only", "public"];
  if (VALID_VIS.indexOf(visibility) === -1) {
    throw new HttpsError("invalid-argument", "gallery_visibility が不正です");
  }

  const authEmail = String(
    (request.auth && request.auth.token && request.auth.token.email) || "",
  ).trim().toLowerCase();
  if (!authEmail) {
    throw new HttpsError("permission-denied", "Firebase Auth が必要です");
  }
  const isOp = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
  if (!isOp) {
    const ok = await isOrganizerForEx(authEmail, exCode);
    if (!ok) {
      throw new HttpsError(
        "permission-denied",
        "この展覧会の主催者または運営者の Firebase Auth が必要です",
      );
    }
  }

  const db = admin.firestore();
  const published = (visibility === "public" || visibility === "visitor_only");

  // exhibitions doc を更新 (gallery_visibility + gallery_interactions)
  const exhibitionUpdate = { gallery_visibility: visibility };
  if (interactions) {
    exhibitionUpdate.gallery_interactions = interactions;
  }
  await db.collection("exhibitions").doc(exCode).set(exhibitionUpdate, { merge: true });

  // 全 artworks._published を batch update。
  // status 区別なく一律 set する (Rules で visitor は status='1' も別途要求するため
  // 空きスロットが漏れる心配はない)。
  const snap = await db.collection("artworks").where("exCode", "==", exCode).get();
  let updated = 0;
  let batch = db.batch();
  let pendingInBatch = 0;
  const BATCH_LIMIT = 400;
  for (const doc of snap.docs) {
    batch.update(doc.ref, { _published: published });
    pendingInBatch++;
    updated++;
    if (pendingInBatch >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      pendingInBatch = 0;
    }
  }
  if (pendingInBatch > 0) await batch.commit();

  logger.info("syncArtworkPublishedFlags success", {
    exCode, visibility, updated, caller: authEmail,
    role: isOp ? "operator" : "organizer",
  });
  return { success: true, exCode, visibility, updated };
});

exports.setLikesExcludedFromStats = onCall(async (request) => {
  const authEmail = String(
    (request.auth && request.auth.token && request.auth.token.email) || "",
  ).trim().toLowerCase();
  if (!authEmail) {
    throw new HttpsError("permission-denied", "Firebase Auth が必要です");
  }

  const data = request.data || {};
  const exCode = String(data.exCode || "").trim();
  const sessionIds = data.sessionIds;
  const excluded = !!data.excluded;

  if (!exCode) {
    throw new HttpsError("invalid-argument", "exCode が必要です");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(exCode)) {
    throw new HttpsError("invalid-argument", "exCode が不正です");
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new HttpsError("invalid-argument", "sessionIds 配列が必要です");
  }
  if (sessionIds.length > 50) {
    throw new HttpsError("invalid-argument", "sessionIds は 50 件以内にしてください");
  }

  // 認可: operator OR 該当 exhibition の organizer
  const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
  if (!isOperator) {
    const ok = await isOrganizerForEx(authEmail, exCode);
    if (!ok) {
      throw new HttpsError(
        "permission-denied",
        "この展覧会の主催者または運営者の Firebase Auth が必要です",
      );
    }
  }

  const db = admin.firestore();
  let updated = 0;
  for (const rawSid of sessionIds) {
    if (typeof rawSid !== "string") continue;
    const sid = rawSid.trim();
    if (!sid || sid.length > 200) continue;
    try {
      const snap = await db.collection("likes")
        .where("exCode", "==", exCode)
        .where("sessionId", "==", sid)
        .get();
      if (snap.empty) continue;
      const batch = db.batch();
      snap.docs.forEach((doc) => {
        batch.update(doc.ref, { excluded_from_stats: excluded });
      });
      await batch.commit();
      updated += snap.docs.length;
    } catch (e) {
      logger.warn("setLikesExcludedFromStats: per-session failed", {
        exCode, sid, error: e && e.message,
      });
    }
  }

  logger.info("setLikesExcludedFromStats success", {
    exCode,
    sessionCount: sessionIds.length,
    excluded,
    updated,
    caller: authEmail,
    role: isOperator ? "operator" : "organizer",
  });
  return { success: true, updated };
});

// =========================================================
// callGasAuthed: ログイン必須の GAS 操作を集約する「受付」。
//   従来クライアントは GAS Web App (ANYONE_ANONYMOUS) を直接叩いており、
//   exCode さえ知れば誰でも運営者権限で操作・メール送信できる状態だった。
//   この CF を間に挟み、Firebase Auth + organizer/operator 認可を通してから
//   ADMIN_SECRET 付きで GAS に中継する。GAS 側は対象 action を adminSecret
//   必須にすることで直叩きを塞ぐ (CLAUDE.md AI-Native 原則: 認可を奥に置く)。
//
//   入力: { action, params }  (organizer 認可の action は params に ex を含む)
//   出力: GAS doPost の JSON をそのまま返す (既存クライアントの戻り値処理と互換)。
//
//   GAS_PROXY_ACTIONS: action ごとの認可種別。
//     "organizer" = 対象 ex の主催者 or operator、"operator" = operator のみ。
//   段階的移行中。乗せ替えた action から順にここへ追加していく。
// =========================================================
const GAS_PROXY_ACTIONS = {
  sendArtistGuide: "organizer",
  sendInquiryReply: "operator",
  // 第2回 (2026-06-12): データ改変系。すべて対象 ex の主催者 (or operator)。
  updateExName: "organizer",
  addArtworks: "organizer",
  saveRegistrationFields: "organizer",
  bumpArtworkCount: "organizer",
  graduateExhibition: "organizer",
};

exports.callGasAuthed = onCall(
  { secrets: [GAS_ADMIN_SECRET] },
  async (request) => {
    const authEmail = String(
      (request.auth && request.auth.token && request.auth.token.email) || "",
    ).trim().toLowerCase();
    if (!authEmail) {
      throw new HttpsError("permission-denied", "ログインが必要です");
    }

    const data = request.data || {};
    const action = String(data.action || "").trim();
    const params = (data.params && typeof data.params === "object" &&
      !Array.isArray(data.params)) ? data.params : {};

    const authKind = GAS_PROXY_ACTIONS[action];
    if (!authKind) {
      throw new HttpsError(
        "invalid-argument",
        "許可されていないアクションです: " + action,
      );
    }

    const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;
    if (authKind === "operator") {
      if (!isOperator) {
        throw new HttpsError("permission-denied", "運営者の権限が必要です");
      }
    } else { // "organizer"
      const exCode = String(params.ex || params.exCode || "").trim();
      if (!exCode || !/^[A-Za-z0-9_-]+$/.test(exCode)) {
        throw new HttpsError("invalid-argument", "ex が不正です");
      }
      if (!isOperator) {
        const ok = await isOrganizerForEx(authEmail, exCode);
        if (!ok) {
          throw new HttpsError(
            "permission-denied",
            "この展覧会の主催者または運営者の権限が必要です",
          );
        }
      }
    }

    const adminSecret = GAS_ADMIN_SECRET.value();
    if (!adminSecret) {
      throw new HttpsError("internal", "GAS_ADMIN_SECRET が未設定です");
    }

    // params をそのまま GAS doPost に転送 (object は JSON 文字列化)。
    const form = new URLSearchParams();
    form.set("action", action);
    form.set("adminSecret", adminSecret);
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v === null || v === undefined) continue;
      form.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }

    let res;
    try {
      res = await fetch(GAS_CAPTION_EXEC_URL.value(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        redirect: "follow",
      });
    } catch (e) {
      logger.error("callGasAuthed GAS fetch failed", {
        action, error: e && e.message,
      });
      throw new HttpsError(
        "internal",
        "GAS との通信に失敗しました: " + (e && e.message),
      );
    }
    const text = await res.text();
    if (!res.ok) {
      logger.warn("callGasAuthed GAS non-200", { action, status: res.status });
      throw new HttpsError("internal", "GAS エラー HTTP " + res.status);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new HttpsError("internal", "GAS の応答が JSON ではありません");
    }
    logger.info("callGasAuthed ok", { action, caller: authEmail });
    return json;
  },
);

// =========================================================
// deleteLike: いいね / コメントの取消・削除を本人確認してから行う「削除専用窓口」。
//   #3 対策。従来は Firestore Rules の sessionId 一致で visitor が直接 delete していたが、
//   sessionId は likes の公開 read で誰でも見え、かつ任意 sessionId の custom token を
//   発行できたため、他人の like/comment を消せてしまった。
//   本 CF は doc の ownerKeyHash (= sha256(ownerKey)) と、クライアントが持つ ownerKey を
//   照合し、一致した本人だけ削除する。Rules 側は likes の delete/update を operator のみに
//   絞ったので、visitor の削除はこの経路だけになる。
//
//   入力: { likeId, ownerKey }
//   - operator (Firebase Auth) は ownerKey 不要でモデレーション削除可。
//   - それ以外は ownerKey の指紋一致が必須。指紋を持たない旧 doc は operator のみ削除可。
// =========================================================
exports.deleteLike = onCall(async (request) => {
  const data = request.data || {};
  const likeId = String(data.likeId || "").trim();
  const ownerKey = String(data.ownerKey || "");
  if (!likeId) {
    throw new HttpsError("invalid-argument", "likeId が必要です");
  }

  const authEmail = String(
    (request.auth && request.auth.token && request.auth.token.email) || "",
  ).trim().toLowerCase();
  const isOperator = OPERATOR_EMAILS.indexOf(authEmail) !== -1;

  const ref = admin.firestore().collection("likes").doc(likeId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { success: true, alreadyGone: true };
  }

  if (!isOperator) {
    if (!ownerKey) {
      throw new HttpsError("permission-denied", "本人確認の鍵がありません");
    }
    const storedHash = String((snap.data() || {}).ownerKeyHash || "");
    if (!/^[0-9a-f]{64}$/.test(storedHash)) {
      throw new HttpsError(
        "permission-denied",
        "この項目は本人確認の対象外です (古いデータのため取消できません)",
      );
    }
    const computed = crypto.createHash("sha256").update(ownerKey).digest("hex");
    const a = Buffer.from(computed, "hex");
    const b = Buffer.from(storedHash, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new HttpsError("permission-denied", "本人確認に失敗しました");
    }
  }

  await ref.delete();
  logger.info("deleteLike", { likeId, by: isOperator ? "operator" : "owner" });
  return { success: true };
});
