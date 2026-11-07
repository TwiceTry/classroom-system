/**
 * 青果 KINGOSOFT 高校智慧校园教学综合服务平台 —— 登录/验证码 核心库
 * ======================================================================
 * 站点示例: http://117.159.97.151:8888/  (schoolcode=14715)
 *
 * 登录链路(逆向自 /cas/login.action + loginbar.js):
 *   1. GET /            -> 302 -> /cas/login.action, 拿到 JSESSIONID
 *      页内变量: _sessionid / _ssessionid / schoolcode / yzmbt(1=需要验证码)
 *   2. GET /frame/homepage?method=getTempDeskey   取一次性临时 DES 密钥
 *   3. GET /frame/homepage?method=getTempNowtime  取服务端时间戳
 *   4. 密码 = md5( md5(明文) + md5(randnumber.toLowerCase()) )
 *      账号 = base64( 账号 + ";;" + _sessionid )
 *   5. 明文串  _u{验证码}=…&_p{验证码}=…&randnumber=…&isPasswordPolicy=…
 *              &txt_mm_expression=…&txt_mm_length=…&txt_mm_userzh=…
 *              &hid_flag=…&hidlag=1&hid_dxyzm=
 *      -> DES(临时密钥) -> base64  => params
 *      -> token = md5( md5(明文串) + md5(timestamp) )
 *   6. POST /cas/logon.action  body: params&token&timestamp&deskey&ssessionid
 *      返回 JSON {status,message,result}; 200=成功, 401=需要/验证码有误, 402=密码错
 *   7. 验证码图: GET /cas/genValidateCode (JPEG 70x30, 4 位数字, 与会话绑定)
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { recognizeImageData } from './captcha_cnn.js';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------- 站点自带加密库 */
export function createCrypto() {
  const sandbox = {
    console,
    Math,
    Date,
    window: {},
    navigator: { userAgent: UA },
    document: {
      write() {},
      getElementById() {
        return { style: {}, value: '' };
      },
      getElementsByTagName() {
        return [];
      },
      createElement() {
        return {};
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  for (const f of ['md5.js', 'base64.js', 'utf.js', 'jkingo.des.js']) {
    vm.runInContext(fs.readFileSync(path.join(LIB_DIR, f), 'utf8'), ctx, { filename: `lib/${f}` });
  }
  const pick = (n) => {
    const fn = ctx[n];
    if (typeof fn !== 'function') throw new Error('加密库缺失函数: ' + n);
    return fn;
  };
  return {
    md5: (s) => pick('hex_md5')(s),
    b64: (s) => pick('base64encode')(s),
    utf16to8: (s) => pick('utf16to8')(s),
    strEnc: (s, k) => pick('strEnc')(s, k, null, null),
  };
}

/* --------------------------------------------------------------- 会话 */
export class Session {
  constructor() {
    this.jar = new Map();
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const pair = raw.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async raw(url, opts = {}) {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...(opts.headers || {}) };
    const ck = this.cookieHeader();
    if (ck) headers.Cookie = ck;
    const res = await fetch(url, { redirect: 'manual', ...opts, headers });
    this.absorb(res);
    return res;
  }

  /** 跟随 3xx(站点 GET / 会 302 到 /cas/login.action) */
  async follow(url, opts = {}, maxHop = 5) {
    let cur = url;
    let res = await this.raw(cur, opts);
    for (let i = 0; i < maxHop && res.status >= 300 && res.status < 400; i++) {
      const loc = res.headers.get('location');
      if (!loc) break;
      cur = new URL(loc, cur).href;
      res = await this.raw(cur, { ...opts, method: 'GET', body: undefined });
    }
    return { res, url: cur };
  }

  async getText(url, headers) {
    const { res, url: finalUrl } = await this.follow(url, { method: 'GET', headers });
    return { status: res.status, url: finalUrl, text: decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type')) };
  }

  async postForm(url, body, headers) {
    const res = await this.raw(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/plain, */*; q=0.01',
        Origin: new URL(url).origin,
        Referer: url.replace('/cas/logon.action', '/cas/login.action'),
        ...(headers || {}),
      },
      body,
    });
    const text = decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type'));
    return { status: res.status, text };
  }
}

export function decodeBody(buf, contentType = '') {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  let enc = (m && m[1]) || 'gbk';
  if (/^utf-?8$/i.test(enc)) enc = 'utf-8';
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/* ----------------------------------------------------------- 登录页解析 */
export function parseLoginPage(html) {
  const grab = (re, dflt = '') => (re.exec(html) || [])[1] ?? dflt;
  return {
    sessionid: grab(/var\s+_sessionid\s*=\s*"([^"]*)"/),
    ssessionid: grab(/var\s+_ssessionid\s*=\s*"([^"]*)"/),
    schoolcode: grab(/var\s+schoolcode\s*=\s*"([^"]*)"/),
    yzmbt: grab(/var\s+yzmbt\s*=\s*"([^"]*)"/, '0'),
  };
}

/** 打开登录页并取会话变量 */
export async function openLoginPage(ses, base) {
  const page = await ses.getText(`${base}/`);
  return { page, info: parseLoginPage(page.text) };
}

/* ------------------------------------------------------------- 参数构造 */
export function passwordExpression(pwd) {
  let r = 0;
  for (let i = 0; i < pwd.length; i++) {
    const c = pwd.charCodeAt(i);
    if (c >= 48 && c <= 57) r |= 8;
    else if (c >= 97 && c <= 122) r |= 4;
    else if (c >= 65 && c <= 90) r |= 2;
    else r |= 1;
  }
  return r;
}

export function passwordPolicy(username, password) {
  if (!password || password === username) return '0';
  if (password.length < 6) return '0';
  return '1';
}

/**
 * 构造 /cas/logon.action 的请求体
 * @param {object} p
 * @param {string} p.captcha 验证码(免验证码时为空串)
 * @returns {{body:string, plain:string, timestamp:string, deskey:string, token:string}}
 */
export async function buildLoginBody(ses, base, cr, { username, password, captcha = '', sessionid, ssessionid }) {
  const deskeyTmp = (await ses.getText(`${base}/frame/homepage?method=getTempDeskey`)).text.trim();
  const timestamp = (await ses.getText(`${base}/frame/homepage?method=getTempNowtime`)).text.trim();
  const deskeyPage = (await ses.getText(`${base}/custom/js/SetKingoEncypt.jsp`)).text;
  const deskey = (/var\s+_deskey\s*=\s*'([^']*)'/.exec(deskeyPage) || [])[1] ?? '';
  if (!deskeyTmp) throw new Error('未取到临时 DES 密钥');

  const pwdDigest = cr.md5(cr.md5(password) + cr.md5(captcha.toLowerCase()));
  const plain =
    `_u${captcha}=${cr.b64(`${username};;${sessionid}`)}` +
    `&_p${captcha}=${pwdDigest}` +
    `&randnumber=${captcha}` +
    `&isPasswordPolicy=${passwordPolicy(username, password)}` +
    `&txt_mm_expression=${passwordExpression(password)}` +
    `&txt_mm_length=${password.length}` +
    `&txt_mm_userzh=${password.toLowerCase().indexOf(username.toLowerCase()) > -1 ? '1' : '0'}` +
    `&hid_flag=${captcha ? '' : '1'}` +
    `&hidlag=1&hid_dxyzm=`;

  const params = cr.b64(cr.utf16to8(cr.strEnc(plain, deskeyTmp)));
  const token = cr.md5(cr.md5(plain) + cr.md5(timestamp));
  const body = `params=${params}&token=${token}&timestamp=${timestamp}&deskey=${deskey}&ssessionid=${ssessionid}`;
  return { body, plain, timestamp, deskey, token };
}

/* --------------------------------------------------------------- 验证码 */
/**
 * 在同一会话内取一张验证码并本地识别
 * @returns {{code:string, prob:number, bytes:Buffer}}
 */
export async function solveCaptcha(ses, base) {
  const res = await ses.raw(`${base}/cas/genValidateCode?v=${Math.floor(Math.random() * 1000) + 1}`, {
    method: 'GET',
    headers: { Referer: `${base}/cas/login.action`, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const img = jpeg.decode(bytes, { useTArray: true });
  const { code, prob } = recognizeImageData(img.data, img.width, img.height, true);
  return { code, prob, bytes };
}

/**
 * 完整登录流程 —— 含"是否需要验证码"的判定
 * ============================================
 * 站点的验证码机制(已实测确认):
 *   · 首屏 `yzmbt=0` 时不带验证码即可提交；
 *   · 但登录页 loginbar.js 的逻辑是: 应答 message 形如 "…|N"(N=失败次数), **N>=2 或 yzmbt=1
 *     或上次报错后**，浏览器就强制显示验证码输入框, 之后每次提交必须带 randnumber
 *     (字段名变成 _u{验证码}/_p{验证码}, hid_flag='')；
 *   · 只要带了验证码, 服务端就真校验: 错了返回 401「验证码有误!」, 且**不累计**密码失败次数；
 *   · 密码错返回 402(带失败计数), 累计 5 次锁号 —— 所以判定为"密码错"时必须立刻停手。
 *
 * 判定顺序: forceCaptcha > 页面 yzmbt=1 > 上次 401/验证码有误 > 失败计数>=2 > 配置里给了码
 *
 * @returns {{status:string, message:string, result?:string, captcha?:string, tries:number,
 *            counter:number, needCaptcha:boolean, reasons:string[], info:object, session:Session}}
 */
export async function login({
  base,
  username,
  password,
  captcha = '',
  maxTries = 3,
  forceCaptcha = false,
  log = () => {},
}) {
  const cr = createCrypto();
  const ses = new Session();
  let { page, info } = await openLoginPage(ses, base);
  log(`登录页 ${page.url}  yzmbt=${info.yzmbt}  schoolcode=${info.schoolcode}  JSESSIONID=${ses.jar.get('JSESSIONID') ?? '-'}`);

  let code = captcha;       // 人工/配置提供的验证码(优先使用一次)
  let counter = 0;          // 服务端返回的当日失败计数
  let lastStatus = '';
  let lastMsg = '';
  let needCaptcha = false;
  const reasons = [];

  for (let tries = 1; tries <= maxTries; tries++) {
    // ---------------- 判定这一轮要不要带验证码 ----------------
    reasons.length = 0;
    if (forceCaptcha) reasons.push('--force-captcha');
    if (info.yzmbt === '1') reasons.push('页面 yzmbt=1');
    if (lastStatus === '401') reasons.push('上次 401 验证码有误');
    else if (/验证码/.test(lastMsg)) reasons.push('上次提示验证码');
    if (counter >= 2) reasons.push(`失败计数=${counter}(>=2 客户端强制带码)`);
    needCaptcha = reasons.length > 0 || !!code;

    if (needCaptcha && !code) {
      const s = await solveCaptcha(ses, base);
      code = s.code;
      log(`  判定: 需要验证码 [${reasons.join(' / ')}] → 本地识别 ${s.code} (置信度 ${s.prob.toFixed(3)})`);
    } else {
      log(`  判定: ${needCaptcha ? '带验证码(人工提供 ' + code + ')' : '免验证码'} [${reasons.join(' / ') || '首屏 yzmbt=0 且无失败记录'}]`);
    }

    const built = await buildLoginBody(ses, base, cr, {
      username,
      password,
      captcha: code,
      sessionid: info.sessionid,
      ssessionid: info.ssessionid,
    });
    const res = await ses.postForm(`${base}/cas/logon.action`, built.body);
    let data;
    try {
      data = JSON.parse(res.text);
    } catch {
      return { status: 'ERR', message: res.text.slice(0, 200), tries, counter, needCaptcha, reasons: [...reasons], info, session: ses };
    }

    const status = String(data.status);
    const [msgText, cnt] = String(data.message ?? '').split('|');
    if (cnt && /^\d+$/.test(cnt)) counter = Number(cnt);
    log(`  第 ${tries} 次提交: status=${status} message=${msgText}${cnt ? ` (失败计数=${cnt})` : ''} captcha=${code || '(无)'}`);

    if (status === '200') {
      return { status, message: msgText, result: data.result, captcha: code, tries, counter, needCaptcha, reasons: [...reasons], info, session: ses };
    }

    lastStatus = status;
    lastMsg = msgText;

    const isCaptchaIssue = status === '401' || /验证码/.test(msgText);
    const isPwdIssue = !isCaptchaIssue && /密码|账号/.test(msgText);

    if (status === '505') {
      // 短信二次验证: 换手机验证码, 脚本无法自动完成
      return { status, message: msgText, captcha: code, tries, counter, needCaptcha, reasons: [...reasons], info, session: ses };
    }

    if (isCaptchaIssue) {
      // 验证码错/需要验证码 —— 不消耗密码失败次数, 可以安全重试
      code = '';
      if (tries < maxTries) {
        const again = await openLoginPage(ses, base);
        info = again.info;
        log(`  → 验证码未被接受, 重新取图识别后再试(页面 yzmbt=${info.yzmbt})`);
        continue;
      }
      return { status, message: msgText, captcha: code, tries, counter, needCaptcha, reasons: [...reasons], info, session: ses };
    }

    if (isPwdIssue) {
      // 密码/账号错: 再试只会累积"5 次锁号"额度, 必须停手(是否要带验证码交给下一轮判定, 但不自动重试)
      log('  → 密码/账号错误, 停止重试以免触发 5 次锁号');
      return { status, message: msgText, captcha: code, tries, counter, needCaptcha, reasons: [...reasons], info, session: ses };
    }

    // 其它错误(如"经非法处理的登录信息"): 若已达需要验证码的阈值, 带码再试一次
    if (tries < maxTries && (counter >= 2 || !code)) {
      code = '';
      const again = await openLoginPage(ses, base);
      info = again.info;
      log('  → 其它错误, 重新加载登录页后重试');
      continue;
    }
    return { status, message: msgText, captcha: code, tries, counter, needCaptcha, reasons: [...reasons], info, session: ses };
  }

  return { status: 'ERR', message: `超过最大尝试次数(${maxTries})`, tries: maxTries, counter, needCaptcha, reasons, info };
}

/** 保存会话(便于后续带 Cookie 访问内部页面) */
export function saveSession(ses, base, extra = {}) {
  return {
    base,
    cookie: ses.cookieHeader(),
    cookies: Object.fromEntries(ses.jar),
    at: new Date().toISOString(),
    ...extra,
  };
}
