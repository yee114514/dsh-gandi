# AGENTS.md

给**在本仓库里干活**的 AI agent 看的。用户文档在 `README.md`；
给"用这个插件写 Scratch 项目"的模型看的说明在 `skills/gandi-scratch-authoring/SKILL.md`。
三者受众不同，不要互相搬运。

先读这一节，其余按需查。

## 三条硬规则

1. **不要修改 Gandi 的任何代码。** 桥接只在运行时通过 CDP 驱动它：不碰 `app.asar`、不反编译、
   不注入脚本文件。安装目录（`E:\Gandi`）只读，也**不要**把解包出来的代码当上游读——
   上游是公开的 `Gandi-IDE/scratch-vm`（见 `docs/gandi-spike.md`），那才是该对着写的地方。
2. **零第三方依赖。** 只能用 `node:*`。这个包是被加载进宿主进程的，多一个依赖就多一份
   拖垮宿主启动的风险。已有能力都是手写的：ZIP 读写、XML 解析、WAV 编码、CDP 客户端
   （用 Node 全局 `WebSocket`）。
3. **可选服务一律软探测，缺了必须静默降级。** `attachments` / `skills` / `systemPrompt`
   在有些部署里不存在；拿不到就走降级路径（例如截图写成 PNG 文件并告诉模型去读），
   **绝不能因此抛错或影响宿主启动**。

## 目录地图

| 位置 | 是什么 |
| --- | --- |
| `src/index.mjs` | 插件入口：17 个工具的注册、参数校验、输出渲染。改工具面只改这里 |
| `src/plugin/service.mjs` | 进程级单例 `BridgeService`：互斥链、会话租约、attach 判定、错误话术 |
| `src/bridge/cdp.mjs` | CDP 客户端（零依赖）。`evaluate` / `callFunction`，错误会带**页面侧调用栈** |
| `src/bridge/app.mjs` | 找与记住 `Gandi.exe`、探测 target、拉起、向 shell 要一个编辑器页签、等编辑器就绪 |
| `src/bridge/gandi-vm.mjs` | 页面侧**找 VM** 的解析器与引导片段（Gandi 没有 `window.vm`，见下） |
| `src/bridge/ops.mjs` | **所有页面侧操作都在这里**，页面源码以模板字符串内嵌，每条都以 `${vmBootstrapSource()}` 开头 |
| `src/scratch/xml-parse.mjs` | 够用的 XML 解析器（含 `escapeXml`） |
| `src/scratch/xml.mjs` | 编译器、反编译器、自定义积木展开、注释收集、孤儿清理 |
| `src/scratch/primitives.mjs` | 原语常量表，**改动前先核对上游** |
| `src/scratch/engine.mjs` | 线形式 ↔ 引擎形式，**双向**都要维护 |
| `src/scratch/sb3.mjs` | `.sb3` 归档读写、`blankProject` / `starterProject` / `buildSprite` |
| `src/scratch/project.mjs` | 离线项目层：读角色、拼片段、写回文档 |
| `src/scratch/zip.mjs` / `wav.mjs` / `svg.mjs` / `keys.mjs` | 手写的小工具 |
| `test/` | 163 项单元测试，全部离线可跑 |
| `tools/e2e.mjs` | 验收测试：走真实工具面驱动真编辑器 |
| `tools/cleanup-editor.mjs` | 把编辑器恢复到确定的基准（**会先备份**） |
| `tools/spike*.mjs` | 探针（`.spike/` 下还有一批 Gandi 移植期的，编号见下）。不是历史垃圾，是"上游到底怎么工作"的可执行证据。注意 `tools/` 里几个是 TurboWarp 时代的，连着 `tw-editor://` 目标跑不通，别把它们当 Gandi 的基线 |
| `docs/gandi-spike.md` | **Gandi 侧**的实测结论（挂接模型、找 VM、积木/注释/声音/截图的真实调用方式）。新发现要追加 |
| `docs/spike.md` | TurboWarp 时代的踩坑记录。其中与编辑器无关的部分（离线 `.sb3`、编译器、积木表示）仍然有效；带 `tw-editor://` 的复现步骤已经过时。**新的 Gandi 结论写进 `docs/gandi-spike.md`** |
| `skills/gandi-scratch-authoring/SKILL.md` | 给写 Scratch 的模型看的方言速查 |

## 常用命令

```powershell
cd E:\dsh-gandi
node --test                                  # 全部单测（必须在插件根目录跑）
node --test test/xml.test.mjs                # 单个文件
node tools/cleanup-editor.mjs --reset        # 把编辑器重置成确定的基准（先备份到 backups/）
node tools/e2e.mjs                           # 验收测试（会快照并还原用户项目）
node tools/e2e.mjs --keep                    # 保留改动，自己看
node tools/spike-procedures.mjs              # 例：问编辑器"自定义积木的 XML 长什么样"
```

