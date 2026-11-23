# Accoding Companion 发布与验收

当前处于开发预览阶段。**未授权公开 npm 发布。** 主程序与 C Exam Kit npm 数据包中的 `private:true` 是防误发布保险。任何切换为可发布状态必须经过用户最终验收。

## 发行物

- `@annouimo/accoding-companion`：Node.js 22.12+ 的单文件 `dist/accoding.mjs`，以及 README、许可、安装引导；**不安装 TypeScript、Ink、React 等构建期包**，构建时已全部打入 JS 文件。
- `@annouimo/c-exam-kit-preset`：纯数据 `preset/manifest.json` 和 `preset/components/`，无安装时执行脚本；在独立 `Annouimo/c-exam-kit` 仓库维护。
- `install.sh` 与 `install.ps1`：公开、可检查的脚本，负责检测 Node/npm，主动查询 npm 版本并选择更新全部或其中一项。用户不必装 Bun。
- GitHub Release：版本说明、安装脚本和可选备份下载。不发布多平台二进制作为常规发行渠道。

主程序和模板都分别使用 `next` 预览、`latest` 稳定发行标签。程序平时不检查新版本；只有用户再次运行安装器才检查更新。

## 开发与测试要求

- 普通提交：本地 typecheck / regression，不运行全平台矩阵。
- 合并前：Node.js 22/24/26 的 CLI 检查、基础业务回归、至少一次真实 TTY 交互验证。
- 发布前：macOS Apple Silicon 与 Windows 11 双平台人工验收；Windows 家庭版、PowerShell、终端中文、GCC/Dev-C++、macOS Terminal/Ghostty。
- 安全：Keychain/DPAPI 凭据、目录符号链接、外部路径、写事务、中断恢复、脚手架升级回退。
- 回归：未 AC、AC、空题、自选批量升级；源文件、`题目.md` 不被覆盖；旧数据迁移冲突不删除原文件；网络超时和 OJ 提交状态不确定时不重复 POST。
- npm 发行前：通过 `npm pack --dry-run` 检查仅有必要文件，并在全新系统的临时目录中用本地 `.tgz` 安装、运行测试；检查包的 `bin`、shebang、文件权限和版本号。
- 安装器验收：初次安装、Node 缺失、无权限、离线、包名冲突、重复运行、软件单独升级、脚手架单独下载。
- 隐私：不得向诊断日志、CI 记录或发行包输出账号密码、会话 Cookie。

## 正式发布步骤（验收后）

1. 测试通过并由用户确认目标版本、更新日志与 npm 包名。
2. 对 C Exam Kit 的 npm 数据目录生成版本包，确认组件完整、许可齐全，发布至 `next` 或 `latest`。
3. 在 Accoding Companion 中以该数据包验证安装器与现有工作区；构建主程序，检查最终 npm 包内容。
4. 发布 CLI 到对应发行标签，验证命令 `accoding --version`、`accoding --help` 和本地测试。
5. 手动创建 GitHub Release，链接已发布的版本与对应安装脚本。
6. 不自动修改旧课程文件夹，不自动批量升级题目脚手架。

推荐在配置 npm Trusted Publishing 后进行手动触发的 GitHub Actions 发布，以减少长期 npm 发布令牌。不得把公开正式发行与日常 push 绑定。

## 当前开发限制

- 安装器依赖两个**尚未公开发布**的 npm 包；直接执行会查询失败，不代表 Node 安装异常。
- 真实 Accoding 账号提交链路在旧独立 CLI 曾由用户实测；迁至新仓库后的全屏 TUI 尚需账号实机验收。
- 迁移目前是显式的只复制导入，尚需全面验证历史账号状态和旧提交记录。
- `private:true` 移除与 `latest` 发布必须在验收后执行。
