# Companion Next · 04a 版本化 Exam Kit

基于 #30。普通 C99/C++17 源文件直接打开，无需初始化；真实目录树、测试数据、批量运行、诊断、差异与结果失效。03d 新增原生 Wails 文件/目录拖放（一次一个）、恢复最近目录/相对文件、全局 C/C++ 编译器和外部编辑器设置、打开编辑器/所在目录、普通源码预览与剪贴板复制、非交互 CLI、批量进度和 Unicode 字符差异。设置存用户配置目录，不污染课程目录；不保存测试结果。旧数据不兼容、不读取。

## CLI

开发环境在 next/ 下运行 go build -o out/companion-cli ./cmd/companion（Windows 加 .exe）。分发名暂为 companion-cli，最终由 Routilet 确定。

- companion-cli test [-compiler PATH] [-case N] FILE：使用已保存的本地样例，默认全部；编号从 1 开始；无样例则空输入运行。stdout 为 JSON，stderr 为错误；0 = 所运行组成功/无预期正常退出，1 = 失败/取消/过期，2 = 参数或工具错误。不代表 OJ AC。
- companion-cli source FILE：输出原样 UTF-8 独立普通源码，不修改文件；不自动展开头文件，Exam Kit 留 04。

## 构建与验收

Go 1.26、Node 22、已有 GCC/Clang。next/desktop/frontend 执行 npm install --ignore-scripts --no-audit --no-fund && npm run build；next/ 执行 go mod tidy、go test ./internal/localrun ./cmd/companion、go vet ./internal/localrun ./cmd/companion、go build -tags production ./desktop。独立双平台 CI 仅上传开发 ZIP，依赖锁随 CI 产物。未发布。

人工验收：拖入单文件/目录、取消未保存切换、重开恢复子目录选中、编译器设置跨重启；指定编辑器路径并打开、打开所在目录；复制原样源码、预览期间外部修改则拒绝复制、未通过全部比较仍允许明确复制；批量运行观察完成数及取消；Unicode 差异、多处差异及长输出降级。CLI stdout/退出码、无写入行为。真机 Windows/macOS 未验收。

## 实现限制

- 进度按 300ms 轮询；只显示编译与已完成用例数，仍一次返回完整批次。拖放由原生事件入队，忙时拒绝，需真机验证 WebView。外部编辑器仅支持单一可执行文件路径/名称，不解析 shell 或自定义参数；macOS 默认文本编辑器使用 open -t，Windows 使用文件关联。
- 字符差异以 Unicode code point 的 LCS 对齐，使用规范化比较文本；矩阵超过 1M 单元降级为前后缀/整段差异，超过 16000 字符只报告首差异，原始 stdout 仍保留。不是字素簇 diff。
- 复制快照重新核对源码、样例与编译配置；验证标记仅当最新完整批次所有样例均比较通过，不能证明独立源码对所有输入正确。普通 include 检查不是完整预处理器；系统剪贴板不保证粘贴字节恒等。运行可信源码，不是沙箱。
- 继承 03b 的 Windows Job Object 接管窗口/降级、03c 的轮询间隙及硬链接重命名限制；不支持多文件工程。03c/03d 仍需双平台真机检查；配置并发写采用最后一次保存，未实现配置合并。现有旧版不受影响。

## 04a：资源准备与默认新建 C

现行 @routilet/c-exam-kit 包版本 0.6.10（CI 固定资源仓库提交 f17f8715c6ca552b059da4f95969d956026e584a）使用 preset/manifest.json schema 2 内嵌组件和 reference.json schema 1；发布包不提供 expanded.h，Companion 按旧版 renderHeader 规则生成。只支持实际 v2，不兼容旧 .accoding 或旧 v1 包。保留许可证、引用数据以及可选 Markdown；无 Markdown 时不伪造。

预览安装包路径由 COMPANION_EXAM_KIT_PACKAGE（绝对路径）或设置内一次性目录选择提供；可从 04a CI 的 companion-04a-exam-kit-preview artifact 解压获取。不是正式 Routilet 接口，不执行 npm、网络访问或安装；正式激活资源定位留 06。新建 C 默认引入当前资源版本；资源缺失时不创建源码。C++ 普通模板不变。资源放在当前浏览根 .companion/resources/<version>/；子目录文件生成相对 include；同版本只复用一致的快照，新版本并存。完整头、manifest、reference、许可证和 snapshot.json 指纹记录一并保存；锁与暂存目录后发布，外部非协作写入仍可能竞争。指纹用于完整性检测，不是签名。旧代码不修改，删除安装包不影响本地快照。

验收：选择实际 npm 包目录，创建 C，外部 IDE 编译 read_int 示例；换版创建另一个 C，旧 include 不变；缺包、循环/未知依赖、同版本冲突、篡改头文件应失败。CI 使用真实生成的资源包和外部 GCC/Clang 编译新文件，另有合成 fixture 验证版本及损坏。测试/复制含 Kit 的源文件仍明确拒绝（04b 才实现最小展开与一致性），手册界面在 04c。GUI 真机仍待验收。Observer/Routilet/OJ 未接入，不改正式发行。stacked PR。