装到 profile 里：

```powershell
dsh plugin --profile dsh-tui add E:/dsh-gandi
dsh plugin --profile web     add E:/dsh-gandi
dsh --profile <p> --dump-config | Select-String gandi    # 确认真的装上了
```

第一次 `add` 可能因下载中断**静默回滚**（`package.json` 不变），重跑一次。
**DSH 不热重载宿主面插件**：改完代码必须让用户重启 DSH 才生效，别声称"改好了就能用"。

## 不可破坏的不变量

1. **两种积木表示，方向要对上。** 线形式（压缩）是数组协议：
   `[1, ref]` / `[2, id]` / `[3, blockId, shadowRef]`，原语**内联**成裸数组。
   引擎形式是 `{name, block, shadow}`，原语是真实的 `shadow: true` 积木。
   - `fragmentToEngine`：写进运行中的编辑器用（`createBlock` 要引擎形式）。
   - `engineToFragment`：读运行中的编辑器用（反编译器吃线形式）。
   - 纯影子的约定是 **`block === shadow`（同一个 id）**。漏了这条，原语会变成 `[2, id]`
     并永久留在积木表里。
   走错方向的症状是**静默的**：反编译出空脚本，看起来像"这个角色没积木"。
   `test/engine-roundtrip.test.mjs` 守着双向相等。

2. **编译 ↔ 反编译必须闭环。** `compileScripts(decompileScripts(f))` 要与 `f` 深度相等
   （含自定义积木、注释、字段 id、mutation）。这是"读出 → 改 → 写回"能成立的全部依据。
   新增任何语法都要补往返测试。

3. **注释是 target 状态，不是积木。** `target.comments[id]` 里必须是 **`Comment` 实例**
   （渲染走 `comment.toXML()`）。塞普通对象进去，下一次 `emitWorkspaceUpdate()` 会
   `toXML is not a function`——**一加注释就把编辑器的工作区同步弄崩**。
   Gandi 的签名是 `createComment(id, blockId, text, x, y, width, height, minimized, isRemoteOperation)`，
   而且**没有返回值**：实例落在 `target.comments[id]`，要从那里读回来（见 `docs/gandi-spike.md`）。
   另外 `emitWorkspaceUpdate` 会把每条注释**发两次**（工作区级 + 块内），编译器按 id 合并。

4. **编出来的 XML 不带告警才允许应用。** 半个项目比一个报错更难查。
   `dryRun: true` 必须能在**完全离线**的情况下给出告警。

5. **工具面清单是断言过的。** `test/plugin.test.mjs` 比对排序后的工具名数组与
   `concurrencySafe` 划分。加/删工具必须同步改那里。
   只读工具（status/inspect/observe/screenshot/save）`concurrencySafe: true`；
   其余 `mutating: true`，走租约与串行化。

6. **页面源码是模板字符串。** 在那里面写注释**不能出现反引号**——一个反引号提前闭合字面量，
   报错是几十行外的 `missing ) after argument list`。这个坑踩过三次，
   `test/page-source.test.mjs` 静态守着 `src/` 与 `tools/`。
   同一测试还断言 `src/` 每个模块可 import：页面源码的语法错误只有 import 时才暴露，
   对插件而言那就是 DSH 启动时炸。`tools/` **故意不查 import**——import 工具脚本会**执行**它。
   它还**把每个页面源码模板当 JavaScript 解析一遍**（`new Function`）：这是唯一能在离线阶段
   抓住"页面源码语法错"的办法，而移植到 Gandi 的第一版正好栽在这上面（`const vm` 声明了两遍，
   只有真机 e2e 才发现）。新增页面源码时别绕开它。

## 上游事实与陷阱（都实测过，别凭直觉改）

按"照直觉写必错"的程度排序。Gandi 侧的结论与出处见 `docs/gandi-spike.md`；
下表里与编辑器无关的条目（编译器、离线 `.sb3`）在两边都成立。

