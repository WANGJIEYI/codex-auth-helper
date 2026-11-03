// popup.js — Codex 登陆助手核心交互逻辑
// 遵循纯本地处理原则，不存储、不上云

// 缓存全局 Session 数据
let globalSession = null;
let countdownInterval = null;

// [FORK] 允许在 Node 里直接 require 本文件做单元测试（浏览器环境下行为不变）
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    // 初始化界面获取数据
    initSessionFetch();

    // 绑定基础事件监听
    bindEvents();
  });
}

/**
 * [FORK] 解析会话的 access_token 过期时间。
 * 只用 session.expires 一个来源：它是 OpenAI 签发 /api/auth/session 时给的权威值。
 * 解析失败返回 null，调用方必须按「不可用」处理，禁止再编一个假期。
 */
function sessionAccessExpiry(session) {
  if (!session || !session.expires) return null;
  const t = new Date(session.expires).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * [FORK] 导出前的可用性体检。返回剩余毫秒数，或 null 表示拿不到过期时间。
 */
function sessionRemainingMs(session, now = Date.now()) {
  const exp = sessionAccessExpiry(session);
  return exp === null ? null : exp - now;
}

/**
 * 初始化 Session 获取
 */
function initSessionFetch() {
  showState('loading');
  
  // 向 background.js 发送请求，发起跨域 fetch
  chrome.runtime.sendMessage({ action: 'fetch_session' }, (response) => {
    // 拦截通道关闭或报错
    if (chrome.runtime.lastError) {
      console.error('通信错误:', chrome.runtime.lastError);
      showState('unauthorized');
      return;
    }

    if (response && response.success) {
      globalSession = response.data;
      renderAuthorizedState(response.data);
      showState('authorized');
    } else {
      showState('unauthorized');
    }
  });
}

/**
 * 切换界面显示状态
 * @param {'loading'|'unauthorized'|'authorized'} state 
 */
function showState(state) {
  const loadingEl = document.getElementById('state-loading');
  const unauthorizedEl = document.getElementById('state-unauthorized');
  const authorizedEl = document.getElementById('state-authorized');

  loadingEl.classList.remove('active');
  unauthorizedEl.classList.remove('active');
  authorizedEl.classList.remove('active');

  if (state === 'loading') {
    loadingEl.classList.add('active');
  } else if (state === 'unauthorized') {
    unauthorizedEl.classList.add('active');
  } else if (state === 'authorized') {
    authorizedEl.classList.add('active');
  }
}

/**
 * 渲染已登录状态的 UI 数据
 */
function renderAuthorizedState(session) {
  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name');
  const emailEl = document.getElementById('user-email');
  const planEl = document.getElementById('badge-plan');
  const expiresEl = document.getElementById('token-expires');

  // 用户个人信息
  const user = session.user || {};
  avatarEl.src = user.image || 'https://lh3.googleusercontent.com/a/default-user=s96-c';
  nameEl.textContent = user.name || 'ChatGPT 用户';
  emailEl.textContent = user.email || '未绑定邮箱';

  // 账户套餐
  const account = session.account || {};
  const planType = (account.planType || 'free').toUpperCase();
  planEl.textContent = planType;
  
  if (planType === 'PLUS' || planType === 'PRO') {
    planEl.className = 'plan-badge plus';
  } else {
    planEl.className = 'plan-badge free';
  }

  // 有效期至
  const expiresTime = session.expires ? new Date(session.expires) : null;
  if (expiresTime && Number.isFinite(expiresTime.getTime())) {
    expiresEl.textContent = formatLocalDate(expiresTime);
    // 启动剩余期限实时倒计时
    startCountdown(expiresTime);
  } else {
    // [FORK] 原来这里写「长期有效」+「无限」，会让用户导出白导一次。
    // 拿不到过期时间就不能导出，明确阻止。
    expiresEl.textContent = '未知（无法导出）';
    document.getElementById('token-countdown').textContent = '—';
  }

  // [FORK] 剩余寿命不到 24 小时时亮警告条
  updateTtlWarning(sessionRemainingMs(session));
}

/**
 * [FORK] 剩余寿命警告条。少于 24h 时提示先重新登录网页再导出。
 */
function updateTtlWarning(remainingMs) {
  const el = typeof document !== 'undefined' ? document.getElementById('ttl-warning') : null;
  if (!el) return;

  if (remainingMs === null) {
    el.textContent = '⚠️ 读不到 access_token 过期时间，无法判断可用期，已禁用导出。';
    el.hidden = false;
    el.className = 'ttl-warning danger';
    return;
  }
  if (remainingMs <= 0) {
    el.textContent = '⚠️ 网页会话的 access_token 已过期，请刷新 chatgpt.com 重新登录后再导出。';
    el.hidden = false;
    el.className = 'ttl-warning danger';
    return;
  }
  if (remainingMs < 24 * 3600 * 1000) {
    el.textContent = `⚠️ 剩余不到 24 小时（${Math.floor(remainingMs / 3600000)} 小时），导出的文件很快就会失效，建议先刷新网页再导出。`;
    el.hidden = false;
    el.className = 'ttl-warning danger';
    return;
  }
  el.hidden = true;
  el.textContent = '';
  el.className = 'ttl-warning';
}

/**
 * 绑定所有 DOM 按钮事件
 */
function bindEvents() {
  // 1. 未登录一键跳转
  document.getElementById('btn-login').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://chatgpt.com/' });
    window.close(); // 关闭 popup 窗口
  });

  // 2. 导出 auth.json — 委托给 background service worker 执行下载
  document.getElementById('btn-download').addEventListener('click', () => {
    if (!globalSession) return;

    // [FORK] 导出前把「注定马上失效」的文件挡掉
    const remaining = sessionRemainingMs(globalSession);
    if (remaining === null) {
      showToast('❌ 读不到过期时间，无法导出');
      return;
    }
    if (remaining < 10 * 60 * 1000) {
      showToast('❌ 会话剩余不足 10 分钟，请刷新网页后重试');
      return;
    }

    const authJsonString = generateCodexAuthJson(globalSession);
    
    chrome.runtime.sendMessage({
      action: 'download_auth_json',
      jsonContent: authJsonString
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('下载通信异常:', chrome.runtime.lastError);
        showToast('❌ 下载失败，请重新尝试');
        return;
      }
      if (response && response.success) {
        showToast('🎉 auth.json 已开始下载');
      } else {
        showToast('❌ 下载失败，请重新尝试');
      }
    });
  });
}

