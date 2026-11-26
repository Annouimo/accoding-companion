# Launcher v2：统一应用安装与更新

维护者确认：用户只有一个 Accoding 更新入口，更新确认页展示组件变化。开发者仍独立发布各 npm 包。仓库使用 Routilet/accoding-companion、Routilet/c-observer、Routilet/c-exam-kit；现有 @annouimo/* npm 包名保持不变。组织迁移后另行核验发行元数据及 Trusted Publisher。

## 阶段一：安装内核

- tests/standalone/npm-dependency-probe.mjs：回环 HTTP registry，测试作用域假包，不向真实 registry 发布。验证精确根版本、间接依赖兼容更新、精确预览依赖、缺失可选依赖、禁用安装脚本、候选锁文件和 npm ci。
- launcher/internal/managed：独立安装内核。仅声明 Companion 根依赖。候选锁文件生成、版本差异（包括 npm 路径；可选项不是安装保证）、锁文件 SHA-256、npm ci、CLI 校验、激活记录一次替换、写锁、过期候选拒绝、回退。稳定版和预览版隔离，保留历史安装，直到运行租约及安全清理实现。
- 使用现有 Node 运行时，不配置 PATH，不安装编译器。机器命令有超时，禁用 npm 生命周期脚本。

安装目录：旧 packages/current 暂不改变。v2/channels/{latest,next}/activation.json 保存 current/previous；releases/release-*/ 保存 package.json、package-lock.json、installation.json、node_modules；write.lock 用于并发写操作。

## 接口

accoding --installation-info 在构造业务对象之前执行，无网络、无登录、无 TUI。schemaVersion=1、version、ready、components(name/package/version/required/status)。必要依赖缺失应失败，可选依赖不可用不阻断。必须使用与实际程序一致的 npm 模块解析。没有新接口的旧 Companion 保留旧安装启动路径，不认作新版受管理安装。

## 计划

1. 迁入已验证的本地安装内核，真实 npm/三平台 CI 复测。
2. Companion 安装信息、配置隔离；与 Observer 集成协调。
3. 新版启动器入口、统一候选确认、渠道切换、迁移及离线启动、回退。
4. 运行租约、安全清理、故障及 Windows 文件替换验证。
5. HTML 定稿审核、预览发行、实机及断网验收。Observer Windows/GDB 暂缓，启动器 Windows 支持保留。

本地原型已验证 Node 22.16.0/npm 10.9.2、Go 1.23.2 Linux amd64；Windows amd64、Darwin arm64 交叉编译。提交后的 CI 需独立确认，不等于实机验收。阶段一不改变现有入口、正式版本或发行工作流。
