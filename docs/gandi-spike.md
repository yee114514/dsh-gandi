# Gandi 移植：实测报告

这个文件记的是**在真的 Gandi 上量出来的结论**，不是从文档推的。每一条都改了代码，
每条都带可复现的证据（探针脚本在 `tools/spike-gandi-*.mjs`）。

TurboWarp 时代的记录在 `docs/spike.md`：其中与编辑器无关的部分（编译器、离线 `.sb3`、
积木两种表示）在 Gandi 上照样成立，这里不重复。**新的 Gandi 结论写在这里。**

## 实测环境

| 项 | 值 |
| --- | --- |
| Gandi Desktop | 1.0.5（`E:\Gandi\Gandi.exe`） |
| 运行时 | Electron 30.1.0 / Chrome 124 / V8 12.4 |
| 调试端口 | `--remote-debugging-port=9222`，冷启动约 10 秒就绪 |
| 编辑器 | `https://www.ccw.site/gandi?tabId=…&lang=zh-cn`，标题「编辑器 - 共创世界」 |
| 上游源码 | `Gandi-IDE/scratch-vm`（MIT，公开），包名 `@xigua/scratch-vm` 1.26.1，描述里写着 "merged tw-vm" |
| 验收 | `node tools/e2e.mjs` **67/67 通过** |

## 1. 挂接模型：shell 和编辑器是两个 target

Gandi 的主窗口是一个 `file://` 页面（`Gandi Desktop`，项目浏览器），**编辑器不在里面**：
每开一个作品，主进程会造一个 `WebContentsView` 指向 `www.ccw.site/gandi/…`，
它在 CDP 里是**独立的一个 page target**。

```
page  Gandi Desktop       file:///E:/Gandi/resources/app.asar/out/renderer/index.html
page  Gandi Desktop HomePage  file:///E:/Gandi/resources/app.asar/out/renderer/home.html
page  (编辑器)             https://www.ccw.site/gandi?tabId=…
```

所以"attach"这件事和 TurboWarp 不同，是两步：**先找到 shell，向它要一个页签，再连那个页签**。
要页签只有一个调用——shell 自己的「创建作品」按钮就是这么做的：

```js
await ViewPreload.addView({ url, tabId, offline, lang })
```

URL 是 `${EDITOR_ORIGIN}/gandi?tabId=${tabId}&lang=${lang}`（`EDITOR_ORIGIN = https://www.ccw.site`）。
不用开新页签就 `tabId` 不给。

顺带三条实测事实：

- **Gandi 没有单实例锁**（TurboWarp 有），所以"已经在跑但没端口"只需重启一次即可，
  不用像 TurboWarp 那样必须让用户先关掉。
- **主进程不处理 `commandLine` 里的调试开关**，但 Electron 本身认，直接传就行。
- 启动后停在项目浏览器，**一个编辑器页签都没有**。这是正常状态，不是错误：
  `gandi_status` 会照实说 `editor tab: none`，而任何别的 `gandi_*` 调用都会先要一个页签。

探针：`node tools/spike-gandi-targets.mjs`。

## 2. 找 VM：Gandi 没有 `window.vm`

这是整个移植最关键的一条。TurboWarp 把 VM 放在 `window.vm` 上，Gandi 不：

```
Scratch.vm === null     // 而且一直保持 null
```

为什么？上游 `src/extension-support/extension-load-helper.js` 在加载完扩展后**主动清空**：
它先把 `global.Scratch` 浅拷贝一份，再把 `vm` / `runtime` / `renderer` 置为 `null`
（注释里写了理由：扩展可能还留着旧引用，所以要克隆再清）。
所以 `window.Scratch` 长期只剩 `Cast` / `Color` / `ArgumentType` 这些静态工具。

**VM 实际在哪儿：Redux 里。** 插件的容器组件是这么接线的：

```js
// 插件 wrapper 的 connect：vm: e.scratchGui.vm
const sW = Object(c.b)(e => ({ vm: e.scratchGui.vm, theme: …, … }))
```

于是 VM 可以从两个地方拿到，两条路实测指向**同一个对象**：

