# Collection runtime notices

The independent Windows runtime includes Python, Scrapling, Playwright, Patchright,
Chromium and their locked dependencies. Runtime installation and downloads are
disabled. The application does not copy an existing user Python or browser cache.

Python is distributed under the Python Software Foundation license. Its bundled
`python/LICENSE.txt` is retained. Scrapling uses the BSD 3-Clause license;
Playwright and Patchright use Apache-2.0. Chromium includes BSD and other component
licenses in its distribution. BrowserForge and the bundled fingerprint data are
retained with their original distribution metadata and license files.

The complete Python dependency versions and source archive hashes are recorded
in `python/requirements.lock`. Each binary, model, CA bundle, driver and license
file in the packaged runtime is recorded with its byte size and SHA-256 in the
runtime `manifest.json`; its `licenses` list identifies retained notice files.
The original license files and distribution metadata apply to each component.

Official sources:

- Python: <https://www.python.org/downloads/windows/>
- Scrapling: <https://github.com/D4Vinci/Scrapling>
- Playwright: <https://github.com/microsoft/playwright-python>
- Patchright: <https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python>
- Chromium: <https://www.chromium.org/chromium-projects/>
- BrowserForge: <https://github.com/daijro/browserforge>
