# Accoding Companion 发布与验收

主程序和 C Exam Kit 资源包独立维护、独立发布。日常提交与 PR 验证不发布 npm 或 GitHub Release；正式发布通过人工触发 GitHub Actions 完成。源码中的 `private: true` 保留为防误发布措施，发布工作流只修改 runner 中的临时副本。

## 发行物

- `@annouimo/accoding-companion`：Node.js 22.12+ 的单文件 CLI，构建期依赖打入 JS 文件。
- `@annouimo/c-exam-kit-preset`：独立仓库维护的纯数据包。0.6.7 起使用内联组件的 `preset/manifest.json` 和 `preset/reference.json`；旧工作区的 v1 资源与 Markdown 手册仍受支持。
- GitHub Release：Windows x64/ARM64、macOS x64/ARM64 原生启动器 ZIP，随包附离线 HTML 使用说明和独立编译环境配置指引。启动器只负责 Node.js 和两个 npm 软件包，不安装或检查编译器。

主程序和资源包分别维护版本号。仅更新函数时不必提升 Companion 版本，但改变资源格式时必须先发布兼容的 Companion。用户从启动器检查更新；TUI 不自动修改课程资源。

## 发布前验收

- CLI：`npm run typecheck`、`npm test`、`npm run build`、真实 TTY smoke test。
- 启动器：macOS、Windows、Linux 上的 Go 测试与 launcher smoke test。Node.js 安装覆盖中文目录。单独使用外部 GCC 验证含中文和空格的工作区中 C/C++ 编译、链接、运行，以及缺少编译器时的提示；不要求启动器下载 GCC。
- ZIP：四个平台/架构均成功构建，包含对应原生启动器、版本匹配的 HTML、独立编译环境配置指引和图片、许可文件。
- 诊断与测试详情：验证成功编译的警告、原始源码行号（包括多行注释）、字符级差异高亮、长行滚动、视图切换、stderr 与输出比较分离；警告不阻止提交，诊断源码不得上传。
- 工作区：测试和 OJ 提交复用同一份精简后的源码；已改动或无法判断状态的题目不自动升级。旧数据迁移只复制，冲突不覆盖。
- 实机：macOS Apple Silicon、Windows 11、中文终端、首次安装、重复运行、独立升级、断网启动、卸载、真实 Accoding 登录与提交。自动化测试不能代替账号实测。
- 安全：凭据、目录符号链接、外部路径、写事务、中断恢复；诊断日志及发行包不含账号、密码或 Cookie。

## 正式发布顺序

涉及新资源格式时，以 0.2.6 / 0.6.9 为例：

1. 确认目标提交已合入 main，所有必要回归测试通过。HTML 定稿必须经过用户认可。
2. 在 Companion 的 [Publish npm stable release](https://github.com/Annouimo/accoding-companion/actions/workflows/publish-npm.yml) 工作流选择 main、`PUBLISH_LATEST`、`expected_version=0.2.6`。如只检查构建则使用 `DRY_RUN`。
3. 验证 `npm view @annouimo/accoding-companion@latest version` 已返回 0.2.6。
4. 在 C Exam Kit 的 [Publish npm stable release](https://github.com/Annouimo/c-exam-kit/actions/workflows/publish-npm.yml) 工作流选择 main、`PUBLISH_LATEST`、`expected_version=0.6.9`。
5. 验证 `npm view @annouimo/c-exam-kit-preset@latest version` 已返回 0.6.9。npm 的版本验证未完成时不要抢先发布启动器。
6. 回到 Companion 发布工作流选择 main、`PUBLISH_LAUNCHERS`、`expected_version=0.2.6`、`expected_preset_version=0.6.9`。工作流将核对两个 npm latest 版本后创建 GitHub Release 并上传四个 ZIP。
7. 检查下载入口与版本号，解压后做实际首次安装和启动验收。

仅更新资源内容且不改变格式时，可单独发布资源包。已有原生启动器可直接更新两个 npm 包；ZIP 内的使用说明是独立文件，需重新下载新版 ZIP 才会同步更新。不要为失败的构建或未发布的修复增加版本号；如果版本已经发布到 npm，则不能覆盖该版本。

正式 npm 发布使用 Trusted Publishing/OIDC；不在源码或工作流中保存长期 npm 令牌。