| 事情 | 真相 |
| --- | --- |
| `Blocks.getScripts()` | 返回**运行时的活动数组**，`deleteBlock` 会就地缩短它。`for (const id of ...getScripts()) deleteBlock(id)` **每隔一个漏一个**，且只在 ≥2 个脚本时出错。一律先 `[...]` 快照 |
| 删脚本 | `deleteBlock` 级联删整摞，但会留**孤儿**（复制自定义积木会多出 `argument_reporter`）。清完要按"从顶层块可达"再扫一遍（`PRUNE_ORPHANS_SOURCE`） |
| 运行项目时的 glow | 替换脚本后运行会抛 `Tried to glow stack on block that does not exist`，**没有调用栈**（是被拒绝的 promise 里的字符串）。发光记账按 block id 记在 UI 层。修法是别请求动画：`thread.js:520` 看 `blocks.forceNoGlow`，运行期间置真、跑完恢复 |
| `Blocks.toXML()` | **不传参就一条注释都不输出**。注释在 target 上，`emitWorkspaceUpdate` 是 `toXML(comments)` 这样调的 |
| 造型资产 | `createAsset(assetType, dataFormat, data, id, generateId)` 是**五个**参数；序列化读的是历史属性名 **`md5`**（`sb3.js:451`），不是 `md5ext`。只设 `md5ext` 会让资产进归档却无人引用，而编辑器里完全看不出来 |
| `assetType` | 必须是真枚举，从 `runtime.storage.AssetType` 取（`load-costume.js:465` 自己就这么取）。`svg` → `ImageVector`，其余 → `ImageBitmap`。早期"从已有造型借一个"对 PNG 是错的 |
| 声音 | `load-sound.js:88-105` 读历史属性名 `sound.md5`，且优先用 `sound.asset`；`format` 对未压缩 PCM 是**空字符串**；`rate`/`sampleCount` 会被解码结果覆盖 |
| 变量 id | `createVariable(null, …)` 会把变量挂在键 `"null"` 下，**下一次创建静默丢失**；改名/删除要按 `Object.entries(variables)` 的**键**，不是对象自报的 `id` |
| `vm.loadProject(projectJson)` | 项目带资产时**永不 settle**（造型加载器等一个谁也注册不了的资产），表现是 120 秒超时且项目**已部分应用**。装东西进编辑器一律走**归档字节** |
| 舞台 | 名字是 `Stage`，不是 `stage`；`target:"stage"` 是插件的大小写不敏感约定。给舞台加背景走 `vm.addBackdrop`，不是 `addCustom` |
| 运行节奏 | `runtime.currentStepTime` 是固定帧长（1000/30），计时块读的是**真实时钟**。必须按真实间隔推进，否则 `wait 1 seconds` 要上千步。被节流的是页面（后台窗口约 1 秒一次），所以节奏由 Node 侧控制 |
| 截图 | 快照回调只在 `draw()` 内部发出，而 `draw()` 在渲染器不脏时直接返回。必须显式 `requestRedraw()` + `dirty = true` + `draw()`。另外**回调挂在 renderer 上**（`renderer.requestSnapshot`），`runtime` 上那个是 `requestRedraw` |
| 找 VM | Gandi **没有 `window.vm`**（加载完扩展后还会把 `global.Scratch.vm` 显式置空）。VM 要从 Redux 的 `scratchGui.vm` 或某个拿到 `vm` prop 的组件上取，`src/bridge/gandi-vm.mjs` 负责这件事 |
| 工作区 | Gandi 暴露的是 `window.Blockly`（不是 `ScratchBlocks`），主工作区用 `Blockly.getMainWorkspace()` |
| 写积木 | `target.blocks.createBlock(block, source)`，**没有** `vm.createBlock`／`vm.deleteBlock` |
| 按键帽子 | `当按下…键` 不是每帧轮询：它由 `KEY_PRESSED` 事件驱动 `startHats`。所以按键必须在项目**步进期间**投递 |
| `greenFlag()` | 会先 `stopAll()` 并 `resetKeyPressedCache()`——**绿旗之前投的按键会被清掉** |
| 舞台造型 | `scratch-parser` 拒绝"舞台一个造型都没有"的项目（`should NOT have fewer than 1 items`），所以空白项目必须带一张背景 |
| `targets[].broadcasts` | sb3 里值是**裸字符串**（`{id: name}`），而 `variables`/`lists` 是 `[name, value]` |
| 编辑器页签的 URL | 刚开出来的页签在 `/json/list` 里 **`url` 是空字符串**，要等导航提交才有值——所以"等页签出现"必须能按 **target id** 匹配，只按 URL 会白等满超时 |
| `document.hidden` | 页面里 `runtime._step()` 无论如何都会推进，但 `draw()` 被 `!document.hidden` 挡着（后台窗口拿不到帧）。截图要自己 `dirty = true` + `draw()`，别等应用循环 |
| 页面定时器 | 后台窗口的 `setTimeout` 会被节流到分钟级。页面源码里**不要**用定时器等待，等待放在 Node 侧 |

## 工作方式：先问，别猜

