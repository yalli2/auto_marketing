/**
 * 다인에듀 뉴스레터 자동화 백엔드 (Google Apps Script)
 * ------------------------------------------------------------------
 * 하는 일
 *  1) 랜딩 페이지에서 들어온 구독 신청을 받아 '수신동의 기록'과 함께 시트에 저장
 *  2) 확인 메일(더블 옵트인) → 본인이 확인해야만 발송 대상이 됨
 *  3) GitHub 저장소의 newsletters/queue.json 을 매일 읽어 새 뉴스레터를 가져옴
 *  4) 원장님께 미리보기 메일 발송 → [발송 승인]을 눌러야 구독자에게 발송
 *  5) 모든 광고 메일에 (광고) 표기, 전송자 정보, 수신거부 링크 자동 삽입
 *  6) 수신거부 즉시 처리 + 처리 결과 통지, 2년마다 수신동의 확인 안내
 *
 * 설치: 구글 시트 > 확장 프로그램 > Apps Script 에 이 파일을 붙여넣고 setup() 실행.
 * 자세한 순서는 저장소의 SETUP.md 참고.
 */

const TZ = 'Asia/Seoul';
// 스크립트를 시트의 [확장 프로그램 → Apps Script]가 아닌 곳에서 만들었다면
// 시트 주소(…/spreadsheets/d/여기/edit)의 ID를 따옴표 안에 넣으세요.
const SHEET_ID = '';
const PER_RUN_CAP = 40; // 한 번 실행(1시간 간격)에 보내는 최대 통수
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

const SHEETS = {
  Subscribers: ['email', 'name', 'type', 'interests', 'status', 'token',
    'consent_privacy_at', 'consent_marketing_at', 'consent_version', 'source',
    'created_at', 'confirmed_at', 'unsubscribed_at', 'last_consent_check_at'],
  Campaigns: ['id', 'send_date', 'subject', 'preheader', 'audience', 'status',
    'created_at', 'approved_at', 'sent_count', 'finished_at', 'body_html'],
  SendLog: ['at', 'campaign_id', 'email', 'result'],
  Settings: ['key', 'value', '설명'],
};

const DEFAULT_SETTINGS = [
  ['BRAND_NAME', '다인에듀', '메일에 표시되는 브랜드 이름'],
  ['SENDER_LEGAL_NAME', '다인원격평생교육직업학원', '전송자 정식 명칭 (사업자등록증 기준으로 확인)'],
  ['SENDER_ADDRESS', '', '[필수] 사업장 주소 - 비어 있으면 광고 메일이 발송되지 않습니다'],
  ['SENDER_PHONE', '', '[필수] 대표 전화번호 - 비어 있으면 광고 메일이 발송되지 않습니다'],
  ['SENDER_EMAIL', '', '문의/회신용 이메일 (setup 실행 시 자동 입력)'],
  ['SITE_URL', 'https://www.dainedu.net', '홈페이지 주소'],
  ['LANDING_URL', 'https://yalli2.github.io/auto_marketing/', '구독 신청 페이지 주소'],
  ['WELCOME_GIFT_URL', '', '(선택) 구독 확인 직후 화면에 보여줄 무료 자료 링크'],
  ['QUEUE_URL', 'https://raw.githubusercontent.com/yalli2/auto_marketing/main/newsletters/queue.json', '뉴스레터 대기열 주소'],
  ['RAW_BASE', 'https://raw.githubusercontent.com/yalli2/auto_marketing/main/', '저장소 raw 주소'],
  ['WEBAPP_URL', '', '[필수] 웹 앱 배포 후 받은 URL (…/exec)'],
  ['AUTO_SEND', 'FALSE', 'TRUE면 승인 없이 자동 발송 (권장: FALSE)'],
  ['DAILY_LIMIT', '80', '하루 최대 발송 통수 (무료 Gmail은 하루 100통 안팎이 한도)'],
  ['SEND_HOUR_START', '9', '발송 시작 시각 (시)'],
  ['SEND_HOUR_END', '18', '발송 종료 시각 (시)'],
  ['CONSENT_VERSION', '2026-11', '동의 문구 버전 (랜딩 페이지 문구를 바꾸면 함께 변경)'],
  ['ADMIN_KEY', '', '발송 승인 링크용 비밀키 (자동 생성, 공유 금지)'],
];

