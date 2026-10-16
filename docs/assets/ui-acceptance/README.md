# 合成桌面验收资料

这里保存最终发行 EXE 的三个独立进程原始 JSON，以及 16 张代表性 PNG。所有资料来自新临时目录和合成记录，不包含用户简历、凭据或私人路径。

- `scale-100`：PID 82700，实际 DPR 1，57/57，exit 0。
- `scale-125`：PID 86960，实际 DPR 1.25，57/57，exit 0。
- `scale-150`：PID 83556，实际 DPR 1.5，57/57，exit 0。

PNG 文件名表示请求的 CSS 宽度。125% / 150% 的 `jobs-375-*` 实际为更窄的 374px；报告保留 requestedWidth、nativeRequestedWidth、width、dpr 和完整原生采样。768 / 1024 / 1440 的实际 CSS 宽度均精确。`ui-font-125.png` 表示各进程额外放大字体 125%。

JSON 列出的每进程全部 9 张原图仍保留在 `docs/UI-ACCEPTANCE.md` 列出的相对 `.cache` 合成目录中；这里随附岗位库四种宽度、字体放大及默认 375px 设置页的代表截图。

详细断言、包 SHA、完整离线结果、审查修复和 Docker 环境限制见 [验收报告](../../UI-ACCEPTANCE.md)。
