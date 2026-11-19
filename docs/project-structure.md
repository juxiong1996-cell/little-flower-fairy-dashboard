# 项目目录

按用途放文件，相关功能放在一起。程序继续使用原生 JavaScript ES modules，没有为了整理目录增加框架或第三方包。

```text
小花仙/
├─ src/                  程序代码
│  ├─ app/               启动器、网页服务和接口入口
│  ├─ accounts/          账号保存、显示名称
│  ├─ browser/           浏览器发现、登录、游戏启动导航
│  ├─ game/              官方协议、查询、签到、领奖与进度
│  └─ schedule/          每日定时任务
├─ web/                  浏览器页面、样式和交互
├─ test/                 自动化测试；support/ 放测试辅助代码
├─ scripts/              打包、开发抓包工具
├─ docs/                 使用和协议说明
├─ dist/                 生成的便携发布包（不入库）
├─ .local/               开发临时文件（不入库、不发布）
├─ package.json          启动、测试、打包命令
├─ README.md
└─ 启动签到台.cmd         Windows 便携包入口
```

新增账号功能放 `src/accounts/`，游戏业务放 `src/game/`，浏览器控制放 `src/browser/`。只有生成或检查程序的工具放 `scripts/`，测试统一放 `test/`。跨目录导入写明相对路径和 `.mjs` 扩展名；资源路径相对模块文件解析，避免依赖打开终端时所在的目录。

## 查阅依据

2026-11-19 查阅了以下官方资料：

- [Express FAQ：如何组织应用](https://expressjs.com/en/starter/faq.html)：没有唯一标准，应根据项目规模和用途划分。
- [Express 官方生成器示例](https://expressjs.com/en/starter/generator.html)：将启动入口、静态资源、路由等不同职责分开。本项目借鉴职责分离，不引入 Express。
- [Node.js ES modules](https://nodejs.org/api/esm.html)：相对导入需要扩展名；`import.meta.url` 可用于定位模块旁边的资源。

运行 `npm start` 启动，`npm test` 测试，`npm run build:portable -- --node-license "完整许可证路径"` 打包。移动文件时，需要同步更新导入路径、资源路径和上述入口；发布打包器会从入口递归收集实际使用的模块。
