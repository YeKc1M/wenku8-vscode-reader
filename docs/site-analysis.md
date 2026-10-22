# 网站与自包含实现检查（2026-10-22）

最初通过 kimi-webbridge 调研网站 HTML 与请求；该工具只用于调研，**0.5.0 运行时不使用它，也不连接外部浏览器或中继服务**。

## 协议与入口核查

- 主站为服务端 HTML，首页字符集为 GBK。直接 HTTPS 请求主站目录和 WAP，本次均遇到 Cloudflare 403；VS Code 自带 Chromium 内正常访问。
- 搜索表单 POST `/so.php`，转到 GET `/modules/article/search.php?searchtype=articlename&searchkey=…`。实际关键字使用 GBK 字节百分号编码；「败北」为 `%B0%DC%B1%B1`。作者查询使用 `searchtype=author`。
- 单条搜索命中会跳转 `/book/{id}.htm`；多条结果在 `#content`，翻页见 `#pagelink a.next`。实测站点要求两次搜索至少间隔五秒，错误页仍返回 HTTP 200；客户端串行间隔 5.2 秒并显示真实错误。
- 目录路径 `/novel/{floor(id/1000)}/{id}/index.htm`，书名 `#title`、作者 `#info`，分卷 `td.vcss`、章节 `td.ccss a`，按 DOM 顺序关联。
- 章节路径同目录，相对 `{chapterId}.htm`，正文位于 `#content`，标题位于 `#title`。移除重复的 `#contentdp` 宣传块、脚本和广告后提取纯文本。
- 图片章节可能没有文字。本次图片域名包括 `pic.777743.xyz`；只允许实测的图片域名，按需在无脚本面板中加载。
- 登录页 `/login.php`，表单 POST `/login.php?do=submit`，字段 `username`、`password`、`action=login`、`usecookie`。使用账号原有权限访问，密码不持久化。
- 网站书架为 `/modules/article/bookcase.php?classid=0`，分组 0–5，书籍链接的 `aid` 是书籍 ID。导入不修改远端书架。

另核查历史 Android 接口 `app.wenku8.com/android.php`：本次 HTTP GET / POST 都仅返回 Welcome，HTTPS 主机证书不匹配；`app.wenku8.net` 未建立可用 TLS。没有把该入口做成可用 API，也没有关闭证书校验。[Android 项目](https://github.com/MewX/light-novel-library_Wenku8_Android) 当前公开 API 为 stub，真正模块单独维护；因此不依赖其第三方中继，也不宣称旧 API 稳定可用。

## 运行架构

1. `network.ts` 用插件内的 fetch 直接请求网站。GBK 编解码、CookieJar、受限重定向、请求大小上限及超时均随插件打包。Cookie 使用 SecretStorage，密码仅用于本次请求。
2. 遇到验证时明确提示用户执行内置验证，不悄悄启动外部程序。`session.ts` 通过 VS Code 自带 `editor-browser` 调试器创建内置浏览器，手动验证后维持同源网络会话。
3. 点击验证完成后导航到同源无脚本资源，再替换成普通工具函数和 `session.ts` 标题。其底层仍是站点地址，原生地址栏不是插件控制的界面，不能声称网站地址彻底消失。连接页需保持打开。
4. 插件请求通过同源 fetch 返回纯数据。CDP 拦截器在请求及重定向响应阶段检查地址，拒绝外域和远端书架删除等未允许操作；登录不自动重放。会话只用于取数，不将原站正文作为阅读 UI。
5. `extension.ts` / `reader.ts` 用 [TextDocumentContentProvider](https://code.visualstudio.com/api/extension-guides/virtual-documents) 提供只读 `workspace.ts`，由原生编辑器负责语法高亮、行号、主题、查找和拆分。正文做 JSON 字符串转义。dark/light 切换实际运行验证；会话占位页同步切换浅色/深色。
6. 隐藏递增请求版本，清理正文与所有拆分阅读标签、图片面板、书架条目；旧异步读取不能重新显示。窗口失焦默认触发隐藏。恢复是显式操作。

浏览器 API 本身仍属 proposed API，因此插件没有申请 proposed 权限；通过内置调试器建立的 CDP 代理及 `vscodeBrowserViewId` 是内部集成点，已在 VS Code 1.142.0 验证，但不能保证未来兼容。普通 HTML 前端不能独自消除服务器的 Cloudflare 验证要求。

## 验证结果与边界

- 单元测试：HTML 解析、GBK 关键字、恶意链接、Cookie 保存和恢复、外域重定向拦截、登录失败与不保存密码、GET / POST 注入脚本语法。
- 真正的 VS Code Extension Host：原生 TypeScript 文档、dark/light 切换、滚动恢复、上下章、拆分编辑器隐藏、读取过程中隐藏后正文不恢复。
- 真实内置浏览器：网站验证后，读取书籍 3057 的 234 个目录章节、正文及插图；账号登录、按书名搜索、结果翻页和网站书架读取成功；没有使用 Kimi 桥接或外部浏览器。主题占位页截图已检查。

不保存完整小说或账号页面到测试工件。站点验证和会话有效期受网络、网站及 VS Code 存储策略影响；本次成功不表示免验证保证。代码外观与快捷隐藏也不是操作系统级防观察机制。
