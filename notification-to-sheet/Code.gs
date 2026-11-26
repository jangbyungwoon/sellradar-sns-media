/**
 * 안드로이드 주문 알림 → 구글 시트 정리
 *
 * 폰(MacroDroid)이 알림을 이 웹앱으로 보내면:
 *   1) 주문 관련 알림인지 판별
 *   2) 유형 / 금액 / 수량 / 주문번호 / 상품명 추출
 *   3) "주문알림" 시트에 한 줄 추가 (중복 알림은 무시)
 *   4) "일별요약" 시트가 자동으로 날짜·쇼핑몰별 합계를 보여줌
 *
 * 설치 방법은 같은 폴더의 README.md 참고.
 */

// ===== 설정 =====
// 아무 문자열로 바꾸세요. MacroDroid에서 보낼 token 값과 같아야 합니다.
const SECRET_TOKEN = 'CHANGE_ME_TO_RANDOM_STRING';

// true 로 바꾸면 주문과 무관한 알림도 "기타알림" 시트에 저장합니다.
const KEEP_NON_ORDER = false;

const TIMEZONE = 'Asia/Seoul';
const ORDER_SHEET = '주문알림';
const OTHER_SHEET = '기타알림';
const SUMMARY_SHEET = '일별요약';
const HEADERS = ['수신시각', '날짜', '쇼핑몰/앱', '유형', '상품명', '수량', '금액', '주문번호', '알림제목', '알림내용'];

// 앱 이름(또는 패키지명)에 이 단어가 있으면 해당 쇼핑몰로 표시합니다. 필요하면 추가하세요.
const SHOP_ALIASES = [
  ['스마트스토어', ['스마트스토어', 'smartstore', '네이버 커머스', 'sellercenter']],
  ['쿠팡', ['쿠팡', 'coupang', 'wing']],
  ['11번가', ['11번가', '11st']],
  ['G마켓', ['g마켓', 'gmarket', 'esm']],
  ['옥션', ['옥션', 'auction']],
  ['카페24', ['카페24', 'cafe24']],
  ['아임웹', ['아임웹', 'imweb']],
  ['토스쇼핑', ['토스쇼핑']],
  ['카카오', ['카카오', 'kakao']],
];

// 유형 판별 키워드 (위에서부터 먼저 걸리는 것으로 결정)
const TYPE_RULES = [
  ['취소', ['취소요청', '주문취소', '취소 요청', '취소접수', '취소']],
  ['반품', ['반품']],
  ['교환', ['교환']],
  ['구매확정', ['구매확정', '구매 확정']],
  ['배송', ['발송', '배송', '출고']],
  ['정산', ['정산', '입금']],
  ['문의', ['문의', '질문']],
  ['신규주문', ['신규주문', '신규 주문', '새 주문', '새로운 주문', '주문이 들어', '주문 접수', '주문접수', '결제완료', '결제 완료', '주문', '구매', '결제', 'order']],
];

// ===== 웹앱 진입점 =====
function doPost(e) { return handle_(e); }
function doGet(e) { return handle_(e); }

function handle_(e) {
  const p = readParams_(e);
  if (p.token !== SECRET_TOKEN) return json_({ ok: false, error: 'bad token' });

  const app = (p.app || '').trim();
  const title = (p.title || '').trim();
  const text = (p.text || '').trim();
  if (!title && !text) return json_({ ok: false, error: 'empty' });

  // 같은 알림이 여러 번 오는 경우(업데이트/재표시) 10분간 중복 무시
  const cache = CacheService.getScriptCache();
  const key = 'n_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, app + '|' + title + '|' + text));
  if (cache.get(key)) return json_({ ok: true, duplicate: true });

  const parsed = parseNotification(app, title, text);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (cache.get(key)) return json_({ ok: true, duplicate: true });
    const now = new Date();
    const row = [
      Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd HH:mm:ss'),
      Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd'),
      parsed.shop, parsed.type, parsed.product, parsed.qty, parsed.amount, parsed.orderNo,
      title, text,
    ];
    if (parsed.isOrder) {
      getSheet_(ORDER_SHEET).appendRow(row);
    } else if (KEEP_NON_ORDER) {
      getSheet_(OTHER_SHEET).appendRow(row);
    }
    cache.put(key, '1', 600);
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, saved: parsed.isOrder || KEEP_NON_ORDER, parsed: parsed });
}