**每一条上游行为都要有实测依据。** 这个仓库的 `docs/spike.md` 全是"照直觉写被真机打回来"
的记录，而且每一条都改过代码。规矩：

- 要动某个运行时 API，先写一个 `tools/spike-*.mjs` 探针，把**编辑器自己的输出**打出来。
  例：自定义积木的规范 XML 不是我推的，是探针按线格式造一个项目、载入、
  打印它自己 `toXML()` 得到的（`tools/spike-procedures.mjs`）。
- **光看形态一致不够，要真的跑一遍。** 自定义积木写错时照样能写入、能读回、在编辑器里
  也长得对，只有运行起来才暴露（探针会打印 `movedBy`）。
- 报错信息离病因很远时，**先怀疑自己的假设，再怀疑上游**。
  典型：那个 glow 报错折腾了很久，最后靠"先让探针复现 + 打印真实数据"定位，
  而不是继续读代码猜。
- 结论写进 `docs/gandi-spike.md`（Gandi 侧）或 `docs/spike.md`（与编辑器无关的部分），连同**为什么**和出处。

## 测试与验证的规矩

- **基准必须确定。** 失败的运行会把编辑器留在半路状态，而 e2e 是"快照当前项目、最后还原"，
  于是下一次会把上次的残骸当成原始项目，制造一串看起来像真 bug 的失败。
  跑 e2e 前先 `node tools/cleanup-editor.mjs --reset`。
- **动编辑器之前先备份。** `cleanup-editor.mjs` 操作的是"调试端口上那个编辑器"，
  它分辨不出那是可丢弃的测试实例还是别人正在做的东西；替换项目不可逆。
  它现在会先导出到 `backups/` 并打印路径，别把这个行为删掉。
- **e2e 的快照与还原都走归档字节**，不是 JSON（JSON 不含资产，会把项目留成
  "造型引用悬空资产"的样子——还能看能跑，但再也导不出忠实结果）。快照同时写一份
  `.e2e/original-backup.sb3`，因为还原只在跑完时执行，中途崩掉就没有回头路。
- **断言不要依赖历史、语言环境或机器状态**：
  - 名字用每次运行唯一的后缀（Scratch 会给重名自动加后缀）；
  - 角色名从报告里**读**而不是写死（默认项目在中文环境叫 `角色1`）；
  - 桥接错误话术会随"Gandi 是否正在运行、有没有编辑器页签"而变，别把某一种措辞写进断言
    （有一条测试这样写了，并且**因为测试机上恰好开着编辑器而绿了很久**，
    直到编辑器关掉才暴露）。要断言"无论哪种情况都必须为真"的部分：
    端口号有没有被点出来、有没有给出出路。
- **能离线测的就离线测。** 离线测试的假 ctx 故意指向一个**关着的**调试端口，
  任何偷偷去连桥接的实现都会当场失败，而不是在这台恰好开着 Gandi 的机器上蒙混过关。
- 改完的标准动作：`node --test` → `node tools/e2e.mjs`（连跑两遍，第二遍验证还原是干净的）。
  Gandi 侧不需要 `cleanup-editor --reset`：e2e 自己快照并还原它所在的那个页签，
  而每次运行都会新开一个页签，所以上一轮的残骸不会变成这一轮的"原始项目"。

## 已知未做 / 有意不做

- **云变量**：没有实现，也没验证过。
- **不发布到 npm**：安装靠路径或 git 地址。顺带记一条容易搞错的事实：
  `dsh plugin --profile <p> <args>` 只是把参数**转发给 profile 目录里的 pnpm**
  （`lib/bin.js:116`，`add` / `remove` / `why` …），**DSH 没有独立的插件市场**——
  所以别在文档或话术里承诺"上架"之类的事。
- **不做 Gandi 插件**（那种在"插件设置"里填 URL 加载的 JS），也不做 Gandi 扩展积木，
  更不改 Gandi 的界面。本项目是从外面通过 CDP 驱动编辑器。
  顺带记一条：Gandi 的**在线**编辑器确实是靠 `window.Scratch.plugins.register` 注入插件的，
  但那条路要用户自己点开设置填 URL，不是插件该走的路。
- **未在 DSH 的 `desktop` surface 上验证**（只验证了 `dsh-tui` 与 `web`）。
- **新建角色**没有走 `vm.addSprite`（它要求资产已在 storage 里，公开 API 不接受资产对象），
  而是**复制 → 清空 → 换造型**。代价是必须有一个源角色可复制——这就是
  `gandi_new` 会带一个起始角色的原因。
- **不碰用户的云端作品**：Gandi 的编辑器是在线作品，插件只把项目导出到本地 `.sb3`，
  不会替用户保存/发布云端版本。
