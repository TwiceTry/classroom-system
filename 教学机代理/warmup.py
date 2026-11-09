# -*- coding: utf-8 -*-
"""缓存预热 —— 代理启动后主动把常用资源拉一遍，学生第一波来就是命中。

为什么单独一个文件：
  这段逻辑（拉首页 → 抠入口 bundle → 抠全部懒加载 chunk → 拉 lib/vendor/路由
  → 用教师身份拉材料正文和代码示例）和代理主流程无关，
  改预热不该动那个 3000 行的 lan-proxy.py。

为什么需要预热（实测数据，40 人 / 学生只肯等 3 秒）：
  不预热   22/40 成功 · 37 次刷新 · 公网 9.63 MB
  预热后   40/40 成功 ·  0 次刷新 · 公网 1.28 MB

  机制：第一个学生要经公网隧道拉 2.35MB 的运行时库，其余 39 个卡在
  防穿透锁上等；学生等 3 秒就按 F5，全部挤进等待队列，越刷越慢。

名单全部可配（proxy.conf 的 warmup.* 项），见 DEFAULT_* 常量。
只有「懒加载 chunk」是自动发现的 —— Vite 的 chunk 名带内容哈希，
写死在配置里一升级就失效，所以从入口 bundle 里正则抠。
"""
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from urllib.parse import quote

# ---------- 默认名单（proxy.conf 里同名项可覆盖） ----------

DEFAULT_LIB = [
    '/lib/vue.global.js',
    '/lib/vue3-sfc-loader.js',
    '/lib/sfc-boot.js',
]

DEFAULT_VENDOR = [
    # 材料页按需动态 import 的渲染库（HTML 和入口 bundle 里都没有字符串）
    '/vendor/marked.min.js',
    '/vendor/mermaid.min.js',
    '/vendor/srcdoc.js',
]

DEFAULT_ROUTES = [
    # SPA 各路由返回同一份 HTML，但缓存 key 是完整 path ——
    # 只预热 "/" 的话，学生进 /student/materials 还是要 MISS 一次。
    '/login',
    '/student/materials',
    '/student/playground',
    '/student/score',
    '/student/watch',
    '/teacher/classes',
    '/teacher/attendance',
    '/teacher/courses',
    '/teacher/settings',
]

DEFAULT_EXTRA = ['/favicon.svg']

DEFAULT_MATERIALS_MAX = 30   # 材料正文按课次 id 从 1 试到这个值
DEFAULT_EXAMPLES_MAX = 25    # 预热前 N 节课的代码示例
DEFAULT_WORKERS = 16


def _split_list(raw):
    """配置里的名单：逗号 / 分号 / 换行分隔都认。"""
    if not raw:
        return []
    parts = re.split(r'[,;\n]+', raw)
    return [p.strip() for p in parts if p.strip()]


