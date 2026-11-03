/**
 * Fork 自测：不启动浏览器，直接验证 generateCodexAuthJson 的输出契约。
 * 运行：node tools/test_payload.js
 */
const path = require('path');
const assert = require('assert');

const {
  generateCodexAuthJson,
  sessionAccessExpiry,
  sessionRemainingMs,
} = require(path.join(__dirname, '..', 'extension', 'popup', 'popup.js'));

const b64url = (o) =>
  Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());

let pass = 0;
const ok = (name) => { console.log(`  PASS  ${name}`); pass += 1; };

const now = Date.now();
const DAY = 86400 * 1000;
const accessJson = {
  iss: 'https://auth.openai.com',
  exp: Math.floor((now + 5.8 * DAY) / 1000),
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
};
const session = {
  accessToken: `eyJhbGciOiJSUzI1NiJ9.${b64url(accessJson)}.sig`,
  expires: new Date(now + 5.8 * DAY).toISOString(),
  user: { email: 'someone@example.com', id: 'user-test' },
  account: { id: 'acct-test', planType: 'plus' },
};

console.log('== 正常会话 ==');
const auth = JSON.parse(generateCodexAuthJson(session));

assert.strictEqual(auth.auth_mode, 'chatgpt');
assert.strictEqual(auth.OPENAI_API_KEY, null);
ok('顶层结构符合 Codex AuthDotJson');

assert.strictEqual(auth.tokens.refresh_token, '');
ok('refresh_token 是空串（不是 "placeholder"）');

assert.strictEqual(auth.tokens.access_token, session.accessToken);
ok('access_token 原样透传');

assert.strictEqual(auth.tokens.account_id, 'acct-test');
ok('account_id 正确');

const idTok = decode(auth.tokens.id_token);
assert.strictEqual(auth.tokens.id_token.split('.').length, 3);
assert.strictEqual(auth.tokens.id_token.split('.')[2], 'synthetic');
assert.strictEqual(idTok.exp, Math.floor((now + 5.8 * DAY) / 1000));
ok('id_token.exp 与 access_token.exp 严格对齐（不再 +30 天）');

assert.strictEqual(idTok.email, 'someone@example.com');
assert.strictEqual(idTok['https://api.openai.com/auth'].chatgpt_account_id, 'acct-test');
ok('id_token 携带 email / account_id / plan');

const lastRefresh = Date.parse(auth.last_refresh);
assert.ok(Math.abs(lastRefresh - now) < 5000, 'last_refresh 应为导出时刻');
ok('last_refresh 是导出时刻（8 天内不会触发刷新）');

console.log('== 边界 ==');
assert.throws(() => generateCodexAuthJson({ ...session, expires: undefined }), /SESSION_EXPIRY_UNKNOWN/);
ok('缺 expires 时抛 SESSION_EXPIRY_UNKNOWN（不再编 30 天）');

assert.throws(
  () => generateCodexAuthJson({ ...session, expires: new Date(now - 1000).toISOString() }),
  /SESSION_EXPIRED/
);
ok('会话已过期时抛 SESSION_EXPIRED');

const rem = sessionRemainingMs(session);
assert.ok(Math.abs(rem - 5.8 * DAY) < 60_000, `剩余时长应≈5.8天，实际 ${rem}`);
ok('sessionRemainingMs 与 expires 一致（误差 <1 分钟）');

assert.strictEqual(sessionAccessExpiry({}), null);
ok('sessionAccessExpiry 对空对象返回 null');

console.log(`\n全部通过：${pass} 项断言`);
