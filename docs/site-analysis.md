# 文库吧前端检查记录

检查日期：2026-10-20。使用用户指定的 MCP `chrome-devtools`，打开页面、执行 DOM 查询、检查 document 网络请求并使用同源 fetch 读取目录。没有使用第三方小说 API。

| 页面 | 观察到的地址与结构 |
| --- | --- |
| 首页 | `https://www.wenku8.net/index.php`，匿名访问重定向到 `login.php?jumpurl=...`，先出现 Cloudflare 验证，再显示登录表单 |
| 书籍详情 | `/book/1.htm`，GBK，`#content` 内首个表格的 `b` 为书名，单元格包含 `小说作者：` |
| 分卷目录 | `/novel/0/1/index.htm`，GBK，`#title` 为书名，`.vcss` 为卷名，`.ccss a` 为按文档顺序排列的章节链接 |
| 正文 | `/novel/0/1/2.htm`，document 请求 HTTP 200，GBK；`#title` 为标题，`#content` 为正文，段落由 `br` 分隔 |
| 正文附加元素 | `#contentdp` 是来源 / 页尾提示；需移除脚本、样式、iframe 等；插图可单独提取 |
| 翻页 | 正文链接中“上一页 / 下一页”为相对 `.htm` 地址，边界链接回到 `index.htm`；实现用已解析的目录顺序定位相邻章节，避免将目录当正文 |
| 搜索 | 详情页搜索表单 `POST /so.php`，字段 `searchtype=articlename`、GBK 的 `searchkey`、`charset=gbk`；实测 GET 同字段会重定向至 `/modules/article/search.php?...`，随后要求登录 |
| 更新榜 | `/modules/article/toplist.php?sort=lastupdate&page=1` 实测要求登录，不将它作为阅读入口依赖 |

目录地址的第一段是书籍 ID 的千位分组，例如 ID 1234 对应 `/novel/1/1234/index.htm`。实测示例 ID 1《文学少女》有 18 个分卷、213 个章节链接。

直接使用 HTTP 客户端请求正文在当前网络下返回 403，而实际浏览器可访问公开详情、目录和正文。因此实现两种网络传输：Node HTTP 与本机浏览器 CDP。浏览器传输在文库吧标签页中执行带会话的同源 fetch，用 TextDecoder 解码原始字节；账号登录与安全验证交由用户在浏览器中正常完成。

扩展只向 Webview 传送结构化数据，用 textContent 创建 DOM，不注入网站 HTML 或执行网站脚本。网络地址限于本站阅读 / 搜索 / 登录路径，图片限于文库吧图片域名；Webview 使用 CSP 并限制本地资源为 media 目录。

验证包括 GBK / UTF-8 解码、分卷顺序、相对链接、脚本剔除、图片域名、登录 / 验证提示、重定向域名限制、缓存、CDP 协议交互，以及真实 VS Code Extension Host 激活和面板生命周期。浏览器界面检查涵盖 light / dark 变量、目录、翻章、隐藏后正文 DOM 移除及滚动比例恢复。

未验证：登录后的搜索结果布局、所有书籍变体、远程扩展环境。搜索结果解析支持主内容区域的 `/book/{id}.htm` 链接，以及单结果直接重定向书籍详情的情况。

API 依据：[VS Code Webview 指南](https://code.visualstudio.com/api/extension-guides/webview)，涵盖 createWebviewPanel、asWebviewUri、CSP 与 VS Code 主题 CSS 变量。实现前通过 find-docs / Context7 核对。
