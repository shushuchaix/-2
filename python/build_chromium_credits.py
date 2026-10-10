"""Capture the pinned browser's internal third-party notices without external access."""
import asyncio
import pathlib
import sys
from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=sys.argv[1], headless=True, timeout=20000,
            args=["--disable-background-networking", "--disable-component-update",
                  "--disable-sync", "--disable-default-apps", "--no-first-run",
                  "--host-resolver-rules=MAP * ~NOTFOUND",
                  "--proxy-server=http://127.0.0.1:9"],
        )
        try:
            page = await browser.new_page()
            await page.route("http://**/*", lambda route: route.abort())
            await page.route("https://**/*", lambda route: route.abort())
            await page.goto("chrome://credits", wait_until="domcontentloaded", timeout=20000)
            html = await page.content()
            if len(html) < 10000 or "license" not in html.lower():
                raise RuntimeError("Chromium notices incomplete")
            pathlib.Path(sys.argv[2]).write_text(html, encoding="utf-8")
        finally:
            await browser.close()


asyncio.run(main())
