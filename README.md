# dsh-gandi

让 DSH 的 agent 在你**正在用的 Gandi**（共创世界 Gandi IDE 桌面版）里做 Scratch 项目：
写脚本、画造型、加声音、跑起来、看截图，然后接着改。

它不修改 Gandi 本身，也不往你的项目里塞看不见的东西——只是在旁边操作它，
就像另一个坐在电脑前的人。

> **它不碰你的云端作品。** Gandi 的编辑器开的是你账号里的在线作品；这个插件只把项目
> **导出成本地 `.sb3`**，不会替你保存或发布云端版本。要接着改就 `gandi_save`，
> 下次 `gandi_open` 读回来。

---

## 它能做什么

对 agent 说一句「用 gandi 工具做个接苹果的小游戏」，它就会自己开工：
开一个编辑器页签 → 新建项目 → 画苹果和篮子 → 写脚本 → 按键测试 → 看舞台截图 → 发现问题再改。

具体一点，它能：

- **写脚本**：用 Scratch 自己的积木方言（可读的 XML），支持自定义积木和脚本注释。
- **用扩展**：音乐、画笔、文字朗读、3D、AI…… 先把扩展载入编辑器，它的积木就能像自带积木一样写。
  每个积木的输入名和下拉菜单都是**从编辑器里读出来的**，所以不会写出"看起来对、跑起来没反应"的积木。
- **画美术**：造型和背景直接写 SVG；也可以给位图。
- **加声音**：给个音高和时长就**合成**一个（上滑＝跳跃/得分，下滑＝失败，游戏音效基本就这两种）。
- **建变量、列表、角色**，改名字、摆位置、调大小。
- **真的跑起来**：点绿旗、推进 N 秒、返回坐标和变量值，还能截图给模型"看"。
- **模拟键盘和鼠标**：这是测游戏唯一靠谱的办法——按住空格键，看小人有没有动。
  按键可以安排在**跑到第几秒**按下，所以"按住会走、松开就停"一次就能测完。
- **不打开 Gandi 也能改文件**：手上有个 `.sb3`，可以直接读它、改它、存回去。

## 快速开始

```powershell
# 1. 装进你要用的 profile（两个都装也可以）
dsh plugin --profile dsh-tui add https://github.com/yee114514/dsh-gandi
dsh plugin --profile web     add https://github.com/yee114514/dsh-gandi

# 2. 告诉插件 Gandi 装在哪（也可以写进配置文件，如下）
$env:GANDI_APP_PATH = 'E:\Gandi\Gandi.exe'

# 3. 重启 DSH
```

装完可以用 `dsh --profile <profile> --dump-config` 确认配置里真的出现了
`gandi` 这一行。第一次安装如果中途断网，可能会**静默回滚**（配置文件不变），
重跑一次即可。

> **改完代码要重启 DSH 才生效。** 宿主面插件不支持热重载。

## 前置条件

| 项 | 要求 |
| --- | --- |
| Node | `^22.19` 或 `>=24` |
| Gandi Desktop | 1.0.5 已验证（Windows，`E:\Gandi\Gandi.exe`） |
| 网络 | **需要联网**：编辑器本体是 `www.ccw.site` 上的网页 |
| 账号 | 桌面版要登录过（编辑器要用它载入默认项目） |
| 模型 | 需要能看图片，否则截图会降级成"把 PNG 写到某个路径，你自己去读" |

插件通过 Chrome DevTools 协议连进编辑器，所以 **Gandi 必须带调试端口启动**。
`gandi_launch` 会替你加这个参数，也会替你**开一个编辑器页签**。

### 两个必须知道的坑

**1. Gandi 启动后停在"我的作品"列表页，没有编辑器。** 编辑器是单独一个页面，
只有开了作品才存在。所以 `gandi_status` 里会看到 `editor tab: none`——这不是错误，
任何别的 `gandi_*` 调用都会先要一个页签。