| 路 | 怎么走 | 稳定性 |
| --- | --- | --- |
| Redux store | React 根的 `Provider` fiber 上 `memoizedProps.store` / `stateNode.store` → `getState().scratchGui.vm` | 首选：`scratchGui.vm` 是插件系统公开依赖的字段 |
| `vm` prop | 遍历 fiber，找 `memoizedProps.vm` 是 VM 的组件 | 兜底：store 形状变了还能用 |

`src/bridge/gandi-vm.mjs` 把这两条路（外加"顺手看看 `window.Scratch.vm`"）做成一段页面侧表达式，
并**按形状**认 VM（有 `greenFlag`、有 `runtime`、有 `editingTarget`），不用 `instanceof`
——编辑器 bundle 里没有可比的类。结果缓存在页面上，但**每次调用都重新校验**：
编辑器可能换掉 VM，用到一个已经死掉的引用会让后面所有操作都像"项目是空的"。

探针：`node tools/spike-gandi-find-vm.mjs`、`node tools/spike-gandi-vm-api.mjs`。

## 3. 编辑器启动有竞态：写早了会被丢掉

**这是最容易浪费一整个调试周期的一条。**

页面加载后 VM 对象大约 2 秒就存在了，但它**那时候还没有项目**；编辑器会在
9–12 秒左右载入自己的默认项目，**把之前的东西整个替换掉**。

```
5884ms  vm 找得到
6696ms  targets=[]
7210ms  targets=[]        ← 此刻 loadProject 会成功返回，然后被清掉
9429ms  targets=[Stage,角色1]   ← 编辑器自己载入了
```

症状：`vm.loadProject(bytes)` 正常 resolve、不报错，但过一会儿项目里是
编辑器自己的 `Stage + 角色1`。看起来像"我的项目根本没载入"。

**修法是等它稳定**：`waitForVm` 轮询目标列表，要求**连续两次相同且非空**才算就绪。
这条门用同一套项目连测三次（`tools/spike-gandi-ready-gate.mjs`），三次都正确载入。

代价是每次连上要等 ~10 秒。这个等待是必要的：Gandi 的编辑器**总是在启动时载入
一个默认项目**（模板作品），没有"空编辑器"这种状态。

## 4. 积木：`vm.createBlock` 不存在，走 `target.blocks`

TurboWarp 的 VM 上有 `createBlock` / `deleteBlock`（其实是转发给 `editingTarget.blocks`）。
Gandi 的 VM 上**没有**这两个方法。上游 `blocks.js` 里它们是 `Blocks` 容器自己的方法，
`blocklyListen` 也是直接调 `this.createBlock(...)`。

所以页面侧写积木改成：

```js
target.blocks.createBlock(block, 'default')   // block 是引擎形式（inputs: {name, block, shadow}）
target.blocks.deleteBlock(id)
target.blocks.getScripts()                    // 同样是"运行时活动数组"，先 [... ] 快照
```

其余不变：`vm.setEditingTarget(id)`、`vm.stopAll()`、`vm.emitWorkspaceUpdate()` 都在。

端到端结果（`tools/spike-gandi-loop.mjs`）：编译一条
`当绿旗被点击 → 将 x 增加 25`，写进 VM，`emitWorkspaceUpdate()` 之后
**编辑器自己的工作区里出现了 3 个积木**（`event_whenflagclicked,motion_changexby,math_number`），
跑 30 帧后 `movedBy = 25`。

工作区本身也换了名字：Gandi 暴露的是 **`window.Blockly`**（不是 `ScratchBlocks`），
主工作区用 `Blockly.getMainWorkspace()`。`gandi-vm.mjs` 里两个都查一遍。

## 5. 注释：九参数，而且没有返回值

Gandi 的 `Target.createComment`：

```js
createComment (id, blockId, text, x, y, width, height, minimized, isRemoteOperation) { … }
```

两个坑：

1. **返回值是 `undefined`**，实例落在 `target.comments[id]`。照 TurboWarp 的写法
   `const c = target.createComment(…)` 拿到的是 `undefined`，之后读 `c.something` 就炸
   （第一次移植正是这么炸的：`target.deleteComment is not a function` 之前先无声地拿到 undefined）。
   现在的写法是**调用后从 `target.comments[id]` 读回来**。
2. **`isRemoteOperation` 要传 `true`**：我们随后就 `emitWorkspaceUpdate()` 把整份 XML
   推给编辑器了，不需要运行时再广播一次"加了条注释"。

