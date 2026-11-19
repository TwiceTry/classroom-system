# 登录插件接入规范

一个插件 = 一个目录 + 一个 `index.js`。丢进来重启就生效，不用改任何既有代码。

```
auth-providers/
  types.js          契约（插件只能 import 这个）
  index.js          加载器
  local/index.js    内置：学号 + 姓名
  kg/index.js       内置：青果平台（含验证码两阶段）
  _模板/index.js    复制改名就能写新插件（下划线开头的不会加载）
```

---

## 一、插件要抹平的是什么

不同平台的差异有三层，全由插件吃掉：

```
① 传输层   HTTP POST / 页面解析 / OAuth 跳转 / 扫码轮询
② 协议层   字段名（username vs account）、加解密、验证码
③ 语义层   status:402「您已输错1次」 / code:1「密码错误」 / invalid_grant
```

系统只认一个 **Outcome**。它不需要（也不该）知道「青果 402」和「正方 code:1」是同一件事。

---

## 二、必填导出

```js
export const apiVersion = 1        // 契约版本，改了 Outcome 形状才会 +1
export const key = 'kg'            // 唯一标识，会存进数据库
export const name = '青果平台'      // 老师看到的名字
export const credentials = [...]   // 登录表单要什么字段（没有就写 []）
export async function verify(ctx)  // 核心

// 可选
export const desc = '用学校平台的账号密码登录'
export const remember = true       // 要不要让系统记住密码
export const settings = [...]      // 老师要配什么
export const captcha = { kind: 'image', auto: true, maxAutoTries: 2 }
export async function beforeVerify(ctx) {}
export async function afterVerify(result, ctx) {}
export async function onSuccess(result, ctx) {}
export async function onFailure(result, ctx) {}
```

---

## 三、Outcome：只有三种

```js
import { REASON, ok, fail, challenge } from '../types.js'

ok({ sid, name })                       // 成功
fail(REASON.BAD_CREDENTIAL, '账号或密码不对')   // 失败（终局）
challenge({ type:'captcha', image, handle })   // 还差一步
```

### `challenge` 不是失败

系统会以 **200** 返回它，前端据此显示验证码输入框。
用 401 会走统一的错误处理，把学生踢回第一步——体验全错。

### REASON 七种，只有一种计失败

| REASON | 含义 | 计失败 |
|---|---|---|
| `BAD_CREDENTIAL` | 学生输错了 | **是** |
| `ACCOUNT_LOCKED` | 被对方锁了 | 否 |
| `NEED_CHALLENGE` | 需要短信/图形码/扫码 | 否 |
| `NOT_ENROLLED` | 不在对方系统里 | 否 |
| `SERVICE_DOWN` | 对方超时 / 5xx / DNS | **否** |
| `CONFIG_ERROR` | 我方没配好 | 否 |
| `UNSUPPORTED` | 当前环境跑不了 | 否 |

**`SERVICE_DOWN` 不计失败是最要紧的一条。** 平台挂了却把失败次数加上去，会把人推向 5 次锁定，把学校账号一起搭进去。

---

## 四、验证码：两阶段

一期只支持图形验证码。流程固化在插件内部，系统层不参与：

```
学生提交「学号 + 密码」
      ↓
插件循环（一次请求内跑完，学生无感）
  拉登录页 → 要验证码？
    ├─ 不要 → 直接提交 → 看结果
    └─ 要   → 自动识别 → 提交
        第 1 次失败
          ├─ 明确是密码错 → 立即返回 BAD_CREDENTIAL（别折腾验证码）
          └─ 说不清       → 算 1 次验证码失败
        第 2 次失败 → 不管原因都算
      ↓
抓一张**新**图 → challenge({ type:'captcha', image, handle })
      ↓
学生自己填 → 再提交（带 handle + code）
      ↓
**手填错一次就终局** → fail(NEED_CHALLENGE, '验证码没填对，请找老师')
```

