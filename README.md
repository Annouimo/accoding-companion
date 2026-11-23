# Accoding Companion

独立的、**非官方** Accoding 命令行／终端编程助手。用于导入课程比赛、管理 C99/C++17 源码、本地评测及提交到 OJ。此项目与 Accoding、北航没有官方隶属关系。

> **开发预览版。** 两个包已发布到 npm 的 `next` 预览通道，但仍未完成 Mac/Windows 全面实机验收；暂无 `latest` 稳定版。源码中的 `private: true` 仅用于阻止误发布，手动 GitHub Actions 预览发布会在打包时移除该标记。请勿将预览版视为考试或课程官方工具。

## 产品设计

- **一个课程工作区，多场比赛。** 初次配置工作区时指定 C99 或 C++17，比赛创建在该目录的独立子文件夹；用户自己的文件夹保持不变。
- **题目可见文件精简。** 每道题默认生成 `main.c`（或 `main.cpp`）、`题目.md`，C99 另外生成小型 `exam.h` 入口。
- **内部数据隐藏。** 工作区根目录 `.accoding/` 保存题目与样例元数据、脚手架快照、不可变提交源码及提交历史。已有的普通文件不会被程序接管。
- **本地测试与 OJ 使用同一份代码。** C99 在测试前按需展开脚手架，生成内容哈希标识的源码快照；测试通过后确认提交时复用该快照。
- **全屏 Ink TUI + 独立 CLI。** 默认恢复上次停留的位置，Esc 返回上一层，Tab 可通过课程／作业／题目的面包屑跳转；窗口较小时可以使用经典菜单，编辑器通过 `test`、`submit` 调用 CLI。
- **安装器是唯一联网版本检查入口。** TUI 不自动查软件或脚手架更新；只能将本机已经下载的 C Exam Kit 版本按范围应用到题目。

## 本地开发与预览

需要 Node.js 22.12+、npm、C 编译器（GCC 或 Clang）。首版正式发行计划以已验证的 Node LTS 为准，**无需 Bun**。

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

从命令行初始化一个新的 C99 课程目录：

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

## npm 预览版安装

两个包可以通过 npm 全局安装：

```sh
npm install -g @annouimo/accoding-companion@next @annouimo/c-exam-kit-preset@next
accoding --version
```

Companion 通过 `npm root --global` 找到 C Exam Kit。启用某个版本时，组件会复制到课程工作区。全局更新后，旧题仍可使用工作区已有的副本。

从旧安装方式升级时，可以用 npm 单独清理旧安装目录。以下是 macOS 上卸载旧 `0.6.4-next.0` 的示例：

```sh
npm uninstall --prefix "$HOME/Library/Application Support/Accoding Companion/presets/0.6.4-next.0" \
  --no-save --ignore-scripts @annouimo/c-exam-kit-preset
```

进入 Accoding Companion 的「设置 → 课程工作区」创建 C99 课程；全新课程默认选择本机已安装的最新数据包。已有课程可在「设置 → 脚手架版本」中选择默认版本。C++17 不需要这个 C99 数据包。

预备中的 [install.sh](install.sh)（macOS/Linux）和 [install.ps1](install.ps1)（Windows）在用户主动运行时：

1. 检测 Node.js/npm，缺失时征求同意并提供官方安装途径；
2. 查询 npm 上主程序和 C Exam Kit 数据包的可用版本；
3. 选择一起更新，或使用 `--software-only`、`--preset-only`；
4. 全局安装 CLI 和 preset，保留已有课程数据和题目快照。

主程序包：`@annouimo/accoding-companion`；C99 数据包：`@annouimo/c-exam-kit-preset`。两个包目前均有公开的 `next` 预览版；没有 `latest` 稳定版。安装器仍需后续单独验收与修复。

脚手架下载后可以在 TUI 中设为课程默认版本，并选择更新 **所有空题目／所有未 AC 题目／所有题目／自选题目**。每题可以单独撤销。切换版本只修改 `main.c` 里的脚手架引用。

## 数据迁移与安全

旧项目的工作区不自动迁移。可以手动尝试**只复制、不删除源目录**的迁移命令：

```sh
node dist/accoding.mjs workspace migrate "/path/to/old" \
  --root "/path/to/new-course" --workspace-lang c
```

迁移前仍建议备份。当前该功能覆盖绑定、源码、样例和题目笔记，提交历史和账号状态需要进一步核实；遇到冲突会报告跳过，不会清除旧文件。详见 [工作区说明](docs/architecture.md)。

运行用户代码并不构成安全沙箱；程序使用当前用户权限编译、运行本地源码。运行和材料使用是否被课程考试规则允许，需要另行确认。登录凭据应存储在操作系统安全设施而不是课程目录中。详见 [发行与验收清单](docs/release.md)。

本项目从 [better-accoding-for-buaaers](https://github.com/Annouimo/better-accoding-for-buaaers) 的独立 CLI 分支整理而来，旧 VS Code 扩展仓库保留。迁移代码及第三方依赖许可见 [LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
