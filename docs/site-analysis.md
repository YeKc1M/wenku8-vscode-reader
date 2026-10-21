# 文库吧登录与读取检查记录

检查日期：2026-10-20。目标：让阅读器直接接收账号密码，并在需要网站验证时使用 VS Code 内置浏览器，不依赖外部 Chrome。

## 实测协议

| 页面 / 流程 | 观察结果 |
| --- | --- |
| 登录页 | `https://www.wenku8.net/login.php`，GBK；可能先出现 Cloudflare 验证 |
| 登录表单 | `POST /login.php?do=submit`；字段为 `username`、`password`、`usecookie`、隐藏字段 `action=login` 和提交按钮 `submit` |
| 会话有效期 | `usecookie` 选项为 `0`、`86400`、`2592000`、`315360000`；插件选择 `2592000`，即一个月 |
| 表单陷阱 | 隐藏字段 `name="action"` 会覆盖 DOM 的 `form.action` 属性，须读 HTML attribute，而非该 DOM property |
| 受保护首页 | `/index.php` 用于确认会话；成功须识别本站 `/logout.php` 链接，不能仅凭 HTTP 200 或提交结果判定 |
| 搜索 | `/so.php?searchtype=articlename&searchkey={GBK编码}&charset=gbk`，随后可能重定向到 `/modules/article/search.php` 或书籍详情；匿名访问要求登录 |
| 书籍详情 | `/book/1.htm`，`#content table b` 为书名，单元格含 `小说作者：` |
| 分卷目录 | `/novel/0/1/index.htm`，`#title` 为书名，`.vcss` 为分卷，`.ccss a` 为章节 |
| 正文 | `/novel/0/1/2.htm`，`#title` 为标题，`#content` 内 `br` 分段；移除脚本、iframe 和 `#contentdp` 页尾提示 |

目录的第一段为书籍 ID 千位分组。真实目录 ID 1《文学少女》解析得到 213 个章节。

## 验证与传输

命令行直接请求登录页曾返回 Cloudflare 403。通过独立 VS Code 1.142.0 Extension Host 测试窗口，`editor-browser` 成功打开内置浏览器，经历网站安全检查后出现真实登录表单。已通过该会话中的同源 fetch 读取真实目录和正文；个别请求仍可能返回新的验证页，因此验证入口会导航到实际受阻的阅读 / 搜索地址（登录提交受阻时导航到登录页）。

标准 Webview iframe 无法承诺承载 Cloudflare 的整页验证：[Cloudflare 限制说明](https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/)。内置浏览器可作为独立编辑器页签显示，不需要外部 Chrome：[VS Code 内置浏览器文档](https://code.visualstudio.com/docs/debugtest/integrated-browser)。嵌入式浏览器仍可能被网站拒绝，不能保证所有网络都能通过。

扩展使用稳定的 `vscode.debug.startDebugging` API 启动自身的 `editor-browser` 调试会话，通过其页面子会话的 `requestCDPProxy` 获取本机临时代理，再用 Node 内置 WebSocket 连接。此调试器专用请求并非稳定 VS Code 公共 API，因此最低版本固定为本机验证过的 1.142.0；不启用 proposed API，也不修改 VS Code 用户设置。关闭时仅停止扩展自己创建的调试会话。

验证页通过 `Target.getTargetInfo` 中 VS Code 添加的 `vscodeBrowserViewId` 定位，再以对应的 `vscode-browser` URI 调用移动编辑器命令，放到独立窗口。目标标识也是内部接口，缺失时明确报错，不回退为移动当前代码编辑器。最小化窗口保留同一浏览器及 CDP 会话；再次验证时将同一浏览器放入可见的独立窗口，原空窗口关闭，以避开普通焦点命令不能可靠恢复最小化窗口的限制。关闭验证窗口时停止本站会话，退出登录或停用扩展时同时关闭所属网站标签。Linux / VS Code 1.142 的隔离桌面测试覆盖最小化、模拟登录确认、搜索、目录、正文、再次显示、关闭重开及退出清理；未使用真实账号。

浏览器请求通过本机 CDP 进行同源 fetch，保留 GBK / UTF-8 解码、超时、8 MiB 大小限制及 Cookie。请求拦截在发送之前检查扩展请求及其重定向地址，拒绝外站和未允许的路径。网站正常页面加载及用户验证交互不套用阅读器请求白名单。

## 凭据与会话

直接请求使用 CookieJar，按域名、路径、Secure 和过期属性管理 Cookie；每个重定向响应先更新 Cookie，302 / 303 后清除 POST body。每次跳转都先检查 HTTPS 地址白名单。

密码只用于当次 GBK 表单提交。登录消息不进入 Webview 重试动作或持久状态，UI 提交后清空密码；不会把密码放进调试控制台的 evaluate 请求，也不主动记录请求体。扩展不保存密码。

直接请求的 Cookie 与传输选择保存在 VS Code SecretStorage。内置浏览器会话由 VS Code 自身的 `workbench.browser.dataStorage` 管理，插件不改变该设置，也不读取用户外部 Chrome 的任何会话。退出时取消旧请求、清空扩展会话及本站 Cookie，避免迟到响应重新恢复登录；浏览器清理失败会保存待清理标记并阻止继续使用。

阅读器仅接收结构化数据，使用 textContent 创建 DOM，不执行网站 HTML 或脚本。保留 Webview CSP、阅读地址白名单及插图域名限制。

## 验证范围

- 单元测试：登录表单及隐藏字段、GBK 凭据与密码空格、Cookie 作用域和过期、重定向处理、200 假成功、验证页分类、会话恢复与失效、退出期间迟到响应、浏览器请求取消、跨域重定向拦截，以及原有目录 / 正文 / 搜索解析。
- 真实 Extension Host：扩展激活、新登录 / 退出命令注册、旧 Chrome 命令移除、面板生命周期。
- 真实内置浏览器界面（虚构账号及模拟服务器响应）：登录失败提示、登录成功状态、密码清空且不进入 UI 存储、验证返回流程、隐藏与恢复正文；已检查登录窗口截图。
- 真实网站：Cloudflare 后的登录表单、会话中的目录与正文请求。

尚未实测有效账号登录、登录后搜索布局、跨重启有效账号恢复、所有书籍变体和非 macOS 平台。自动化测试中的登录成功使用模拟响应，不能替代真实账号验收。
