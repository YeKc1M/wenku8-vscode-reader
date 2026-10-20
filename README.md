# Wenku8 · Code Reader

在 VS Code 主编辑区阅读文库吧轻小说。标签页名为 `workspace.ts`，正文呈现为带行号的 TypeScript 字符串数组，默认收起目录、隐藏插图。背景、文字、输入框和目录跟随 VS Code 的 light / dark / 高对比度主题。

## 安装与使用

需要桌面版 **VS Code 1.142.0 或更新版本**。

1. 在扩展面板的 `…` 菜单选择 **从 VSIX 安装**，选中 `wenku8-vscode-reader-0.2.0.vsix`。
2. 执行 **Wenku8: 打开阅读器**，输入书籍 ID（例如 `1`），或 `https://www.wenku8.net/book/1.htm`。也支持目录 / 章节链接。
3. 点击阅读器中的 **登录账号**，输入账号 / 邮箱和密码。也可执行 **Wenku8: 登录账号**。搜索书名需要登录。
4. 如果网站要求安全验证，点击 **在 VS Code 内完成验证**。在 VS Code 打开的文库吧页签中完成验证，再回到阅读器点击 **验证完成，继续**，根据提示重新输入账号密码。需要额外验证码时，也可以在网站页签中正常登录，再返回继续。

不需要安装、启动或连接外部 Chrome。验证页签使用 VS Code 内置浏览器；请保持内置 **JavaScript Debugger** 扩展启用。网站仍可能拒绝当前网络或浏览器环境；插件会显示验证提示，不会自动解验证码或反复提交密码。

也可以安装打包文件：

```sh
code --install-extension ./wenku8-vscode-reader-0.2.0.vsix
```

## 会话与退出登录

- 密码仅用于当次提交，不写入扩展设置、书架、Webview 持久状态或重试记录。提交后密码输入框会清空。
- 扩展直接请求时，Cookie 保存在 VS Code SecretStorage 中；登录表单选择网站提供的一个月会话有效期。会话失效后需要重新登录。
- 网站验证后，后续请求继续使用同一 VS Code 内置浏览器会话。该浏览器的 Cookie 保存方式由 `workbench.browser.dataStorage` 控制；若你设置为 `ephemeral`，关闭页签或重启后可能需要重新验证 / 登录。插件不会修改这个全局设置。
- 点击 **退出登录**、登录窗口中的 **清除登录会话**，或执行 **Wenku8: 退出登录**，可清除扩展保存的会话和本站浏览器 Cookie。书架与阅读进度保留。
- 清除内置浏览器会话失败时会提示重试，并阻止继续使用残留会话；下次启动也会重试清理。

网站会话是否持续有效由网站决定。恢复时会检查受保护页面，不会仅凭本地有 Cookie 就显示已登录。

## 阅读功能

- 本地书架、分卷目录、上一章 / 下一章、按书名搜索。
- 自动保存每本书最近章节及章节内滚动比例。重启后从书架继续阅读。
- 点击 **隐藏** 或按 `Esc`，立即移除页面正文，显示普通工具函数；点击 **继续** 恢复。
- `Alt+←` / `Alt+→` 切换章节；`Ctrl+Alt+H` 隐藏正文（macOS 为 `Cmd+Alt+H`）。
- `wenku8.fontSize`、`wenku8.lineHeight` 调整排版；`wenku8.showImages` 显示章节插图。
- 章节与目录仅做内存缓存，不提供整本批量下载或离线阅读。

## 从 0.1 升级

原有书架与阅读进度保留。`wenku8.transport`、`wenku8.browserPort` 和连接 Chrome 命令已移除，旧配置不再生效。旧 Chrome 独立目录不会导入新会话，也不会被插件删除，需要在阅读器内重新登录。插件不再启动外部浏览器。

## 开发与验证

```sh
npm ci
npm test
npm run package
```

按 `F5` 启动 Extension Development Host，在新窗口执行打开阅读器命令。

`test/extensionHost.cjs` 可由 VS Code 的 `--extensionDevelopmentPath` / `--extensionTestsPath` 参数运行，验证激活、命令注册和面板生命周期。`node scripts/preview.cjs` 在 `http://127.0.0.1:4178` 提供使用虚构文字及模拟登录的界面环境，不连接网站；模拟密码 `wrong` 会显示登录失败，其他非空密码模拟成功。请勿在预览环境使用真实凭据。

实现与网站检查记录见 `docs/site-analysis.md`。已验证真实内置浏览器的验证页、登录表单和匿名目录 / 正文读取；有效账号登录及登录后搜索尚未实测。浏览器传输依赖当前 VS Code 内置调试器的 CDP 代理接口；未来 VS Code 变更可能需要适配。仅验证本机 macOS 桌面环境，不支持 vscode.dev，Remote SSH / WSL / 容器环境尚未验证。