/* ====================== 1. 최초 설치 ====================== */

function setup() {
  const ss = ss_();
  Object.keys(SHEETS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = SHEETS[name];
    if (sh.getLastRow() === 0) sh.appendRow(head);
    // 날짜·숫자 자동 변환을 막기 위해 전체를 '일반 텍스트'로 지정
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
    sh.setFrozenRows(1);
  });

  const t = table_('Settings');
  const have = {};
  t.rows.forEach(function (r) { have[r.key] = true; });
  DEFAULT_SETTINGS.forEach(function (d) {
    if (have[d[0]]) return;
    let value = d[1];
    if (d[0] === 'ADMIN_KEY') value = newToken_();
    if (d[0] === 'SENDER_EMAIL') value = Session.getEffectiveUser().getEmail();
    t.sh.appendRow([d[0], value, d[2]]);
  });

  ScriptApp.getProjectTriggers().forEach(function (tr) { ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('checkQueue').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
  ScriptApp.newTrigger('sendApproved').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('reconfirmConsents').timeBased().onMonthDay(1).atHour(10).inTimezone(TZ).create();
  return '설치 완료: 시트 4개와 자동 실행 3개가 준비되었습니다.';
}

/* ====================== 2. 웹 요청 처리 ====================== */

function doPost(e) {
  let out;
  try {
    out = subscribe_((e && e.parameter) || {});
  } catch (err) {
    console.error(err);
    out = { ok: false, code: 'server_error', message: '일시적인 오류가 발생했습니다. 잠시 후 다시 신청해 주세요.' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const s = settings_();
  try {
    switch (p.action) {
      case 'confirm': return confirmAsk_(p.token, s);
      case 'confirm2': return confirmDo_(p.token, s);
      case 'unsub': return unsubscribeDo_(p.token, s);
      case 'approve': return approveAsk_(p.id, p.key, s);
      case 'approve2': return approveDo_(p.id, p.key, s);
      default: return page_(s.BRAND_NAME + ' 뉴스레터', '<p>정상 동작 중입니다.</p><p><a target="_top" href="' + esc_(s.LANDING_URL) + '">구독 신청 페이지로 가기</a></p>');
    }
  } catch (err) {
    console.error(err);
    return page_('오류', '<p>요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.</p>');
  }
}

/* ====================== 3. 구독 신청 / 확인 / 수신거부 ====================== */

function subscribe_(p) {
  if (p.website) return { ok: true, code: 'pending' }; // 봇 차단용 숨은 칸
  const email = String(p.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, code: 'bad_email', message: '이메일 주소를 다시 확인해 주세요.' };
  }
  if (p.age14 !== 'yes' || p.consent_privacy !== 'yes' || p.consent_marketing !== 'yes') {
    return { ok: false, code: 'no_consent', message: '필수 동의 항목을 모두 선택해 주세요.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const s = settings_();
    const t = table_('Subscribers');
    const now = now_();
    const existing = t.rows.filter(function (r) { return String(r.email).toLowerCase() === email; })[0];
    if (existing && existing.status === 'active') return { ok: true, code: 'already' };
    if (existing && existing.status === 'pending' && minutesSince_(existing.created_at) < 10) {
      return { ok: true, code: 'pending' }; // 방금 보낸 확인 메일이 있음
    }
    if (!confirmQuotaOk_()) {
      return { ok: false, code: 'busy', message: '신청이 많아 잠시 접수를 멈췄습니다. 내일 다시 신청해 주세요.' };
    }

    const fields = {
      name: clean_(p.name, 40),
      type: p.type === '기업·기관' ? '기업·기관' : '개인',
      interests: clean_(p.interests, 120),
      status: 'pending',
      consent_privacy_at: now,
      consent_marketing_at: now,
      consent_version: s.CONSENT_VERSION,
      source: clean_(p.source, 80),
      created_at: now,
      unsubscribed_at: '',
    };
    let token;
    if (existing) {
      token = existing.token || newToken_();
      fields.token = token;
      setCells_(t, existing._row, fields);
    } else {
      token = newToken_();
      fields.email = email;
      fields.token = token;
      append_(t, fields);
    }
    sendConfirmRequest_(email, token, s);
    return { ok: true, code: 'pending' };
  } finally {
    lock.releaseLock();
  }
}

function sendConfirmRequest_(email, token, s) {
  const link = webapp_(s) + '?action=confirm&token=' + token;
  const html = '<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#10243A">' +
    '<p>' + esc_(s.BRAND_NAME) + ' 뉴스레터 구독을 신청해 주셔서 감사합니다.</p>' +
    '<p>아래 버튼을 눌러야 구독이 완료됩니다. 신청하신 적이 없다면 이 메일은 무시하셔도 됩니다. 아무 메일도 발송되지 않습니다.</p>' +
    '<p><a href="' + link + '" style="display:inline-block;background:#10243A;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">구독 확인하기</a></p>' +
    '<p style="color:#5b6b7b;font-size:13px">' + esc_(s.SENDER_LEGAL_NAME) + '</p></div>';
  MailApp.sendEmail({
    to: email,
    subject: '[' + s.BRAND_NAME + '] 뉴스레터 구독 확인',
    htmlBody: html,
    name: s.BRAND_NAME,
    replyTo: s.SENDER_EMAIL,
  });
}

function confirmAsk_(token, s) {
  const sub = findSub_(token);
  if (!sub) return page_('구독 확인', '<p>확인 링크가 올바르지 않거나 만료되었습니다. 다시 신청해 주세요.</p>');
  if (sub.row.status === 'active') return page_('구독 확인', '<p>이미 구독이 완료된 주소입니다.</p>');
  const link = webapp_(s) + '?action=confirm2&token=' + token;
  return page_('구독 확인',
    '<p><b>' + esc_(sub.row.email) + '</b> 주소로 ' + esc_(s.BRAND_NAME) + ' 뉴스레터(광고성 정보 포함)를 받으시겠습니까?</p>' +
    '<p><a class="btn" target="_top" href="' + link + '">네, 구독합니다</a></p>');
}

function confirmDo_(token, s) {
  const sub = findSub_(token);
  if (!sub) return page_('구독 확인', '<p>확인 링크가 올바르지 않거나 만료되었습니다. 다시 신청해 주세요.</p>');
  if (sub.row.status !== 'active') {
    const now = now_();
    setCells_(sub.t, sub.row._row, { status: 'active', confirmed_at: now, last_consent_check_at: now });
    // 수신동의 처리 결과 통지 (광고 내용 없이 사실만)
    notice_(sub.row.email, s, '수신동의 처리 결과 안내',
      '<p>아래와 같이 수신동의가 처리되었습니다.</p>' +
      '<ul><li>전송자: ' + esc_(s.SENDER_LEGAL_NAME) + ' (' + esc_(s.BRAND_NAME) + ')</li>' +
      '<li>처리 내용: 광고성 정보(이메일 뉴스레터) 수신동의</li>' +
      '<li>동의 일시: ' + esc_(String(sub.row.consent_marketing_at)) + '</li></ul>' +
      '<p>언제든지 <a href="' + webapp_(s) + '?action=unsub&token=' + token + '">여기</a>를 눌러 무료로 수신을 거부할 수 있습니다.</p>');
  }
  const gift = s.WELCOME_GIFT_URL
    ? '<p><a class="btn" target="_top" href="' + esc_(s.WELCOME_GIFT_URL) + '">무료 학습 자료 열기</a></p>' : '';
  return page_('구독 완료', '<p>구독이 완료되었습니다. 첫 편지로 찾아뵙겠습니다.</p>' + gift +
    '<p><a target="_top" href="' + esc_(s.SITE_URL) + '">' + esc_(s.BRAND_NAME) + ' 홈페이지로 가기</a></p>');
}

function unsubscribeDo_(token, s) {
  const sub = findSub_(token);
  if (!sub) return page_('수신거부', '<p>링크가 올바르지 않습니다. ' + esc_(s.SENDER_EMAIL) + ' 로 알려 주시면 바로 처리하겠습니다.</p>');
  if (sub.row.status !== 'unsubscribed') {
    const now = now_();
    const wasActive = sub.row.status === 'active';
    setCells_(sub.t, sub.row._row, { status: 'unsubscribed', unsubscribed_at: now });
    if (wasActive) {
      notice_(sub.row.email, s, '수신거부 처리 결과 안내',
        '<p>아래와 같이 수신거부가 처리되었습니다. 앞으로 광고성 메일을 보내지 않습니다.</p>' +
        '<ul><li>전송자: ' + esc_(s.SENDER_LEGAL_NAME) + ' (' + esc_(s.BRAND_NAME) + ')</li>' +
        '<li>처리 내용: 광고성 정보 수신거부(수신동의 철회)</li>' +
        '<li>처리 일시: ' + now + '</li></ul>');
    }
  }
  return page_('수신거부 완료', '<p><b>' + esc_(sub.row.email) + '</b> 주소의 수신거부가 처리되었습니다. 더 이상 메일을 보내지 않습니다.</p>' +
    '<p>Your email address has been unsubscribed.</p>');
}

/* ====================== 4. 뉴스레터 가져오기 / 승인 ====================== */

function checkQueue() {
  const s = settings_();
  const res = UrlFetchApp.fetch(s.QUEUE_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { console.warn('queue.json 을 읽지 못했습니다: ' + res.getResponseCode()); return; }
  let queue;
  try { queue = JSON.parse(res.getContentText()); }
  catch (err) { notifyOwner_(s, 'queue.json 형식 오류', '<p>newsletters/queue.json 을 읽을 수 없습니다.</p><pre>' + esc_(String(err)) + '</pre>'); return; }

  const t = table_('Campaigns');
  const known = {};
  t.rows.forEach(function (r) { known[String(r.id)] = true; });
  const today = today_();
  const auto = isTrue_(s.AUTO_SEND);

  (queue.campaigns || []).forEach(function (c) {
    const id = String(c.id || '').trim();
    if (!id || known[id]) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.send_date || ''))) return;
    if (dayDiff_(c.send_date, today) > 7) return; // 일주일 넘게 지난 것은 보내지 않음
    if (!/^newsletters\/[\w\-]+\.html$/.test(String(c.file || ''))) return;
    const fileRes = UrlFetchApp.fetch(s.RAW_BASE + c.file + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (fileRes.getResponseCode() !== 200) return;
    const body = sanitizeBody_(fileRes.getContentText());
    if (!body || body.length > 45000) {
      notifyOwner_(s, '뉴스레터 본문 오류: ' + id, '<p>본문이 비었거나 너무 깁니다(45,000자 초과).</p>');
      return;
    }
    const now = now_();
    const row = {
      id: id, send_date: c.send_date, subject: clean_(c.subject, 120), preheader: clean_(c.preheader, 160),
      audience: clean_(c.audience, 40) || 'all', status: auto ? 'approved' : 'waiting_approval',
      created_at: now, approved_at: auto ? now : '', sent_count: '0', finished_at: '', body_html: body,
    };
    append_(t, row);
    known[id] = true;
    sendPreview_(row, s, auto);
  });
}

function sendPreview_(c, s, auto) {
  const count = table_('Subscribers').rows.filter(function (r) {
    return r.status === 'active' && matchAudience_(r, c.audience);
  }).length;
  const approve = webapp_(s) + '?action=approve&id=' + encodeURIComponent(c.id) + '&key=' + s.ADMIN_KEY;
  const head = '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;background:#FFF7D6;padding:14px 16px;border-radius:6px;margin-bottom:18px;color:#10243A">' +
    '<b>[미리보기] 구독자에게는 아직 발송되지 않았습니다.</b><br>' +
    '발송 예정일: ' + esc_(c.send_date) + ' / 대상: ' + esc_(c.audience) + ' (' + count + '명)<br>' +
    (auto ? '자동 발송(AUTO_SEND=TRUE) 설정이라 예정일에 그대로 발송됩니다.'
      : '<a href="' + approve + '">내용 확인 후 발송 승인하기</a> — 승인하지 않으면 발송되지 않습니다.') +
    '</div>';
  const fake = { email: s.SENDER_EMAIL, token: 'preview', consent_marketing_at: '(미리보기)' };
  MailApp.sendEmail({
    to: s.SENDER_EMAIL,
    subject: '[미리보기] ' + adSubject_(c.subject),
    htmlBody: head + buildEmailHtml_(c, fake, s),
    name: s.BRAND_NAME + ' 자동화',
  });
}

function approveAsk_(id, key, s) {
  if (!key || key !== s.ADMIN_KEY) return page_('발송 승인', '<p>권한이 없습니다.</p>');
  const c = findCampaign_(id);
  if (!c) return page_('발송 승인', '<p>해당 뉴스레터를 찾을 수 없습니다.</p>');
  if (c.row.status !== 'waiting_approval') return page_('발송 승인', '<p>현재 상태: ' + esc_(c.row.status) + '</p>');
  const link = webapp_(s) + '?action=approve2&id=' + encodeURIComponent(id) + '&key=' + key;
  return page_('발송 승인',
    '<p><b>' + esc_(adSubject_(c.row.subject)) + '</b></p><p>발송 예정일: ' + esc_(String(c.row.send_date)) + '</p>' +
    '<p><a class="btn" target="_top" href="' + link + '">이 뉴스레터를 발송합니다</a></p>');
}

function approveDo_(id, key, s) {
  if (!key || key !== s.ADMIN_KEY) return page_('발송 승인', '<p>권한이 없습니다.</p>');
  const c = findCampaign_(id);
  if (!c) return page_('발송 승인', '<p>해당 뉴스레터를 찾을 수 없습니다.</p>');
  if (c.row.status === 'waiting_approval') setCells_(c.t, c.row._row, { status: 'approved', approved_at: now_() });
  return page_('발송 승인 완료', '<p>승인되었습니다. 예정일의 발송 시간대(' + esc_(String(s.SEND_HOUR_START)) + '시~' + esc_(String(s.SEND_HOUR_END)) + '시)에 자동 발송됩니다.</p>');
}

/* ====================== 5. 발송 ====================== */

function sendApproved() {
  const s = settings_();
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (hour < Number(s.SEND_HOUR_START) || hour >= Number(s.SEND_HOUR_END)) return;

  const camp = table_('Campaigns');
  const today = today_();
  const due = camp.rows.filter(function (c) { return c.status === 'approved' && dateStr_(c.send_date) <= today; });
  if (!due.length) return;

  const missing = missingSenderInfo_(s);
  if (missing.length) {
    notifyOwnerDaily_(s, '발송 보류: 전송자 정보가 비어 있습니다',
      '<p>Settings 시트의 다음 항목을 채워야 광고 메일을 보낼 수 있습니다: <b>' + missing.join(', ') + '</b></p>');
    return;
  }

  const subs = table_('Subscribers').rows.filter(function (r) { return r.status === 'active'; });
  const log = table_('SendLog');
  let budget = Math.min(PER_RUN_CAP, Number(s.DAILY_LIMIT) - sentToday_(log, today), MailApp.getRemainingDailyQuota() - 5);

  due.forEach(function (c) {
    const done = {};
    log.rows.forEach(function (l) { if (String(l.campaign_id) === String(c.id)) done[String(l.email).toLowerCase()] = true; });
    const targets = subs.filter(function (r) {
      return matchAudience_(r, c.audience) && !done[String(r.email).toLowerCase()];
    });
    let sent = Number(c.sent_count) || 0;
    let processed = 0;
    for (let i = 0; i < targets.length && budget > 0; i++) {
      const r = targets[i];
      let result = 'sent';
      try {
        MailApp.sendEmail({
          to: r.email,
          subject: adSubject_(c.subject),
          htmlBody: buildEmailHtml_(c, r, s),
          name: s.BRAND_NAME,
          replyTo: s.SENDER_EMAIL,
        });
        sent++;
      } catch (err) {
        result = 'error: ' + String(err).slice(0, 120);
      }
      log.sh.appendRow([now_(), String(c.id), r.email, result]);
      processed++;
      budget--;
    }
    const update = { sent_count: String(sent) };
    if (processed === targets.length) { update.status = 'sent'; update.finished_at = now_(); }
    setCells_(camp, c._row, update);
  });
}

/** 광고 메일 한 통의 HTML: 본문 + 법정 표기 사항(전송자 정보, 수신거부) */
function buildEmailHtml_(c, sub, s) {
  const unsub = webapp_(s) + '?action=unsub&token=' + sub.token;
  const pre = c.preheader ? '<div style="display:none;max-height:0;overflow:hidden">' + esc_(c.preheader) + '</div>' : '';
  return pre +
    '<div style="max-width:620px;margin:0 auto;font-family:\'Apple SD Gothic Neo\',\'Malgun Gothic\',sans-serif;font-size:15px;line-height:1.75;color:#10243A">' +
    '<div style="padding:18px 0;border-bottom:3px solid #10243A;font-size:18px;font-weight:700">' + esc_(s.BRAND_NAME) + '</div>' +
    '<div style="padding:22px 0">' + c.body_html + '</div>' +
    '<div style="border-top:1px solid #cfd8e1;padding:16px 0;font-size:12px;line-height:1.7;color:#5b6b7b">' +
    '본 메일은 ' + esc_(String(sub.consent_marketing_at)) + '에 ' + esc_(s.BRAND_NAME) + ' 뉴스레터 수신에 동의하신 분께 보내드립니다.<br>' +
    '전송자: ' + esc_(s.SENDER_LEGAL_NAME) + ' | ' + esc_(s.SENDER_ADDRESS) + ' | 전화 ' + esc_(s.SENDER_PHONE) + ' | ' + esc_(s.SENDER_EMAIL) + '<br>' +
    '수신을 원하지 않으시면 <a href="' + unsub + '" style="color:#2B4FBF">[수신거부]</a>를 눌러 주세요. 한 번의 클릭으로 무료 처리됩니다.<br>' +
    'If you no longer wish to receive these emails, click <a href="' + unsub + '" style="color:#2B4FBF">[Unsubscribe]</a>.' +
    '</div></div>';
}

/* ====================== 6. 수신동의 정기 확인 (2년) ====================== */

function reconfirmConsents() {
  const s = settings_();
  const t = table_('Subscribers');
  let budget = Math.min(30, MailApp.getRemainingDailyQuota() - 5);
  t.rows.forEach(function (r) {
    if (budget <= 0 || r.status !== 'active') return;
    const base = r.last_consent_check_at || r.confirmed_at || r.consent_marketing_at;
    if (dayDiff_(dateStr_(base).slice(0, 10), today_()) < 700) return; // 2년(730일)이 되기 전에 안내
    notice_(r.email, s, '광고성 정보 수신동의 확인 안내',
      '<p>고객님의 광고성 정보 수신동의 내역을 안내드립니다.</p>' +
      '<ul><li>전송자: ' + esc_(s.SENDER_LEGAL_NAME) + ' (' + esc_(s.BRAND_NAME) + ')</li>' +
      '<li>수신동의 일시: ' + esc_(String(r.consent_marketing_at)) + '</li>' +
      '<li>동의 내용: 이메일 뉴스레터(광고성 정보) 수신</li></ul>' +
      '<p>수신동의를 유지하시려면 별도 조치가 필요 없습니다. 철회하시려면 <a href="' + webapp_(s) + '?action=unsub&token=' + r.token + '">여기</a>를 눌러 주세요.</p>');
    setCells_(t, r._row, { last_consent_check_at: now_() });
    budget--;
  });
}

/* ====================== 7. 공통 도구 ====================== */

function ss_() {
  if (SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('연결된 시트가 없습니다. Code.gs 위쪽 SHEET_ID 에 시트 ID를 넣으세요.');
  return active;
}

function table_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('시트가 없습니다: ' + name + ' (setup 을 먼저 실행하세요)');
  const values = sh.getDataRange().getValues();
  const head = values[0];
  const rows = values.slice(1).map(function (r, i) {
    const o = { _row: i + 2 };
    head.forEach(function (h, j) { o[h] = r[j]; });
    return o;
  });
  return { sh: sh, head: head, rows: rows };
}

function setCells_(t, rowNum, obj) {
  Object.keys(obj).forEach(function (k) {
    const c = t.head.indexOf(k);
    if (c >= 0) t.sh.getRange(rowNum, c + 1).setValue(obj[k]);
  });
}

function append_(t, obj) {
  t.sh.appendRow(t.head.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function settings_() {
  const s = {};
  table_('Settings').rows.forEach(function (r) { s[String(r.key)] = String(r.value === undefined ? '' : r.value).trim(); });
  DEFAULT_SETTINGS.forEach(function (d) { if (s[d[0]] === undefined) s[d[0]] = d[1]; });
  return s;
}

function webapp_(s) { return s.WEBAPP_URL || ScriptApp.getService().getUrl(); }

function findSub_(token) {
  if (!token || String(token).length < 20) return null;
  const t = table_('Subscribers');
  const row = t.rows.filter(function (r) { return String(r.token) === String(token); })[0];
  return row ? { t: t, row: row } : null;
}

function findCampaign_(id) {
  const t = table_('Campaigns');
  const row = t.rows.filter(function (r) { return String(r.id) === String(id); })[0];
  return row ? { t: t, row: row } : null;
}

function matchAudience_(sub, audience) {
  const a = String(audience || 'all').trim();
  if (!a || a === 'all') return true;
  if (String(sub.type) === a) return true;
  return String(sub.interests || '').split(',').map(function (x) { return x.trim(); }).indexOf(a) >= 0;
}

function adSubject_(subject) {
  const t = String(subject || '').replace(/^\s*[\(\[（]\s*광고\s*[\)\]）]\s*/, '');
  return '(광고) ' + t;
}

function missingSenderInfo_(s) {
  return ['SENDER_LEGAL_NAME', 'SENDER_ADDRESS', 'SENDER_PHONE', 'SENDER_EMAIL'].filter(function (k) { return !s[k]; });
}

function sanitizeBody_(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|form)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
}

function notice_(to, s, title, innerHtml) {
  MailApp.sendEmail({
    to: to,
    subject: '[' + s.BRAND_NAME + '] ' + title,
    htmlBody: '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#10243A">' + innerHtml +
      '<p style="color:#5b6b7b;font-size:12px">' + esc_(s.SENDER_LEGAL_NAME) + ' | ' + esc_(s.SENDER_EMAIL) + '</p></div>',
    name: s.BRAND_NAME,
    replyTo: s.SENDER_EMAIL,
  });
}

function notifyOwner_(s, title, innerHtml) {
  if (!s.SENDER_EMAIL) return;
  MailApp.sendEmail({ to: s.SENDER_EMAIL, subject: '[자동화 알림] ' + title, htmlBody: innerHtml, name: s.BRAND_NAME + ' 자동화' });
}

function notifyOwnerDaily_(s, title, innerHtml) {
  const props = PropertiesService.getScriptProperties();
  const key = 'notified_' + today_();
  if (props.getProperty(key)) return;
  props.setProperty(key, '1');
  notifyOwner_(s, title, innerHtml);
}

/** 확인 메일 남용 방지: 하루 60통까지만 */
function confirmQuotaOk_() {
  const props = PropertiesService.getScriptProperties();
  const key = 'confirm_' + today_();
  const n = Number(props.getProperty(key) || 0);
  if (n >= 60) return false;
  props.setProperty(key, String(n + 1));
  return true;
}

function sentToday_(log, today) {
  return log.rows.filter(function (l) { return dateStr_(l.at).slice(0, 10) === today && l.result === 'sent'; }).length;
}

function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  return String(v || '');
}

function toDate_(v) {
  if (v instanceof Date) return v;
  const str = String(v || '');
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return new Date(0);
  return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':' + (m[6] || '00') + '+09:00');
}

function minutesSince_(v) { return (Date.now() - toDate_(v).getTime()) / 60000; }

/** b - a (일 단위). 'yyyy-MM-dd' 문자열 기준 */
function dayDiff_(a, b) {
  return Math.round((toDate_(String(b).slice(0, 10)).getTime() - toDate_(String(a).slice(0, 10)).getTime()) / 86400000);
}

function isTrue_(v) { return String(v).trim().toUpperCase() === 'TRUE'; }

function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

function clean_(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u001f<>]/g, ' ')
    .replace(/^[=+\-@\s]+/, '')
    .trim()
    .slice(0, max);
}

function esc_(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page_(title, innerHtml) {
  const html = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#F3F6F9;color:#10243A;margin:0;padding:48px 20px;line-height:1.7}' +
    '.box{max-width:480px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;border:1px solid #d5dde6}h1{font-size:22px;margin:0 0 16px}' +
    '.btn{display:inline-block;background:#10243A;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none}a{color:#2B4FBF}</style></head>' +
    '<body><div class="box"><h1>' + esc_(title) + '</h1>' + innerHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title);
}