/**
 * 实时计算并更新剩余过期时间倒计时
 */
function startCountdown(expiresTime) {
  if (countdownInterval) clearInterval(countdownInterval);

  const countdownEl = document.getElementById('token-countdown');

  function update() {
    const now = new Date();
    const diff = expiresTime - now;

    if (diff <= 0) {
      countdownEl.textContent = '已过期';
      countdownEl.className = 'detail-value text-danger';
      clearInterval(countdownInterval);
      return;
    }

    // 换算天、小时、分、秒
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    let displayStr = '';
    if (days > 0) displayStr += `${days}天`;
    if (hours > 0 || days > 0) displayStr += `${hours}时`;
    displayStr += `${minutes}分${seconds}秒`;

    countdownEl.textContent = displayStr;
  }

  update();
  countdownInterval = setInterval(update, 1000);
}

/**
 * 格式化输出本地化的年月日 时分秒
 */
function formatLocalDate(date) {
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 核心转换逻辑：将获取到的 ChatGPT Session 数据转化为符合 Codex 要求的格式
 *
 * [FORK] 本文件明确不做「伪造 refresh_token」这件事：
 *   - 网页 session 拿不到 auth.openai.com 签发的 refresh_token，任何伪造值都会被 400 拒绝；
 *   - 因此这个 auth.json 的寿命 = access_token 的自然寿命（当前样本约 5~6 天）；
 *   - 只要 last_refresh 是导出时刻，Codex 在 8 天内不会尝试刷新，期间正常可用；
 *   - 到期后重新导出即可，不要指望它自己续期。
 */
function generateCodexAuthJson(session) {
  const accountId = session.account?.id || '';
  const email = session.user?.email || '';
  const planType = session.account?.planType || 'free';

  // [FORK] 过期时间只认 session.expires；拿不到或已过期就直接抛，
  // 不再用 iat + 30 天兜底（那会让 auth.json 显示「还有效」，实际请求立刻 401）。
  const accessExpMs = sessionAccessExpiry(session);
  if (accessExpMs === null) throw new Error('SESSION_EXPIRY_UNKNOWN');
  const iat = Math.floor(Date.now() / 1000);
  const exp = Math.floor(accessExpMs / 1000);
  if (exp <= iat) throw new Error('SESSION_EXPIRED');

  // 构建 Synthetic id_token (无签名 JWT)
  const jwtHeader = { alg: 'none', typ: 'JWT', cpa_synthetic: true };
  const jwtPayload = {
    iat, exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: planType,
      chatgpt_user_id: session.user?.id || '',
      user_id: session.user?.id || ''
    },
    email
  };

  const base64UrlEncode = (obj) => {
    const str = JSON.stringify(obj);
    const base64 = btoa(unescape(encodeURIComponent(str)));
    return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };

  const syntheticIdToken = `${base64UrlEncode(jwtHeader)}.${base64UrlEncode(jwtPayload)}.synthetic`;

  const authConfig = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: syntheticIdToken,
      access_token: session.accessToken,
      // [FORK] 强制空串，不再写 "placeholder"。
      // 理由：refresh_token 只能由 auth.openai.com 的授权码 + PKCE 流程签发，
      // 网页 sessionToken / session token cookie 都换不出可用的 refresh token。
      // 写假值只会让服务端返回 invalid_grant，日志更乱；空串语义更诚实。
      // 代价：Codex 的 doctor 会报「stored credentials are incomplete」——已知且故意保留。
      refresh_token: "",
      account_id: accountId
    },
    last_refresh: new Date().toISOString()
  };

  return JSON.stringify(authConfig, null, 2);
}

/**
 * 一键复制公共方法
 */
function copyToClipboard(text, successMsg) {
  navigator.clipboard.writeText(text)
    .then(() => {
      showToast(successMsg);
    })
    .catch(err => {
      console.error('复制失败:', err);
      showToast('❌ 复制失败，请手动选取');
    });
}

/**
 * 弹出精致轻巧的 Toast 反馈
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  
  toastMsg.textContent = message;
  toast.classList.add('show');
  
  // 2秒后淡出
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2000);
}

// [FORK] Node 测试入口：浏览器里 module 未定义，这段不执行
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateCodexAuthJson,
    sessionAccessExpiry,
    sessionRemainingMs,
    updateTtlWarning,
  };
}
