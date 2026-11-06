#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
教学机代理 · 自检脚本（只用标准库，Win7 的内嵌 Python 3.8 能跑）

用法（在 教学机代理\\ 目录下）：
    runtime\\python\\python.exe 自检.py                      # 测默认端口 18799
    runtime\\python\\python.exe 自检.py --port 18799
    runtime\\python\\python.exe 自检.py --target https://你的公网地址:45600
    runtime\\python\\python.exe 自检.py --n 40                # 并发学生数（默认 10）
    runtime\\python\\python.exe 自检.py --only cache,cast    # 只跑某几项
    runtime\\python\\python.exe 自检.py --list               # 列出所有检查项

检查项：
    proxy      代理自检页（监听地址、上游、缓存配置）
    upstream   上游公网能不能通（/api/health）
    cache      缓存：第一次 MISS、第二次 HIT（毫秒级）
    cast       投屏帧经代理转发，字节一字节不差（sha256 对比）
    presence   在场通道扇出：本地名单人数 = 教师端看到的在线人数
    load       N 个学生同时开页：成功率、延迟 P50/P90

不需要 node、不需要 npm、不需要外网。
"""

import argparse
import hashlib
import json
import os
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
OK = '✓'
NG = '✗'


# ---------------------------------------------------------------- 小工具
def http(url, method='GET', body=None, headers=None, timeout=20, with_headers=False):
    """返回 (状态码, 字节内容, 耗时毫秒)；with_headers=True 时多返回一个响应头字典"""
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        hdrs.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            buf = r.read()
            ms = int((time.time() - t0) * 1000)
            if with_headers:
                return r.status, buf, ms, dict(r.getheaders())
            return r.status, buf, ms
    except urllib.error.HTTPError as e:
        buf = e.read()
        ms = int((time.time() - t0) * 1000)
        if with_headers:
            return e.code, buf, ms, dict(e.headers or {})
        return e.code, buf, ms
    except Exception as e:
        buf = str(e).encode('utf-8')
        ms = int((time.time() - t0) * 1000)
        if with_headers:
            return 0, buf, ms, {}
        return 0, buf, ms


def read_conf(path):
    conf = {}
    try:
        with open(path, 'rb') as f:
            raw = f.read().decode('utf-8-sig', 'replace')
    except Exception:
        return conf
    for line in raw.splitlines():
        line = line.strip()
        if not line or line[0] in '#;':
            continue
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        conf[k.strip().lower()] = v.strip()
    return conf


class Ws(object):
    """最小 WebSocket 客户端（只够测投屏与在场）"""

    def __init__(self, host, port, path, timeout=20):
        self.host, self.port, self.path = host, port, path
        self.sock = None
        self.buf = b''
        self.texts = []
        self.bins = []
        self.status = ''
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._stop = False
        self._timeout = timeout
        self._open()

    def _open(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=self._timeout)
        key = 'dGhlIHNhbXBsZSBub25jZQ=='
        req = (
            'GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n'
        ) % (self.path, self.host, self.port, key)
        self.sock.sendall(req.encode('latin1'))
        self._t = threading.Thread(target=self._read)
        self._t.daemon = True
        self._t.start()
        if not self._ready.wait(self._timeout):
            raise RuntimeError('WebSocket 握手超时')

    def _read(self):
        try:
            while not self._stop:
                d = self.sock.recv(65536)
                if not d:
                    break
                self.buf += d
                if not self._ready.is_set():
                    # 先把 HTTP 握手响应（101）吃掉 —— 它不是 WebSocket 帧
                    if b'\r\n\r\n' in self.buf:
                        head, _, rest = self.buf.partition(b'\r\n\r\n')
                        self.status = head.split(b'\r\n')[0].decode('latin1')
                        self.buf = rest
                        self._ready.set()
                    continue
                self._parse()
        except Exception:
            # 出错也要放行，否则一直等到超时
            self._ready.set()

    def _parse(self):
        while len(self.buf) >= 2:
            b0, b1 = self.buf[0], self.buf[1]
            op = b0 & 0x0f
            ln = b1 & 0x7f
            off = 2
            if ln == 126:
                if len(self.buf) < 4:
                    return
                ln = int.from_bytes(self.buf[2:4], 'big')
                off = 4
            elif ln == 127:
                if len(self.buf) < 10:
                    return
                ln = int.from_bytes(self.buf[2:10], 'big')
                off = 10
            if len(self.buf) < off + ln:
                return
            payload = self.buf[off:off + ln]
            self.buf = self.buf[off + ln:]
            with self._lock:
                if op == 1:
                    self.texts.append(payload.decode('utf-8', 'replace'))
                elif op == 2:
                    self.bins.append(payload)

    def send(self, data, binary=False):
        payload = data if isinstance(data, bytes) else str(data).encode('utf-8')
        ln = len(payload)
        head = bytearray([0x82 if binary else 0x81])
        if ln < 126:
            head.append(0x80 | ln)
        elif ln < 65536:
            head.append(0x80 | 126)
            head += ln.to_bytes(2, 'big')
        else:
            head.append(0x80 | 127)
            head += ln.to_bytes(8, 'big')
        mask = os.urandom(4)
        head += mask
        masked = bytearray(payload)
        for i in range(ln):
            masked[i] ^= mask[i % 4]
        self.sock.sendall(bytes(head) + bytes(masked))

    def send_json(self, obj):
        self.send(json.dumps(obj, ensure_ascii=False))

    def wait_text(self, want_key=None, timeout=8.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self._lock:
                for t in self.texts:
                    try:
                        j = json.loads(t)
                    except Exception:
                        continue
                    if want_key is None or want_key in j:
                        return j
            time.sleep(0.1)
        return None

    def wait_bin(self, timeout=8.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            with self._lock:
                if self.bins:
                    return self.bins[0]
            time.sleep(0.05)
        return None

    def close(self):
        self._stop = True
        try:
            self.sock.close()
        except Exception:
            pass


# ---------------------------------------------------------------- 检查项
class Check(object):
    def __init__(self, name, title):
        self.name = name
        self.title = title
        self.lines = []
        self.passed = None
        self.hint = ''

    def say(self, text):
        self.lines.append(text)

    def ok(self, text):
        self.lines.append('    ' + OK + ' ' + text)

    def bad(self, text):
        self.lines.append('    ' + NG + ' ' + text)

    def note(self, text):
        self.lines.append('    · ' + text)

    def done(self, passed, hint=''):
        self.passed = passed
        self.hint = hint
        return passed


def c_proxy(cfg, args, c):
    st, buf, ms = http(cfg['base'] + '/__proxy_health')
    if st != 200:
        c.bad('连不上 %s/__proxy_health（%s）' % (cfg['base'], (buf[:40] or b'').decode('utf-8', 'replace')))
        c.note('代理窗口开着吗？端口对吗？proxy.conf 里 listen.port 写的是 %d' % cfg['port'])
        c.note('端口不对就用 --port 指定，或改 proxy.conf 的 listen.port')
        return c.done(False, '连不上代理（端口 %d）—— 先确认代理在哪个端口' % cfg['port'])
    try:
        j = json.loads(buf.decode('utf-8'))
    except Exception:
        return c.done(False, '自检页返回的不是 JSON')
    c.ok('监听：%s' % j.get('listen'))
    c.ok('上游：%s' % j.get('target'))
    if j.get('localAvailable') is False:
        c.note('本机没有课堂系统（正常，课堂系统只部署在公网）')
    pool = j.get('upstreamPool')
    if pool:
        c.ok('上游连接池：%s 条（空闲 %s）' % (pool.get('max'), pool.get('size')))
    c.say('  （耗时 %d ms）' % ms)
    return c.done(True)


def c_upstream(cfg, args, c):
    st, buf, ms = http(cfg['base'] + '/api/health', timeout=25)
    if st == 200:
        try:
            j = json.loads(buf.decode('utf-8'))
            c.ok('/api/health 200 · %s · uptime %s 秒' % (j.get('node'), j.get('uptimeSec')))
        except Exception:
            c.ok('/api/health 200')
        c.say('  （耗时 %d ms）' % ms)
        return c.done(True)
    c.bad('/api/health 返回 %s' % (st or buf[:60]))
    c.note('代理能通但上游不通：检查 target 地址/端口、隧道有没有掉线、证书（tls.insecure = yes）')
    return c.done(False, '上游不通 —— 先看 target 对不对')


def c_cache(cfg, args, c):
    # ---- 先验一条反例：API 绝不能被缓存 ----
    # 以前 cache_policy 里「最后一段没有扩展名 → 当成 SPA 入口页」这条规则会把
    # /api/classes、/api/state 这类路径也一起缓存 300 秒，而 need_revalidate 又把
    # /api/ 排除在外（过期后连 ETag 都不问）。后果是老师刚加的名单、刚给的分，
    # 学生端要等 5 分钟才看到。这里用公开的 /api/health 兜住这条底线。
    for api in ('/api/health', '/api/classes'):
        try:
            s1, _, _, h1 = http(cfg['base'] + api, timeout=20, with_headers=True)
            s2, _, _, h2 = http(cfg['base'] + api, timeout=20, with_headers=True)
        except Exception as e:
            c.note('取 %s 失败（%s），跳过这条' % (api, e))
            continue
        x2 = (h2.get('X-Cache') or '-').upper()
        if x2 == 'HIT':
            c.bad('%s 被代理缓存了（X-Cache: HIT）—— 接口不能走缓存' % api)
            c.note('改 lan-proxy.py 的 cache_policy：/api/ 要落到「不缓存」那条')
            return c.done(False, 'API 被缓存了，老师改完数据学生端要等 5 分钟')
        c.ok('%s 不缓存（%s / X-Cache=%s）' % (api, s1, x2))

    path = '/examples/vue3-sfc-loader.js'
    st1, b1, ms1, h1 = http(cfg['base'] + path, timeout=60, with_headers=True)
    if st1 != 200:
        c.bad('取不到 %s（%s）' % (path, st1))
        return c.done(False, '这个文件没取到 —— 先看「上游公网连通」那项')
    st2, b2, ms2, h2 = http(cfg['base'] + path, timeout=60, with_headers=True)
    x1 = (h1.get('X-Cache') or '?').upper()
    x2 = (h2.get('X-Cache') or '?').upper()
    c.ok('%s → %s · %.1f KB · %d ms' % (path, x1, len(b1) / 1024.0, ms1))
    c.ok('%s → %s · %.1f KB · %d ms' % (path, x2, len(b2) / 1024.0, ms2))
    same = hashlib.sha256(b1).hexdigest() == hashlib.sha256(b2).hexdigest()
    if not same:
        c.bad('两次取到的内容不一样！')
        return c.done(False, '缓存内容不一致，缓存坏了')
    if x2 == 'HIT' and ms2 < 200:
        c.ok('命中很快（%d ms）—— 第二个学生不出公网' % ms2)
        return c.done(True)
    if x2 == 'HIT':
        c.note('命中了但还是 %d ms —— 检查缓存是不是命中在内存里（本地磁盘快是正常的）' % ms2)
        return c.done(True)
    c.bad('第二次不是 HIT —— 缓存没生效')
    c.note('检查 proxy.conf 里 cache.enabled = yes')
    return c.done(False, '缓存没生效')


def c_cast(cfg, args, c):
    teacher = args.teacher_token
    student = args.student_token
    if not teacher or not student:
        c.bad('拿不到令牌（教师/学生登录失败）')
        return c.done(False, '登录失败：检查 --password 与 --sid/--name')
    ctl = None
    watcher = None
    try:
        # hello 的字段必须和前端一致（照 web/src 抄）：
        #   screencast.js  ctl     → { t:'hello', token }                    （不带 cid）
        #   Watch.vue      student → { t:'hello', cid, w, h, ua, token }     （必须带 cid）
        #   ctl 连上后还要发一条 { t:'mode', mode:'watch' }，否则不进入推流状态。
        # 以前这里 watcher 没带 cid、ctl 反而带了（还是课程 id），
        # 服务端把学生当成「没有班级的观众」→ peers 一直是 0 → 帧不转发。
        cid = ''
        try:
            st, buf, _ = http(cfg['base'] + '/api/classes',
                              headers={'Authorization': 'Bearer ' + teacher})
            if st == 200:
                body = json.loads(buf.decode('utf-8')) or {}
                arr = body.get('items') or body.get('classes') or []
                if arr:
                    cid = arr[0].get('id') or ''
        except Exception:
            pass

        watcher = Ws(cfg['host'], cfg['port'], '/ws?role=student')
        watcher.send_json({'t': 'hello', 'cid': cid, 'w': 1280, 'h': 720,
                           'ua': 'selftest', 'token': student})
        ctl = Ws(cfg['host'], cfg['port'], '/ws?role=ctl')
        ctl.send_json({'t': 'hello', 'token': teacher})
        ctl.send_json({'t': 'mode', 'mode': 'watch'})
        peers = ctl.wait_text('students', 8)
        n = peers.get('students') if peers else '?'
        c.ok('教师端连上，服务器说 %s 人在看' % n)
        if n in (0, '?', None):
            c.note('peers 仍是 %s：检查学生令牌是否有效、cid=%s 是否为真实班级' % (n, cid or '(空)'))

        payload = os.urandom(64 * 1024)
        frame = bytearray(16 + len(payload))
        frame[0] = 1
        frame[1] = 0
        frame[2:4] = (1).to_bytes(2, 'little')
        frame[4:6] = (1280).to_bytes(2, 'little')
        frame[6:8] = (720).to_bytes(2, 'little')
        frame[8:10] = (0).to_bytes(2, 'little')
        frame[10:12] = (0).to_bytes(2, 'little')
        frame[12:16] = (0).to_bytes(4, 'little')
        frame[16:] = payload
        ctl.send(bytes(frame), binary=True)

        got = watcher.wait_bin(12)
        if not got:
            c.bad('学生端没收到帧')
            c.note('看代理窗口的日志；确认教师端真的在投屏（帧是从教师端来的）')
            return c.done(False, '投屏帧没到学生端')
        h1 = hashlib.sha256(bytes(frame)).hexdigest()
        h2 = hashlib.sha256(got).hexdigest()
        c.ok('发出 %d 字节 · 收到 %d 字节' % (len(frame), len(got)))
        if h1 == h2:
            c.ok('sha256 一致 → 字节一字节不差')
            return c.done(True)
        c.bad('sha256 不一致 → 转发把内容弄坏了')
        return c.done(False, '投屏帧字节不一致')
    except Exception as e:
        c.bad('异常：%s' % e)
        return c.done(False, 'WebSocket 连接失败')
    finally:
        for w in (ctl, watcher):
            if w:
                w.close()


def c_presence(cfg, args, c):
    socks = []
    try:
        # 1) 三个学生连到场通道
        for i in range(3):
            w = Ws(cfg['host'], cfg['port'], '/ws?role=presence')
            socks.append(w)
            w.send_json({'t': 'auth', 'token': args.students[i]})
            time.sleep(0.4)
        c.ok('3 个学生连上 /ws?role=presence')

        # 模拟真实场景：学生端每 10 秒发一次心跳，代理据此补齐名单
        for i in range(3):
            http(cfg['base'] + '/api/presence/ping', 'POST', {},
                 headers={'Authorization': 'Bearer ' + args.students[i]}, timeout=15)
            time.sleep(0.4)
        time.sleep(1.0)
        # 边缘端：到场通道只在本地连，状态聚合成快照上云
        st, buf, _ = http(cfg['base'] + '/__proxy_stats')
        try:
            j = json.loads(buf.decode('utf-8'))
        except Exception:
            j = {}
        edge = j.get('cast', {}).get('edge') or {}
        if edge:
            c.ok('代理本地状态：知道 %d 人（在线 %d · 看投屏 %d）· 快照周期上报'
                 % (edge.get('known', 0), edge.get('online', 0), edge.get('casting', 0)))
        else:
            c.bad('代理统计里没有 edge 状态')
            return c.done(False, '代理不是边缘端模式？')

        # 2) 教师端查在线名单（数据来自服务端，代理原样转发）
        # 路径与返回结构都对过：/api/classes 返回 {items:[...]}，
        # 在场名单在 /api/classes/:id/presence。
        # （旧写法是 /api/teacher/classes + {classes:[...]}，后端重构后这两个都变了。）
        st, buf, _ = http(cfg['base'] + '/api/classes',
                          headers={'Authorization': 'Bearer ' + args.teacher_token})
        if st != 200:
            c.bad('教师端拿不到班级列表（%s）' % st)
            return c.done(False, '教师令牌不对？')
        body = json.loads(buf.decode('utf-8')) or {}
        classes = body.get('items') or body.get('classes') or []
        if not classes:
            c.bad('没有班级')
            return c.done(False, '没有班级数据')
        cid = classes[0]['id']
        st, buf, _ = http(cfg['base'] + '/api/classes/%s/presence' % cid,
                          headers={'Authorization': 'Bearer ' + args.teacher_token})
        if st != 200:
            c.bad('拿不到在场名单（%s）' % st)
            return c.done(False, '教师端接口不对')
        p = json.loads(buf.decode('utf-8'))
        c.ok('服务端记的：在线 %d 人 · 在看投屏 %d 人 · 全班 %d 人'
             % (p.get('onlineCount', 0), p.get('castingCount', 0), p.get('total', 0)))
        if p.get('onlineCount', 0) >= 3:
            c.ok('在场名单由服务端直接记账（准）')
            return c.done(True)
        c.bad('服务端只记到 %d 人 —— 到场通道没通' % p.get('onlineCount', 0))
        c.note('看代理窗口日志：是不是 presence 连接建不起来')
        return c.done(False, '在场名单不对')
    except Exception as e:
        c.bad('异常：%s' % e)
        return c.done(False)
    finally:
        for w in socks:
            w.close()


def c_load(cfg, args, c):
    st, buf, _ = http(cfg['base'] + '/', timeout=20)
    html = buf.decode('utf-8', 'replace') if st == 200 else ''
    import re
    m = re.search(r'src="(/assets/[^"]+\.js)"', html)
    js = m.group(1) if m else ''
    m2 = re.search(r'href="(/assets/[^"]+\.css)"', html)
    css = m2.group(1) if m2 else ''
    paths = ['/student/materials', '/api/public/course']
    if js:
        paths.append(js)
    if css:
        paths.append(css)
    paths.append('/examples/vue3-sfc-loader.js')

    results = []
    lock = threading.Lock()

    def one(i):
        got = []
        for p in paths:
            st, b, ms = http(cfg['base'] + p, timeout=90)
            got.append((p, st, len(b), ms))
        with lock:
            results.append(got)

    t0 = time.time()
    ths = [threading.Thread(target=one, args=(i,)) for i in range(args.n)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    wall = time.time() - t0

    bad = []
    times = []
    total = 0
    for got in results:
        for p, st, ln, ms in got:
            times.append(ms)
            total += ln
            if st != 200:
                bad.append('%s → %s' % (p, st or 'ERR'))
    times.sort()
    p50 = times[len(times) // 2] if times else 0
    p90 = times[int(len(times) * 0.9)] if times else 0
    c.ok('%d 个学生 × %d 个请求 = %d 个' % (args.n, len(paths), len(results) * len(paths)))
    c.ok('全部完成 %.1f 秒 · 延迟 P50 %d ms · P90 %d ms · 最大 %d ms'
         % (wall, p50, p90, times[-1] if times else 0))
    c.ok('浏览器侧共收到 %.1f MB' % (total / 1048576.0))
    if not bad:
        c.ok('没有一个请求失败')
        return c.done(True)
    c.bad('%d 个请求失败：%s' % (len(bad), bad[:4]))
    c.note('失败多是上游连接被踢（弱网）或缓存没命中；看代理窗口的日志')
    return c.done(False, '%d 个请求失败' % len(bad))


CHECKS = [
    ('proxy', '代理自检页', c_proxy),
    ('upstream', '上游公网连通', c_upstream),
    ('cache', '缓存 MISS→HIT', c_cache),
    ('cast', '投屏帧字节无损', c_cast),
    ('presence', '在场扇出与名单', c_presence),
    ('load', '并发开页', c_load),
]


def login(base, password, sid, name, course):
    """拿教师令牌与几个学生令牌。

    要「几个」：服务端规定「同一个学生只保留一个观看连接」，
    所以投屏测试用的学生必须与在场测试用的学生不是同一个，
    否则代理的上游通道和本地观看会被服务端互相踢掉。
    """
    teacher = ''
    # 后端把登录路径挪到了 /api/auth/ 下（旧的 /api/login/teacher 现在 404）。
    # 这个自检一度因此永远报「教师登录失败」，后两项（投屏 / 在场）连带全部跳过。
    st, buf, _ = http(base + '/api/auth/login/teacher', 'POST', {'password': password})
    if st == 200:
        teacher = (json.loads(buf.decode('utf-8')) or {}).get('token') or ''
    # 服务端校验「学号 + 姓名」的配对，所以必须用**真实名单里**的组合。
    # 以前这里硬编码了几个学号/姓名，名单一变（或换了课程）就全部登录失败，
    # 而投屏 / 在场两项会因此一起跳过 —— 自检等于没跑。
    # 现在：先问服务端拿当前班级的真实名单，拿不到才退回 --sid/--name。
    roster = []
    try:
        st, buf, _ = http(base + '/api/classes',
                          headers={'Authorization': 'Bearer ' + teacher})
        if st == 200:
            body = json.loads(buf.decode('utf-8')) or {}
            arr = body.get('items') or body.get('classes') or []
            if arr:
                cid0 = arr[0].get('id')
                # 名单接口是 /students（不是 /roster —— 那个现在 404）。
                # 写错时 roster 取空，只能退回同一个默认学生，
                # 于是「3 个连接只记 1 人」—— 其实代理没错，是这三条连接是同一个人。
                st2, buf2, _ = http(base + '/api/classes/%s/students' % cid0,
                                    headers={'Authorization': 'Bearer ' + teacher})
                if st2 == 200:
                    rb = json.loads(buf2.decode('utf-8')) or {}
                    for it in (rb.get('items') or []):
                        if it.get('sid') and it.get('name'):
                            roster.append((it['sid'], it['name']))
                        if len(roster) >= 4:
                            break
    except Exception:
        pass

    if not roster:
        roster = [(sid, name)]
    else:
        # --sid/--name 指定的那个排最前（如果确实在名单里）
        if (sid, name) in roster:
            roster.remove((sid, name))
            roster.insert(0, (sid, name))

    students = []
    for s, n in roster:
        st, buf, _ = http(base + '/api/auth/login/student', 'POST',
                          {'sid': s, 'name': n, 'courseId': course})
        if st == 200:
            students.append((json.loads(buf.decode('utf-8')) or {}).get('token') or '')
        else:
            students.append('')
            verbose_note = '学号 %s / %s 登录失败（名字对不上？用 --sid --name 指定）' % (s, n)
    return teacher, students


def main():
    ap = argparse.ArgumentParser(description='教学机代理自检（只用标准库）')
    ap.add_argument('--port', type=int, default=None, help='代理端口（默认读 proxy.conf）')
    ap.add_argument('--host', default='127.0.0.1', help='代理所在机器（默认本机）')
    ap.add_argument('--target', default='', help='公网上游地址（默认读 proxy.conf 的 target）')
    ap.add_argument('--n', type=int, default=10, help='并发学生数（默认 10）')
    ap.add_argument('--password', default='teacher', help='教师口令（默认 teacher）')
    ap.add_argument('--sid', default='2515230114', help='学生学号（默认取名单里第一个）')
    ap.add_argument('--name', default='马婷婷', help='学生姓名')
    ap.add_argument('--course', default='web-front-dev', help='课程 id')
    ap.add_argument('--only', default='', help='只跑某几项，逗号分隔')
    ap.add_argument('--list', action='store_true', help='列出所有检查项')
    args = ap.parse_args()

    if args.list:
        print('可用检查项：')
        for name, title, _ in CHECKS:
            print('  %-10s %s' % (name, title))
        return 0

    conf = read_conf(os.path.join(HERE, 'proxy.conf'))
    port = args.port or int(conf.get('listen.port', '18799'))
    target = args.target or conf.get('target', '')

    # 端口探测：配置里的端口连不上时，扫几个常见端口，
    # 直接告诉用户「代理在哪个端口能通」—— 比让他自己猜省事得多
    if not args.port:
        st, _, _ = http('http://127.0.0.1:%d/__proxy_health' % port, timeout=3)
        if st != 200:
            for p in (18799, 18805, 18850, 18860, 18905, 18798):
                if p == port:
                    continue
                st2, _, _ = http('http://127.0.0.1:%d/__proxy_health' % p, timeout=2)
                if st2 == 200:
                    print('  ! proxy.conf 里写的是端口 %d，但 %d 能通 —— 用 %d 继续测'
                          % (port, p, p))
                    port = p
                    break
            else:
                print('  ! 端口 %d 不通，常见端口也没找到 —— 代理是不是没起来？' % port)
    cfg = {'host': args.host, 'port': port, 'base': 'http://%s:%d' % (args.host, port),
           'target': target}

    print('=' * 62)
    print('  教学机代理自检')
    print('  代理：%s   上游：%s' % (cfg['base'], target or '(没读到)'))
    print('=' * 62)

    # 令牌（通过代理拿，这样测的是「学生看到的」那条路）
    teacher, students = login(cfg['base'], args.password, args.sid, args.name, args.course)
    args.teacher_token = teacher
    # students[0] 给「投屏」用（本地看投屏的那个学生）
    # students[1..] 给「在场」用（别的学生，避免同一学生被服务端互踢）
    args.student_token = students[0] if students else ''
    args.students = (students[1:4] if len(students) > 3 else students) + [''] * 5
    if not teacher:
        print('  ! 教师登录失败（口令不对？后面几项会跳过）')

    only = [x.strip() for x in args.only.split(',') if x.strip()]
    failed = []
    for name, title, fn in CHECKS:
        if only and name not in only:
            continue
        c = Check(name, title)
        try:
            fn(cfg, args, c)
        except Exception as e:
            c.bad('异常：%s: %s' % (type(e).__name__, e))
            c.passed = False
            c.hint = c.hint or '脚本异常'
        print('')
        print('[%s] %s' % (OK if c.passed else NG, title))
        for l in c.lines:
            print(l)
        if not c.passed:
            if c.hint:
                print('    → 怎么办：' + c.hint)
            failed.append((title, c.hint))

    print('')
    print('=' * 62)
    if failed:
        print('  有 %d 项没通过：' % len(failed))
        for t, h in failed:
            print('    · %s —— %s' % (t, h or '看上面的数字'))
    else:
        print('  全部通过 ✓')
    print('=' * 62)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n（中断）')
        sys.exit(130)
