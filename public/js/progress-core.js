/**
 * progress-core.js — 進捗アシスタントの判定ロジック (純粋関数)
 *
 * 「展覧会の準備が今どこまで済み、次に何をすればいいか」を、展覧会 doc と作品一覧から導出する。
 * 描画 (js/progress-assistant.js) とは分離してあり、DOM / Firebase に一切触らない。
 * 将来 AI アシスタントを載せるときも同じ判定を使い、画面と AI の言うことがずれないようにする
 * (CLAUDE.md 設計原則4: LLM 機能は既存ロジックのクライアント)。必要になれば CF に移設する。
 *
 * ブラウザでは window.QriineProgressCore、Node (scripts のテスト) では module.exports。
 */
(function (root) {
  'use strict';

  // 展覧会作成時に GAS が入れる registration_fields の初期値 (gas_Exhibition_register/aps.js)。
  // 画面①の既定 (field-defs.js の DEFAULT_FIELDS) は7項目なので、①で一度でも保存すれば必ずこれと異なる。
  const GAS_INITIAL_FIELDS = ['title', 'year', 'technique', 'size', 'price'];

  // fields_confirmed_at の記録を始めた日。これより前に作られた展覧会は記録を持たないため、
  // 「初期値から変わっていれば確認済み」とみなす (進行中の展覧会に急に未完了を出さないため)。
  // これ以降の展覧会は記録のみで判定する (caption のテンプレ採用で項目が足されただけでは済みにしない)。
  const FIELDS_CONFIRM_TRACKING_SINCE = '2026-09-24T00:00:00+09:00';

  function parseFieldNames(v) {
    if (!v) return [];
    let arr = v;
    if (typeof v === 'string') {
      try { arr = JSON.parse(v); } catch (e) { return []; }
    }
    if (!Array.isArray(arr)) return [];
    return arr.map(f => (f && typeof f === 'object') ? f.name : f).filter(Boolean);
  }

  function isLegacyExhibition(ex) {
    const created = Date.parse(ex.createdAt || '');
    if (isNaN(created)) return true;  // createdAt を持たない古い展覧会
    return created < Date.parse(FIELDS_CONFIRM_TRACKING_SINCE);
  }

  function fieldsConfirmed(ex) {
    if (ex.fields_confirmed_at) return true;
    if (!isLegacyExhibition(ex)) return false;
    const names = parseFieldNames(ex.registration_fields);
    if (names.length === 0) return false;
    if (names.length !== GAS_INITIAL_FIELDS.length) return true;
    return !GAS_INITIAL_FIELDS.every((n, i) => names[i] === n);
  }

  // 'YYYY-MM-DD' / 'YYYY/MM/DD' はその暦日、ISO 日時などは JST の暦日として扱い、
  // 暦日を UTC 0時の epoch ms で返す (日数差の計算用)。読めなければ null。
  function toJstDay(v) {
    if (!v) return null;
    if (typeof v === 'object' && typeof v.toDate === 'function') v = v.toDate();
    if (typeof v === 'string') {
      const m = v.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    }
    const t = (v instanceof Date) ? v.getTime() : Date.parse(v);
    if (isNaN(t)) return null;
    const j = new Date(t + 9 * 3600 * 1000);
    return Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate());
  }

  function daysUntil(dateValue, now) {
    const target = toJstDay(dateValue);
    const today = toJstDay(now);
    if (target == null || today == null) return null;
    return Math.round((target - today) / 86400000);
  }

  function formatJstDate(v) {
    const d = toJstDay(v);
    if (d == null) return '';
    const x = new Date(d);
    return (x.getUTCMonth() + 1) + '/' + x.getUTCDate();
  }

  /**
   * @param {object} input
   *   ex                  exhibitions/{exCode} の doc データ (必須)
   *   exCode              展覧会コード (必須)
   *   artworks            その展覧会の artworks doc データ配列 (空の作品枠を含む)。未取得なら null
   *   hasPastExhibitions  この主催者に他の展覧会があるか (複製の案内を出すため)
   *   now                 現在時刻 (Date、省略時は new Date())
   * @returns {{ steps, optional, next, doneCount, total, daysToStart, allDone }}
   *   state: 'done' | 'partial' (途中) | 'todo' (未着手) | 'unknown' (データ未取得)
   */
  function computeProgress(input) {
    const ex = input.ex || {};
    const exCode = input.exCode || ex.ex_code || '';
    const now = input.now || new Date();
    const q = encodeURIComponent(exCode);
    const reg = tab => 'register.html?ex=' + q + '&tab=' + tab;
    const captionUrl = 'caption.html?ex=' + q;

    const steps = [];

    // 1. 項目を決める
    const fieldsDone = fieldsConfirmed(ex);
    const artworks = Array.isArray(input.artworks) ? input.artworks : null;
    const entered = artworks ? artworks.filter(a => String(a.status) === '1') : [];
    const fieldsStep = {
      key: 'fields',
      label: '項目を決める',
      state: fieldsDone ? 'done' : 'todo',
      detail: fieldsDone ? '' : '作品について何を記録するか(タイトル・サイズ等)を一度確認してください。',
      action: { label: '項目を確認する', href: reg('fields'), tab: 'fields' },
    };
    if (!fieldsDone && input.hasPastExhibitions) {
      fieldsStep.altAction = { label: '前回の展覧会から設定を複製する', href: reg('fields') + '&import=1', tab: 'fields', openImport: true };
    }
    if (!fieldsDone && entered.length > 0) {
      fieldsStep.warning = 'あとから項目を追加すると、入力済みの作品はその欄が空欄になります。';
    }
    steps.push(fieldsStep);

    // 2. 作品を入力 (空の作品枠は最初から存在するので status=='1' を数える)
    const artStep = { key: 'artworks', label: '作品を入力', action: { label: '作品を入力する', href: reg('artworks'), tab: 'artworks' } };
    if (!artworks) {
      artStep.state = 'unknown';
      artStep.detail = '';
    } else {
      const total = artworks.length;
      const noImage = entered.filter(a => !a.image_url).length;
      artStep.count = { entered: entered.length, total: total, noImage: noImage };
      if (entered.length === 0) {
        artStep.state = 'todo';
        artStep.detail = total > 0 ? '0 / ' + total + ' 点' : '';
      } else if (entered.length < total) {
        artStep.state = 'partial';
        artStep.detail = entered.length + ' / ' + total + ' 点 入力済み';
        artStep.action = { label: '作品の入力を続ける', href: reg('artworks'), tab: 'artworks' };
      } else {
        artStep.state = 'done';
        artStep.detail = entered.length + ' 点 入力済み';
      }
      if (noImage > 0) artStep.warning = '画像のない作品が ' + noImage + ' 点あります。';
    }
    steps.push(artStep);

    // 3. キャプションを決める
    const tplId = String(ex.caption_template_id || '');
    steps.push({
      key: 'caption',
      label: 'キャプションを決める',
      state: tplId ? 'done' : 'todo',
      detail: tplId ? '' : 'キャプションのデザイン(テンプレート)を選んでください。',
      action: { label: 'キャプションを選ぶ', href: captionUrl, page: 'caption' },
    });

    // 4. 印刷
    const printedAt = ex.caption_printed_at || '';
    steps.push({
      key: 'print',
      label: '印刷',
      state: printedAt ? 'done' : 'todo',
      detail: printedAt ? '印刷済み (' + formatJstDate(printedAt) + ')' : '',
      action: { label: printedAt ? '印刷画面を開く' : 'キャプションを印刷する', href: captionUrl, page: 'caption' },
    });

    // 任意項目 (やらなくても展示はできる)
    const vis = ex.gallery_visibility || 'closed';
    const optional = [
      {
        key: 'gallery',
        label: 'Web展覧会',
        status: vis === 'public' ? '公開中' : vis === 'visitor_only' ? '来場者のみに公開中' : '未公開',
        href: 'web-exhibition.html?ex=' + q,
      },
      {
        key: 'comments',
        label: '感想の受付期間',
        status: (ex.comments_start_at || ex.comments_end_at) ? '設定済み' : '未設定 (いつでも受付)',
        href: reg('manage'), tab: 'manage',
      },
    ];
    if (ex.is_sandbox) {
      optional.push({ key: 'graduate', label: '本番に切り替え', status: '練習モード中', href: reg('manage'), tab: 'manage' });
    }

    // 次の一手: 未着手の最初のステップ → なければ途中の最初のステップ。
    // 途中 (例: 作品 12/20) は後続を止めない (枠が多めに取られていることもあるため)。
    const next = steps.find(s => s.state === 'todo') || steps.find(s => s.state === 'partial') || null;
    const doneCount = steps.filter(s => s.state === 'done').length;

    return {
      exCode: exCode,
      steps: steps,
      optional: optional,
      next: next,
      doneCount: doneCount,
      total: steps.length,
      allDone: doneCount === steps.length,
      daysToStart: ex.start_date ? daysUntil(ex.start_date, now) : null,
    };
  }

  const api = { computeProgress, fieldsConfirmed, daysUntil, parseFieldNames, GAS_INITIAL_FIELDS, FIELDS_CONFIRM_TRACKING_SINCE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QriineProgressCore = api;
})(typeof window !== 'undefined' ? window : this);
