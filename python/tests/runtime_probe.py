"""Synthetic transport substitution only; not shipped or callable by the product.

Actual curl/Playwright/Patchright still traverse the controlled Node HTTP proxy.
HTTPS fixture URLs are mapped to HTTP on the simulated public fixture gateway,
avoiding any certificate bypass or changes to the worker's strict TLS settings.
"""
import contextlib
import importlib.util
import logging
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit

spec = importlib.util.spec_from_file_location("collection_worker", Path(__file__).parents[1] / "collection_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def fixture_url(value):
    url = urlsplit(value)
    if url.scheme != "https" or url.hostname != "mp.weixin.qq.com":
        raise worker.ProtocolError()
    return urlunsplit(("http", url.netloc, url.path, url.query, ""))


def main():
    logging.disable(logging.CRITICAL)
    request = worker.validate_request(worker.frame_read())
    with contextlib.redirect_stdout(sys.stderr):
        from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher
        from playwright.sync_api import Route as PlaywrightRoute
        from patchright.sync_api import Route as PatchrightRoute
        for route_type in (PlaywrightRoute, PatchrightRoute):
            original = route_type.fetch

            def bounded_fetch(self, *args, _original=original, **kwargs):
                assert kwargs["max_redirects"] == 0
                assert kwargs["max_retries"] == 0
                kwargs["url"] = fixture_url(self.request.url)
                return _original(self, *args, **kwargs)
            route_type.fetch = bounded_fetch

        def static(url, **options):
            assert options["verify"] is True
            from curl_cffi.const import CurlHttpVersion
            options['http_version'] = CurlHttpVersion.V1_1
            return Fetcher.get(fixture_url(url), **options)

        def dynamic(url, **options):
            assert options["additional_args"]["ignore_https_errors"] is False
            assert options["additional_args"]["service_workers"] == "block"
            assert options["retries"] == 1
            fetcher = DynamicFetcher if request["mode"] == "dynamic" else StealthyFetcher
            return fetcher.fetch(url, **options)

        result = worker.collect(request, static_fetch=static, dynamic_fetch=dynamic)
    worker.emit(result)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Synthetic test errors only; production entry never forwards raw errors.
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(2)