另外 Gandi 的 **`target` 上没有 `deleteComment`**。要删注释走 VM 自己的事件处理：

```js
target.blocks.changeBlock({ id: 'n/a', element: 'comment_delete', commentId, blockId }, false)
```

（`blocks.js` 的 `case 'comment_delete'` 分支就是干这个的。）

`Comment` 实例本身仍然必须有 `toXML()`——普通对象塞进 `target.comments` 会让
`emitWorkspaceUpdate()` 报 `toXML is not a function`，这条和 TurboWarp 一样。

探针：`node tools/spike-gandi-comments-sound-shot.mjs`。

## 6. 声音：认历史属性名 `md5`

`loadSound` 第一件事是 `StringUtil.splitFirst(sound.md5, '.')`。只给 `md5ext` 不给 `md5`
的报错是 `Cannot read properties of undefined (reading 'indexOf')`——完全看不出是缺字段。
`vm.addSound(sound, targetId)` 和 `target.addSound(sound)` 都在。

`rate` / `sampleCount` 会被解码结果覆盖（实测传 44100/8820，回读是 48000/1 那种解码器给的数），
所以传什么无所谓，别拿它当断言。

## 7. 截图：`requestSnapshot` 在 renderer 上，且必须自己 `draw()`

- 回调**挂在 renderer 上**：`renderer.requestSnapshot(cb)`；`runtime` 上只有 `requestRedraw`。
  把两者写反的报错是 `rt.requestSnapshot is not a function`。
- `requestSnapshot` 只是 `dirty = true` 并把回调排队；**真正回调是在 `draw()` 里发出的**。
- Gandi 的 `draw()` 被 `if (!document.hidden && !this.frameLoop._interpolationAnimation)` 挡着
  （上游注释：`tw: do not draw if document is hidden or a rAF loop is running`）。
  **窗口在后台时 `document.hidden` 为真，`draw()` 永远不会被应用循环调用**，
  于是回调永远不触发——症状是快照超时。

  正确姿势：`runtime.requestRedraw()` → `renderer.dirty = true` → `renderer.requestSnapshot(cb)`
  → `renderer.dirty = true; renderer.draw()`，全在**同一次 evaluate** 里同步做完。
  `toDataURL` 要在本帧内取，WebGL 的绘制缓冲不跨任务保留。

- 顺带一条会误导人的：`renderer.draw()` 是 `if (dirty || peDirty || needResort) { … }`。
  `requestSnapshot` 会把 `dirty` 置真，所以**紧接着调 `draw()` 一定能进函数体**；
  如果看到 `dirty` 进 `draw()` 后还是 `true`，那说明根本没进函数体（渲染器不是你以为的那个对象）。

## 8. 渲染器是 Gandi 自己的

`runtime.renderer` 的构造器是个被压缩的单字母类，`_useGpuMode`、`layerManager`、
`_gandiShaderManager`、`spineManager` 这些字段在 TurboWarp 里没有。
`rt.renderer.canvas` 是普通 `HTMLCanvasElement`，`renderer.gl` 是 WebGL2。
**没有 `getCanvas()`**（TurboWarp 有）。

所以任何"从 renderer 拿画布"的代码都不要写死方法名，用 `renderer.canvas`。

## 9. 「打开本地 .sb3」这条官方路径有启动竞态，插件不走它

桌面版支持把本地 `.sb3` 拖给 Gandi，走的机制是：

1. shell 调 `ViewPreload.addView({ url, tabId, filePath, saveToCloud })`；
2. 主进程把 `{filePath, saveToCloud}` 存进 `PendingProjectImportMap`；
3. 编辑器页面挂载时调 `GandiEditorPreload.onLoadProjectFromDisk(cb)`，主进程**一次性**把
   `fileData` 交给它；编辑器再造 `File` → `FileReader` → `deserializeProject`。

**竞态在这里**：第 3 步的订阅写在编辑器的 `useEffect(..., [])` 里，条件是 `t && s`
（preload 存在 **且 VM 已经在了**）。冷启动时 VM 还没就绪，这个 effect 就**不订阅**，
而它没有依赖数组、不会重跑。于是文件被主进程读出来了却没人接，页签永远停在
「载入作品 / 下载作品数据中…」。

