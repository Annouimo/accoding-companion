# Companion Next · 03a 开发预览

旧版保持原样。本目录为独立 Go 模块，基于阶段 02 设计 PR #27。真实原生窗口 → 选择普通 C 文件 → 输入 → 编译 → 执行 → 显示 stdout/stderr、编译诊断、退出状态。无模拟编译。

## 构建（开发环境）

Go 1.26、Node 22、现有 GCC/Clang；Windows 11 amd64 / macOS arm64。运行生成的桌面程序不需要 Go/Node。

```sh
cd next/desktop/frontend
npm install --ignore-scripts --no-audit --no-fund
npm run build
cd ../..
go mod tidy
go test ./internal/localrun
go vet ./internal/localrun
go build -tags production -o out/companion ./desktop
```

CI 单独构建 Windows EXE / macOS ad-hoc .app ZIP，只生成临时 artifact，不发布。初次 CI 解析依赖并附锁文件，后续审核固化；当前未声称可复现锁定。应用读取所选磁盘文件，不写用户目录；运行用户明确选择的可信程序，非安全沙箱。运行程序本身可能写文件或联网。无需注册、账号或 .companion。编译器由用户自行准备。Go/Wails API 基于 Observer 已验证方向；当前窗口未真机验证。

## 人工验收

1. 启动 EXE/APP（或带单个 .c 路径启动），打开包含中文和空格的目录下普通 C 文件；父目录和文件名正确。
2. 使用标准输入回显程序，输入多行文本，确认输出、EOF、空输入；外部编辑后重新运行读取最新版本。
3. 语法错误显示编译 stderr；非零退出显示运行失败；无限循环超时；取消可恢复按钮；缺编译器报明确错误。
4. 检查原始文件和目录不被工具写入；断网可启动并运行（已安装编译器）。
5. Windows Dev-C++ GCC 的中文路径、macOS 系统 WebView、输入法/窗口/关闭需真实设备复验。

## 范围与已知限制

- 仅普通 C99 单文件；C++、本地头文件、Exam Kit、任意预处理展开、多文件项目、样例保存/比较/批量、完整文件树、拖入、复制、手册、Observer/Routilet、OJ 均未实现。
- 本轮使用 TypeScript + 原生 DOM，避免为首个切片引入组件框架；产品原型仍为设计参考。文件列表暂只展示已选文件。后续按原型逐步恢复完整交互。
- 核心使用参数数组调用真实工具链，限制时长和输出、取消、临时目录清理。进程树终止为基础实现；Windows taskkill、父进程先退出的后代/管道清理、关闭窗口等待与跨卷 Unicode 路径需要 03b 加固与真机测试。非 sandbox。
- 目前只有运行结束时源码变化检查，不提供完整会话失效/运行 ID；03b/03c 实现。编译诊断当前原始文本，不提供精确原文件映射。
- 现有设计文档均为上游 stacked PR；不得合并/发布。真实构建及测试结果以 CI 和人工验收为准。
