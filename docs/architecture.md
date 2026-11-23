# Accoding Companion 存储与运行架构

## 三种数据所有权

| 层级 | 保存内容 | 更新策略 |
| --- | --- | --- |
| 系统用户配置目录 | 最近工作区、编译器设置、最近题目、账号标识 | 程序升级保留 |
| 系统用户数据目录 | 安装器下载的脚手架 npm 数据包，可保留多个版本 | 用户主动运行安装器下载 |
| 课程工作区 | 源码、题目笔记、样例、脚手架和提交快照 | 不随 npm 升级自动变化 |

账号凭据在 macOS Keychain 或 Windows DPAPI 中，**不随课程工作区拷贝**。Linux 首版只支持进程内会话凭据。

### 新课程的约定目录

```text
C语言课程/
  第六次作业/
    A-字符统计/
      main.c
      exam.h
      题目.md
    B-数组操作/
      main.c
      exam.h
      题目.md
  第七次作业/
    A-字符串/main.c
    A-字符串/exam.h
    A-字符串/题目.md
  用户自己的笔记/
  .accoding/
    workspace.json
    index.json
    bindings/
    contests/
    problems/
    cases/
    scaffold/
    scaffold-history/
    initial-hashes/
    submissions/
    snapshots/
    cache/
    runs/
    transactions/
```

C++17 工作区只有 `main.cpp` 和 `题目.md`，不生成 C99 的 `exam.h`。

`.accoding/workspace.json` 保存 `schemaVersion:1`、`kind:"course"`、`language:"c"|"cpp"` 及可选的 `presetVersion`。工作区语言固定。每场比赛通过 `.accoding/contests/<id>.location.json` 记录子目录，不凭名字猜测用户文件夹的所有权。索引 `.accoding/index.json` 是可重建派生文件；题目绑定、用例和提交记录是持久数据，不能当缓存删除。

## C99 源码展开

用户可见的 `exam.h` 是一份小型包装头文件，以相对路径引用工作区 `.accoding/scaffold/<题目ID>/expanded.h`，使普通 GCC/Clang 能直接编译 `main.c`。使用完整函数库定义而不是重复放入每道题目的可见目录。

本地测试时从 `main.c` 与绑定的 `manifest.json` 按需展开实际使用组件及依赖，产生 `.accoding/snapshots/<sha256>.c`，将相同的代码字节送入编译器；测试通过后确认提交时直接复用该源码快照。如果源文件改变，需要重新测试。程序发现可见的 `exam.h` 被修改时拒绝自动展开，避免本地开发与 OJ 上传使用不同内容。

正式发行前需要检查 C99/GCC、macOS Clang 和旧 Windows MinGW 的相对头文件及 Unicode 路径兼容性。

## 用户可编辑文件

- `main.c`、`main.cpp`：用户源码。程序不因远程同步或脚手架更新覆盖。
- `题目.md`：第一次导入生成，后续同步只更新隐藏缓存，不覆盖用户编辑。
- `exam.h`：由程序生成的入口，用户修改后拒绝自动组件替换，必须明确处理冲突。
- 用户其他目录：不由 Accoding 管理。若拟生成目录与已有目录冲突，另选安全名称而非接管。

## 旧版工作区

旧版以 `.better-accoding/` 为核心，常有数字目录和多余的 C/C++ 源文件。新版**不自动搬迁**。显式运行 `accoding workspace migrate OLD --root NEW --workspace-lang c|cpp` 在独立新根目录复制题目绑定、源码、可用样例及题目说明，保留旧数据。当前版本不声称所有旧账号与提交历史都已迁移：未经迁移验证的内容仍应从旧目录读取或通过 Accoding 同步恢复。

## 脚手架更新

安装器只将 npm 数据包下载到程序用户数据目录，不触及课程题目。用户在 TUI 选择本机版本后可设置课程默认版本（影响未来题目），或批量应用到已有 C99 题目。应用前预览选项范围，先编译检查，再在受控写锁内备份和切换组件目录；用户源码与笔记保持不变。

模式包括：所有未 AC（当前账号状态未知的题目排除）、所有空题目（必须有可信初始化源码哈希）、所有题目、自选题目。C++17 不参与 C99 脚手架更新。

## 系统约定

系统配置：

- macOS/Linux：`$XDG_CONFIG_HOME/accoding-companion/`，默认 `~/.config/accoding-companion/`
- Windows：`%APPDATA%\accoding-companion\`

本机下载包：

- macOS：`~/Library/Application Support/Accoding Companion/presets/<version>`
- Windows：`%LOCALAPPDATA%\Accoding Companion\presets\<version>`
- Linux：`$XDG_DATA_HOME/accoding-companion/presets/<version>` 或 `~/.local/share/accoding-companion/presets/<version>`

安装器与应用使用同一布局。敏感账户数据不随工作区发布，也不放在 npm 包中。