实测时序（`tools/spike-gandi-open-seq.mjs`）：从 CDP 侧抢先订阅，**能**拿到那份数据
（`delivered: true, bytes: 781`），可见数据一直在等；是编辑器自己错过了。

**结论**：不要依赖这条路径开项目。插件开页签时**不带 `filePath`**，等编辑器稳定后
直接把归档字节交给 `vm.loadProject()`——这条路和 `loadProjectBytes` 完全一样，
也是 e2e 里 `gandi_open` 用的那条。

顺带一个好消息：**不带 `fromComputer=true` 的普通页签没有加载遮罩**，
编辑器正常载入默认项目后就能直接接管。

## 10. 按键必须按在"跑的过程中"

两条都会让"先按键再跑"的测试变成**假通过**：

1. `greenFlag()` 的第一句是 `stopAll()`，还会 `resetKeyPressedCache()`
   ——跑之前投的按键连状态带线程一起被清掉。
2. `当按下…键` **不是每帧轮询**：`scratch3_event.js` 在构造时监听 `KEY_PRESSED`，
   收到事件才 `startHats('event_whenkeypressed', …)`。所以按键必须落在**步进期间**。

顺序对了就正常：

```
greenFlag → postIOData('keyboard', {key:' ',isDown:true}) → 10 帧   ⇒ x = 10
postIOData(...) → greenFlag → 10 帧                                ⇒ x = 0   （被清掉）
```

于是 `gandi_run` 加了 `input` 参数（`{atSeconds, key, isDown}` / `{atSeconds, x, y, click}`），
按键由 Node 侧在指定帧之前投递。

探针：`node tools/spike-gandi-keyboard.mjs`。

## 11. 空白项目必须带背景

`scratch-parser` 会拒绝"舞台一个造型都没有"的项目：

```
{"keyword":"minItems","dataPath":".targets[0].costumes","message":"should NOT have fewer than 1 items"}
```

所以在"新建项目"这条路上，**一个没有资产的 `project.json` 是加载不了的**（JSON 和归档都一样）。
`blankProject()` 现在自带一张 480×360 的白色背景 SVG（自己画的，不打包 Scratch 美术），
`starterProject()` 把它的字节一起交出来。

这条是在 e2e 跑到 `gandi_new` 时才炸出来的——离线单测反而先红了：
`readSb3(writeSb3(blankProject()))` 会报"引用了归档里没有的资产"，正是想要的提醒。

## 12. 页面定时器会被节流到分钟级

窗口在后台时，页面里的 `setTimeout` **不是**按毫秒跑的。踩到的具体后果：
一个 5 秒的"等回调"超时，在一次调试里过了好几分钟才返回，让人以为是页面卡死。

规矩：**页面源码里不要用定时器等待**。等待放在 Node 侧（`await evaluate` 一次一次问，
中间 `sleep`），页面里能同步做完的就同步做完。

**反向的一条**：`runtime._step()` 里"要不要 draw"看的不是定时器，是 `document.hidden`
（见第 7 条）。所以"跑 N 帧"在后台窗口里照样精确——推进由 Node 控制，只是**画面不重绘**。

## 13. 新开的页签 URL 是空的

`ViewPreload.addView` 之后，`/json/list` 里那个 target **会立刻出现，但 `url` 是空字符串**，
要等导航提交才有值。

所以"等编辑器页签出现"不能只按 URL 匹配：第一次移植就卡在这里，
明明日志里能看到 `page:https://www.ccw.site/gandi?tabId=dshmuwjd4ykcb9z`，
`isEditorUrl` 却因为 `url === ''` 判否，白等满 90 秒超时。

修法：`waitForEditorTarget` 接受 `tabId`，按 **target id** 匹配
（`tabId` 就是我们向 shell 要页签时用的那个 id，和 CDP target id 一致）。

## 14. 监视器记录：两种形状

`runtime.getMonitorState()` 返回的是**记录容器**，不是"值映射"，而且两个编辑器的形状不同：

- TurboWarp：`{ map, dirty }`，记录在 `map` 里（一个 `Map`）；
- Gandi：直接就是 `runtime._monitorState`，一个 **Immutable.js OrderedMap**。

