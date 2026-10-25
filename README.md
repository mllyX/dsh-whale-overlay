# dsh-whale-overlay · 桌面鲸鱼

把 [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（DSH 界面右下角的余额小鲸鱼挂件）**放到整个桌面上活动**：一个透明、无边框、置顶、覆盖全屏的悬浮窗（独立 Electron 助手进程）加载与 GUI 完全相同的挂件代码 —— 拖拽、四边吸附、泡泡、菜单、音效、余额轮询全部原样工作，只是视口从"DSH 页面"变成了"整个屏幕"。

> 依赖：本机已安装 `dsh-whale-widget`（挂件本体与全部 `/dsh-whale/*` 路由由它提供，本插件不复制任何挂件代码）。
> 平台：Windows（当前实现只测试了 Windows；macOS/Linux 需要另测点击穿透与托盘行为）。

## 工作原理

```
DSH 宿主进程（本插件 host 半区）
 ├─ 配置 $DSH_HOME/.dshw-overlay.json；路由 /dsh-whale-overlay/*（信任围栏保护）
 ├─ spawn → Electron 助手（$DSH_HOME/whale-overlay/node_modules/electron）
 │           └─ 透明置顶全屏窗
 │               ① 首航加载 connection.authenticatedUrl 签发的根 URL → 换取会话 cookie
 │               ② 跳转 /dsh-whale-overlay/overlay.html（裸承载页，隐藏假 #root 过挂件闸门）
 │               ③ 播种 dshw-last-seq 后注入 /dsh-whale/widget.js（挂件原样初始化）
 │               ④ 默认整窗点击穿透；glue 命中 dshwv-* 元素时经 IPC 关闭穿透
 ├─ 崩溃退避重启（2s/10s/60s，连续 5 次快速失败进 crash-loop 错误态）
 └─ 桌面模式开启时抑制 GUI 内挂件副本：
     · 桌面壳：过滤 webserver/index-inject 结构化注入行（重启 DSH 后生效）
     · 浏览器：tapIndex 剥掉 widget.js 的 <script> 标签
DSH GUI（本插件 client 半区）
 └─ 侧栏「🐋 桌面鲸鱼」控制卡：桌面模式开关 / 状态 / 设置入口 / 组件安装
```

## 控制入口

| 入口 | 能做什么 |
|---|---|
| 侧栏「🐋 桌面鲸鱼」卡片 | 桌面模式开/关（即时生效）、状态一览、安装桌面组件、打开设置 |
| 系统托盘（鲸鱼图标） | 显示/隐藏、窗口置顶开关、重新加载挂件、设置、退出桌面模式 |
| `Ctrl+Alt+W` | 全局热键：一键显示/隐藏悬浮鲸鱼 |
| 设置页 `/dsh-whale-overlay/settings.html` | 覆盖范围（主屏/全部显示器）、置顶档位、不透明度、热键开关、硬件加速、组件安装/修复 |

## 配置（`$DSH_HOME/.dshw-overlay.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 桌面模式总开关：开 = 悬浮窗随 DSH 启动 |
| `suppressInApp` | `true` | 桌面模式开启时抑制 DSH 界面内的挂件副本（避免双鲸鱼/双重提示音；**重启 DSH 后生效**） |
| `display` | `primary` | `primary` 主显示器 / `all` 全部显示器并集（跨屏漫游） |
| `opacity` | `1` | 悬浮窗整体不透明度 0.3~1 |
| `alwaysOnTop` | `screen-saver` | `screen-saver`（高于几乎一切）/ `normal` / `off` |
| `hotkeyEnabled` | `true` | Ctrl+Alt+W 全局显隐热键 |
| `hardwareAcceleration` | `true` | 透明窗口黑底/花屏时改 false 并在设置页「保存并重启悬浮窗」 |

## 安装（desktop profile，本地 link 方式）

```powershell
# 1) 接线到 profile（在 C:\Users\<user>\.dsh\profiles\desktop 下）
#    package.json dependencies 加： "dsh-whale-overlay": "link:D:/DSHarness/dsh-whale-overlay"
#    dsh.profile.bundles 数组**末尾**追加： "dsh-whale-overlay"
#    ⚠ 必须排在 dsh-whale-widget 之后：注入抑制依赖"后订阅后执行"的顺序
pnpm install   # 同步 lock 并建立 junction

# 2) 安装 Electron 桌面组件（一次性，~100MB，npmmirror 镜像）
#    方式 A：重启 DSH 后在侧栏卡片/设置页点「安装桌面组件」
#    方式 B：手动
mkdir C:\Users\<user>\.dsh\whale-overlay
cd C:\Users\<user>\.dsh\whale-overlay
# package.json: {"dependencies":{"electron":"latest"},"pnpm":{"onlyBuiltDependencies":["electron"]}}
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
pnpm install

# 3) 重启 DeepSeek Harness
```

## 已知边界

- **重启语义**：界面内挂件副本的隐藏/恢复由 DSH 启动时收集的注入表决定 → 切换 `enabled`/`suppressInApp` 后需重启 DSH 才对该副本生效；悬浮窗本身即时拉起/关闭。切换后到重启前可能出现"双鲸鱼+双重提示音"的过渡期。
- **全屏独占游戏**：置顶悬浮窗可能盖在无边框窗口化应用上；`Ctrl+Alt+W` 或托盘可一键隐藏。
- **模态遮罩**：挂件的编辑器（用量记录、泡泡编辑等）自带半透明全屏遮罩，在桌面模式下会罩住整屏 —— 属其固有模态交互，关闭编辑器即恢复。
- **位置记忆**：悬浮窗有自己独立的 localStorage（`$DSH_HOME/whale-overlay/userdata`），桌面位置与 GUI 内位置互不干扰。
- **鉴权**：悬浮窗每次由宿主拉起时都用新签发的启动令牌换取会话 cookie；cookie 失效（超过 maxAgeDays）时悬浮窗自动退出，由宿主用新令牌重拉。

## 文件布局

```
lib/index.js            宿主半区：路由/配置/围栏/子进程生命周期/注入抑制
lib/client.js           GUI 半区：侧栏控制卡（__ModuleLoader__ 纯 DOM）
lib/overlay/main.cjs    悬浮窗 Electron 主进程
lib/overlay/preload.cjs contextBridge：命中测试 → 点击穿透切换
lib/static/overlay.html 裸承载页（隐藏假 #root + glue）
lib/static/overlay-glue.js  seq 播种 + widget.js 注入 + 命中测试桥
lib/static/settings.html    设置页
assets/icon.png         插件/托盘图标
scripts/make-icon.py    图标生成脚本（Pillow）
```

## 许可

代码 MIT。图标为本插件自绘；鲸鱼挂件本体与其素材遵循 `dsh-whale-widget` 自身的许可声明（本插件不分发其任何文件）。
