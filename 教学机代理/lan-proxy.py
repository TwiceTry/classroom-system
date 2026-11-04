#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lan-proxy.py —— 教学机上的「局域网 → 公网」反向代理（Python 版）

场景：教学机有两块网卡 —— 一块连学生机的局域网，一块通公网。
      项目部署在公网上，学生机在局域网里直接访问不稳 / 不通，
      就在教学机上跑这个脚本：监听一个本地端口，把请求原样转给公网地址。

    学生机  ──(局域网)──▶  教学机 :<listen.port>  ──(公网)──▶  <target>

★ 不做分流
  课堂系统只部署在公网那一份，教学机本机与局域网都不部署 —— 所以页面、接口、
  静态资源、投屏的 /ws 全部转给同一个上游（target），不做任何按路径分流。

★ 所有信息都在配置文件里，脚本本身不含任何地址
  配置文件：同目录的 proxy.conf（首次使用：把 proxy.example.conf 复制一份改名）
  改完配置 → 重新双击 启动代理.bat 生效

特点：
  · 只用 Python 标准库，**没有任何第三方依赖**（不需要 pip install）
  · 兼容 Python 3.6 ~ 3.8（Windows 7 能装的最后几版；自带内嵌版是 3.8.10）
  · 透传 WebSocket（课堂系统的投屏 / 同步走 /ws，必须能代理）
  · 透传流式响应、压缩、分块；上游的 Location 会改写成本地地址，避免跳到公网去

用法（一般用 启动代理.bat 就行）：
  python lan-proxy.py                       # 读同目录的 proxy.conf
  python lan-proxy.py --config D:\\proxy.conf
  python lan-proxy.py --port 18800 --verbose   # 命令行临时覆盖配置
