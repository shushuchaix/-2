"""One anonymous read. stdin/stdout are a fixed private protocol, never commands."""
import contextlib
import json
import logging
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

MAX_FRAME = 8 * 1024 * 1024
PROTOCOL_OUT = sys.stdout
RULES = {"wechat_article_v1", "weibo_post_v1", "official_article_v1"}


class ProtocolError(Exception):
    pass


def frame_read():
    raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not raw or len(raw) > MAX_FRAME or not raw.endswith(b"\n"):
        raise ProtocolError()
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get("protocolVersion") != 1:
        raise ProtocolError()
    return value


def emit(value):
    line = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(line.encode("utf-8")) > MAX_FRAME:
        raise ProtocolError()
    PROTOCOL_OUT.write(line + "\n")
    PROTOCOL_OUT.flush()


def public_url(value):
    url = urlsplit(value)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        raise ProtocolError()
    if re.search(r"(?:^|&)(?:[^=&]*token|api_?key|key|uin|pass_ticket|wx_header|auth(?:orization)?|cookie|password|secret|ticket|signature|code)=", url.query, re.I):
        raise ProtocolError()
    return value


def validate_request(value):
    allowed = {"protocolVersion", "kind", "requestId", "mode", "publicUrl", "ruleId", "limits", "timeoutMs", "control"}
    if set(value) - allowed or value.get("kind") != "read" or value.get("ruleId") not in RULES or value.get("mode") not in {"static", "dynamic", "enhanced"}:
        raise ProtocolError()
    public_url(value["publicUrl"])
    limits = value["limits"]
    for key, cap in {"maxRequests": 60, "maxWireBytes": 20971520, "maxDomBytes": 6291456}.items():
        if type(limits.get(key)) is not int or not 1 <= limits[key] <= cap:
            raise ProtocolError()
    control = value.get("control", {})
    proxy = control.get("proxy", {})
    if set(control) - {"proxy", "browserPath", "tempDir"} or set(proxy) != {"server", "username", "password"}:
        raise ProtocolError()
    url = urlsplit(proxy["server"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
        raise ProtocolError()
    return value


class Broker:
    def __init__(self, request, receive=frame_read, send=emit):
        self.request = request
        self.receive = receive
        self.send = send
        self.requests = 0
        self.redirect = False

    def grant(self, url, method="GET", resource_type="document"):
        public_url(url)
        if method not in {"GET", "HEAD"} or resource_type in {"media", "websocket", "object"} or self.requests >= self.request["limits"]["maxRequests"]:
            raise ProtocolError()
        self.requests += 1
        self.send({"protocolVersion": 1, "kind": "grant_request", "requestId": self.request["requestId"], "sequence": self.requests, "url": url, "method": method, "resourceType": resource_type})
        answer = self.receive()
        if answer.get("kind") == "cancel" or answer.get("kind") != "grant" or answer.get("requestId") != self.request["requestId"] or answer.get("sequence") != self.requests or answer.get("allowed") is not True:
            raise ProtocolError()


def sanitize_html(value, rule_id, max_bytes):
    from lxml import etree
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if len(value.encode("utf-8")) > max_bytes:
        raise ProtocolError()
    document = etree.HTML(value, parser=etree.HTMLParser(huge_tree=False, no_network=True, remove_comments=True))
    if document is None:
        return "", False
    for element in list(document.iter()):
        if not isinstance(element.tag, str):
            continue
        style = element.get("style", "")
        hidden = "hidden" in element.attrib or element.get("aria-hidden") == "true" or re.search(r"display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:;|$)", style, re.I)
        if element.tag.lower() in {"script", "style", "template", "iframe", "object", "embed", "video", "audio"} or hidden:
            parent = element.getparent()
            if parent is not None:
                parent.remove(element)
            continue
        for key in list(element.attrib):
            if key.lower().startswith("on") or key.lower() in {"srcdoc", "formaction"}:
                del element.attrib[key]
    query = {"wechat_article_v1": '//*[@id="js_content"]', "weibo_post_v1": '//*[contains(concat(" ",normalize-space(@class)," ")," weibo-text ")]', "official_article_v1": '//article|//main'}[rule_id]
    bodies = document.xpath(query)
    complete = any("".join(body.itertext()).strip() for body in bodies)
    cleaned = etree.tostring(document, encoding="unicode", method="html").replace("\u200b", "")
    if len(cleaned.encode("utf-8")) > max_bytes:
        raise ProtocolError()
    return cleaned, complete


def body_status(html, status, complete):
    if status in {401, 403}:
        return "restricted"
    if re.search(r"<title>[^<]*(?:验证码|安全验证|captcha)|id=[\"'][^\"']*(?:captcha|verify)|访问过于频繁|人机验证", html, re.I):
        return "challenge_required"
    if not complete and re.search(r"<title>[^<]*登录|login_required", html, re.I):
        return "login_required"
    return "complete" if status == 200 and complete else "incomplete"


def browser_options(request, broker):
    control = request["control"]
    executable = control.get("browserPath")
    if not executable or not Path(executable).is_file():
        raise ProtocolError()
    ready = {"value": False}

    def setup(page):
        try:
            def route_handler(route):
                outgoing = route.request
                try:
                    broker.grant(outgoing.url, outgoing.method, outgoing.resource_type)
                    response = route.fetch(max_redirects=0, max_retries=0, timeout=40000)
                    if 300 <= response.status < 400:
                        broker.redirect = True
                        route.abort()
                        return
                    content = response.body()
                    if len(content) > request["limits"]["maxDomBytes"]:
                        route.abort()
                        return
                    route.fulfill(response=response)
                except Exception:
                    route.abort()
            page.context.route("**/*", route_handler)
            page.context.route_web_socket("**/*", lambda socket: socket.close())
            page.context.on("page", lambda popup: popup.close() if popup != page else None)
            ready["value"] = True
        except Exception:
            page.context.close()
            raise ProtocolError()

    options = {"headless": True, "executable_path": executable, "proxy": control["proxy"], "user_data_dir": control.get("tempDir"), "retries": 1, "retry_delay": 0, "timeout": 40000, "max_pages": 1, "network_idle": False, "wait": 0, "google_search": False, "dns_over_https": False, "disable_resources": False, "blocked_domains": None, "block_ads": False, "real_chrome": False, "cdp_url": None, "cookies": [], "page_setup": setup, "additional_args": {"ignore_https_errors": False, "service_workers": "block", "accept_downloads": False, "permissions": []}, "selector_config": {"adaptive": False, "huge_tree": False, "keep_comments": False}, "extra_flags": ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--proxy-bypass-list=<-loopback>"]}
    if request["mode"] == "enhanced":
        options.update({"solve_cloudflare": False, "block_webrtc": True})
    return options, ready


def collect(request, broker=None, static_fetch=None, dynamic_fetch=None):
    broker = broker or Broker(request)
    if request["mode"] == "static":
        if static_fetch is None:
            from scrapling.fetchers import Fetcher
            static_fetch = Fetcher.get
        broker.grant(request["publicUrl"])
        proxy = request["control"]["proxy"]
        body = bytearray()

        def receive_content(chunk):
            if len(body) + len(chunk) > request["limits"]["maxDomBytes"]:
                return 0xFFFFFFFF  # CURL_WRITEFUNC_ERROR; return 0 does not abort.
            body.extend(chunk)
            return len(chunk)
        response = static_fetch(request["publicUrl"], proxy=proxy["server"], proxy_auth=(proxy["username"], proxy["password"]), retries=1, retry_delay=0, follow_redirects=False, max_redirects=0, verify=True, http3=False, stealthy_headers=False, timeout=40, content_callback=receive_content, selector_config={"adaptive": False, "huge_tree": False, "keep_comments": False})
        source, status = bytes(body), response.status
        if 300 <= status < 400:
            broker.redirect = True
    else:
        if dynamic_fetch is None:
            from scrapling.fetchers import DynamicFetcher, StealthyFetcher
            dynamic_fetch = DynamicFetcher.fetch if request["mode"] == "dynamic" else StealthyFetcher.fetch
        options, ready = browser_options(request, broker)
        response = dynamic_fetch(request["publicUrl"], **options)
        if not ready["value"]:
            raise ProtocolError()
        source, status = response.body, response.status
    cleaned, complete = sanitize_html(source, request["ruleId"], request["limits"]["maxDomBytes"])
    return {"protocolVersion": 1, "kind": "result", "requestId": request["requestId"], "status": status, "url": request["publicUrl"], "html": cleaned, "bodyStatus": "redirect_required" if broker.redirect else body_status(cleaned, status, complete), "requests": broker.requests}


def main():
    logging.disable(logging.CRITICAL)
    try:
        request = validate_request(frame_read())
        with contextlib.redirect_stdout(sys.stderr):
            result = collect(request)
        emit(result)
    except Exception:
        # Fixed exit only. Raw source, URLs, library errors and credentials stay off stdout.
        sys.exit(2)


if __name__ == "__main__":
    main()
