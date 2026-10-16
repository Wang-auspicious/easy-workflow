# E 界面验收

运行 `node ui/test/rooms-browser.mjs --v2`。脚本使用临时项目、真实 journal/KernelStore 与 API，不调用外部模型，不连接真实项目。此目录用于 E 的界面验收，不作为 B/C/D 的真实模型通过证据。

- `summary-attention.png`：固定总结行与待处理卡片。
- `shots-challenge.png`：三屏群组的质疑、答复及讨论。
- `progress-off.png` / `progress-on.png`：默认隐藏进展及开关对比，刷新后保持选择。
- `canvas-waits.png`：模型黄、预算橙、讨论紫、退避灰；脚本同时检查四个计数实际位于屏幕内。
- `fixture-report.json`：七项浏览器检查回执，另包含真实 API 经验删除、claim 证据链和 v2 隐藏配员控件。

原 v1 路径使用 `node ui/test/rooms-browser.mjs` 验证。完整结果见 `docs/v2-progress.md`。
