# -*- coding: utf-8 -*-
"""缓存预热 —— 代理启动后主动把常用资源拉一遍，学生第一波来就是命中。

为什么需要（实测，40 人 / 学生只肯等 3 秒）：
  不预热  22/40 成功 · 37 次刷新 · 公网 9.63 MB
  预热后  40/40 成功 ·  0 次刷新 · 公网 1.28 MB

  机制：第一个学生要经公网隧道拉 2.35MB 的运行时库，其余 39 个卡在
  防穿透锁上等；学生等 3 秒就按 F5，全部挤进等待队列，越刷越慢。

配置独立在 warmup.conf（模板见 warmup.example.conf），**不写死任何具体文件**：

  [static]   /assets/*  /lib/*.js  /vendor/*.js  …
             候选由程序自动发现（HTML 引用 + 入口 bundle 里的懒加载 chunk
             + 各目录下的 js/css 名），再用这些模式过滤。
  [routes]   /login  /student/*  …     SPA 各路由（同一份 HTML，不同 path）
  [content]  /api/examples/*  /api/content/doc?type=materials&id=*&courseId={courseId}
             需要登录才给、但内容与身份无关的接口

模式语法：
  *        通配任意字符
  regex:   正则，例：regex:^/assets/.+\.js$
  {courseId}  替换成第一门未归档课程的 id
"""
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONF_PATH = os.path.join(HERE, 'warmup.conf')

# 配置文件缺失时的兜底（和 warmup.example.conf 保持一致）
FALLBACK_CONF = """\
enabled = yes
workers = 16
password =
materials-max = 30
examples-max = 25

[static]
/
/assets/*
/lib/*.js
/vendor/marked.min.js
/vendor/mermaid.min.js
/vendor/srcdoc.js
/favicon.svg

[routes]
/login
/student/materials
/student/playground
/student/score
/student/watch
/teacher/classes
/teacher/attendance
/teacher/courses
/teacher/settings

[content]
/api/courses/{courseId}/content/list?type=materials&path=materials
/api/examples?courseId={courseId}
/api/examples/*
/api/content/doc?type=materials&id=*&courseId={courseId}
"""


# ---------------- 配置 ----------------

def load_conf(path=None):
    """读 warmup.conf。读不到就用 FALLBACK_CONF。

    返回 {顶层 key: value, 'sections': {name: [pattern, ...]}}
    """
    p = path or DEFAULT_CONF_PATH
    text = None
    try:
        with open(p, 'r', encoding='utf-8-sig') as f:
            text = f.read()
    except Exception:
        text = FALLBACK_CONF

    conf = {'sections': {}}
    cur = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('[') and line.endswith(']'):
            cur = line[1:-1].strip().lower()
            conf['sections'].setdefault(cur, [])
            continue
        if cur is None:
            if '=' in line:
                k, v = line.split('=', 1)
                conf[k.strip().lower()] = v.strip()
        else:
            conf['sections'][cur].append(line)
    return conf


def _match(patterns, url):
    """URI 是否命中任一模式。

    *        通配任意字符
    regex:   正则
    其余     精确相等
    """
    for p in patterns or []:
        if p.startswith('regex:'):
            try:
                if re.search(p[6:], url):
                    return True
            except re.error:
                pass
        elif '*' in p:
            rx = '^' + re.escape(p).replace(r'\*', '.*') + '$'
            if re.match(rx, url):
                return True
        elif p == url:
            return True
    return False


# ---------------- 主流程 ----------------

