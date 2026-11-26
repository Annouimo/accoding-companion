# Routilet 第一轮整体发行候选

基于 main 30bac0b，整合 Observer 88c4676、Launcher b97e635，保留旧发行安装和历史资源兼容。正式 npm scope @routilet，C Exam Kit 包名无 -preset 后缀。保留旧稳定入口，待兼容 Companion next 发行后切换。

Observer 已快进到 Windows GDB 后端并接入正式 CLI；后续验证 Windows 原生分发、真实回放与 Session 后端选择。Compiler/Debugger 只用用户指定路径或 PATH（macOS 保留 xcrun），不扫描 IDE、不自动安装、不改 PATH，不附离线工具链下载链接。

当前候选尚未声明 Observer 可选 npm 依赖，等实际新版本发布再精确绑定。npm 11 缺失可选依赖导致 npm ci EUSAGE 待修复；旧版正常启动不受影响。当前不发布、不修改 main。发布前完整 CI、真实 npm 安装、实机审核和 HTML 审核。

## npm 11 兼容调整

候选目录先实际 npm install/update（禁用 lifecycle scripts），再校验实际 CLI、组件状态、锁文件和版本差异。用户确认后不再访问 registry，也不重新解析依赖；复验锁摘要及 CLI 后一次切换。取消删除候选，不影响当前安装。保留缺失可选依赖的真实 registry 测试，改测正式采用的 staged install/update 流程；npm ci 旧方案在 npm 11 EUSAGE 已记录。待实际 CI 验证。

Observer 能力接口可声明 sessionFeatures。Companion 仅在实际二进制声明支持时传入 backend=auto 和样例 comparison；旧 Session v1 严格解析器仍可使用。Windows CRLF 与样例规则的判定另显示，原始字节保留。新后端原生构建和真实 TUI CI 尚需通过。

## 2026-11-26 修复后的预览发行门槛

Observer 2b9e6a3 已通过真实 Windows/Linux GDB、Linux LLDB 和四平台原生安装；真实 Companion 装配回放分别 16/17 快照。CI 45758886077 从 npm 实际查询到 C Exam Kit latest 0.6.10、Observer latest/next 0.1.0-beta.2、Companion latest 0.2.7（无 next），并验证私有实际安装的组件均 ready。候选版本 Observer 0.1.0-beta.3、Companion 0.2.8-beta.1、Launcher 0.3.0-beta.1；发行前仍查完整已发布版本列表。

1. 先审核 Observer PR #1、许可说明及全部真实 CI，再合入用于预览发布的 main。维护者在 Observer publish-npm.yml 主分支人工触发 PUBLISH_NEXT；只发布 next，不改 latest，核对 npm view @routilet/c-observer@next version。
2. Companion 现有正式 OIDC 工作流仍只支持 latest。新增只读 Verify integrated release candidate (no publishing) 流程可在候选分支手动触发并输入上述实际版本：先验证已发布 Observer next，再生成真正的公共预览 tarball（仅 runner 临时修改 package.json），从 registry 安装精确 Observer 可选依赖、核对组件状态及 SHA256，保存 companion-reviewed-preview。该流程无发布权限，不自动执行 npm publish。维护者审核产物后使用 npm 的交互式授权发布该 tarball到 next；正式流程/OIDC 的新增 next 发布能力仍需单独审核。
3. 同一工作流产生 launcher-v2-review-only 四平台 ZIP。预览使用 next；确认 Companion next 可安装以后再开展实机审核，不转发为正式发行。v2 使用说明从现有分页 HTML 渲染，不替换稳定说明；观察器截图待真实审核。
4. 实机审核通过后才决定稳定版发行及独立 Release；不把跨平台安装测试替代实机审核。不需要更改 C Exam Kit 版本。

本次只生成审核产物，不合并主分支、不变更 npm 标签。npm 工作流手动触发及交互式 npm 认证须维护者完成。
