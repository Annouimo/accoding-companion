# Accoding Companion

非官方 Accoding 终端编程助手。独立于原 VS Code 插件 `Annouimo/better-accoding-for-buaaers`。

> 开发分支进行中；**尚未正式发布到 npm**。与北航或 Accoding 官方无隶属关系。

## 目标

- **课程工作区**：一个目录、多场比赛；工作区统一 C99 或 C++17
- 题目目录保留 `main.c` / `main.cpp`、`题目.md`；内部数据集中隐藏
- 本地评测、不可变提交源码、OJ 状态恢复
- C99 与独立维护的 [C Exam Kit](https://github.com/Annouimo/c-exam-kit) 配置联动
- Node.js LTS、npm 发行；安装器负责软件与脚手架包的版本检查

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
node dist/accoding.cjs --help
```

当前处于基础迁移阶段。请不要把开发中的 `0.2.0-next.0` 当作已发布版本。

源码迁移保留了原项目的 MIT 许可证与第三方许可说明。