// ===== 알림 해석 (순수 함수: 테스트 가능) =====
function parseNotification(app, title, text) {
  const all = [app, title, text].join(' ');
  const lower = all.toLowerCase();

  let shop = app || '알 수 없음';
  for (const [name, words] of SHOP_ALIASES) {
    if (words.some(w => (app || '').toLowerCase().includes(w))) { shop = name; break; }
  }

  let type = '';
  for (const [name, words] of TYPE_RULES) {
    if (words.some(w => lower.includes(w.toLowerCase()))) { type = name; break; }
  }
  const isOrder = type !== '' && type !== '문의';

  // 금액: "12,900원", "₩12,900", "결제금액 12900" 중 첫 번째
  let amount = '';
  const m1 = all.match(/(?:₩\s*)([\d,]+)|([\d]{1,3}(?:,\d{3})+|\d+)\s*원/);
  if (m1) amount = Number((m1[1] || m1[2]).replace(/,/g, '')) || '';
  if (amount === '') {
    const m2 = all.match(/(?:금액|결제|합계)\s*[:：]?\s*([\d,]{3,})/);
    if (m2) amount = Number(m2[1].replace(/,/g, '')) || '';
  }

  // 수량: "2개", "수량 2", "x2"
  let qty = '';
  const q = all.match(/수량\s*[:：]?\s*(\d+)|(\d+)\s*(?:개|건)|(\d+)\s*ea\b|[x×]\s*(\d+)\b/i);
  if (q) qty = Number(q[1] || q[2] || q[3] || q[4]);

  // 주문번호: "주문번호 2026112612345" / "주문번호: 123-456"
  let orderNo = '';
  const o = all.match(/주문\s*번호\s*[:：]?\s*([0-9A-Za-z-]{5,})/);
  if (o) orderNo = o[1];

  // 상품명: [대괄호] 또는 "상품명: ..." 또는 따옴표 안
  let product = '';
  const pm = text.match(/상품명?\s*[:：]\s*([^\n,/]+)/) || text.match(/\[([^\]]{2,60})\]/) ||
             text.match(/[‘'"“]([^’'"”]{2,60})[’'"”]/);
  if (pm) product = pm[1].trim();

  return { isOrder, shop, type: type || '기타', product, qty, amount, orderNo };
}

// ===== 시트 =====
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f1f3f4');
    sh.getRange('G:G').setNumberFormat('#,##0"원"');
    if (name === ORDER_SHEET) ensureSummary_();
  }
  return sh;
}

function ensureSummary_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SUMMARY_SHEET)) return;
  const sh = ss.insertSheet(SUMMARY_SHEET);
  sh.getRange('A1').setValue('신규주문 일별 · 쇼핑몰별 합계 (자동 계산)').setFontWeight('bold');
  sh.getRange('A3').setFormula(
    "=IFERROR(QUERY('" + ORDER_SHEET + "'!A:J," +
    "\"select B, C, count(B), sum(G) where D = '신규주문' group by B, C order by B desc " +
    "label B '날짜', C '쇼핑몰', count(B) '주문건수', sum(G) '주문금액'\", 1), \"아직 주문 없음\")");
  sh.getRange('D:D').setNumberFormat('#,##0"원"');
  sh.getRange('F1').setValue('유형별 건수').setFontWeight('bold');
  sh.getRange('F3').setFormula(
    "=IFERROR(QUERY('" + ORDER_SHEET + "'!A:J," +
    "\"select D, count(D) where D is not null group by D label D '유형', count(D) '건수'\", 1), \"\")");
}

/** 처음 한 번 실행: 시트 생성 + 권한 승인용 */
function setup() {
  getSheet_(ORDER_SHEET);
  ensureSummary_();
}

/** 편집기에서 실행해서 동작 확인용 */
function testInsert() {
  const r = handle_({ parameter: {
    token: SECRET_TOKEN,
    app: '스마트스토어센터',
    title: '신규주문 알림',
    text: '[무선 블루투스 이어폰] 2개 주문이 들어왔습니다. 결제금액 39,800원 주문번호 2026112612345',
  }});
  Logger.log(r.getContent());
}

// ===== 유틸 =====
function readParams_(e) {
  const p = Object.assign({}, (e && e.parameter) || {});
  if (e && e.postData && e.postData.contents && /json/.test(e.postData.type || '')) {
    try { Object.assign(p, JSON.parse(e.postData.contents)); } catch (err) { /* ignore */ }
  }
  return p;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

if (typeof module !== 'undefined') module.exports = { parseNotification };