"""

import hashlib
import base64
import hashlib
import json
import os
import select
import socket
import ssl
import sys
import threading
import time
from http.client import HTTPConnection, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
CONF_NAME = 'proxy.conf'

# 逐跳头：不能转发给上游
HOP = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
}

# 我们自己要设的头：先从客户端那份里剔掉，免得出现两个同名头
# （浏览器发来的头名常是小写 content-length，再补一个 Content-Length 上游会判 400）
OURS = ('host', 'content-length', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host')


# ---------------------------------------------------------------- 配置
def read_conf(path):
    """读 .conf：key = value，# 与 ; 开头是注释。读不到返回 None。

    存法兼容三种（Win7 记事本默认存 ANSI/GBK，很容易踩）：
      UTF-8（带不带 BOM 都行）→ ANSI/GBK → 任意字节（latin-1 兜底）
    以前只用 utf-8-sig 解码：文件里有中文注释又是 GBK 存的，
    整个配置就**读不出来**了 —— 于是 tls.insecure 这类设置全都悄悄退回默认值。
    """
    try:
        with open(path, 'rb') as f:
            raw = f.read()
    except Exception:
        return None
    text = None
    for enc in ('utf-8-sig', 'gbk', 'latin-1'):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        return None
    conf = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in '#;':
            continue
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        conf[k.strip().lower()] = v.strip()
    return conf


def parse_args(argv):
    """--key value / --flag 两种写法"""
    out = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith('--'):
            key = a[2:]
            val = True
            if i + 1 < len(argv) and not argv[i + 1].startswith('--'):
                val = argv[i + 1]
                i += 1
            out[key] = val
        i += 1
    return out


def as_bool(v, default=False):
    if v is None or v is True or v is False:
        return default if v is None else v
    s = str(v).strip().lower()
    if s == '':
        return default
    return s in ('1', 'y', 'yes', 'true', 'on', '是', '开')


START = time.time()

# 管道/重定向到文件时也用 UTF-8（Windows 控制台本身没问题，这里是为了日志好看）
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ARGS = parse_args(sys.argv[1:])
CONF_PATH = ARGS.get('config') if isinstance(ARGS.get('config'), str) else os.path.join(HERE, CONF_NAME)
CONF = read_conf(CONF_PATH)
CONF_FOUND = CONF is not None
if not CONF_FOUND:
    CONF = {}


def conf_get(key, default=None):
    v = CONF.get(key)
    if v is None or v == '':
        return default
    return v


def cli(name, conf_key, default=None):
    """命令行优先，其次配置，最后默认值"""
    v = ARGS.get(name)
    if isinstance(v, str) and v != '':
        return v
    return conf_get(conf_key, default)


LISTEN_PORT = int(cli('port', 'listen.port', '18799'))
LISTEN_HOST = cli('host', 'listen.host', '0.0.0.0')
TARGET = cli('target', 'target', '')
TIMEOUT = float(cli('timeout', 'timeout.ms', '120000')) / 1000.0
INSECURE = 'insecure' in ARGS or as_bool(conf_get('tls.insecure'), False)
CA_FILE = conf_get('tls.cafile', '') or ''
VERBOSE = 'verbose' in ARGS or as_bool(conf_get('log.verbose'), False)
QUIET = 'quiet' in ARGS or as_bool(conf_get('log.quiet'), False)
REWRITE = 'no-redirect-rewrite' not in ARGS

# 说明：课堂系统只部署在公网那一份，教学机本机与局域网都不部署，
# 所以**不做任何分流**——所有请求（页面、接口、静态资源、投屏的 /ws）一律转给 target。

# 投屏扇出：教师端 → 代理 → 服务器 → 代理 → N 个学生，全程「公网上行 1 份 + 下行 1 份」。
# 关掉就退回「每个学生一条连接直连服务器」（公网下行 N 份）。
FANOUT_ENABLED = as_bool(conf_get('cast.fanout'), True) and '--no-fanout' not in ARGS

# ---------------- 缓存 ----------------
# 为什么需要缓存：走公网隧道的下行带宽是瓶颈，而系统所有响应都是 no-cache，
# 浏览器每次都重下 —— 打开一次代码练习页就是 2.5MB（vue.global.js + sfc-loader）。
# 代理在教学机上把公开的静态资源缓存下来：第一个学生出公网，后面都本地命中。
CACHE_ENABLED = as_bool(conf_get('cache.enabled'), True)
CACHE_MAX_BYTES = int(float(conf_get('cache.maxbytes', str(64 * 1024 * 1024))))
CACHE_MAX_ENTRIES = int(conf_get('cache.maxentries', '500'))
TTL_ASSETS = int(float(conf_get('cache.ttl.assets', str(365 * 24 * 3600))))
TTL_STATIC = int(float(conf_get('cache.ttl.static', str(24 * 3600))))
TTL_CONTENT = int(float(conf_get('cache.ttl.content', '60')))


class CacheStore(object):
    """内存 LRU：按字节数与条数封顶，先进先出淘汰"""

    def __init__(self, max_bytes, max_entries):
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.items = {}
        self.bytes = 0
        self.hits = 0
        self.misses = 0
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            e = self.items.get(key)
            if e is None:
                self.misses += 1
                return None
            if e['expires'] < time.time():
                self.items.pop(key, None)
                self.bytes -= e['size']
                self.misses += 1
                return None
            self.hits += 1
            # 重新插到末尾 → 最近用过的留到最后淘汰
            self.items.pop(key, None)
            self.items[key] = e
            e['age'] = int(time.time() - e['stored'])
            return e

    def put(self, key, entry):
        with self.lock:
            old = self.items.pop(key, None)
            if old:
                self.bytes -= old['size']
            self.items[key] = entry
            self.bytes += entry['size']
            while self.items and (self.bytes > self.max_bytes or len(self.items) > self.max_entries):
                k = next(iter(self.items))
                v = self.items.pop(k)
                self.bytes -= v['size']

    def stats(self):
        with self.lock:
            return {
                'entries': len(self.items),
                'bytes': self.bytes,
                'maxBytes': self.max_bytes,
                'hits': self.hits,
                'misses': self.misses,
                'hitRate': (round(self.hits / float(self.hits + self.misses), 3) if (self.hits + self.misses) else 0),
            }


CACHE = CacheStore(CACHE_MAX_BYTES, CACHE_MAX_ENTRIES)


def cache_policy(path):
    """这个路径能不能缓存、缓存多久、给浏览器什么 Cache-Control
    返回 (ttl 秒, 浏览器缓存秒数)；ttl=0 表示不缓存"""
    p = (path or '').split('?')[0]
    if p.startswith('/assets/'):
        # 文件名带内容哈希 → 内容变了就换名，可以永久缓存
        return TTL_ASSETS, TTL_ASSETS
    if p.startswith('/vendor/') or p == '/favicon.svg':
        return TTL_STATIC, TTL_STATIC
    if p.startswith('/examples/'):
        # 示例运行时库（名字不带哈希，但极少变）
        return TTL_STATIC, TTL_STATIC
    if p.startswith('/api/content/asset'):
        # 讲义里的图片
        return TTL_STATIC, TTL_STATIC
    if p.startswith('/api/content/doc'):
        # 课程材料（学生讲义）是公开内容 → 可缓存；讲义（教师讲稿）明确不缓存
        if 'type=lecture' in (path or ''):
            return 0, 0
        return TTL_CONTENT, TTL_CONTENT
    return 0, 0

if not CONF_FOUND:
    sys.stderr.write('配置文件读不到：%s\n' % CONF_PATH)
    if os.path.exists(CONF_PATH):
        sys.stderr.write('  文件在，但内容读不出来。\n')
    else:
        sys.stderr.write('  文件不存在。第一次用：把 proxy.example.conf 复制成 proxy.conf（同目录），再填地址。\n')
    sys.stderr.write('  存成 UTF-8 或 ANSI 都行；注释写中文也没问题（读不出的字符会被忽略）。\n')
    sys.exit(1)
if not TARGET:
    sys.stderr.write('配置里没有 target（公网上游地址）。\n')
    sys.stderr.write('Edit %s and set: target = https://your-public-host:port\n' % CONF_PATH)
    sys.exit(1)
if not LISTEN_PORT:
    sys.stderr.write('端口不对：listen.port 要一个数字\n')
    sys.exit(1)


class Target(object):
    """一个上游地址"""

    def __init__(self, raw):
        u = urlsplit(raw if '://' in raw else 'http://' + raw)
        if not u.hostname:
            raise ValueError('地址不对：%s' % raw)
        self.raw = raw
        self.scheme = u.scheme or 'http'
        self.host = u.hostname
        self.port = u.port or (443 if self.scheme == 'https' else 80)
        self.base_path = (u.path or '').rstrip('/')
        self.host_header = u.netloc


try:
    UP = Target(TARGET)
except ValueError as e:
    sys.stderr.write('target 不对：%s\n' % e)
    sys.exit(1)

def tls_hint(e):
    """证书类错误给一句人能看懂的话（别把 Python 的原文甩给用户）"""
    msg = str(e)
    if 'CERTIFICATE_VERIFY_FAILED' in msg or 'certificate verify failed' in msg:
        return ' —— 上游证书校验不过：proxy.conf 里加 tls.insecure = yes（自签证书必须加）'
    if 'unable to get local issuer certificate' in msg:
        return ' —— 缺少该域名的根证书/中间证书：proxy.conf 里加 tls.insecure = yes'
    if 'SSL' in type(e).__name__:
        return ' —— TLS 出错：proxy.conf 里加 tls.insecure = yes 试试'
    return ''


def make_tls_context():
    """建一个 TLS 上下文。

    Win7 上的坑（真机踩过）：ssl.create_default_context() 会去加载
    「本地受信任的根证书库」（Windows 证书库）。内嵌 Python + Win7 这一步
    经常直接失败，浏览器/日志里就看到
      「本地受信任证书库中缺少该域名的根证书或中间证书」
    —— 哪怕把 tls.insecure 设成 yes 也没用：老写法是**先**
    create_default_context()（已经在读证书库了）**后**把校验关掉。

    所以：
      · tls.insecure = yes → 干脆不加载根证书，直接不校验（最稳，Win7 必选）
      · tls.insecure = no  → 加载根证书；加载失败就退回不校验，并提示加 tls.insecure
      · tls.cafile = 路径   → 额外指定一份 CA bundle（自建 CA 时用）
    """
    if INSECURE:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    try:
        ctx = ssl.create_default_context()
        if CA_FILE:
            ctx.load_verify_locations(CA_FILE)
        return ctx
    except Exception as e:
        verbose('加载根证书失败（%s: %s）→ 本次连接不校验证书' % (type(e).__name__, e))
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx


def probe_upstream():
    """启动时探一下上游通不通。

    顺带作用：https 分支要是写错（比如把 'https' 写成 'https:'），
    这里就会暴露出来 —— 明文 HTTP 打到 TLS 端口，上游会回 501。
    """
    try:
        if is_https(UP):
            conn = HTTPSConnection(UP.host, UP.port, timeout=6, context=make_tls_context())
        else:
            conn = HTTPConnection(UP.host, UP.port, timeout=6)
        conn.request('GET', (UP.base_path or '') + '/api/health')
        resp = conn.getresponse()
        body = resp.read(200)
        conn.close()
        return resp.status, body.decode('utf-8', 'replace')
    except Exception as e:
        return None, '%s: %s' % (type(e).__name__, e)


def is_https(target):
    """是不是 https 上游。

    注意：Target.scheme 存的是 'https'（不带冒号）——
    之前写错过成 'https:'，导致校验请求走了明文 HTTP 打到 TLS 端口，
    隧道回 501，于是「学生一连上投屏就被踢」。统一用这个函数，别再手写字符串。
    """
    return (target.scheme or '').lower() in ('https', 'https:', 'wss')


# 不分流：所有请求都转给公网上游（课堂系统只部署在公网）


def local_origin():
    return 'http://%s' % LISTEN_HOST


def rewrite_location(loc):
    """上游的绝对地址 → 本地地址（重定向别把人甩到公网去）"""
    if not loc or not REWRITE:
        return loc
    origin = '%s//%s' % (UP.scheme, UP.host_header)
    if loc.startswith(origin):
        return local_origin() + loc[len(origin):]
    if loc.startswith('//' + UP.host_header):
        return local_origin() + loc[len('//' + UP.host_header):]
    return loc


def strip_domain(cookie):
    parts = []
    for one in cookie.split(', '):
        idx = one.lower().find('; domain=')
        if idx < 0:
            idx = one.lower().find(';domain=')
        parts.append(one[:idx] if idx >= 0 else one)
    return ', '.join(parts)


def now():
    return time.strftime('%H:%M:%S')


def log(*args):
    if QUIET:
        return
    print('[%s] %s' % (now(), ' '.join(str(a) for a in args)))
    sys.stdout.flush()


def verbose(*args):
    if VERBOSE:
        log(*args)


def fail_page(code, msg):
    body = (
        '<!doctype html><meta charset="utf-8"><title>%d</title>'
        '<body style="font:16px/1.7 system-ui;padding:40px"><h2>代理没能转发出去（%d）</h2><p>%s</p>'
        '<p style="color:#666">检查：上游/本机课堂系统能不能访问？端口对不对？</p>'
    ) % (code, code, str(msg).replace('<', '&lt;').replace('>', '&gt;'))
    return body.encode('utf-8')


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'lan-proxy'

    # BaseHTTPRequestHandler 默认会往 stderr 打访问日志，我们自己控制
    def log_message(self, fmt, *args):
        pass

    def log_request(self, code='-', size='-'):
        pass

    def log_error(self, fmt, *args):
        pass

    # 所有方法都走同一条路
    def do_GET(self):
        self.proxy_request()

    def do_POST(self):
        self.proxy_request()

    def do_PUT(self):
        self.proxy_request()

    def do_PATCH(self):
        self.proxy_request()

    def do_DELETE(self):
        self.proxy_request()

    def do_HEAD(self):
        self.proxy_request()

    def do_OPTIONS(self):
        self.proxy_request()

    # ---------- 工具 ----------
    def read_body(self):
        te = (self.headers.get('Transfer-Encoding') or '').lower()
        if 'chunked' in te:
            return self.read_chunked()
        cl = self.headers.get('Content-Length')
        if not cl:
            return None
        try:
            n = int(cl)
        except ValueError:
            return None
        if n <= 0:
            return b''
        return self.rfile.read(n)

    def read_chunked(self):
        data = b''
        while True:
            line = self.rfile.readline().strip()
            if not line:
                break
            try:
                size = int(line.split(b';')[0], 16)
            except ValueError:
                break
            if size == 0:
                # 读掉结尾的空行
                while True:
                    tail = self.rfile.readline()
                    if tail in (b'\r\n', b'\n', b''):
                        break
                break
            data += self.rfile.read(size)
            self.rfile.read(2)  # CRLF
        return data

    def open_upstream(self, target):
        if target.scheme == 'https':
            conn = HTTPSConnection(target.host, target.port, timeout=TIMEOUT, context=make_tls_context())
        else:
            conn = HTTPConnection(target.host, target.port, timeout=TIMEOUT)
        conn.connect()
        return conn

    def build_upstream_headers(self, target):
        headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in HOP or lk in OURS:
                continue
            headers[k] = v
        headers['Host'] = target.host_header
        # 让上游知道真正的客户端是谁
        client_ip = self.client_address[0] if self.client_address else ''
        prev = self.headers.get('X-Forwarded-For')
        headers['X-Forwarded-For'] = (prev + ', ' + client_ip) if prev else client_ip
        headers['X-Forwarded-Proto'] = 'http'
        fh = self.headers.get('Host')
        if fh:
            headers['X-Forwarded-Host'] = fh
        return headers

    def fail(self, code, msg):
        body = fail_page(code, msg)
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
            self.close_connection = True
        except Exception:
            pass

    # ---------- 缓存 ----------
    def cache_key(self):
        return self.command + ' ' + self.path

    def cacheable(self):
        """能不能缓存：看路径是不是「公开内容」

        教学公开的原则：
          · 课程材料（学生讲义）公开 → 可缓存（即使请求带了令牌，内容与身份无关）
          · 讲义（教师讲稿）不公开 → 路径上就排除掉
          · 其它接口（教师端 / 学生端数据）→ 一律不缓存
        另外还有一道保险：上游回 no-store / private 的响应也不进缓存。
        """
        if not CACHE_ENABLED:
            return 0, 0
        if self.command not in ('GET', 'HEAD'):
            return 0, 0
        return cache_policy(self.path)

    def send_cached(self, entry, hit):
        """把缓存里的内容回给浏览器；顺便把 Cache-Control 改成我们自己的，
        让浏览器也能存下来（第二次连代理都不用问）"""
        inm = self.headers.get('If-None-Match')
        if inm and entry['etag'] and inm.strip() == entry['etag']:
            self.send_response(304)
            self.send_header('ETag', entry['etag'])
            self.send_header('Cache-Control', entry['cache_control'])
            self.send_header('X-Cache', 'HIT')
            self.send_header('Age', str(entry['age']))
            self.end_headers()
            return
        self.send_response(entry['status'])
        for k, v in entry['headers']:
            self.send_header(k, v)
        self.send_header('Content-Length', str(entry['size']))
        self.send_header('Cache-Control', entry['cache_control'])
        self.send_header('ETag', entry['etag'])
        self.send_header('X-Cache', 'HIT' if hit else 'MISS')
        self.send_header('Age', str(entry['age']))
        self.end_headers()
        if self.command != 'HEAD' and entry['body']:
            self.wfile.write(entry['body'])

    # ---------- 主流程 ----------
    def proxy_request(self):
        upgrade = (self.headers.get('Upgrade') or '').lower()
        if upgrade:
            self.handle_upgrade()
            return

        # 缓存：命中就直接回，不出公网
        ttl, browser_ttl = self.cacheable()
        key = self.cache_key()
        if ttl > 0:
            entry = CACHE.get(key)
            if entry is not None:
                verbose('缓存命中 %s' % self.path)
                try:
                    self.send_cached(entry, True)
                except Exception as e:
                    verbose('回缓存失败：%s' % e)
                return

        target, tag = UP, '公网'
        body = self.read_body()
        started = time.time()
        try:
            conn = self.open_upstream(target)
        except Exception as e:
            verbose('连不上 %s %s：%s' % (tag, target.raw, e))
            self.fail(502, '连不上%s：%s%s' % (target.raw, e, tls_hint(e)))
            return

        try:
            headers = self.build_upstream_headers(target)
            if body is not None:
                headers['Content-Length'] = str(len(body))
            path = target.base_path + self.path
            conn.putrequest(self.command, path, skip_host=True, skip_accept_encoding=True)
            for k, v in headers.items():
                conn.putheader(k, v)
            if body is None:
                conn.endheaders()
            else:
                conn.endheaders(body)

            resp = conn.getresponse()
            # 上游明确说「不要缓存」（no-store / private）→ 尊重它，不进缓存
            up_cc = (resp.getheader('Cache-Control') or '').lower()
            may_cache = ('no-store' not in up_cc) and ('private' not in up_cc)
            if ttl > 0 and resp.status == 200 and may_cache:
                # 可缓存的：整包读进来 → 存一份 → 回给浏览器
                buf = self.read_all(resp)
                cc = 'public, max-age=%d' % browser_ttl if browser_ttl else 'no-cache'
                entry = {
                    'status': resp.status,
                    'headers': [(k, v) for k, v in resp.getheaders()
                                if k.lower() not in HOP and k.lower() not in ('content-length', 'cache-control', 'etag')],
                    'body': buf,
                    'size': len(buf),
                    'etag': '"%s"' % hashlib.md5(buf).hexdigest(),
                    'cache_control': cc,
                    'expires': time.time() + ttl,
                    'stored': time.time(),
                    'age': 0,
                }
                CACHE.put(key, entry)
                self.send_response(entry['status'])
                for k, v in entry['headers']:
                    self.send_header(k, v)
                self.send_header('Content-Length', str(len(buf)))
                self.send_header('Cache-Control', cc)
                self.send_header('ETag', entry['etag'])
                self.send_header('X-Cache', 'MISS')
                self.send_header('Age', '0')
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(buf)
            else:
                self.send_upstream_response(resp, target)
                self.stream_body(resp)
            verbose('%s %s %s → %s · %dms · %s' % (
                tag, self.command, self.path, resp.status,
                int((time.time() - started) * 1000),
                resp.getheader('Content-Type') or ''
            ))
        except socket.timeout:
            self.fail(504, '上游超时（%.0f 秒没回话）' % TIMEOUT)
        except Exception as e:
            verbose('转发出错 %s %s：%s' % (tag, self.path, e))
            self.fail(502, '%s' % e)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def send_upstream_response(self, resp, target, cache_control=None, extra=None):
        self.send_response(resp.status)
        has_len = False
        for k, v in resp.getheaders():
            lk = k.lower()
            if lk in HOP:
                continue
            if lk == 'location':
                v = rewrite_location(v)
            elif lk == 'set-cookie':
                v = strip_domain(v)
            elif lk == 'content-length':
                has_len = True
            self.send_header(k, v)
        if cache_control:
            self.send_header('Cache-Control', cache_control)
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        if not has_len:
            # 长度不明（分块 / 流式）：用「连接关闭」表示结束
            self.send_header('Connection', 'close')
            self.close_connection = True
        self.end_headers()

    def stream_body(self, resp):
        if self.command == 'HEAD':
            return
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            self.wfile.write(chunk)
        try:
            self.wfile.flush()
        except Exception:
            pass

    def read_all(self, resp):
        buf = b''
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            buf += chunk
        return buf

    # ---------- WebSocket / 投屏 ----------
    def handle_upgrade(self):
        """投屏（ctl / student）走「扇出」，其余（presence 等）走原样转发。"""
        role = ''
        try:
            from urllib.parse import urlsplit, parse_qs
            q = parse_qs(urlsplit(self.path).query)
            role = (q.get('role') or [''])[0]
        except Exception:
            role = ''
        if FANOUT_ENABLED and role in ('ctl', 'student'):
            self.handle_fanout(role)
            return
        self.handle_upgrade_raw()

    # ---------- 原样转发（presence 等非投屏通道）----------
    def handle_upgrade_raw(self):
        target, tag = UP, '公网'
        try:
            raw = socket.create_connection((target.host, target.port), timeout=TIMEOUT)
            if target.scheme == 'https':
                raw = make_tls_context().wrap_socket(raw, server_hostname=target.host)
        except Exception as e:
            verbose('WebSocket 连不上（%s）：%s' % (tag, e))
            self.fail(502, '连不上%s：%s' % (target.raw, e))
            return

        lines = ['%s %s%s HTTP/1.1' % (self.command, target.base_path, self.path)]
        for k, v in self.headers.items():
            if k.lower() == 'host':
                continue
            lines.append('%s: %s' % (k, v))
        lines.append('Host: %s' % target.host_header)
        try:
            raw.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin1'))
        except Exception as e:
            verbose('WebSocket 握手发送失败：%s' % e)
            try:
                raw.close()
            except Exception:
                pass
            return

        # 读上游的响应头，原样转给客户端
        head = b''
        try:
            while b'\r\n\r\n' not in head:
                chunk = raw.recv(4096)
                if not chunk:
                    break
                head += chunk
        except Exception as e:
            verbose('WebSocket 读上游响应失败：%s' % e)

        if not head:
            try:
                raw.close()
            except Exception:
                pass
            self.close_connection = True
            return

        try:
            self.wfile.write(head)
            self.wfile.flush()
        except Exception:
            pass

        status_line = head.split(b'\r\n')[0]
        if b' 101' not in status_line:
            verbose('%s WebSocket 上游没同意：%s' % (tag, status_line.decode('latin1', 'replace')))
            try:
                raw.close()
            except Exception:
                pass
            self.close_connection = True
            return

        verbose('%s WebSocket 已接通：%s' % (tag, self.path))
        self.close_connection = True
        self.relay(self.connection, raw, client_reader=self.read_client)

    def relay(self, client_sock, upstream_sock, client_reader=None):
        """双向转发（各一个线程，谁先断就结束）

        投屏的画面帧是 WebSocket 二进制帧，最怕攒包（Nagle）：
        关掉 Nagle、把接收缓冲调大，帧才能「发出去就到」。
        """
        client_sock.settimeout(None)
        upstream_sock.settimeout(None)
        for s in (client_sock, upstream_sock):
            try:
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except Exception:
                pass
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 20)
            except Exception:
                pass

        def pump(src, dst, reader=None):
            try:
                while True:
                    if reader is not None:
                        data = reader()
                    else:
                        data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except Exception:
                        pass

        t1 = threading.Thread(target=pump, args=(client_sock, upstream_sock, client_reader), daemon=True)
        t2 = threading.Thread(target=pump, args=(upstream_sock, client_sock), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            upstream_sock.close()
        except Exception:
            pass

    # ---------- 投屏扇出 ----------
    def handle_fanout(self, role):
        """本地的投屏连接：交给扇出管理器统一处理"""
        self.close_connection = True
        try:
            self.connection.settimeout(None)
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except Exception:
            pass
        ws = WsConn(self.connection, mask_out=False, on_close=self.on_local_closed, reader=self.read_client)
        ws.on_text = lambda t: FANOUT.on_local_text(ws, role, t)
        ws.on_bin = lambda b: FANOUT.on_local_bin(ws, role, b)
        FANOUT.attach_local(ws, role)
        # 握手响应直接给本地（我们是服务端，不掩码）
        try:
            key = self.headers.get('Sec-WebSocket-Key') or ''
            accept = base64.b64encode(
                hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode('latin1')).digest()
            ).decode()
            self.wfile.write(
                ('HTTP/1.1 101 Switching Protocols\r\n'
                 'Upgrade: websocket\r\n'
                 'Connection: Upgrade\r\n'
                 'Sec-WebSocket-Accept: %s\r\n\r\n' % accept).encode('latin1')
            )
            self.wfile.flush()
        except Exception:
            return
        ws.start()
        ws.wait()

    def read_client(self):
        """从 HTTP 层那个带缓冲的 rfile 里读（浏览器发来的 WS 帧都缓存在那里）"""
        try:
            return self.rfile.read1(65536)
        except Exception:
            return b''

    def on_local_closed(self, ws):
        FANOUT.detach_local(ws)


# ---------------- WebSocket 帧 ----------------
WS_TEXT, WS_BIN, WS_CLOSE, WS_PING, WS_PONG = 0x1, 0x2, 0x8, 0x9, 0xa


class WsConn(object):
    """一条 WebSocket 连接：能解帧（回调）与发帧。

    mask_out=True  → 我们是客户端（发给上游，要掩码）
    mask_out=False → 我们是服务端（发给浏览器，不掩码）
    """

    def __init__(self, sock, mask_out, on_text=None, on_bin=None, on_close=None, reader=None):
        self.sock = sock
        self.reader = reader      # 从哪读（本地连接要传 rfile.read1）
        self.mask_out = mask_out
        self.on_text = on_text
        self.on_bin = on_bin
        self.on_close = on_close
        self.buf = b''
        self.closed = False
        self._latest = None   # 背压：只保留最新一帧
        self._flushing = False
        self._thread = None

    # ---------- 发 ----------
    def send_frame(self, opcode, payload):
        if self.closed:
            return False
        try:
            n = len(payload)
            head = bytearray([0x80 | opcode])
            if n < 126:
                head.append(n)
            elif n < 65536:
                head.append(126)
                head += n.to_bytes(2, 'big')
            else:
                head.append(127)
                head += n.to_bytes(8, 'big')
            data = payload
            if self.mask_out:
                mask = os.urandom(4)
                head[1] |= 0x80
                head += mask
                data = bytes(payload[i] ^ mask[i % 4] for i in range(n))
            self.sock.sendall(bytes(head) + data)
            return True
        except Exception:
            self.close()
            return False

    def send_text(self, text):
        return self.send_frame(WS_TEXT, text.encode('utf-8'))

    def send_bin(self, buf):
        return self.send_frame(WS_BIN, buf)

    def send_latest(self, buf):
        """只保留最新一帧：上一帧没写完就把待发的那一帧覆盖掉。

        慢的学生机只会自己少收几帧，不会拖垮别人，内存也不会堆积。
        （与服务端 server/lib/ws.js 的 sendBinaryLatest 同一个思路）
        """
        if self.closed:
            return False
        self._latest = buf
        if not self._flushing:
            self._flush()
        return True

    def _flush(self):
        if self.closed:
            self._latest = None
            self._flushing = False
            return
        buf = self._latest
        self._latest = None
        if not buf:
            self._flushing = False
            return
        self._flushing = True
        try:
            self.sock.sendall(encode_ws_frame(WS_BIN, buf, self.mask_out))
            # 写完接着发下一帧
            def done():
                self._flushing = False
                if self._latest:
                    self._flush()
            try:
                self.sock.settimeout(0.001)
                self.sock.sendall(b'')  # 触发一次空写，确认缓冲已排空
            except Exception:
                pass
            finally:
                try:
                    self.sock.settimeout(None)
                except Exception:
                    pass
            done()
        except Exception:
            self._flushing = False
            self.close()

    # ---------- 收 ----------
    def start(self):
        self._thread = threading.Thread(target=self.pump, daemon=True)
        self._thread.start()

    def wait(self):
        """占住这个 HTTP 请求，直到 WS 结束。

        不占住的话，do_GET 一返回，HTTP 层就会把连接关掉（WebSocket 立刻断）。
        """
        if self._thread:
            self._thread.join()

    def pump(self):
        try:
            while not self.closed:
                if self.reader is not None:
                    data = self.reader()
                else:
                    data = self.sock.recv(65536)
                if not data:
                    break
                self.buf += data
                self.parse()
        except Exception:
            pass
        self.close()

    def parse(self):
        while True:
            b = self.buf
            if len(b) < 2:
                return
            fin = b[0] & 0x80
            op = b[0] & 0x0f
            masked = b[1] & 0x80
            ln = b[1] & 0x7f
            off = 2
            if ln == 126:
                if len(b) < 4:
                    return
                ln = int.from_bytes(b[2:4], 'big')
                off = 4
            elif ln == 127:
                if len(b) < 10:
                    return
                ln = int.from_bytes(b[2:10], 'big')
                off = 10
            mask = None
            if masked:
                if len(b) < off + 4:
                    return
                mask = b[off:off + 4]
                off += 4
            if len(b) < off + ln:
                return
            payload = b[off:off + ln]
            if mask:
                payload = bytes(payload[i] ^ mask[i % 4] for i in range(ln))
            self.buf = b[off + ln:]
            if not fin:
                # 分片消息：投屏与控制消息都是单帧，这里先攒着不动
                continue
            try:
                if op == WS_TEXT and self.on_text:
                    self.on_text(payload.decode('utf-8', 'replace'))
                elif op == WS_BIN and self.on_bin:
                    self.on_bin(payload)
                elif op == WS_PING:
                    self.send_frame(WS_PONG, payload)
                elif op == WS_CLOSE:
                    self.close()
                    return
            except Exception as e:
                verbose('WebSocket 处理消息出错：%s' % e)

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass
        if self.on_close:
            try:
                self.on_close(self)
            except Exception:
                pass


def encode_ws_frame(opcode, payload, mask):
    """给 WsConn.send_latest 用（一次写完，不做回调）"""
    n = len(payload)
    head = bytearray([0x80 | opcode])
    if n < 126:
        head.append(n)
    elif n < 65536:
        head.append(126)
        head += n.to_bytes(2, 'big')
    else:
        head.append(127)
        head += n.to_bytes(8, 'big')
    data = payload
    if mask:
        mk = os.urandom(4)
        head[1] |= 0x80
        head += mk
        data = bytes(payload[i] ^ mk[i % 4] for i in range(n))
    return bytes(head) + data


def open_upstream_ws(path):
    """连到上游的 WebSocket，返回 socket（握手已完成）"""
    target = UP
    sock = socket.create_connection((target.host, target.port), timeout=TIMEOUT)
    if target.scheme == 'https':
        sock = make_tls_context().wrap_socket(sock, server_hostname=target.host)
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [
        'GET %s%s HTTP/1.1' % (target.base_path, path),
        'Host: %s' % target.host_header,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: %s' % key,
        'Sec-WebSocket-Version: 13',
    ]
    sock.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin1'))
    head = b''
    while b'\r\n\r\n' not in head:
        chunk = sock.recv(4096)
        if not chunk:
            break
        head += chunk
    if b' 101' not in head.split(b'\r\n')[0]:
        try:
            sock.close()
        except Exception:
            pass
        raise IOError('上游没同意 WebSocket：' + head.split(b'\r\n')[0].decode('latin1', 'replace'))
    return sock


def verify_student(token):
    """用上游的 /api/me 校验学生令牌，拿身份（classId:sid）。

    代理是局域网里的「门」，不能让任何人都白看投屏 —— 所以本地学生连接
    也要过一道身份校验（一次小请求，只在连接时做一次）。
    """
    try:
        if is_https(UP):
            conn = HTTPSConnection(UP.host, UP.port, timeout=5, context=make_tls_context())
        else:
            conn = HTTPConnection(UP.host, UP.port, timeout=5)
        conn.request('GET', '/api/me', headers={'Authorization': 'Bearer ' + token})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        if resp.status != 200:
            verbose('校验学生令牌：/api/me 返回 %d · %s' % (
                resp.status, data[:160].decode('utf-8', 'replace').replace('\n', ' ')))
            verbose('  校验用的上游：%s' % ('%s://%s:%s%s' % (
                UP.scheme, UP.host, UP.port, UP.base_path)))
            return None
        j = json.loads(data.decode('utf-8'))
        if j.get('role') != 'student':
            verbose('校验学生令牌：role=%r，不是学生' % j.get('role'))
            return None
        st = j.get('student') or {}
        ident = '%s:%s' % (st.get('classId') or '', st.get('sid') or '')
        verbose('校验学生令牌通过：%s' % ident)
        return ident
    except Exception as e:
        verbose('校验学生令牌失败：%s: %s' % (type(e).__name__, e))
        return None


class CastFanout(object):
    """投屏扇出：

        教师端  ──1 条上游 ctl──▶  服务器  ──1 条上游 student──▶  代理  ──▶  N 个本地学生

    公网上行 1 份、下行 1 份（不再 N 份）。服务器那侧一行都不用改：
    它照旧给「学生连接」广播帧，代理用一条上游 student 连接接住，再在局域网里扇给所有人。
    """

    def __init__(self):
        self.lock = threading.RLock()
        self.up_ctl = None       # 上游教师通道
        self.up_stu = None       # 上游学生通道（帧从这条路来）
        self.local_ctl = []      # 本地教师端连接
        self.local_stu = []      # 本地学生端连接
        self.idents = {}         # id(conn) -> 'classId:sid'
        self.stu_hello = None    # 第一个学生的 hello（用来建立上游 student 连接）
        self.ctl_hello = None
        self.frames = 0
        self.bytes = 0
        self.fanned = 0

    # ---------- 本地连接 ----------
    def attach_local(self, ws, role):
        with self.lock:
            if role == 'ctl':
                self.local_ctl.append(ws)
            else:
                self.local_stu.append(ws)
        verbose('本地投屏连接接入：%s（当前本地观看 %d）' % (role, len(self.local_stu)))

    def detach_local(self, ws):
        with self.lock:
            self.local_ctl = [c for c in self.local_ctl if c is not ws]
            self.local_stu = [c for c in self.local_stu if c is not ws]
            self.idents.pop(id(ws), None)
        verbose('本地投屏连接断开（剩余观看 %d）' % len(self.local_stu))

    # ---------- 本地 → 上游 ----------
    def on_local_text(self, ws, role, text):
        try:
            msg = json.loads(text)
        except Exception:
            msg = {}
        if role == 'ctl':
            # 教师端：hello（带教师令牌）→ 转发给上游 ctl 通道
            if msg.get('t') == 'hello':
                with self.lock:
                    self.ctl_hello = text
                up = self.ensure_up_ctl()
                if up:
                    up.send_text(text)
            else:
                up = self.up_ctl
                if up:
                    up.send_text(text)
            return

        # 学生端：hello（带学生令牌）
        if msg.get('t') == 'hello':
            token = str(msg.get('token') or '')
            ident = verify_student(token) if token else None
            if not ident:
                ws.send_text(json.dumps({'t': 'error', 'message': '观看投屏需要先用学号登录'}, ensure_ascii=False))
                ws.close()
                return
            with self.lock:
                self.idents[id(ws)] = ident
            # 第一个学生：拿他的 hello 建立「上游学生通道」（只建一条）
            up = self.ensure_up_stu(text)
            if up is None:
                ws.send_text(json.dumps({'t': 'error', 'message': '投屏通道暂时不可用，请稍后重试'}, ensure_ascii=False))
                ws.close()
                return
            # 告诉服务器「有人在看」→ 服务器会给上游 student 通道发 cast 状态
            up.send_text(text)

    def on_local_bin(self, ws, role, buf):
        # 教师端发来的二进制帧 = 投屏画面 → 送到上游教师通道，
        # 服务器收到后会广播给「学生连接」→ 代理的上游学生通道接住 → 本地扇给所有人
        if role == 'ctl':
            up = self.up_ctl
            if up:
                up.send_bin(buf)
        # 学生端不该发二进制，忽略

    # ---------- 上游 → 本地 ----------
    def on_up_ctl_text(self, text):
        # 服务器告诉教师端「几人在看」→ 改写成「本地真实人数」
        with self.lock:
            n = len(set(self.idents.values())) or len(self.local_stu)
        try:
            msg = json.loads(text)
        except Exception:
            msg = None
        if isinstance(msg, dict) and msg.get('t') == 'peers':
            msg['students'] = n
            text = json.dumps(msg, ensure_ascii=False)
        with self.lock:
            for c in list(self.local_ctl):
                c.send_text(text)

    def on_up_stu_text(self, text):
        with self.lock:
            for c in list(self.local_stu):
                c.send_text(text)

    def on_up_stu_bin(self, buf):
        with self.lock:
            self.frames += 1
            self.bytes += len(buf)
            targets = list(self.local_stu)
        for c in targets:
            c.send_latest(buf)
        self.fanned += len(targets)

    # ---------- 上游通道 ----------
    def ensure_up_ctl(self):
        with self.lock:
            if self.up_ctl is not None and not self.up_ctl.closed:
                return self.up_ctl
        try:
            sock = open_upstream_ws('/ws?role=ctl')
        except Exception as e:
            verbose('上游教师通道建不起来：%s' % e)
            return None
        ws = WsConn(sock, mask_out=True, on_text=self.on_up_ctl_text, on_close=self.on_up_ctl_closed)
        with self.lock:
            self.up_ctl = ws
        ws.start()
        verbose('上游教师通道已建立')
        return ws

    def on_up_ctl_closed(self, ws):
        with self.lock:
            if self.up_ctl is ws:
                self.up_ctl = None
        verbose('上游教师通道断开')

    def ensure_up_stu(self, hello_text):
        with self.lock:
            if self.up_stu is not None and not self.up_stu.closed:
                return self.up_stu
            self.stu_hello = hello_text
        try:
            sock = open_upstream_ws('/ws?role=student')
        except Exception as e:
            verbose('上游学生通道建不起来：%s' % e)
            return None
        ws = WsConn(sock, mask_out=True, on_bin=self.on_up_stu_bin, on_close=self.on_up_stu_closed)
        with self.lock:
            self.up_stu = ws
        ws.start()
        verbose('上游学生通道已建立（公网下行从 N 份变成 1 份）')
        return ws

    def on_up_stu_closed(self, ws):
        with self.lock:
            if self.up_stu is ws:
                self.up_stu = None
            hello = self.stu_hello
        verbose('上游学生通道断开，尝试重连')
        if hello:
            time.sleep(1.0)
            up = self.ensure_up_stu(hello)
            if up:
                up.send_text(hello)

    def stats(self):
        with self.lock:
            return {
                'fanout': FANOUT_ENABLED,
                'upCtl': bool(self.up_ctl and not self.up_ctl.closed),
                'upStudent': bool(self.up_stu and not self.up_stu.closed),
                'localTeacher': len(self.local_ctl),
                'localWatchers': len(self.local_stu),
                'uniqueWatchers': len(set(self.idents.values())),
                'frames': self.frames,
                'bytes': self.bytes,
                'framesToWatchers': self.fanned,
            }


FANOUT = CastFanout()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        """浏览器自己把连接断了（刷新、切页、取消）不是错误，别刷 traceback。"""
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, socket.timeout)):
            verbose('客户端断开：%s（%s）' % (client_address, type(exc).__name__))
            return
        if isinstance(exc, OSError) and getattr(exc, 'winerror', None) in (10053, 10054):
            verbose('客户端断开：%s（WinError %s）' % (client_address, exc.winerror))
            return
        super(Server, self).handle_error(request, client_address)
    daemon_threads = True
    allow_reuse_address = True


def fmt_bytes(n):
    if n >= 1048576:
        return '%.0f MB' % (n / 1048576.0)
    if n >= 1024:
        return '%.0f KB' % (n / 1024.0)
    return '%d B' % n


def fmt_ttl(sec):
    if sec >= 86400:
        return '%d 天' % (sec // 86400)
    if sec >= 3600:
        return '%d 小时' % (sec // 3600)
    return '%d 秒' % sec


def print_banner():
    print('=' * 64)
    print('  课堂系统 · 局域网代理')
    print('=' * 64)
    print('  监听：%s : %d' % ('所有网卡' if LISTEN_HOST == '0.0.0.0' else LISTEN_HOST, LISTEN_PORT))
    print('  页面/接口 → %s' % UP.raw)
    print('  实时流量（/ws、/api/cast…）→ 同样走公网（课堂系统只部署在公网）')
    if FANOUT_ENABLED:
        print('  投屏扇出：开（公网上行 1 份 / 下行 1 份；本地再分给每个学生）')
    else:
        print('  投屏扇出：关（每个学生一条连接直连服务器，公网下行 N 份）')
    print('  配置文件：%s（改完重启生效）' % CONF_PATH)
    print('    读到：port=%s · target=%s · tls.insecure=%s · cache=%s · 扇出=%s' % (
        LISTEN_PORT, TARGET or '(空)', 'yes' if INSECURE else 'no',
        'yes' if CACHE_ENABLED else 'no', 'yes' if FANOUT_ENABLED else 'no'))
    if CACHE_ENABLED:
        print('  缓存：开 · 上限 %s · 静态 %s / 示例 %s / 讲义 %s' % (
            fmt_bytes(CACHE_MAX_BYTES), fmt_ttl(TTL_ASSETS), fmt_ttl(TTL_STATIC), fmt_ttl(TTL_CONTENT)))
    if is_https(UP):
        print('  上游证书：%s' % ('已忽略校验（tls.insecure = yes）' if INSECURE else '严格校验（自签证书要加 tls.insecure = yes）'))
    else:
        print('  缓存：关（cache.enabled = no）')
    # 上游自检：顺带验证 https 分支没写错（明文打到 TLS 端口会被回 501）
    _st, _body = probe_upstream()
    if _st == 200:
        print('  上游自检：OK（/api/health 返回 200）')
    else:
        print('  上游自检：不通 → %s' % (_body or _st))
        print('    · 看看 target 的地址与端口对不对')
        print('    · 上游是 https 且用自签证书时，配置里加 tls.insecure = yes')
        print('    · 隧道 / 防火墙也可能挡住')
    print('  自检：%s:%d/__proxy_health' % ('127.0.0.1' if LISTEN_HOST == '0.0.0.0' else LISTEN_HOST, LISTEN_PORT))
    try:
        host_name = socket.gethostname()
        _name, _aliases, ips = socket.gethostbyname_ex(host_name)
        if ips:
            print('  教学机 %s 的地址：%s' % (host_name, ' / '.join(ips)))
    except Exception:
        pass
    print('  停止：Ctrl + C')
    print('=' * 64)
    sys.stdout.flush()


def main():
    # 自检页
    class HealthHandler(Handler):
        def do_GET(self):
            if self.path == '/__proxy_stats':
                st = CACHE.stats()
                body = json.dumps({
                    'ok': True,
                    'role': 'lan-proxy',
                    'cacheEnabled': CACHE_ENABLED,
                'cast': FANOUT.stats(),
                    'cache': st,
                    'uptimeSec': int(time.time() - START),
                }, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path != '/__proxy_health':
                return Handler.do_GET(self)
            target, tag = UP, '公网'
            body = json.dumps({
                'ok': True,
                'role': 'lan-proxy',
                'listen': '%s:%d' % (LISTEN_HOST, LISTEN_PORT),
                'target': UP.raw,
                'sampleRoute': '公网',
                'uptimeSec': int(time.time() - START),
            }, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    print_banner()
    httpd = Server((LISTEN_HOST, LISTEN_PORT), HealthHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n收到 Ctrl+C，收尾退出…')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