按其中一种写死会得到"每行都是 undefined"，或者一串裸 id。现在两种都试
（`values()` / 数组 / `Object.values`），并把字段摊平成
`{id, opcode, params, value, visible, mode}`；**摊不出来就原样透传**，
因为监视器的形状是运行时的事。

## 15. 变量值的渲染

`observe` 原来用 `JSON.stringify(v.value)` 渲染，于是脚本用**文本**输入赋值时显示成
`n="7"`，和数字 `n=7` 分不开。现在按 Scratch 的显示方式来：数字不加引号，
字符串带引号——`n="7"` 和 `n=7` 是**不同**的项目状态，测试也该能区分。
（e2e 里那条断言因此改成找 `="7"`，并且**故意**保留引号。）

## 16. 步进率：编辑器自己有循环，`gandi_run` 必须把它按停

**结论**：Gandi 的 `runtime` 有一个自己的步进循环，`runtime.start()` → `frameLoop.start()`，
而 `FrameLoop` 在这个版本里是 **`setInterval(this.stepCallback, 1000 / framerate)`**
（`framerate = 30`），`stepCallback` 调的就是 `runtime._step`。也就是说：

- 用户在编辑器里点过绿旗（GUI 的处理器会 `vm.start()`）之后，**编辑器自己每秒也推进 30 帧**；
- 插件 `runSteps` 又按真实时钟推进 30 帧/秒；
- 于是项目在**前台窗口**下一秒钟走约 60 帧，在**后台窗口**下只走约 30 帧
  （后台页面的 `setInterval` 被节流，实测几乎不触发）。

一次真实交付量到自己的帧计数器是 `gandi_run` 报的帧数的 **1.85~2.06 倍**，
于是得出"实际是 60 fps"，把整套物理常数按双倍速调了一遍。

**修法**：`runSteps` 在按绿旗之前 `frameLoop.stop()`（原来是 `_steppingInterval` 就
`clearInterval`），跑完用 `runtime.start()` 还原——**只在原本就在跑的时候还原**。

实测（`node tools/e2e.mjs`，循环体带 `wait 0 seconds` 的计数器）：

```
[PASS] one second of project time is ~30 frames, not ~60 — counter after 1s: 29
```

**另一条容易搞混的事实**：`永远 { 改变变量 1 }`（循环体里没有任何等待）**不是帧计数器**。
scratch-vm 给一个线程每帧 `75% × currentStepTime` 的**工作时间预算**，
非等待类积木会一直执行到用完为止——同一个探针测到一秒 **663162** 次。
要数帧就在循环体里放一个 `wait 0 seconds`（它恰好 `util.yield()` 一次）。

## 17. 下拉菜单的 shadow 只能从编辑器里读出来

`<shadow type="…">` 里的 opcode **不是一个可以推理出来的东西**：菜单（造型、按键、克隆对象…）
在 sb3 里是**真实的 `shadow: true` 积木**，而数值/文本是十种会被序列化器**内联**的 primitive。
把菜单的 opcode 写错有两种后果，都很贵：

- 写成另一个菜单：积木照样能建、能存、编辑器里也长得对，只是**读不到值**——
  `create clone of` 读不到 `CLONE_OPTION`，一个克隆体都不产生，**全程没有任何报错**；
- 写成 `broadcast_msg`（那是**变量声明的 type**）：影子块进了 `blocks` 表，
  反序列化器按 `opcode.split('_')[0]` 当成扩展 id 去加载 → `Extension not found: broadcast`，
  **项目直接打不开**。

**证据来源**：编辑器的工具箱 flyout 会渲染每个积木和它默认挂的 shadow，
`tools/spike-gandi-blocks.mjs` 把它整个 dump 出来（`Blockly.getMainWorkspace().getFlyout()
.getWorkspace().getAllBlocks()`，读 `inputList[].connection.targetBlock()`），
`tools/gen-block-table.mjs` 再把它生成 `src/scratch/menus.mjs`。生成出来的对照表里
`event_broadcast.BROADCAST_INPUT → event_broadcast_menu`——**不是** `broadcast_msg`。

