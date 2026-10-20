# Wenku8 · Code Reader

在 VS Code 主编辑区阅读文库吧轻小说。标签页名为 `workspace.ts`，正文呈现为带行号的 TypeScript 字符串数组，默认收起目录、隐藏插图。背景、文字、输入框和目录使用 VS Code 主题变量，随 light / dark / 高对比度主题即时变化。

## 安装与使用

1. 在 VS Code 扩展面板的 `…` 菜单选择 **从 VSIX 安装**，选中本项目生成的 `wenku8-vscode-reader-0.1.0.vsix`。
2. 打开命令面板，执行 **Wenku8: 打开阅读器**。
3. 输入书籍 ID（例如 `1`），或链接 `https://www.wenku8.net/book/1.htm`。也支持目录 / 章节链接，打开后恢复该书已保存的阅读位置。
4. 遇到登录或安全验证提示时，点击 **连接 Chrome**，在弹出的 Chrome 中完成验证 / 登录，返回阅读器点击 **重试**。搜索书名需要网站登录。

也可以运行：

```sh
code --install-extension ./wenku8-vscode-reader-0.1.0.vsix
```

## 阅读功能

- 本地书架、分卷目录、上一章 / 下一章、按书名搜索。
- 自动保存每本书最近章节及章节内滚动比例。重启后从书架继续阅读。
- 点击 **隐藏** 或按 `Esc`，立即移除当前页面中的正文，显示一段普通工具函数；点击 **继续** 恢复原位置。
- `Alt+←` / `Alt+→` 切换章节；`Ctrl+Alt+H` 隐藏正文（macOS 为 `Cmd+Alt+H`）。
- `wenku8.fontSize`、`wenku8.lineHeight` 调整阅读排版；`wenku8.showImages` 显示章节插图。
- 章节与目录仅做内存缓存，不提供整本批量下载或离线阅读。

## 网络与 Chrome

网站采用 GBK HTML 页面。公开目录和正文可以匿名访问，但是否触发安全验证取决于网站及网络环境；首页、排行榜和搜索在本次检查中跳转到登录页。

`wenku8.transport` 有三个选项：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 直接请求；执行连接 Chrome 后，后续请求使用浏览器会话 |
| `direct` | 始终由扩展直接请求网站 |
| `browser` | 始终连接本机 Chrome |

**连接 Chrome** 会启动一个使用独立用户目录的 Chrome（也支持常见安装路径的 Edge），通过本机 `127.0.0.1:9222` 的 Chrome DevTools Protocol 读取文库吧页面。独立目录不会继承你平时 Chrome 的登录状态，首次使用需要自行登录。扩展不会自动处理验证码，也不保存账号密码；登录状态由独立 Chrome 用户目录保存。书架及阅读进度存储在 VS Code 扩展全局状态中。

可通过 `wenku8.browserPort` 更换端口；已有该端口的 Chrome 时复用其文库吧标签页。自动启动支持 macOS、Windows 的常见 Chrome / Edge 路径和 Linux 常见 Chrome / Chromium 路径；其他安装位置可以手动启动：

```sh
# 用你的 Chrome 可执行文件替换 google-chrome；用户目录必须是独立目录。
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir=/path/to/wenku8-profile https://www.wenku8.net/book/1.htm
```

扩展关闭后不会退出浏览器，便于保留登录状态；可自行关闭窗口。浏览器模式面向本机桌面 VS Code，尚未验证 Remote SSH / WSL / 容器环境，不支持 vscode.dev。若设为 `direct`，连接浏览器不会覆盖你的设置，需要手动切换到 `auto` 或 `browser`。

## 开发与验证

```sh
npm ci
npm test
npm run package
```

按 `F5` 启动 Extension Development Host，在新窗口执行打开阅读器命令。

`test/extensionHost.cjs` 可由 VS Code 的 `--extensionDevelopmentPath` / `--extensionTestsPath` 参数运行，验证激活、命令注册和面板生命周期。`node scripts/preview.cjs` 在 `http://127.0.0.1:4178` 提供使用虚构文字的界面测试环境；它不连接网站。

实现与逆向记录见仓库中的 `docs/site-analysis.md`。网站变更或内容下架可能导致读取失败，错误提示会保留重试及浏览器连接入口。登录后的搜索结果页尚未进行账号实测。
