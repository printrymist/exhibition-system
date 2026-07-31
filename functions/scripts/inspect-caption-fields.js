// inspect-caption-fields.js — read-only 調査用 (使い捨て)
// 展覧会の registration_fields / caption_fields / headers / 採用テンプレと
// 保存テンプレ items を突き合わせて表示する。書き込みは一切しない。
// Usage: node functions/scripts/inspect-caption-fields.js --ex=<exCode>
'use strict';
// 認証: firebase CLI (`firebase login`) の認証情報を流用して Firestore REST API を叩く。
// firebase-tools と同じ OAuth クライアント (公開定数) で refresh → access token 交換。
const os = require('os');
const path = require('path');
const PROJECT = 'rohei-printer-system';
const FIREBASE_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi'; // firebase-tools 同梱の公開定数

const args = {};
process.argv.slice(2).forEach(a => {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) args[a.slice(2)] = true;
    else args[a.slice(2, eq)] = a.slice(eq + 1);
  }
});
if (!args.ex) { console.error('Usage: node inspect-caption-fields.js --ex=<exCode>'); process.exit(1); }

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function getAccessToken() {
  const cfg = require(path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'));
  const refresh = cfg && cfg.tokens && cfg.tokens.refresh_token;
  if (!refresh) throw new Error('firebase-tools の認証情報が見つかりません (`firebase login` が必要)');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: FIREBASE_CLIENT_ID,
      client_secret: FIREBASE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error('token exchange failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return (await res.json()).access_token;
}

// Firestore REST の value object ({stringValue: ...} 等) を素の JS 値に戻す
function fromFsValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue' in v) return fromFsFields(v.mapValue.fields || {});
  return v;
}
function fromFsFields(fields) {
  const o = {};
  Object.keys(fields || {}).forEach(k => { o[k] = fromFsValue(fields[k]); });
  return o;
}

(async function main() {
  const token = await getAccessToken();
  const base = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
  const authHeader = { Authorization: 'Bearer ' + token };

  const exRes = await fetch(base + '/exhibitions/' + encodeURIComponent(args.ex), { headers: authHeader });
  if (!exRes.ok) { console.error('exhibition read failed:', exRes.status, (await exRes.text()).slice(0, 300)); process.exit(1); }
  const d = fromFsFields((await exRes.json()).fields);

  const regFields = parseMaybeJson(d.registration_fields) || [];
  const capFields = parseMaybeJson(d.caption_fields) || [];
  const regNames = regFields.map(f => f && f.name);
  const capNames = capFields.map(f => f && f.name);
  const headers = Array.isArray(d.headers) ? d.headers : parseMaybeJson(d.headers);

  console.log('=== exhibitions/' + args.ex + ' ===');
  console.log('caption_template_id :', d.caption_template_id || '(none)');
  console.log('registration_fields :', JSON.stringify(regNames));
  console.log('caption_fields      :', JSON.stringify(capNames));
  console.log('headers             :', JSON.stringify(headers));
  console.log('');
  console.log('caption_fields - registration_fields :',
    JSON.stringify(capNames.filter(n => !regNames.includes(n))));
  console.log('caption_fields - headers             :',
    JSON.stringify(Array.isArray(headers) ? capNames.filter(n => !headers.includes(n)) : '(headers not array)'));
  console.log('');

  const qRes = await fetch(base.replace(/\/documents$/, '') + '/documents:runQuery', {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'caption_templates' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'exCode' },
            op: 'EQUAL',
            value: { stringValue: args.ex },
          },
        },
      },
    }),
  });
  if (!qRes.ok) { console.error('templates query failed:', qRes.status, (await qRes.text()).slice(0, 300)); process.exit(1); }
  const rows = (await qRes.json()).filter(r => r.document);
  console.log('=== caption_templates (exCode==' + args.ex + '): ' + rows.length + ' 件 ===');
  rows.forEach(r => {
    const t = { id: r.document.name.split('/').pop() };
    const td = fromFsFields(r.document.fields);
    const settings = parseMaybeJson(td.settingsJson) || {};
    const items = Array.isArray(settings.items) ? settings.items : [];
    console.log('--- doc:', t.id, ' name:', td.name, ' updatedAt:', td.updatedAt || td.createdAt);
    console.log('    paperMode:', settings.paperMode, ' cols x rows:', settings.cols, 'x', settings.rows,
      ' paper:', settings.paperSize, settings.orientation, ' cardSheet:', settings.cardSheet,
      settings.cardSheet ? ('card ' + settings.cardW + 'x' + settings.cardH + 'mm') : '');
    const dump = (it, indent) => {
      if (it.type === 'field') {
        console.log(indent + 'field: ' + it.name +
          '  size=' + it.size + ' minSize=' + it.minSize + ' maxLines=' + it.maxLines +
          ' bold=' + !!it.bold +
          '  [reg:' + (regNames.includes(it.name) ? 'o' : 'X') +
          ' cap:' + (capNames.includes(it.name) ? 'o' : 'X') +
          ' hdr:' + (Array.isArray(headers) && headers.includes(it.name) ? 'o' : 'X') + ']');
      } else if (it.type === 'group') {
        console.log(indent + 'group (sep=' + JSON.stringify(it.sep) + '):');
        (it.children || []).forEach(c => dump(c, indent + '  '));
      } else {
        console.log(indent + it.type + (it.size ? ' (' + it.size + ')' : ''));
      }
    };
    items.forEach(it => dump(it, '    '));
    const flat = [];
    items.forEach(it => {
      if (it.type === 'field') flat.push(it.name);
      else if (it.type === 'group') (it.children || []).forEach(c => flat.push(c.name));
    });
    console.log('    >>> caption_fields のうちテンプレに無い項目:',
      JSON.stringify(capNames.filter(n => !flat.includes(n))));
  });
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