def run(port, conf_get, log=None, enabled=True):
    """执行一次预热。在独立线程里调用，不要阻塞主流程。

    port     代理自己的监听端口（预热走 127.0.0.1:port，正常填充缓存）
    conf_get proxy.conf 的读取函数 conf_get(key, default)
    log      打日志的函数（通常是 verbose），可空
    enabled  缓存总开关；关了就不预热
    """
    if not enabled:
        return
    if log is None:
        def log(_msg):
            pass

    if not _as_bool(conf_get('warmup.enabled', 'yes'), True):
        print('  预热：已关闭（warmup.enabled = no）')
        return

    # 等服务真正开始 accept，否则第一批请求会 ConnectionRefused
    time.sleep(2)

    def req(method, path, headers=None, body=None, timeout=60):
        c = HTTPConnection('127.0.0.1', port, timeout=timeout)
        try:
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            return r.status, r.read()
        finally:
            try:
                c.close()
            except Exception:
                pass

    t0 = time.time()

    # ---------- ① 静态资源 ----------
    paths = ['/']
    entry_js = ''
    try:
        st, body = req('GET', '/', timeout=30)
        if st == 200:
            text = body.decode('utf-8', 'ignore')
            for m in re.finditer(r'/assets/[A-Za-z0-9._-]+\.(?:js|css)', text):
                if m.group(0) not in paths:
                    paths.append(m.group(0))
            em = re.search(r'/assets/index-[A-Za-z0-9_-]+\.js', text)
            if em:
                entry_js = em.group(0)
    except Exception as e:
        log('预热：首页没拉到（%s）' % e)

    # 路由懒加载的 chunk 名全在入口 bundle 里（Vite 的 chunk 映射）。
    # 20~50 个，名字带内容哈希，只能运行时抠，写不进配置。
    if entry_js:
        try:
            st, body = req('GET', entry_js, timeout=60)
            if st == 200:
                js = body.decode('utf-8', 'ignore')
                for m in re.finditer(r'[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(?:js|css)', js):
                    p = '/assets/' + m.group(0)
                    if p not in paths:
                        paths.append(p)
        except Exception as e:
            log('预热：入口 bundle 没拉到（%s）' % e)

    conf_lib = _split_list(conf_get('warmup.lib', ''))
    conf_vendor = _split_list(conf_get('warmup.vendor', ''))
    conf_routes = _split_list(conf_get('warmup.routes', ''))
    conf_extra = _split_list(conf_get('warmup.extra', ''))

    for p in (conf_lib or DEFAULT_LIB):
        if p not in paths:
            paths.append(p)
    for p in (conf_vendor or DEFAULT_VENDOR):
        if p not in paths:
            paths.append(p)
    for p in (conf_extra or DEFAULT_EXTRA):
        if p not in paths:
            paths.append(p)
    for p in (conf_routes or DEFAULT_ROUTES):
        if p not in paths:
            paths.append(p)

    workers = int(_num(conf_get('warmup.workers', ''), DEFAULT_WORKERS) or DEFAULT_WORKERS)

    def _one(p):
        try:
            st, _ = req('GET', p)
            return 1 if st == 200 else 0
        except Exception:
            return 0

    try:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            ok = sum(ex.map(_one, paths))
    except Exception:
        ok = 0
    print('  预热静态：%d/%d 个资源（%.1f 秒）' % (ok, len(paths), time.time() - t0))

    # ---------- ② 用教师身份预热公开内容 ----------
    #
    # 材料正文、代码示例、材料目录都要登录才给，但内容和「是谁在请求」无关；
    # 缓存 key 是 method+path（不含 token），所以预热一次全班共享。
    #
    # 绝不能预热 /api/bootstrap、/api/classes/:id/scores 这类按人返回的数据：
    # 缓存 key 不含 token，A 的个人分数会被发给全班。
    pw = str(conf_get('warmup.password', '') or '').strip()
    if not pw:
        pw = _local_password(conf_get)
    if not pw:
        print('  预热内容：跳过（没配 warmup.password，本地也没有 data/config.json）')
        return

    try:
        st, body = req('POST', '/api/auth/login/teacher',
                       {'Content-Type': 'application/json'},
                       json.dumps({'password': pw}).encode('utf-8'), timeout=30)
        token = (json.loads(body.decode('utf-8')) or {}).get('token') if st == 200 else ''
    except Exception as e:
        log('预热：教师登录失败（%s）' % e)
        token = ''
    if not token:
        print('  预热内容：跳过（教师登录失败，检查 warmup.password）')
        return

    H = {'Authorization': 'Bearer ' + token}
    got = 0

    # 课程 id
    course_id = ''
    try:
        st, body = req('GET', '/api/bootstrap', H)
        if st == 200:
            cs = (json.loads(body.decode('utf-8')) or {}).get('courses') or []
            if cs:
                course_id = cs[0].get('id') or ''
    except Exception:
        pass

    # 材料目录 + 每篇正文 + 正文里的图片
    asset_seen = set()
    if course_id:
        try:
            st, _ = req('GET', '/api/courses/%s/content/list?type=materials&path=materials'
                        % quote(course_id), H)
            if st == 200:
                got += 1
        except Exception:
            pass

        # 正文的 id 是数字课次（1、4、7…），不是文件名。
        # 连续 3 次 404 认为到头了。
        max_id = int(_num(conf_get('warmup.materials', ''), DEFAULT_MATERIALS_MAX) or
                     DEFAULT_MATERIALS_MAX)
        miss_streak = 0
        for lid in range(1, max_id + 1):
            if miss_streak >= 3:
                break
            try:
                p = '/api/content/doc?type=materials&id=%d&courseId=%s' % (lid, quote(course_id))
                st, body = req('GET', p, H, timeout=30)
                if st != 200:
                    miss_streak += 1
                    continue
                miss_streak = 0
                got += 1
                text = body.decode('utf-8', 'ignore')
                for m in re.finditer(r'/api/content/asset\?[A-Za-z0-9%&=_.:/\-]+', text):
                    u = m.group(0)
                    if u in asset_seen:
                        continue
                    asset_seen.add(u)
                    try:
                        st2, _ = req('GET', u, H, timeout=30)
                        if st2 == 200:
                            got += 1
                    except Exception:
                        pass
            except Exception:
                miss_streak += 1

    # 代码示例：清单 + 每节课的文件
    #
    # 注意带上 courseId！缓存 key 含查询串，前端请求的是
    # /api/examples?courseId=xxx —— 预热只拉 /api/examples 的话 key 对不上。
    lessons = []
    try:
        ex_path = '/api/examples'
        if course_id:
            ex_path += '?courseId=' + quote(course_id)
        st, body = req('GET', ex_path, H)
        if st == 200:
            got += 1
            lessons = (json.loads(body.decode('utf-8')) or {}).get('lessons') or []
    except Exception:
        pass

    ex_max = int(_num(conf_get('warmup.examples', ''), DEFAULT_EXAMPLES_MAX) or DEFAULT_EXAMPLES_MAX)
    for les in lessons[:ex_max]:
        d = (les or {}).get('dir') or ''
        if not d:
            continue
        try:
            st, _ = req('GET', '/api/examples/' + quote(d), H, timeout=30)
            if st == 200:
                got += 1
        except Exception:
            pass

    print('  预热内容：%d 项公开内容已就位（%.1f 秒）' % (got, time.time() - t0))


# ---------- 小工具 ----------

def _as_bool(v, default=False):
    if v is None or v == '':
        return default
    return str(v).strip().lower() in ('1', 'yes', 'true', 'on', 'y')


def _num(v, default):
    try:
        if v is None or str(v).strip() == '':
            return default
        return float(v)
    except Exception:
        return default


def _local_password(conf_get):
    """同机部署（开发/测试）时从 ../data/config.json 读教师口令，省得再配一遍。

    教学机上没有这个文件，就得在 proxy.conf 填 warmup.password。
    """
    try:
        # conf_get 拿不到配置文件路径，按代理目录的相对位置推
        here = os.path.dirname(os.path.abspath(__file__))
        cfg_file = os.path.join(here, '..', 'data', 'config.json')
        with open(cfg_file, 'r', encoding='utf-8-sig') as f:
            return str(json.load(f).get('teacherPassword') or '').strip()
    except Exception:
        return ''
