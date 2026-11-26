# Accoding Companion

独立的、**非官方** Accoding 命令行／终端编程助手。用于导入课程比赛、管理 C / C++ 源码、本地评测及提交到 OJ。此项目与 Accoding、北航没有官方隶属关系。

所属组织：[Routilet](https://github.com/Routilet) · 原始设计者：Annouimo。

相关项目：[C Exam Kit](https://github.com/Routilet/c-exam-kit) 提供版本化函数资源；[C Observer](https://github.com/Routilet/c-observer) 正在开发独立运行观察功能，尚未集成。

> 正式发行包见 [GitHub Releases](https://github.com/Routilet/accoding-companion/releases/latest)。

## 产品设计

- **一个课程工作区，多场比赛。** 初次配置工作区时选择 C 或 C++，比赛创建在该目录的独立子文件夹；用户自己的文件夹保持不变。
- **题目可见文件精简。** 每道题默认生成 `main.c`（或 `main.cpp`）、`题目.md`，C 题目的资源头文件存放在课程的 `.accoding/presets/` 中。
- **内部数据隐藏。** 工作区根目录 `.accoding/` 保存题目与样例元数据、脚手架快照、不可变提交源码及提交历史。已有的普通文件不会被程序接管。
- **本地测试与 OJ 使用同一份代码。** C99 在测试前按需展开脚手架，生成内容哈希标识的源码快照；测试通过后确认提交时复用该快照。
- **全屏 Ink TUI + 独立 CLI。** 默认恢复上次停留的位置，菜单可首尾循环，Esc 返回上一层，H 定位当前题目或课程所用版本的内置函数速查。样例失败后会跳到首处差异，仅高亮不同字符。测试详情中 `Tab` / `Shift+Tab` 切换样例对比、编译诊断和运行日志，`[` / `]` 切换样例或诊断，方向键滚动，`N` / `P` 跳转差异；编译警告不阻止提交。窗口较小时可以使用经典菜单，编辑器通过 `test`、`submit` 调用 CLI。
- **安装器是唯一联网版本检查入口。** TUI 不自动查软件或脚手架更新；只能将本机已经下载的 C Exam Kit 版本按范围应用到题目。

## 本地开发与预览

需要 Node.js 22.12+、npm、C 编译器（GCC 或 Clang）。原生启动器会按需安装受管理的 Node.js，开发环境和直接 npm 安装**无需 Bun**。

```sh
npm install
npm run typecheck
npm test
npm run build
node tests/standalone/pty-smoke.mjs dist/accoding.mjs  # Linux 伪终端回归测试
node dist/accoding.mjs --help
node dist/accoding.mjs --version
node dist/accoding.mjs
```

要模拟发行包，可以运行 `npm pack --dry-run`；由于脚本包含发布前打包，不会自动发布到 npm。

从命令行初始化一个新的 C 课程目录：

```sh
node dist/accoding.mjs login
node dist/accoding.mjs contest init <比赛ID或链接> --root "/path/to/C语言课程" --workspace-lang c
```

之后再导入其他比赛只需 `contest init ID`，默认沿用最近工作区。首次以 TUI 交互初始化时会提示选择工作区目录和语言。

编辑器的典型命令：

```sh
node dist/accoding.mjs test "/path/to/C语言课程/某次作业/A-题目/main.c"
node dist/accoding.mjs submit "/path/to/C语言课程/某次作业/A-题目/main.c"
node dist/accoding.mjs status --watch
```

## 安装和启动

从 [最新发布页](https://github.com/Routilet/accoding-companion/releases/latest) 下载对应平台的启动包并完整解压。Windows 双击 `Accoding Launcher.exe`，macOS 双击 `Accoding Launcher.command`。首次先选「安装」，完成后选「启动」。使用说明 HTML 随包提供，首次启动时打开。Linux 可使用下面的 npm 命令。

函数手册随 C Exam Kit preset 0.6.6 起提供。按 H 在 Companion 中打开对应版本的函数速查。新版速查按操作分类浏览；`/` 搜索函数名或中文用途，Tab / Shift+Tab 切换类型，C 复制当前完整示例，R 跳转相关条目，U 查看使用约定，G 返回首页，H 关闭并保留阅读位置。旧版资源仍可阅读，但不一定提供全部结构化字段。新版资源只分发程序内速查数据，旧工作区可以继续阅读已保存的 Markdown 手册。

启动器检查 Node.js、主程序和 C Exam Kit。首次安装完成后返回启动菜单，按 Enter 即可启动。已安装时可直接选择「启动」；有更新时会显示对应的软件与资源版本。断网时仍可启动本机已安装的 Companion。

也可以直接通过 npm 安装并启动：

```sh
npm install -g @routilet/accoding-companion @routilet/c-exam-kit-preset
accoding
```

启动器使用独立的安装目录。直接用 npm 安装时，Companion 仍可从全局 npm 路径读取 preset。启用某个版本时，组件会复制到课程工作区。C++ 课程可直接测试和提交。启动器不安装或检测编译器。本地评测使用系统 PATH 中的 GCC / Clang，或在「设置 → 设置 C / C++ 编译器」中指定已有编译器。找不到编译器时，交互界面会自动打开随包提供的独立《编译环境配置》指引。

资源升级后使用「设置 → 更新课程资源」，或从启动器确认更新当前课程。批量更新适用于源码仍与初始模板一致的题。也可以自选题目，单题切换前会试编译，并记录可撤销的旧版本。

## npm 命名空间迁移

新版使用 `@routilet/accoding-companion` 和 `@routilet/c-exam-kit-preset`。原 `@annouimo` 包保留历史版本；旧启动器不会自动发现新命名空间，请从最新 Release 重新下载启动器。新原生启动器可离线启动已有旧安装，并在两个新包均可用时提示迁移；课程目录、登录凭据、资源快照不变。直接通过全局 npm 安装的用户，请在新包可用后先运行 `npm uninstall -g @annouimo/accoding-companion`（仅移除旧 CLI，避免同名命令冲突），再执行上面的新包安装命令；旧资源包可保留。不要在新发行包可用之前移除旧程序。

## 数据迁移与安全

旧项目的工作区不自动迁移。可以手动尝试**只复制、不删除源目录**的迁移命令：

```sh
node dist/accoding.mjs workspace migrate "/path/to/old" \
  --root "/path/to/new-course" --workspace-lang c
```

迁移前仍建议备份。当前该功能覆盖绑定、源码、样例和题目笔记，提交历史和账号状态需要进一步核实；遇到冲突会报告跳过，不会清除旧文件。详见 [工作区说明](docs/architecture.md)。

运行用户代码并不构成安全沙箱；程序使用当前用户权限编译、运行本地源码。运行和材料使用是否被课程考试规则允许，需要另行确认。登录凭据应存储在操作系统安全设施而不是课程目录中。详见 [发行与验收清单](docs/release.md)。

本项目从 [better-accoding-for-buaaers](https://github.com/Annouimo/better-accoding-for-buaaers) 的独立 CLI 分支整理而来，旧 VS Code 扩展仓库保留。迁移代码及第三方依赖许可见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