**2. 一个没带调试端口启动的 Gandi，永远连不上——而且插件不会去关它。**
Chromium 的调试服务只在进程启动时创建，运行期没有开关能补上。所以：

- 插件**不会**替你关掉已经开着的 Gandi，也**不会**在旁边再拉一个（那是两个窗口）；
- 它会报错并告诉你出路。最省事的一条是**用带端口的快捷方式启动**：

  ```
  gandi_launch {launcher: true}
  ```

  这会在你的开始菜单里放一个 **`Gandi (DSH attachable)`**（用户级、不需要管理员、
  删掉即恢复）。以后从它打开 Gandi，模型就能**直接用你已经开着的那个窗口**，
  不会再有"关掉再拉起"。
  如果你想让**现有那个桌面图标**也带上端口，明确要求一次即可：
  `gandi_launch {patchShortcuts: true}`（它会逐个报告改了哪几个、原来是什么参数）。
- 确实需要重启当前那个 Gandi 时，`gandi_launch {restart: true}`：插件用
  `CloseMainWindow`（等于点窗口的 ✕，App 有机会问你要不要保存）礼貌关闭，再启动带端口的。
  **不会 taskkill**，没保存的东西不会跟着没。

编辑器要联网、要登录。断网或没登录时页签开出来是空的，
`gandi_launch` 会等到超时并告诉你原因。

想自己启动的话：

```powershell
Gandi.exe --remote-debugging-port=9222
```

### 你能看见模型在做什么

Gandi 的窗口里是"一个 shell + 一堆视图"：项目浏览器（主页）是一个视图，**每个作品是
另一个视图**，同一时刻只有一个在屏幕上。插件打开的编辑器视图**一定在最前面**，
所以正常情况下你点开 Gandi 就能看着模型改积木、加造型、跑项目。

两条边界，都是刻意的：

- **绝不抢你的焦点。** Gandi 被别的窗口挡住时，插件什么都不做（不会把它弹到最前）。
  你切回 Gandi 时，编辑器就是当前那个视图。
- 如果你在 Gandi 里点了**主页**（或点了自己的作品标签），那些是有标签的视图，
  而插件的编辑器没有标签；下一次真正改东西之前，插件会把编辑器**切回最前**——
  这一步不重新加载、不丢状态（切不动时才会重建视图并把工程整体搬过去，那种情况会在
  工具输出里明确写一行 NOTE，因为 undo 历史会没）。
  `gandi_status` 里的 `editor on screen:` 一行随时告诉你当前是哪种状态。

## 配置

写进 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: gandi
  config:
    appPath: 'E:\Gandi\Gandi.exe'
    port: 9222
    autoLaunch: true
