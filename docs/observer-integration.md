# C Observer 集成开发

权威协议： https://github.com/Annouimo/c-observer/blob/feat/tui/docs/integration.md （合并后改为 main）。
本阶段保持 launcher 不变；使用 ACCODING_OBSERVER_PATH 指定本地开发版绝对路径，或从 npm 安装预览 tarball 后通过运行时解析 manifest.json。Observer 正式 npm 版本尚未发布，因此暂不将不存在的版本写进 package.json 或锁文件。正式发布后再增加 optionalDependencies 并锁定验收版本。不得联网自动更新。

CLI: accoding observe PATH [--sample N]，观察当前源码和选中的已启用样例（编号从 1 开始）。准备工作重用 prepare()，同一次装配保存原始文本、诊断源码与样例，临时目录在子进程退出后清理。用户源码、提交快照不修改；观察结果不替代 OJ 判定。支持编译器配置透传；当前仅 LLDB macOS/Linux，GDB 和链接参数行为仍待后端验收。

接下来：Ink 终端交接和题目/样例快捷入口、C Exam Kit 依赖迁移及旧启动器兼容测试、npm 包正式依赖和全平台验收。