注意：`Blockly.Blocks` 在 Gandi 里**不存在**（`window.Blockly` 只有
`Events/Utils/Xml/Mutator/ContextMenu/getMainWorkspace/Msg/ScratchMsgs` 八项，没有
`ScratchBlocks`，`getAllBlocks` 在主工作区上是空的），所以"遍历块定义"这条路走不通，
只能读 flyout。另外 flyout 的内容依赖工程状态：没有列表时"变量"分类里就没有列表积木，
所以生成的表是**部分**的——查不到的东西一律不校验，绝不因为"没见过"就拒绝。

## 18. 造型/声音的增删改：方法在 Target 上，不在 VM 上

`vm.renameCostume(index, name)` / `vm.deleteCostume(index)` **只作用于当前选中的角色**
（内部是 `this.editingTarget.…`），所以在多角色工程里用它们是错的。
真正能用的是 Target 上的：

```
target.renameCostume(index, name, fireEvent = true)   // 名字会过 unusedName，可能被去重改名
target.deleteCostume(index, fireEvent?)               // 越界返回 null；只剩一张时也返回 null
target.renameSound(index, name, fireEvent = true)     // 顺带改掉脚本里引用它名字的 sound_play
target.deleteSound(index)                             // 不会改脚本引用
target.getCostumeIndexByName(name)
```

两个细节值得记住：`deleteCostume` **不允许删掉最后一张**（返回 `null`，不是抛错），
而 `renameCostume` 的返回值是 `undefined`——新名字要**从 `getCostumes()[index].name` 读回来**，
因为它可能被加后缀。

## 复现方式

```powershell
# 1. 带调试端口启动 Gandi
Start-Process 'E:\Gandi\Gandi.exe' -ArgumentList '--remote-debugging-port=9222'

# 2. 探针（每个都是独立的顶层程序，自己开页签、自己收尾）
cd E:\dsh-gandi
node tools/spike-gandi-targets.mjs        # 有哪些 target
node tools/spike-gandi-vm-api.mjs         # VM 在哪、有哪些方法
node tools/spike-gandi-boot-timeline.mjs  # 启动竞态的时序
node tools/spike-gandi-loop.mjs           # 写积木 → 工作区 → 跑 → 看位移
node tools/spike-gandi-keyboard.mjs       # 按键帽子的正确顺序
node tools/spike-gandi-comments-sound-shot.mjs
node tools/spike-gandi-renderer.mjs       # 渲染器与截图路径
node tools/spike-gandi-blocks.mjs         # 工具箱 flyout：每个积木的输入与下拉 shadow（第 17 条）
node tools/spike-gandi-sprite-api.mjs     # 造型/声音的增删改入口（第 18 条）
node tools/spike-gandi-step-rate.mjs [--front]   # 谁在推进运行时、每秒推进几次（第 16 条）

# 2b. 从 flyout dump 重新生成编译器的方言表
node tools/gen-block-table.mjs            # .spike/blocks.json -> src/scratch/menus.mjs

# 3. 验收（会快照并还原它所在的那个页签）
node tools/e2e.mjs
```

## 移植时改过的地方（备忘）

- 页面源码不再用 `window.vm`，每条都以 `${vmBootstrapSource()}` 开头；
  `test/page-source.test.mjs` 现在会**把每个页面源码模板解析一遍**，专门拦这类错误。
  （第一版移植里 `const vm` 被插了两次，只有真机 e2e 才发现。）
- `waitForVm` 从"目标非空即可"改成"连续两次相同且非空"，等的是第 3 条那个竞态。
- 截图从"注册回调然后等"改成"同一帧里 redraw + snapshot + draw"。
- `gandi_run` 多了 `input`，按键在跑的过程中投递。
- 空白项目带背景（第 11 条）。
- `runSteps` 在跑之前**按停编辑器自己的步进循环**，跑完还原（第 16 条）。
- 编译器多了方言校验：下拉 shadow 必须是该输入的那个 opcode，非下拉输入只接受 primitive，
  `<mutation>` 一律补齐编辑器要读的字段（`tagName`/`children`/`warp`）。
  表是生成的（第 17 条），校验只对表里有的积木生效。
- 跨片段的自定义积木调用按 `proccode` 去目标角色已有定义里取 argument id。
- `tools/` 下 TurboWarp 时代的探针没有删：它们仍然是"上游怎么工作"的证据，
  只是连着 `tw-editor://` 跑不通了。
