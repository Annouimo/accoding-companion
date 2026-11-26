# C Observer 集成开发

权威协议： https://github.com/Routilet/c-observer/blob/feat/tui/docs/integration.md （合并后改为 main）。
本阶段保持 launcher 不变；使用 ACCODING_OBSERVER_PATH 指定本地开发版绝对路径，或从 npm 安装预览 tarball 后通过运行时解析 manifest.json。Observer 正式 npm 版本尚未发布，因此暂不将不存在的版本写进 package.json 或锁文件。正式发布后再增加 optionalDependencies 并锁定验收版本。不得联网自动更新。

CLI: accoding observe PATH [--sample N]，观察当前源码和选中的已启用样例（编号从 1 开始）。准备工作重用 prepare()，同一次装配保存原始文本、诊断源码与样例，临时目录在子进程退出后清理。用户源码、提交快照不修改；观察结果不替代 OJ 判定。支持编译器配置透传；首版仅 LLDB macOS/Linux（macOS ARM64 优先）；LLDB 链接参数和源码映射仍待真实验收，Windows/GDB 后续独立适配，不阻塞首发。

Ink：题目菜单“运行观察”，样例详情 O 观察当前源码。退出 Ink 后才启动原生程序，结束后重新挂载，恢复题目、样例、对比视图、滚动位置及测试报告。当前临时输入支持单行；多行用工作区样例。预期输出对照仍是观察器自身的逐字节比较。资源发现增加 npm 本地模块解析优先级，旧环境变量与历史资源保留。接下来：旧启动器真实升级验收、Observer 正式可选依赖、LLDB 支持平台的真实联调与离线验收。C Exam Kit 正式依赖已实现。Windows 不支持 Observer 时，既有 Companion 功能必须继续正常工作；后续平台适配不阻塞首版。

伪终端验收：使用模拟原生进程检测能力、会话内容、终端输入与退出后的样例视图恢复，并检查临时目录删除。此测试不等同于真实 LLDB/GDB 联调。
C Exam Kit 普通依赖迁移至 @routilet/c-exam-kit-preset ^0.6.10；新包必须先成功发布，才可合并本迁移补丁并运行 npm install。Observer 优先解析 @routilet/c-observer，兼容旧 @annouimo/c-observer；正式可选依赖仍需等待验收。正式运行优先解析包依赖；ACCODING_PRESET_LEGACY_ONLY=1 仅用于旧安装迁移诊断和隔离测试，正常启动器不设置。历史工作区资源不变。

普通 C 源码直接使用同名冻结副本，不传冗余 #line / SourceMap，避免当前 LLDB 不必要的身份降级。含 C Exam Kit 的装配源码仍走映射协议。映射源码的可靠身份待后端完善，不伪造变化。tests/standalone/observer-session-fixture.ts 为跨仓库真实联调生成实际课程工作区及样例会话。
