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
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

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

// 運営者メールアドレス。public/js/operator-auth.js の OPERATOR_EMAILS と
// 一致させること。Cloud Function 側でも email auth を二重チェックする。
const OPERATOR_EMAILS = ["rymist1@gmail.com"];

const SMTP_FROM_NAME = "Rohei Printer System";
const SMTP_FROM_ADDR = "noreply.rohei.printer@gmail.com";
const SMTP_REPLY_TO = "\"Rohei Printer Support\" <noreply.rohei.printer+contact@gmail.com>";

exports.sendSignInLink = onCall(
  { secrets: [SMTP_PASSWORD] },
  async (request) => {
    const email = String((request.data && request.data.email) || "").trim().toLowerCase();
    const continueUrl = String((request.data && request.data.continueUrl) || "").trim();

    if (!email || !continueUrl) {
      throw new HttpsError("invalid-argument", "email と continueUrl が必要です");
    }

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

    const subject = "[Rohei Printer System] 展覧会セットアップの確認";

    // プレーンテキスト版: URL をそのまま含める (テキスト表示でも見える)
    const text = [
      "Rohei Printer System をご利用いただきありがとうございます。",
      "",
      "展覧会セットアップを続けるため、下記の URL を開いて確認を完了してください。",
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
      "  <p>展覧会セットアップを続けるため、下のボタンを押して確認を完了してください。</p>\n" +
      "  <p>\n" +
      "    <a href=\"" + link + "\" style=\"display:inline-block;padding:12px 24px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;\">確認を完了する</a>\n" +
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
  const db = admin.firestore();
  const exRef = db.collection("exhibitions").doc(exCode);
  const ts = new Date().toISOString();
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
  logger.info("exhibition finalized", { exCode, email: verifiedEmail });
  return { success: true, exCode };
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

    if (visibility === "closed") {
      throw new HttpsError(
        "permission-denied",
        "この展覧会は現在公開されていません",
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

    // Custom token を発行。uid は予測不能な乱数で、claims に exCode / role を入れる。
    // Firestore Rules で request.auth.token.role / exCode を見て gate する。
    const randomId = crypto.randomBytes(8).toString("hex");
    const uid = `gallery_${exCode}_${randomId}`;
    const customToken = await admin.auth().createCustomToken(uid, {
      role: "visitor",
      exCode: exCode,
    });

    logger.info("gallery visitor token issued", { exCode, visibility, uid });
    return {
      token: customToken,
      exCode,
      visibility,
      interactions,
    };
  },
);
