#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lan-proxy.py —— 教学机上的「局域网 → 公网」反向代理（Python 版）

场景：教学机有两块网卡 —— 一块连学生机的局域网，一块通公网。
      项目部署在公网上，学生机在局域网里直接访问不稳 / 不通，
      就在教学机上跑这个脚本：监听一个本地端口，把请求原样转给公网地址。

    学生机  ──(局域网)──▶  教学机 :<listen.port>  ──(公网)──▶  <target>

★ 实时流量走本地
  投屏画面帧、点名心跳、在线状态这些是「实时流量」，走公网绕一圈又慢又占带宽
  （投屏的画面帧尤其致命）。所以按路径分流：

    local.paths 里列出的（/ws、/api/cast/*、/api/presence/*…） → 本机课堂系统
    其它（页面、静态资源、作业、名单、接口…）                    → target（公网）

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


# ---------------------------------------------------------------- 配置
def read_conf(path):
    """读 .conf：key = value，# 与 ; 开头是注释。读不到返回 None"""
    try:
        with open(path, 'rb') as f:
            raw = f.read().decode('utf-8-sig')
    except Exception:
        return None
    conf = {}
    for line in raw.splitlines():
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
VERBOSE = 'verbose' in ARGS or as_bool(conf_get('log.verbose'), False)
QUIET = 'quiet' in ARGS or as_bool(conf_get('log.quiet'), False)
REWRITE = 'no-redirect-rewrite' not in ARGS

USE_LOCAL = as_bool(conf_get('local.enabled'), True) and 'no-local' not in ARGS
LOCAL_TARGET = cli('local-target', 'local.target', 'http://127.0.0.1:18730')
LOCAL_PATHS = [
    x.strip()
    for x in str(cli('local-paths', 'local.paths', '/ws,/api/cast,/api/presence,/api/clock')).split(',')
    if x.strip()
]

if not CONF_FOUND:
    sys.stderr.write('没找到配置文件：%s\n' % CONF_PATH)
    sys.stderr.write('First run: copy proxy.example.conf to proxy.conf (same folder), then fill in the addresses.\n')
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

LOCAL = None
if USE_LOCAL:
    try:
        LOCAL = Target(LOCAL_TARGET)
    except ValueError as e:
        sys.stderr.write('local.target 不对：%s\n' % e)
        sys.exit(1)


def pick_target(path):
    """这个请求走哪一边：实时流量走本地，别的走公网"""
    if LOCAL is None:
        return UP, '公网'
    p = (path or '').split('?')[0]
    for pre in LOCAL_PATHS:
        if p == pre or p.startswith(pre + '/') or (pre.endswith('/') and p.startswith(pre)):
            return LOCAL, '本地'
    return UP, '公网'


def local_origin():
    return 'http://%s' % LISTEN_HOST


def rewrite_location(loc):
    """上游的绝对地址 → 本地地址（重定向别把人甩到公网去）"""
    if not loc or not REWRITE:
        return loc
    for t in (UP, LOCAL):
        if t is None:
            continue
        origin = '%s//%s' % (t.scheme, t.host_header)
        if loc.startswith(origin):
            return local_origin() + loc[len(origin):]
        if loc.startswith('//' + t.host_header):
            return local_origin() + loc[len('//' + t.host_header):]
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
            ctx = ssl.create_default_context()
            if INSECURE:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            conn = HTTPSConnection(target.host, target.port, timeout=TIMEOUT, context=ctx)
        else:
            conn = HTTPConnection(target.host, target.port, timeout=TIMEOUT)
        conn.connect()
        return conn

    def build_upstream_headers(self, target):
        headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in HOP or lk == 'host':
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

    # ---------- 主流程 ----------
    def proxy_request(self):
        upgrade = (self.headers.get('Upgrade') or '').lower()
        if upgrade:
            self.handle_upgrade()
            return

        target, tag = pick_target(self.path)
        body = self.read_body()
        started = time.time()
        try:
            conn = self.open_upstream(target)
        except Exception as e:
            verbose('连不上 %s %s：%s' % (tag, target.raw, e))
            self.fail(502, '连不上%s：%s%s' % (
                target.raw, e,
                ' —— 确认课堂系统在本机跑着' if tag == '本地' else ''
            ))
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

    def send_upstream_response(self, resp, target):
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

    # ---------- WebSocket / 投屏 ----------
    def handle_upgrade(self):
        target, tag = pick_target(self.path)
        try:
            raw = socket.create_connection((target.host, target.port), timeout=TIMEOUT)
            if target.scheme == 'https':
                ctx = ssl.create_default_context()
                if INSECURE:
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                raw = ctx.wrap_socket(raw, server_hostname=target.host)
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
        self.relay(self.connection, raw)

    def relay(self, client_sock, upstream_sock):
        """双向转发（各一个线程，谁先断就结束）"""
        client_sock.settimeout(None)
        upstream_sock.settimeout(None)

        def pump(src, dst):
            try:
                while True:
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

        t1 = threading.Thread(target=pump, args=(client_sock, upstream_sock), daemon=True)
        t2 = threading.Thread(target=pump, args=(upstream_sock, client_sock), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            upstream_sock.close()
        except Exception:
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def print_banner():
    print('=' * 64)
    print('  课堂系统 · 局域网代理')
    print('=' * 64)
    print('  监听：%s : %d' % ('所有网卡' if LISTEN_HOST == '0.0.0.0' else LISTEN_HOST, LISTEN_PORT))
    print('  页面/接口 → %s' % UP.raw)
    if LOCAL is not None:
        print('  实时流量 → %s（本机，不出公网）' % LOCAL.raw)
        print('    本地路径：%s' % ' '.join(LOCAL_PATHS))
    else:
        print('  实时流量 → 跟页面一样走公网（local.enabled = no）')
    print('  配置文件：%s（改完重启生效）' % CONF_PATH)
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
            if self.path != '/__proxy_health':
                return Handler.do_GET(self)
            target, tag = pick_target('/api/health')
            body = json.dumps({
                'ok': True,
                'role': 'lan-proxy',
                'listen': '%s:%d' % (LISTEN_HOST, LISTEN_PORT),
                'target': UP.raw,
                'localTarget': LOCAL.raw if LOCAL else '(不分流)',
                'localPaths': LOCAL_PATHS if LOCAL else [],
                'sampleRoute': '本地' if target is LOCAL else '公网',
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
