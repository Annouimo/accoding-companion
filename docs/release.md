# Accoding Companion 发布与验收

## 本轮正式发行

维护者确认先发行正式版，再使用正常 npm 安装流程开展体验微调。保留人工触发、Trusted Publishing/OIDC、发布前阻断性回归测试，不为普通 PR 自动发布。源码保留 private:true；工作流仅在 runner 临时副本移除。

| 组件 | 版本 | 分发 |
|---|---|---|
| C Exam Kit | 0.6.10（已有，不重发） | @routilet/c-exam-kit |
| C Observer | 0.1.0 | @routilet/c-observer |
| Accoding Companion | 0.2.8 | @routilet/accoding-companion |
| Accoding Launcher v2 | 0.3.0 | GitHub Release 的四平台 ZIP |

Companion 通过 ^0.6.10 和可选 ^0.1.0 声明资源包、观察器的兼容范围；后续兼容补丁由统一更新解析，确认实际版本与锁文件差异后启用。C Observer 缺失或平台不支持时不影响普通评测。Node.js 22.12+；不自动安装编译器、调试器或修改 PATH。

## 顺序

1. 在 Observer 主分支人工触发 publish-npm.yml：PUBLISH_LATEST、version=0.1.0，确认 npm latest 已实际可安装。
2. 确认 Companion 发行候选 CI 通过，合入 main。人工触发 [Publish npm stable release](https://github.com/Routilet/accoding-companion/actions/workflows/publish-npm.yml)：PUBLISH_LATEST、expected_version=0.2.8、expected_observer_version=0.1.0。验证真实安装的 tarball、--installation-info 和 Observer 组件状态。
3. 确认 npm latest 为 0.2.8。再选择 PUBLISH_LAUNCHERS、expected_version=0.2.8、expected_preset_version=0.6.10、expected_observer_version=0.1.0。三平台使用实际下载的 Node/npm 及 Go v2 Manager 从公开 registry 安装并验证；全部成功后才创建 v0.2.8 Release 并附 Launcher 0.3.0 四平台 ZIP（Windows x64/ARM64、macOS x64/ARM64）。
4. 维护者下载正常发行物进行 Mac/Windows 首次安装、启动、课程评测、程序观察、断网启动及更新。确认没有阻断问题，再针对使用体验安排小版本更新。

已发布的版本不得覆盖。npm 权限失败由维护者检查 Trusted Publisher 设置：owner Routilet，repo accoding-companion，workflow publish-npm.yml，Environment 留空。无需长期 token。

## 验收边界

CLI 类型检查、单元测试、真实 TTY smoke；Go 启动器三平台测试、中文路径的 Node/npm 下载、真实 npm 本地 fixture registry 安装及旧 CLI 协议拒绝、更新与回退；发行 ZIP 的真实公开 registry 安装门槛；Windows 外部 GCC 回归；四平台构建及许可、HTML 检查。CI 不代替真实登录、提交或原生终端视觉审核。保护旧安装、工作区、历史资源、凭据；失败不得激活暂存版本。旧 scope 历史发行保留。

旧版启动器已安装软件可离线启动；v2 的新安装需要支持 --installation-info 的 Companion。0.2.7 不支持该接口，不能通过 v2 校验。不要删除旧安装或绕过校验。现有错误已补充具体命令及版本，运行环境有效性实际检查 npm --version。

历史发布流程与旧版本说明见 Git 历史及 docs/releases。
