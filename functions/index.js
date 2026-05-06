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
// Artwork access tokens (Plan 5-A: security_key の置換)
//
// 5 種類の認証経路をサポートする。
//   1. operator email (OPERATOR_EMAILS にあれば常時 OK)
//   2. organizer email (exhibitions/{ex}.email と auth.token.email が一致)
//   3. exhibition access token (input.html 招待 URL: ex 全体の作品に書ける)
//   4. artwork QR token (index.html QR: 特定 artworkId にだけ書ける)
//   5. legacy security_key (既発行 QR の互換、最終的に廃止)
//
// 1〜4 は Cloud Function 内で auth、admin SDK で書き込みするので、
// Firestore Rules は将来的に書き込み禁止に閉じてよい (セッション 2 で対応)。
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

exports.submitArtwork = onCall(
  { secrets: [ARTIST_TOKEN_SECRET] },
  async (request) => {
    const data = request.data || {};
    const exCode = String(data.exCode || "").trim();
    const artworkId = String(data.artworkId || "").trim();
    const fields = data.fields || {};
    const tok = data.accessToken || {};

    if (!exCode || !artworkId) {
      throw new HttpsError("invalid-argument", "exCode と artworkId が必要です");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(exCode) || !/^[A-Za-z0-9_-]+$/.test(artworkId)) {
      throw new HttpsError("invalid-argument", "exCode / artworkId が不正です");
    }
    if (typeof fields !== "object" || Array.isArray(fields)) {
      throw new HttpsError("invalid-argument", "fields は object である必要があります");
    }

    // クライアントが上書き不可のフィールド (システム管理) を除外。
    const FORBIDDEN = new Set([
      "security_key", "exCode", "artworkId", "artwork_id",
      "createdAt", "migratedAt", "backfilledAt", "updatedAt",
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
        const expected = computeArtworkSig(secret, exCode, artworkId, exp);
        const a = Buffer.from(expected, "hex");
        const b = Buffer.from(sig, "hex");
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          authMode = "artwork_token";
        }
      } else if (tok.kind === "legacy") {
        const legacyKey = String(tok.key || "");
        if (existingSnap.exists) {
          const existingKey = String((existingSnap.data() || {}).security_key || "");
          if (existingKey && existingKey === legacyKey) {
            authMode = "legacy_key";
          }
        }
      }
    }

    if (!authMode) {
      throw new HttpsError(
        "permission-denied",
        "書き込み権限がありません (operator / organizer auth または有効なアクセストークンが必要)",
      );
    }

    if (!existingSnap.exists) {
      if (authMode === "artwork_token" || authMode === "legacy_key") {
        throw new HttpsError("not-found", "対象の作品枠が見つかりません");
      }
    }

    if (existingSnap.exists) {
      const existingEx = String((existingSnap.data() || {}).exCode || "");
      if (existingEx && existingEx !== exCode) {
        throw new HttpsError("failed-precondition", "doc の exCode が一致しません");
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
    }

    await docRef.set(writePayload, { merge: true });

    logger.info("artwork submitted", {
      exCode,
      artworkId,
      authMode,
      caller: authEmail || "(anon)",
      fieldKeys: Object.keys(cleanFields),
    });
    return { success: true, exCode, artworkId, authMode };
  },
);
