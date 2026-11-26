# Routilet 第一轮整体发行候选

基于 main 30bac0b，整合 Observer 88c4676、Launcher b97e635，保留旧发行安装和历史资源兼容。正式 npm scope @routilet，C Exam Kit 包名无 -preset 后缀。保留旧稳定入口，待兼容 Companion next 发行后切换。

Observer 已快进到 Windows GDB 后端并接入正式 CLI；后续验证 Windows 原生分发、真实回放与 Session 后端选择。Compiler/Debugger 只用用户指定路径或 PATH（macOS 保留 xcrun），不扫描 IDE、不自动安装、不改 PATH，不附离线工具链下载链接。

当前候选尚未声明 Observer 可选 npm 依赖，等实际新版本发布再精确绑定。npm 11 缺失可选依赖导致 npm ci EUSAGE 待修复；旧版正常启动不受影响。当前不发布、不修改 main。发布前完整 CI、真实 npm 安装、实机审核和 HTML 审核。