```

**每个键都有默认值**，都可以省略。因为"Gandi 装在哪"是机器级事实、在两个 profile 里
写两遍很烦，所以也支持环境变量覆盖：

| 配置键 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `appPath` | `GANDI_APP_PATH` | 自动探测常见安装位置 | `Gandi.exe` 的绝对路径 |
| `port` | `GANDI_PORT` | `9222` | 调试端口 |
| `autoLaunch` | `GANDI_AUTO_LAUNCH` | `false` | 连不上时是否自动拉起 Gandi |
| `leaseIdleMs` | — | `60000` | 编辑权空闲多久后自动让出（拿不动就用 `gandi_lease` 或 `force: true`） |
| `launchTimeoutMs` | — | `45000` | 等待编辑器就绪的上限 |
| `recreateCooldownMs` | — | `30000` | "重建编辑器视图"这条重路径的最小间隔；切视图不受它限制（`0` = 不限制） |
| `maxTextChars` | — | `20000` | 单个工具输出的文本上限 |
| `screenshotOnRun` | — | `true` | 跑完是否附一张舞台截图 |
| `allowOutsideWorkspace` | — | `false` | 是否允许读写会话工作目录之外的路径 |
| `enableSystemPrompt` | — | `false` | 是否注入一段简短的提示词 |
| `registerSkill` | — | `true` | 是否注册 `gandi-scratch-authoring` 技能 |
| `debug` | `DSH_TUI_DEBUG` | `false` | 把诊断写到 stderr |

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `gandi_status` | 端口、编辑器页签、连接、**编辑器是不是当前屏幕上的视图**、打开的项目、谁在编辑，以及每个角色的脚本/积木/**克隆体**/变量/造型。**出问题先看它** |
| `gandi_launch` | 让 Gandi 就绪：**已经在跑的那个直接接管**（不会开第二个窗口），必要时才拉起；`restart: true` 才会礼貌重启它；`launcher: true` / `patchShortcuts: true` 把调试端口写进快捷方式，这样你自己打开的 Gandi 也能被接管 |
| `gandi_open` | 把磁盘上的项目载入编辑器（整份替换；别人占着编辑权时用 `force: true`） |
| `gandi_new` | 新建项目（舞台 + 一个起始角色）；`empty:true` 只要舞台 |
| `gandi_sprite` | 新建空角色（只留你给的造型）、复制角色、重命名、删除、选中 |
| `gandi_costume` | 加造型/背景（`costumes:[…]` 一次加一批），或 `action:'rename'|'delete'` 收拾 |
| `gandi_sound` | 加声音：合成一个或上传字节；`action:'rename'|'delete'` 改名/删除 |
| `gandi_variable` | 建、改、重命名、删 变量与列表（全局或角色私有） |
| `gandi_extension` | **扩展**：`action:'list'` 列出这台编辑器能载入的扩展（本机 93 个）和已经载入的；`action:'load', id:'music'` 载入一个，并把它的**积木、输入、下拉 shadow** 打出来。载入后那些积木就能写，用户也能在工具箱里拖到 |
| `gandi_place` | 直接摆位置、朝向、大小、显隐，不写脚本 |
| `gandi_inspect` | 读项目：角色、造型、变量、脚本。**给 `path` 就读磁盘上的文件，不需要编辑器** |
| `gandi_apply` | 写脚本（`replace` / `append` / `replaceScript` 只换一段）。**给 `path` 就改磁盘上的文件，不需要编辑器** |
| `gandi_verify` | **动手之前先问"编辑器打得开吗"**：离线检查加载期才会暴露的问题；`live:true` 再让编辑器真加载一次（会还原原工程） |
| `gandi_merge` | 把另一个 `.sb3` 里的角色（含**它自己的**变量、造型、音效和素材字节）并进当前工程或某个文件 |
| `gandi_lease` | 看/放/拿 编辑权（`status` / `release` / `take`）；`force: true` 是所有改编辑器的工具都有的参数 |
| `gandi_run` | 点绿旗，推进 N 秒，返回运行状态 + 舞台图。`input` 可以在跑的过程中按键/点鼠标 |
| `gandi_input` | 模拟键盘鼠标（设置"跑之前就该在的状态"；要测"按住"用 `gandi_run` 的 `input`） |
| `gandi_stop` | 停止所有脚本（红色停止牌） |
| `gandi_observe` | 读运行状态：坐标、造型、变量值、线程数 |
| `gandi_screenshot` | 只截一张舞台图 |
| `gandi_save` | 导出成 `.sb3` |

写脚本前可以先 `gandi_apply` 加 `dryRun: true`：只检查不落地（给 `path` 时还会把改动
套到副本上按编辑器的读法验一遍）。**会让项目打不开的脚本会被拒绝应用**，免得留下半个坏项目。

### 用扩展积木

扩展就是编辑器「添加扩展」里那些类别。它的积木在**载入之前不存在**，所以顺序是固定的：

```
gandi_extension {action: "load", id: "music"}     # 载入，并把方言打出来
gandi_apply {xml: "…<block type=\"music_playDrumForBeats\">…"}
```

`gandi_extension` 的输出里带着这个扩展每个积木的 opcode、输入名、下拉 shadow 类型和字段名，
照着写就行。三条规则：

- opcode **带扩展 id 前缀**（`music_restForBeats`、`pen_penDown`）——前缀就是"编辑器要载入谁"。
- 下拉的字段名**不一定等于**菜单名：`music_menu_DRUM` 用 `DRUM`，`pen_menu_colorParam` 用 `colorParam`。
  从 `gandi_extension` 的输出里抄，别按名字猜。
- 没载入就写它的积木，`gandi_apply` 会**拒绝**并告诉你该载入哪一个（而不是写出一个跑起来没反应的积木）。
  只改文件（给 `path`）时没有编辑器可问，积木按名字写进文件、扩展记进文档，编辑器打开时自己载入。

载入扩展是编辑器自己的动作（和用户点「添加扩展」同一条路），所以载入后**工具箱里也会出现这个类别**，
用户能自己拖这些积木。

**整个库都能用**：逐个载入实测过，编辑器目录里 89 个未禁用的扩展**成功了 88 个**
（唯一失败的 `whiteBoard` 是编辑器自己载不动它——手点「添加扩展」也是同样的错）。

> **注意：有几个扩展是"设备类"的**（`GandiKamera`、`faceSensing`、视频侦测…）。
> **只要载入它们，编辑器就会打开摄像头/麦克风**——不需要真的去用那些积木，而且编辑器不会主动关。
> `gandi_extension {action:'list'}` 会给这些 id 打 `[uses a device]` 标记；插件在载入后会**主动把设备关掉**，
> 并在结果里说明刚才开了什么。你自己在 Gandi 里点「添加扩展」时同样会发生这件事。

### 运行是确定的：30 帧/秒

`gandi_run` 跑的时候会**暂停编辑器自己的步进循环**，只由插件按 `1000 / currentStepTime`
的真实节奏推进。所以同样的命令跑两次结果一致，也**和 Gandi 窗口在不在前台无关**。

这一条曾经是错的，而且错得很隐蔽：用户点过一次绿旗之后，编辑器自己那个 30 Hz 的循环
（`runtime.frameLoop`，`setInterval` 驱动 `runtime._step`）还在跑，插件再推进 30 次，
项目一秒就走了 60 帧——前台翻倍、后台正常。一次真实交付就是按这个"实测 60 fps"
把物理常数调快的。`node tools/e2e.mjs` 里有一条守着它（循环体带 `wait 0` 的计数器，
一秒应该数到约 30）。

### 测交互的正确姿势

按键要按在**项目跑起来之后**。先按键再点绿旗是不行的——绿旗会停掉所有脚本并清空按键状态。
所以用 `gandi_run` 的 `input`：

```
gandi_run {seconds: 1, input: [{atSeconds: 0, key: 'space', isDown: true}]}
```

想测"按住会走、松开就停"，把两条都写进同一次运行：

```
gandi_run {seconds: 1, input: [
  {atSeconds: 0,   key: 'space', isDown: true},
  {atSeconds: 0.5, key: 'space', isDown: false}
]}
```

## 两种用法

| | 对着 Gandi 用 | 直接改文件 |
| --- | --- | --- |
| 前提 | 编辑器页签开着 | 只要一个 `.sb3` |
| 读 | `gandi_inspect` | `gandi_inspect {path}` |
| 写 | `gandi_apply` | `gandi_apply {path}`（可 `outPath` 另存） |
| 跑 / 看 | `gandi_run` / `gandi_screenshot` / `gandi_input` | 做不到——没有编辑器就没有运行时 |
| 画造型、加声音、建变量、建角色 | 都可以 | 做不到（这些要用到运行时） |

两种方式用**同一套脚本格式**，所以「读出来 → 改 → 写回去 → 打开看」是一条完整通路。

路径默认限制在会话工作目录内；要写到外面得显式开 `allowOutsideWorkspace`。

## 排错

| 现象 | 原因与做法 |
| --- | --- |
| `editor tab: none` | 正常：Gandi 停在项目浏览器。任何 `gandi_*` 调用都会开一个页签 |
| `Gandi is already running … but nothing is listening on the configured debug port` | 那个 Gandi 启动时没带端口，**插件没关它**。用 `gandi_launch {launcher: true}` 造的快捷方式重开一个，或（问过用户后）`gandi_launch {restart: true}` |
| `a Gandi IS running and attachable on port 8315 … configured for 9222` | 你的 Gandi 在别的端口上。把 `port`（或 `GANDI_PORT`）改成那个端口，或者让它按当前端口重启 |
| `no Gandi executable found` | 设 `appPath` 或 `GANDI_APP_PATH` |
| 工具没出现在模型目录里 | 确认 `dsh --profile <p> --dump-config` 里有 `gandi` 行，然后重启 DSH |
| 页签一直停在「载入作品 / 下载作品数据中…」 | 桌面版"导入本地 .sb3"这条官方路径有启动竞态（见 `docs/gandi-spike.md` 第 9 条）。插件不走它：关掉那个页签，用 `gandi_open` |
| 模型说在改，但我在 Gandi 里只看到主页 | 看 `gandi_status` 的 `editor on screen:` 一行。多半是 Gandi 被别的窗口挡住了（插件不抢焦点），或者你点了主页——下一次改东西之前它会自己切回来 |
| 编辑器开不出来 / 一片空白 | 检查网络和登录状态；编辑器是 `www.ccw.site` 上的网页 |
| 脚本跑了但画面没变 | 不是 bug：截图前会主动重绘。若用了 `screenshot: false`，画面可能还是旧的 |
| 截图变成了一个文件路径 | 这个部署没有图片附件服务，插件按设计写成 PNG 文件，读那个文件即可 |
| 图看着像空的 / 两次运行的图一模一样 | 输出里会写明 "byte-identical to the previous one"。改用 `gandi_screenshot {savePath}` 读文件确认 |
| 项目打不开，报 `Extension not found: xxx` | 有个积木的 opcode 不是 Scratch 积木（多半是下拉菜单的 shadow 写错了）。`gandi_verify {path}` 会指出是哪一个 |
| 项目打不开，报 `Cannot read properties of undefined (reading 'length')` | 自定义积木的 `<mutation>` 少了编辑器要读的字段。重新 `gandi_apply` 一次即可（编译器会补全），或用 `gandi_verify` 找出来 |
| 克隆体一个都没有，却没有任何报错 | 极可能是 `CLONE_OPTION` 的 shadow 不是 `control_create_clone_of_menu`。看 `gandi_status` 里的 `clone(s)` 计数 |
| `session ... is driving Gandi` | 另一个会话持有编辑权。等它空闲（默认 60 秒），或传 `force: true`，或 `gandi_lease {action:'take'}` |
| 想改磁盘上的项目，但编辑器里的工程是坏的 | `gandi_open {path:'…', force: true}` 直接换回来，不用等编辑权 |
| 写文件被拒 | 默认只允许会话工作目录内。改到工作目录里，或设 `allowOutsideWorkspace: true` |
| 按住按键小人不动 | 按键必须按在跑的过程中（见上）。`gandi_input` 是在两次运行**之间**设置状态的 |
| 物理常数调好了但手感还是不对 | 先确认步进率：循环体里放 `wait 0 seconds` 自增一个变量，`gandi_run {seconds:1}` 后应当约等于 30 |
| 写扩展积木被拒，说扩展没载入 | 先 `gandi_extension {action:'load', id:'…'}`（它会告诉你是哪个 id）。扩展积木的输入和下拉只存在于载入之后 |
| `gandi_extension` 说这个编辑器不提供某个 id | 那是别的 Scratch 编辑器（或 TurboWarp）才有的扩展。`gandi_extension {action:'list'}` 打出这台编辑器真正提供的 id |
| 载入了扩展，但积木还是写不进去 | 看 `gandi_apply` 的报错：它点名缺的是哪个扩展。载入是**按编辑器页签**算的，换一个页签（另一个作品）要重新载入 |

## 当前限制

- **云变量没做。**
- **扩展能用，但 Gandi 的"插件"体系（插件设置里填 URL 加载 JS）没做**，也不打算做：
  那是改编辑器的路子，本项目只在外面驱动它。
- **扩展要显式载入**：插件不会因为你写了一个 `music_*` 积木就偷偷替你载入（`gandi_apply` 会拒绝并告诉
  你该载入哪个）。载入是编辑器自己的动作，所以会出现在工具箱里——用户也能自己拖这些积木。
  载入状态按页签算，换作品要重新载入；载入过的扩展**不会**因此写进工程，只有真的用了它的积木才会。
- **它不是 Gandi 的插件。** 不会出现在 Gandi 的插件设置里，也不改 Gandi 的界面或代码——
  它是从外面通过调试端口驱动编辑器，所以 Gandi 得开着、并且带调试端口。
- **不发布到 npm**，所以不能按包名安装，要指定路径：
  `dsh plugin --profile <p> add E:/dsh-gandi`。
  （顺带说明：`dsh plugin` 本身就是把参数转发给 profile 目录里的 pnpm，没有额外的插件市场。）
- 只在 `dsh-tui` 和 web 上验证过，**没在 desktop surface 上验证**。
- 「新建角色」的实现是"复制一个已有角色，再把脚本、私有变量和造型清空换成你给的"，
  所以项目里至少要有一个角色可复制——这就是新建项目会自带一个起始角色的原因。
- 每次连上编辑器要等约 10 秒：Gandi 启动时总要载入一个默认项目，插件得等它载完
  才能安全地换成你的项目。这不是可以省掉的等待。
- **插件打开的编辑器视图没有标签。** Gandi 的标签栏只登记它自己开的作品，所以那个视图
  不能靠点标签回来；插件靠"切回最前"（见《你能看见模型在做什么》）保证它在你眼前，
  但如果你在 Gandi 里关掉它（没有标签，正常也点不到），下一次调用会再开一个。
- **绝不抢窗口焦点**：Gandi 在别的窗口后面时，你在切回去之前看不到进度。
  这是用户的显式选择，不是没做。
- **一个没带调试端口的 Gandi 无法接管**（Chromium 的限制），插件只会拒绝并说明，
  不会替用户关掉它。
- **载入设备类扩展会开摄像头/麦克风**（见《用扩展积木》）。插件载入后会主动关掉并如实报告，
  但"要不要载入"这件事本身是你（或模型）决定的——列目录时会标出来。
- **`whiteBoard` 这个库内扩展在这台编辑器上载不动**（编辑器自己抛 manifest 错），
  手点「添加扩展」也一样。其余 88 个实测都能载入。

## 卸载

```powershell
dsh plugin --profile dsh-tui remove dsh-gandi
dsh plugin --profile web     remove dsh-gandi
```

删掉即可完全还原：它不写应用数据目录，不改 Gandi，也不打包任何 Scratch 美术资源
（起始造型和背景都是插件自己画的几行 SVG）。

唯一一处例外是**你自己要求的那次**：`gandi_launch {launcher: true}` 会在
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Gandi (DSH attachable).lnk` 放一个快捷方式，
`gandi_launch {patchShortcuts: true}` 会改已有快捷方式的参数。删掉那个 `.lnk`
（用 `patchShortcuts` 的话，把参数里多出来的 `--remote-debugging-port=…` 去掉）就回到原样。

---

## 想改这个插件

开发相关的约定、上游陷阱、怎么跑测试、怎么加新工具，都写在
[`AGENTS.md`](./AGENTS.md) 里；Gandi 侧的实测结论（含出处）在
[`docs/gandi-spike.md`](./docs/gandi-spike.md)。这两份是给**改代码的 agent** 看的，
这份 README 是给人看的。

一句话版本：

```powershell
node --test                 # 单元测试
node tools/e2e.mjs          # 验收测试（会驱动真的编辑器）
```
