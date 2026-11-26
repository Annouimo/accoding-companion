# Accoding Companion 发布与验收

## 本轮正式发行

维护者确认先发行正式版，再使用正常 npm 安装流程开展体验微调。采用版本驱动的 main 自动发布，保留人工重试、Trusted Publishing/OIDC 和发布前阻断性回归测试，PR 不发布。源码保留 private:true；工作流仅在 runner 临时副本移除。

| 组件 | 版本 | 分发 |
|---|---|---|
| C Exam Kit | 0.6.10（已有，不重发） | @routilet/c-exam-kit |
| C Observer | 0.1.0 | @routilet/c-observer |
| Accoding Companion | 0.2.8 | @routilet/accoding-companion |
| Accoding Launcher v2 | 0.3.0 | GitHub Release 的四平台 ZIP |

Companion 通过 ^0.6.10 和可选 ^0.1.0 声明资源包、观察器的兼容范围；后续兼容补丁由统一更新解析，确认实际版本与锁文件差异后启用。C Observer 缺失或平台不支持时不影响普通评测。Node.js 22.12+；不自动安装编译器、调试器或修改 PATH。

## 版本驱动发布

- Companion 使用根目录 package.json 的 version；Launcher 使用 launcher/VERSION，独立维护。需要发版时修改对应版本号并合入 main，版本文件及发行配置变更触发工作流。
- 工作流先查询 npm 已发行版本及 GitHub Releases；已发行版本跳过，不覆盖或降级。查询失败则停止。普通代码或文档更新无需提升版本，也不重复发行。
- 先合入并发布需要的新 Observer / C Exam Kit 版本，确认 npm latest 已可安装。Companion 工作流核对实际稳定依赖版本满足 package.json 声明的兼容范围，并安装真实候选 tarball、校验组件。
- 需要发行 Companion 时先发布 npm latest。若 Launcher 也有新版本，等待 registry 可见，使用实际下载 Node/npm 和 Go v2 Manager 在 Linux、macOS、Windows 从公开 registry 安装并验证，才创建独立的 launcher-v<版本> GitHub Release，附四个 ZIP。历史 v<Companion 版本> 标签及产物保留不变。
- [发布工作流](https://github.com/Routilet/accoding-companion/actions/workflows/publish-npm.yml) 的手动 AUTO 用于补发或重试；DRY_RUN 仅构建；PUBLISH_LATEST 与 PUBLISH_LAUNCHERS 可单独重试相应组件。版本输入为可选断言，不代替版本文件。若依赖尚未发布，先发布依赖再重试 AUTO。
- 维护者下载正常发行物进行 Mac/Windows 首次安装、启动、课程评测、程序观察、断网启动及更新；CI 不代替实机审核。

已发布的版本不得覆盖。npm 权限失败由维护者检查 Trusted Publisher 设置：owner Routilet，repo accoding-companion，workflow publish-npm.yml，Environment 留空。无需长期 token。

## 验收边界

CLI 类型检查、单元测试、真实 TTY smoke；Go 启动器三平台测试、中文路径的 Node/npm 下载、真实 npm 本地 fixture registry 安装及旧 CLI 协议拒绝、更新与回退；发行 ZIP 的真实公开 registry 安装门槛；Windows 外部 GCC 回归；四平台构建及许可、HTML 检查。CI 不代替真实登录、提交或原生终端视觉审核。保护旧安装、工作区、历史资源、凭据；失败不得激活暂存版本。旧 scope 历史发行保留。

旧版启动器已安装软件可离线启动；v2 的新安装需要支持 --installation-info 的 Companion。0.2.7 不支持该接口，不能通过 v2 校验。不要删除旧安装或绕过校验。现有错误已补充具体命令及版本，运行环境有效性实际检查 npm --version。

历史发布流程与旧版本说明见 Git 历史及 docs/releases。
