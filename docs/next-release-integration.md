# Routilet 第一轮整体发行候选

基于 main 30bac0b，整合 Observer 88c4676、Launcher b97e635，保留旧发行安装和历史资源兼容。正式 npm scope @routilet，C Exam Kit 包名无 -preset 后缀。保留旧稳定入口，待兼容 Companion next 发行后切换。

Observer 已快进到 Windows GDB 后端并接入正式 CLI；后续验证 Windows 原生分发、真实回放与 Session 后端选择。Compiler/Debugger 只用用户指定路径或 PATH（macOS 保留 xcrun），不扫描 IDE、不自动安装、不改 PATH，不附离线工具链下载链接。

当前候选尚未声明 Observer 可选 npm 依赖，等实际新版本发布再精确绑定。npm 11 缺失可选依赖导致 npm ci EUSAGE 待修复；旧版正常启动不受影响。当前不发布、不修改 main。发布前完整 CI、真实 npm 安装、实机审核和 HTML 审核。

## npm 11 兼容调整

候选目录先实际 npm install/update（禁用 lifecycle scripts），再校验实际 CLI、组件状态、锁文件和版本差异。用户确认后不再访问 registry，也不重新解析依赖；复验锁摘要及 CLI 后一次切换。取消删除候选，不影响当前安装。保留缺失可选依赖的真实 registry 测试，改测正式采用的 staged install/update 流程；npm ci 旧方案在 npm 11 EUSAGE 已记录。待实际 CI 验证。

Observer 能力接口可声明 sessionFeatures。Companion 仅在实际二进制声明支持时传入 backend=auto 和样例 comparison；旧 Session v1 严格解析器仍可使用。Windows CRLF 与样例规则的判定另显示，原始字节保留。新后端原生构建和真实 TUI CI 尚需通过。
