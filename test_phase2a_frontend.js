/**
 * Phase 2A 前端整合模擬測試：直接從 index.html 擷取真正要交付的相關函式原始碼
 * （callPhase2A／queryPetSetupStatus_／attemptInitializePet_／submitPetSetupName／
 * pending 冪等性 helper／preview 唯讀攔截器 IIFE），在 Node vm 裡執行，不是另外
 * 重寫一份邏輯來測試——理由跟 test_harness.js（後端測試）開頭註解說的一樣：確保
 * 測到的就是實際要交付的程式碼本身。
 *
 * DOM／遊戲本機模擬狀態（getPetState／savePetState／renderForestPet／showToast／
 * document.getElementById）不在這輪 review 範圍內，用最小 stub 取代，只記錄「有沒有
 * 被呼叫、被呼叫時帶了什麼」供斷言使用。
 *
 * 涵蓋審查要求的 7 個情境：
 *   1. fetch 永久 pending —— callPhase2A 要真的會逾時（AbortController 真的接上，
 *      不是只多寫了處理分支但永遠不會被觸發）。
 *   2. initializePet 逾時 → getTransactionStatus 查到 status:'success' → 正確完成領養。
 *   3. 逾時後使用者把輸入框名字改掉才重試 → 仍然使用「第一次送出時」的原始名字，
 *      不是輸入框裡的新名字（冪等鍵要綁 {clientRequestId, petName} 一起持久化）。
 *   4. getTransactionStatus 回 status:'failed' → 顯示正確文案，不能被誤判成「網路錯誤」。
 *   5. getTransactionStatus 回 status:'error_unsynced' → 同上，且不能清除 pending。
 *   6. 連續點兩次「完成領養」→ busy 狀態要擋下第二次，只能真正送出一次 initializePet。
 *   7. fetch(new Request(url, {method:'POST', body})) 直接打這支 API 的未核准呼叫 →
 *      preview 攔截器要 fail-closed 擋下（不能因為 Request 物件把 method/body 包在
 *      建構子裡就繞過 init.method/init.body 判斷）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC_PATH = path.join(__dirname, 'index.html');
const html = fs.readFileSync(SRC_PATH, 'utf8');

const apiMatch = html.match(/const API = "([^"]+)"/);
if (!apiMatch) throw new Error('找不到 const API = "..." —— index.html 結構可能變了，測試的擷取標記需要更新');
const API_URL = apiMatch[1];

// ---- 從 index.html 擷取真正要測的原始碼區塊（用穩定的字串標記，不是行號） ----
function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error('擷取標記找不到（start）：' + startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error('擷取標記找不到（end）：' + endMarker);
  return html.slice(start, end);
}

const BLOCK_API_AND_GUARD = (() => {
  const start = html.indexOf('const API = ');
  const guardStart = html.indexOf('(function () {', start);
  const guardEnd = html.indexOf('})();', guardStart) + '})();'.length;
  return html.slice(start, guardEnd);
})();

const BLOCK_PET_ADOPTED_FLAGS = slice('function petAdoptedKey(childId)', 'function getPetState(childId) {');
const BLOCK_PENDING_HELPERS = slice('function petDeviceTokenKey(childId)', 'const PHASE2A_TIMEOUT_MS = ');
const BLOCK_CALL_PHASE2A = slice('const PHASE2A_TIMEOUT_MS = ', 'function isValidCanonicalPetNameClient_(name) {');
const BLOCK_VALIDATION_AND_ERRORS = slice('function isValidCanonicalPetNameClient_(name) {', 'function openPetSetup() {');
const BLOCK_SETUP_FLOW = slice('function openPetSetup() {', 'function declinePet() {');

const SRC_TEMPLATE = [
  BLOCK_API_AND_GUARD,
  BLOCK_PET_ADOPTED_FLAGS,
  BLOCK_PENDING_HELPERS,
  BLOCK_CALL_PHASE2A,
  BLOCK_VALIDATION_AND_ERRORS,
  BLOCK_SETUP_FLOW
].join('\n');

// ---- 最小 DOM／localStorage stub ----
function makeFakeElement() {
  return {
    value: '',
    textContent: '',
    disabled: false,
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } }
  };
}

function makeFakeDocument() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeFakeElement());
      return elements.get(id);
    }
  };
}

function makeFakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); }
  };
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

// fetchImpl(url, init) -> 必須回傳一個有 .json() 的物件（用真正的 Response 最貼近瀏覽器）
function buildContext(fetchImpl, opts) {
  opts = opts || {};
  const toasts = [];
  const renderCalls = [];
  const petStates = {};

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.location = { href: 'http://localhost/index.html' };
  sandbox.console = console;
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.AbortController = AbortController;
  sandbox.Request = Request;
  sandbox.Response = Response;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.localStorage = makeFakeLocalStorage();
  sandbox.document = makeFakeDocument();
  sandbox.fetch = fetchImpl;

  // 遊戲本機模擬狀態／畫面渲染：這輪 review 沒有要求修改，最小 stub，只記錄呼叫。
  sandbox.currentChild = 'candice';
  sandbox.allData = { candice: {} };
  sandbox.getPetState = (childId) => petStates[childId] || (petStates[childId] = { pet_name: '貓咪' });
  sandbox.savePetState = (childId, s) => { petStates[childId] = s; };
  sandbox.showToast = (msg, type) => { toasts.push({ msg, type }); };
  sandbox.renderForestPet = (data) => { renderCalls.push(data); };

  vm.createContext(sandbox);

  let src = SRC_TEMPLATE;
  if (opts.timeoutMs != null) {
    const before = src;
    src = src.replace(/const PHASE2A_TIMEOUT_MS = \d+;/, 'const PHASE2A_TIMEOUT_MS = ' + opts.timeoutMs + ';');
    if (src === before) throw new Error('PHASE2A_TIMEOUT_MS 常數宣告找不到，測試沒辦法縮短逾時時間');
  }

  vm.runInContext(src, sandbox, { filename: 'index.html (extracted phase2a frontend)' });

  return { sandbox, toasts, renderCalls, petStates };
}

function raceFailsafe(promise, ms, message) {
  let timer;
  const failsafe = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, failsafe]).finally(() => clearTimeout(timer));
}

// ---- test runner（跟 test_harness.js 同樣的 PASS/FAIL 風格） ----
let passCount = 0, failCount = 0;
async function test(name, fn) {
  try {
    await fn();
    passCount++;
    console.log('PASS:', name);
  } catch (e) {
    failCount++;
    console.log('FAIL:', name, '--', e.message);
  }
}

async function main() {

  await test('1. fetch 永久 pending：callPhase2A 真的會逾時，不是永遠掛著', async () => {
    const fetchImpl = async (url, init) => new Promise((resolve, reject) => {
      if (init && init.signal) {
        if (init.signal.aborted) { reject(abortError()); return; }
        init.signal.addEventListener('abort', () => reject(abortError()));
      }
      // 否則永遠不 resolve/reject —— 模擬 Safari 一直沒有回應
    });
    const ctx = buildContext(fetchImpl, { timeoutMs: 80 });
    const res = await raceFailsafe(
      ctx.sandbox.callPhase2A('getTransactionStatus', { deviceToken: 'dev-1', clientRequestId: 'req-1' }),
      2000,
      'callPhase2A 從未 resolve —— timeout 機制沒有真的接上 fetch'
    );
    // res 是在 vm context 裡建立的物件（跟這裡的 host realm 是不同的 Object.prototype），
    // 逐一比對屬性值，不要用 deepStrictEqual（會因為跨 realm 的 prototype 不同判定失敗，
    // 即使內容完全一樣）。
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'network_error');
  });

  await test('2. initializePet 逾時 → getTransactionStatus 查到 success → 正確完成領養', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'initializePet') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())));
      }
      if (body.action === 'getTransactionStatus') {
        assert.strictEqual(body.clientRequestId, calls[0].clientRequestId, '應該用第一次送出時的同一個 clientRequestId 查詢');
        return new Response(JSON.stringify({ ok: true, status: 'success', result: { pet_id: 'pet_1', species: 'cat', pet_name: '小花' } }));
      }
      throw new Error('未預期的 action: ' + body.action);
    };

    const ctx = buildContext(fetchImpl, { timeoutMs: 60 });
    ctx.sandbox.localStorage.setItem('forest_device_token_candice', 'dev-token-1');
    ctx.sandbox.document.getElementById('pet-setup-name-input').value = '小花';

    await ctx.sandbox.submitPetSetupName();

    assert.strictEqual(ctx.sandbox.localStorage.getItem('forest_pet_adopted_candice'), 'true');
    assert.strictEqual(ctx.sandbox.localStorage.getItem('forest_pet_phase2a_done_candice'), 'true');
    assert.strictEqual(ctx.sandbox.localStorage.getItem('forest_pet_setup_pending_candice'), null, 'pending 應該在成功後被清除');
    assert.ok(ctx.renderCalls.length >= 1, '應該呼叫 renderForestPet 更新畫面');
    assert.ok(ctx.toasts.some(t => t.msg.includes('小花')), '應該顯示含寵物名字的成功 toast');
  });

  await test('3. 逾時後使用者把輸入框名字改掉才重試 → 仍然使用第一次送出的原始名字', async () => {
    const calls = [];
    let statusCallCount = 0;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'initializePet') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())));
      }
      if (body.action === 'getTransactionStatus') {
        statusCallCount++;
        if (statusCallCount === 1) {
          return new Response(JSON.stringify({ ok: true, status: 'processing' }));
        }
        return new Response(JSON.stringify({ ok: true, status: 'success', result: { pet_id: 'pet_1', species: 'cat', pet_name: '小花' } }));
      }
      throw new Error('未預期的 action: ' + body.action);
    };

    const ctx = buildContext(fetchImpl, { timeoutMs: 60 });
    ctx.sandbox.localStorage.setItem('forest_device_token_candice', 'dev-token-1');
    ctx.sandbox.document.getElementById('pet-setup-name-input').value = '小花';

    await ctx.sandbox.submitPetSetupName(); // 第一次點擊：initializePet 逾時 → 查狀態 → processing，保留 pending

    const initCallsAfterFirst = calls.filter(c => c.action === 'initializePet');
    assert.strictEqual(initCallsAfterFirst.length, 1);
    assert.strictEqual(initCallsAfterFirst[0].petName, '小花');

    const pendingAfterFirstClick = JSON.parse(ctx.sandbox.localStorage.getItem('forest_pet_setup_pending_candice'));
    assert.strictEqual(pendingAfterFirstClick.petName, '小花', 'pending 應該記住第一次送出的原始名字');

    // 使用者把輸入框改成別的名字，準備再點一次
    ctx.sandbox.document.getElementById('pet-setup-name-input').value = '咪咪';

    await ctx.sandbox.submitPetSetupName(); // 第二次點擊

    const initCallsFinal = calls.filter(c => c.action === 'initializePet');
    assert.strictEqual(initCallsFinal.length, 1, '不應該用新名字「咪咪」送出第二個 initializePet 請求');
    assert.strictEqual(initCallsFinal[0].petName, '小花');

    const statusCalls = calls.filter(c => c.action === 'getTransactionStatus');
    assert.strictEqual(statusCalls.length, 2);
    assert.strictEqual(statusCalls[0].clientRequestId, statusCalls[1].clientRequestId, '兩次查詢應該用同一個 clientRequestId');

    assert.strictEqual(ctx.sandbox.localStorage.getItem('forest_pet_adopted_candice'), 'true');
    assert.strictEqual(ctx.petStates.candice.pet_name, '小花', '最終領養到的名字應該是原始送出的「小花」，不是「咪咪」');
  });

  await test('4. getTransactionStatus 回 status:"failed" → 顯示正確文案，不是「網路錯誤」', async () => {
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'initializePet') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())));
      }
      if (body.action === 'getTransactionStatus') {
        return new Response(JSON.stringify({ ok: true, status: 'failed', result: null }));
      }
      throw new Error('未預期的 action: ' + body.action);
    };
    const ctx = buildContext(fetchImpl, { timeoutMs: 60 });
    ctx.sandbox.localStorage.setItem('forest_device_token_candice', 'dev-token-1');
    ctx.sandbox.document.getElementById('pet-setup-name-input').value = '小花';

    await ctx.sandbox.submitPetSetupName();

    const errText = ctx.sandbox.document.getElementById('pet-setup-name-err').textContent;
    assert.ok(errText && !errText.includes('網路錯誤'), '應該顯示明確的失敗文案，不是網路錯誤，實際文字=' + JSON.stringify(errText));
    assert.ok(!ctx.toasts.some(t => t.msg.includes('網路錯誤')), '不應該跳出「網路錯誤」的 toast');
    assert.notStrictEqual(ctx.sandbox.localStorage.getItem('forest_pet_setup_pending_candice'), null, 'failed 不應該清除 pending');
  });

  await test('5. getTransactionStatus 回 status:"error_unsynced" → 顯示正確文案，且不清除 pending', async () => {
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'initializePet') {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())));
      }
      if (body.action === 'getTransactionStatus') {
        return new Response(JSON.stringify({ ok: true, status: 'error_unsynced', result: null }));
      }
      throw new Error('未預期的 action: ' + body.action);
    };
    const ctx = buildContext(fetchImpl, { timeoutMs: 60 });
    ctx.sandbox.localStorage.setItem('forest_device_token_candice', 'dev-token-1');
    ctx.sandbox.document.getElementById('pet-setup-name-input').value = '小花';

    await ctx.sandbox.submitPetSetupName();

    const errText = ctx.sandbox.document.getElementById('pet-setup-name-err').textContent;
    assert.ok(errText && !errText.includes('網路錯誤'), '應該顯示明確的文案，不是網路錯誤，實際文字=' + JSON.stringify(errText));
    assert.ok(!ctx.toasts.some(t => t.msg.includes('網路錯誤')), '不應該跳出「網路錯誤」的 toast');
    assert.notStrictEqual(ctx.sandbox.localStorage.getItem('forest_pet_setup_pending_candice'), null, 'error_unsynced 不應該清除 pending');
  });

  await test('6. 連續點兩次「完成領養」→ busy 狀態擋住第二次，只送出一次 initializePet', async () => {
    const calls = [];
    let resolveFirst;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.action === 'initializePet') {
        return new Promise((resolve) => {
          resolveFirst = () => resolve(new Response(JSON.stringify({ ok: true, result: { pet_id: 'pet_1', species: 'cat', pet_name: '小花' } })));
        });
      }
      throw new Error('未預期的 action: ' + body.action);
    };
    const ctx = buildContext(fetchImpl, { timeoutMs: 5000 });
    ctx.sandbox.localStorage.setItem('forest_device_token_candice', 'dev-token-1');
    ctx.sandbox.document.getElementById('pet-setup-name-input').value = '小花';

    // submitPetSetupName 在第一個 await 之前就會同步把 submitBtn.disabled 設成 true，
    // 所以這裡不需要等 tick，「連點」直接背靠背呼叫兩次就能真實重現。
    const p1 = ctx.sandbox.submitPetSetupName();
    const p2 = ctx.sandbox.submitPetSetupName();
    resolveFirst();
    await Promise.all([p1, p2]);

    const initCalls = calls.filter(c => c.action === 'initializePet');
    assert.strictEqual(initCalls.length, 1, '連點兩次應該只真正送出一次 initializePet，實際送出 ' + initCalls.length + ' 次');
  });

  await test('7. fetch(new Request(url, {method:"POST", body})) 未核准呼叫 → 攔截器 fail-closed 擋下', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true, result: { pet_id: 'sneaky' } })); };
    const ctx = buildContext(fetchImpl, { timeoutMs: 5000 });

    const req = new Request(API_URL, {
      method: 'POST',
      body: JSON.stringify({ action: 'initializePet', childId: 'candice', deviceToken: 'x', clientRequestId: 'evil-1', petName: '駭客貓' })
    });

    const res = await ctx.sandbox.fetch(req);
    const json = await res.json();

    assert.strictEqual(calls.length, 0, '真正的 fetch（mock）不應該被呼叫到——應該在攔截器就被擋下');
    assert.ok(json && json.error, '應該回傳一個表示「已停用」的錯誤 JSON，而不是放行');
  });

  console.log('========================================');
  console.log('PASS:', passCount, ' FAIL:', failCount);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
