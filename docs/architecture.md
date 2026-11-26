# Accoding Companion 存储与运行架构

## 三种数据所有权

| 层级 | 保存内容 | 更新策略 |
| --- | --- | --- |
| 系统用户配置目录 | 最近工作区、编译器设置、最近题目、账号标识 | 程序升级保留 |
| 系统用户数据目录 | 安装器下载的脚手架 npm 数据包，可保留多个版本 | 用户主动运行安装器下载 |
| 课程工作区 | 源码、题目笔记、样例、脚手架和提交快照 | 不随 npm 升级自动变化 |

账号凭据在 macOS Keychain 或 Windows DPAPI 中，**不随课程工作区拷贝**。Linux 首版只支持进程内会话凭据。

### 新课程工作区

题目目录包含源码和 `题目.md`。C++17 课程使用 `main.cpp`，C99 课程使用 `main.c`。

| `.accoding/` 路径 | 用途 |
| --- | --- |
| `workspace.json` | 课程语言、新题默认 preset 版本、独立题目目录 |
| `bindings/` | 题目来源、源码路径、本地用例、初始源码哈希和 preset 回退记录 |
| `contests/` | 比赛目录和题目清单 |
| `presets/<版本>/` | 组件、依赖图及由它们构建的完整头文件 |
| `submissions/` | 按账号记录的 OJ 提交和未决尝试 |

题面只保存在 `题目.md`，同步保留既有笔记。样例与自定义用例存放在绑定里。对本地改过的官方样例同时保留官方基线，用于后续同步。打开旧工作区会先恢复未完结的用例事务、导入磁盘上经外部编辑的用例，再原子保存新版绑定。旧文件留在原处供确认，新工作区不产生用例投影、题面镜像或派生索引。

## C99 源码展开

课程内的各题直接通过相对路径引用 `.accoding/presets/<版本>/expanded.h`，IDE 和本地编译器可使用完整接口。每个已使用的版本在课程内只保存一份。选择课程默认版本只影响新题，单题版本由源码中的 include 固定。旧 `exam.h` 包装头仍可读取，显式应用新版时会验证旧头文件并切换到共享路径。版本回退只改写受管理的 include。

测试读取用户源码，从被引用的符号出发计算组件依赖闭包。编译器在系统临时目录中编译生成的 `submit.c`，流程结束后清理文件。测试通过的源码字节在同一会话内可直接提交。如果编辑了原源码，需要重新测试。直接提交会先组装并编译待上传的同一份源码。

正式源码保持精简且不含工具生成的 `#line`。诊断源码从同一次装配生成，保留用户与组件注释，并通过 `#line` 标识用户源码及组件位置。仅在正式编译产生诊断时额外编译该副本；如果主诊断不同、额外编译失败或超时，则保留正式编译结果。诊断副本绝不作为评测通过快照或 OJ 上传内容。警告不改变测试通过条件。

## TUI 交互

Ink 界面保持挂载，页面状态与面包屑共享课程、作业和题目路径。Esc 返回上一级，Tab 将焦点移到路径，左右键选择祖先页，Enter 跳转。测试与提交状态在题目原页显示。测试详情使用同一屏幕的样例对比、编译诊断及运行日志视图；Tab 切换视图，方括号切换对象，方向键滚动，各对象独立保留浏览位置。编译诊断逐条显示，原文保留。运行日志不参与输出比较。字符级高亮遵循用例的比较规则，极长行使用有限成本的共同前后缀算法。

## 旧版工作区

旧 `.better-accoding/` 根目录可用 `accoding workspace migrate OLD --root NEW --workspace-lang c|cpp` 显式迁移。迁移复制题目、源码和用例，原目录保留。账号和旧提交记录的完整迁移仍需验证。

## 系统约定

系统配置：

- macOS/Linux：`$XDG_CONFIG_HOME/accoding-companion/`，默认 `~/.config/accoding-companion/`
- Windows：`%APPDATA%\accoding-companion\`

原生启动器使用独立的 npm 安装目录，通过 ACCODING_PRESET_PACKAGE 指定资源包；直接 npm 安装时，通过 `npm root --global` 发现新 `@routilet` 和旧 `@annouimo` 资源包。课程所用组件保存在工作区内。以下旧目录只用于兼容已有安装：

- macOS：`~/Library/Application Support/Accoding Companion/presets/<version>`
- Windows：`%LOCALAPPDATA%\Accoding Companion\presets\<version>`
- Linux：`$XDG_DATA_HOME/accoding-companion/presets/<version>` 或 `~/.local/share/accoding-companion/presets/<version>`

敏感账户数据不随工作区发布，也不放在 npm 包中。

测试详情优先按位置比较等长输出；不等长输出采用有界字符对齐。诊断上下文来自编译输入快照，已知警告默认折叠原文，未知诊断直接显示原文。顶部状态、视图导航与底部操作栏固定；终端过窄时简化标签与操作说明。