### 为什么第 1 次要分原因

如果是密码错，把验证码图扔给学生是误导——他填对了验证码，密码还是错的，下次照样失败，只会更困惑。

### 为什么必须暂存 session

验证码和平台会话绑死：抓图用这个会话，提交也必须用同一个，否则永远是「验证码错误」。

用 `putPending` / `takePending`：

```js
import { putPending, takePending } from '../types.js'

// 抓完图
const handle = putPending(key, { session, image })
return challenge({ type: 'captcha', image, handle })

// 学生填完
const p = takePending(key, ctx.captcha.handle)
if (!p) return fail(REASON.NEED_CHALLENGE, '验证码已过期，请点「换一张」重新获取')
const raw = await submit(p.session, ctx.captcha.code)
```

暂存在内存、5 分钟 TTL，不落库。`handle` 是不透明字符串，系统原样透传。

---

## 五、ctx 里有什么

```js
ctx = {
  sid,                    // 学号
  credentials,            // { password: '...' } 按你的 credentials 收集
  settings,               // 老师配的（就是你声明的那些）
  captcha,                // { code, handle } | null
  signal,                 // AbortSignal —— **必须透传给 fetch**，否则超时形同虚设
  request: { ip, ua },
  log(obj),               // 写审计日志（系统统一脱敏）

  roster: {               // 只读名册，仅 local 这类插件需要
    classOf(sid) → { id, name, courseId } | null
    studentOf(classId, sid) → { sid, name } | null
  },
}
```

---

## 六、钩子

```
beforeVerify(ctx)            可以短路：返回 Outcome 就不再调 verify
verify(ctx)                  必须返回 Outcome
afterVerify(result, ctx)     无论成败都调，用于记日志/上报
onSuccess(result, ctx)       成功后才调
onFailure(result, ctx)       失败后调
```

**钩子抛错只记日志，绝不影响登录结果。** `verify` 抛错会退化成 `SERVICE_DOWN`（不当成凭证错）。

---

## 七、禁止事项

| 不许 | 为什么 |
|---|---|
| import `repo.js` / `db` / `config.js` | 插件不该知道数据库长什么样。要读名册用 `ctx.roster`，要写数据走钩子回来 |
| 自己记失败次数 | 熔断只有系统一层。各记一套 → 学生换个方式就绕过了 |
| 把 credentials 写进日志 | `ctx.log()` 会脱敏，但你自己 `console.log` 拦不住 |
| 不透传 `ctx.signal` | 系统给的超时失效，一个卡住的平台能拖死整个登录 |
| 超过 25 秒 | 系统超时 20 秒 |
| 在 `message` 里出现 `ERR_402` 这类 | 它是直接显示给学生的 |
| 假设 `verify` 只被调用一次 | 断线重连/重试会再来一次，必须幂等 |

---

## 八、写完之后

**① 先测 `mapResult`**

把「原始返回 → Outcome」抽成一个纯函数，这样不用起服务、不用打网络就能覆盖全部分支：

```js
export function mapResult(raw) { ... }

// test
assert.equal(mapResult({ status:'402', counter:1 }).reason, 'bad-credential')
assert.equal(mapResult({ status:'ERR' }).reason, 'service-down')
```

青果那边的分档（402 的 counter、505、401、ERR）就是靠这个测的。

**② 检查这几条**

```
□ 平台超时 → SERVICE_DOWN（不是 BAD_CREDENTIAL）
□ 密码错   → BAD_CREDENTIAL（带 counter 时一并回）
□ 平台返回乱码/空 → 不能抛异常，要给 SERVICE_DOWN
□ 同一个 session 连提两次不会把账号搞锁
□ 日志里没有出现密码/验证码原文
```

**③ 重启代理，看日志**

```
登录插件：local, kg
```

有插件加载失败会打 warn，写明是哪个目录、什么问题。