def run(port, conf_path=None, log=None, cache_enabled=True):
    """执行一次预热。在独立线程里调用，不要阻塞主流程。

    port         代理自己的监听端口（预热走 127.0.0.1:port，正常填充缓存）
    conf_path    warmup.conf 的路径（None = 同目录默认）
    log          打日志的函数（通常是 verbose），可空
    cache_enabled 缓存总开关；关了就不预热
    """
    if not cache_enabled:
        return
    if log is None:
        def log(_m):
            pass

    conf = load_conf(conf_path)
    if not _as_bool(conf.get('enabled'), True):
        print('  预热：已关闭（warmup.conf 里 enabled = no）')
        return

    static_pat = conf['sections'].get('static') or []
    route_pat = conf['sections'].get('routes') or []
    content_pat = conf['sections'].get('content') or []
    if not static_pat and not route_pat and not content_pat:
        print('  预热：warmup.conf 里一个模式都没有，跳过')
        return

    workers = max(1, int(_num(conf.get('workers'), 16) or 16))
    mat_max = int(_num(conf.get('materials-max'), 30) or 30)
    ex_max = int(_num(conf.get('examples-max'), 25) or 25)

    # 等 httpd 真正开始 accept
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

    def fetch_all(urls, label, headers=None):
        if not urls:
            return 0

        def one(u):
            try:
                # headers 不能漏：内容接口（examples / content/list）要登录，
                # 不带 token 会全部 401，日志上只是「0/N 成功」
                st, _ = req('GET', u, headers)
                return 1 if st == 200 else 0
            except Exception:
                return 0

        try:
            with ThreadPoolExecutor(max_workers=workers) as ex:
                ok = sum(ex.map(one, urls))
        except Exception:
            ok = 0
        print('  预热%s：%d/%d（%.1f 秒）' % (label, ok, len(urls), time.time() - t0))
        return ok

    t0 = time.time()

    # ---------- ① 发现静态候选 ----------
    #
    # 不写死文件名：HTML 里引用的、入口 bundle 里登记的全部抠出来，
    # 再由 [static] 的模式过滤。这样 /lib/*.js、/vendor/*.js 也能自动覆盖。
    found = set(['/'])
    html_entry = ''
    try:
        st, body = req('GET', '/', timeout=30)
        if st == 200:
            text = body.decode('utf-8', 'ignore')
            for m in re.finditer(r'/(?:assets|lib|vendor|static)/[A-Za-z0-9._\-/]+\.(?:js|css|svg)',
                                 text):
                found.add(m.group(0))
            em = re.search(r'/assets/index-[A-Za-z0-9_-]+\.js', text)
            if em:
                html_entry = em.group(0)
    except Exception as e:
        log('预热：首页没拉到（%s）' % e)

    if html_entry:
        try:
            st, body = req('GET', html_entry, timeout=60)
            if st == 200:
                js = body.decode('utf-8', 'ignore')
                # Vite 产物：懒加载 chunk 名形如 Playground-BWTEdrfF.js
                for m in re.finditer(r'[A-Za-z0-9_\-]+-[A-Za-z0-9_\-]{8}\.(?:js|css)', js):
                    found.add('/assets/' + m.group(0))
                for m in re.finditer(r'/(?:lib|vendor|static)/[A-Za-z0-9._\-/]+\.(?:js|css|svg)', js):
                    found.add(m.group(0))
        except Exception as e:
            log('预热：入口 bundle 没拉到（%s）' % e)

    # 配置里写具体 URI 的（不含 *、不是 regex）也直接进候选
    explicit = []
    for p in static_pat:
        if p.startswith('regex:') or '*' in p:
            continue
        explicit.append(p)
    for u in explicit:
        found.add(u)

    # 用 [static] 过滤
    static_urls = sorted(u for u in found if _match(static_pat, u))
    fetch_all(static_urls, '静态')

    # ---------- ② SPA 路由 ----------
    # 通配的（/teacher/*）展开不了，只能跳过 —— 它们返回的是同一份 HTML，
    # 少预热一两个路由的代价只是那一次 MISS，13KB。
    route_urls = sorted(u for u in route_pat if not u.startswith('regex:') and '*' not in u)
    fetch_all(route_urls, '路由')

    # ---------- ③ 需要登录的公开内容 ----------
    #
    # 缓存 key 是 method+path（不含 token），所以这里的内容全班共享。
    # 绝不能放 /api/bootstrap、/api/classes/:id/scores —— 那是按人返回的，
    # 缓存后 A 的分数会发给所有人。
    pw = str(conf.get('password', '') or '').strip() or _local_password()
    if not content_pat:
        return
    if not pw:
        print('  预热内容：跳过（warmup.conf 里 password 空，本地也没有 data/config.json）')
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
        print('  预热内容：跳过（教师登录失败，检查 warmup.conf 的 password）')
        return

    H = {'Authorization': 'Bearer ' + token}

    course_id = ''
    try:
        st, body = req('GET', '/api/bootstrap', H)
        if st == 200:
            cs = (json.loads(body.decode('utf-8')) or {}).get('courses') or []
            if cs:
                course_id = cs[0].get('id') or ''
    except Exception:
        pass

    # 先把课程 id 和课次填进模式，得到基础 URL
    urls = []
    for p in content_pat:
        if p.startswith('regex:'):
            continue
        urls.append(p.replace('{courseId}', quote(course_id) if course_id else ''))

    # /api/examples 拿 lessons，把 /api/examples/* 展开
    lessons = []
    for u in urls:
        if '/api/examples' in u and 'courseId=' in u:
            try:
                st, body = req('GET', u, H)
                if st == 200:
                    lessons = (json.loads(body.decode('utf-8')) or {}).get('lessons') or []
            except Exception:
                pass
            break

    expanded = []
    for u in urls:
        if u.rstrip('/').endswith('/api/examples'):
            # 自身就是清单，已在上面拉过
            expanded.append(u)
            continue
        if '*' in u:
            if u.startswith('/api/examples/'):
                for les in lessons[:ex_max]:
                    d = (les or {}).get('dir') or ''
                    if d:
                        expanded.append(u.replace('*', quote(d)))
            elif 'id=*' in u:
                for lid in range(1, mat_max + 1):
                    expanded.append(u.replace('id=*', 'id=%d' % lid))
            continue
        expanded.append(u)

    # 去重保序
    seen = set()
    todo = []
    for u in expanded:
        if u in seen or not u:
            continue
        seen.add(u)
        todo.append(u)

    # 材料正文的 id 是数字课次，连续 3 次 404 就提前收工（省得试满 30 次）
    ok_count = 0
    miss_streak = 0
    assets_seen = set()

    def one_content(u):
        nonlocal ok_count, miss_streak
        try:
            st, body = req('GET', u, H, timeout=45)
        except Exception:
            return
        if st != 200:
            if 'id=' in u and 'content/doc' in u:
                miss_streak += 1
            return
        ok_count += 1
        # 正文里引用的图片（材料资源现在是 public，能进缓存）
        if 'content/doc' in u and body:
            try:
                text = body.decode('utf-8', 'ignore')
            except Exception:
                return
            for m in re.finditer(r'/api/content/asset\?[A-Za-z0-9%&=_.:/\-]+', text):
                a = m.group(0)
                if a in assets_seen:
                    continue
                assets_seen.add(a)
                try:
                    st2, _ = req('GET', a, H, timeout=30)
                    if st2 == 200:
                        ok_count += 1
                except Exception:
                    pass

    # 正文按 id 递增，串行跑（要判断 404 连续次数）；其余并发
    doc_urls = [u for u in todo if 'content/doc' in u]
    other_urls = [u for u in todo if 'content/doc' not in u]

    if other_urls:
        fetch_all(other_urls, '内容', H)

    for u in doc_urls:
        if miss_streak >= 3:
            break
        one_content(u)

    print('  预热内容：%d 项（%.1f 秒）' % (ok_count, time.time() - t0))


# ---------------- 小工具 ----------------

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


def _local_password():
    """同机部署（开发/测试）时从 ../data/config.json 读教师口令。"""
    try:
        cfg_file = os.path.join(HERE, '..', 'data', 'config.json')
        with open(cfg_file, 'r', encoding='utf-8-sig') as f:
            return str(json.load(f).get('teacherPassword') or '').strip()
    except Exception:
        return ''
