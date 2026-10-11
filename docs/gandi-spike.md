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

## 13. 新开的页签 URL 是空的（以及 tabId 不等于 CDP target id）

`ViewPreload.addView` 之后，`/json/list` 里那个 target **会立刻出现，但 `url` 是空字符串**，
要等导航提交才有值。

所以"等编辑器页签出现"不能只按 URL 匹配：第一次移植就卡在这里，
明明日志里能看到 `page:https://www.ccw.site/gandi?tabId=dshmuwjd4ykcb9z`，
`isEditorUrl` 却因为 `url === ''` 判否，白等满 90 秒超时。

~~修法：`waitForEditorTarget` 接受 `tabId`，按 **target id** 匹配
（`tabId` 就是我们向 shell 要页签时用的那个 id，和 CDP target id 一致）。~~

**⚠ 这一条的后半句是错的，2026-10-07 实测更正**：我们给 shell 的 `tabId` 和 CDP target id
**是两个不同的命名空间**。实测：

```
targetId=6CF3A2FEA5275CF8DB2212D349795E49 | urlTabId=dshmuxqnzt03exx | same=false
targetId=2CA5D105691122A9B320316CE3EBF7D5 | urlTabId=dshmuxqdfz2i1be | same=false
```

当时看到"一致"是因为**只有那一个编辑器页签**，而 `byId ?? 任何编辑器 URL` 的兜底把它接住了。
一旦同时存在两个编辑器视图（插件自己就会造出这种局面），按 target id 匹配必然落空，
兜底就会挑到**另一个**页签——症状是"载入的项目没变"（其实载入到了别人身上）。

现在的做法：`editorTabIdOf(url)` 从 URL 里取 `tabId`；带 `tabId` 的等待**只认这个 id**，
不再兜底到"任意编辑器页签"；要关视图时按 `tabId` 反查它的 target id。

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

## 19. 窗口里的视图：谁在最前面，怎么让它到最前面

**背景**：用户报的"模型在编辑，但我在 Gandi 里只看得到主页"就是这一节。
Gandi 的窗口不是一个页面，而是**一个 shell + 一堆视图**：

| 是什么 | target | 说明 |
| --- | --- | --- |
| shell | `file://…/renderer/index.html` | 只有顶部那条标签栏（主页图标、作品标签、`+`） |
| 主页 | `file://…/renderer/home.html` | 项目浏览器（"Gandi IDE / 我的作品 / 探索社区"） |
| 编辑器 | `https://www.ccw.site/gandi?tabId=…` | 每个作品一个 `WebContentsView`，各自独立 target |

同一时刻**只有一个视图在屏幕上**。实测结论（探针 `tools/spike-gandi-surface.mjs`）：

1. **`addView` 造的视图一定在最前面**，而且**不抢桌面焦点**（冷启动逐帧截图验证：
   addView 之后窗口里就是编辑器，而不是主页）。所以"插件自己开的编辑器用户看不见"
   这件事，只发生在**插件接手的旧视图**上。
2. **`addView` 造的视图在标签栏里没有标签。** 标签是 shell 自己的簿记（只有它自己发起的
   "新建作品/打开作品"流程才会加），所以用户**没有标签可以点回去**：一旦被主页盖住，
   就再也回不来了——这正是"只能看见主页"的成因。
3. **`document.visibilityState` 是逐视图的、可信的**：窗口在屏幕上时，**当前视图**读 `visible`，
   其余（含主页）读 `hidden`；整个窗口被别的窗口挡住时**全都**读 `hidden`。
   于是"编辑器 hidden + shell visible"= 用户正看着 Gandi，但看的不是我们的编辑器。
   探针输出：

   ```
   窗口在前台：  dshmux…（我们的） hidden   XJrYP…（App 开的） visible   index.html visible
   点了主页后：  dshmux… hidden            index.html visible
   窗口被挡住：  全部 hidden
   ```
4. **切换视图是有的，但参数必须是对象**：
   `beforeSwitchView({tabId})` + `switchView({tabId})`（两个都调）**真的会把该视图切到最前**，
   对**没有标签的视图同样有效**，而且不重新加载、不丢状态——用第 3 条的可见性读回来确认的。
   - 裸字符串 `switchView(tabId)`、`switchView({id})`、`switchView(1)` 都没有任何效果；
   - **只调 `switchView` 的那次探测是假阴性**：当时既没有成对调用，也没有可见性信号能证伪，
     只看标签栏（而标签栏是 shell 自己的状态，不跟着主进程的切换变）。
5. **关视图也是有的，参数同样必须是对象**：`removeView({tabId})`——这是 App 自己的关闭路径
   （标签上的 ✕ 走的就是它），关掉之后 App 一切正常。
   裸字符串 `removeView(tabId)` 什么也不做（这就是"removeView 是主→渲染的通知"这个错误结论的来源）。
6. **`Target.closeTarget` 关视图会把整个 Gandi 弄死。** 实测两次：关掉之后几秒内 App 退出，
   或者下一次 `addView` 直接 `DevTools connection errored`，端口随之消失。
   原因大概是 App 手里还留着那个已被销毁的 `WebContents` 的引用。
   **插件里不存在这条路**（连 `cdp.mjs` 里的 `closeTarget` 都删了，免得将来有人再捡起来用）。
7. **重复用同一个 `tabId` 去 `addView` 也会把 App 弄死**，而且中间态很迷惑：
   先多出一个 `error.html` 视图，之后 App 才倒。所以 `openEditorTab` 生成 id 时会先查
   target id 与 URL 里的 `tabId` 两个命名空间，确保没被占用。
8. **`Page.bringToFront` / `Target.activateTarget` 不能用**：它们把整个**窗口**抬到前台
   （抢用户的焦点），却**不切换窗口内部的视图**——两件事都做错了。
   用户明确选了"绝不抢焦点"，所以插件一次都不调它。

**插件据此做的事**（`src/bridge/surface.mjs` + `service.mjs`）：

- 每次真正要改东西之前读一次可见性（两次 evaluate，约 10ms）；
- `编辑器可见` → 不管；`窗口在别的东西后面` → 也不管（不抢焦点，等用户回来看）；
- `窗口在屏幕上但显示的不是我们的编辑器` → 先 `beforeSwitchView`+`switchView`（便宜、无损），
  然后**用可见性确认**；确认不了才退回到"造一个新视图 + 把工程用归档字节搬过去 + `removeView` 旧的"
  （这条会丢 undo 历史，所以有一条 30 秒冷却，只约束这条）；
- 每次"动了用户的画面"都会在**下一个工具结果**里带一行 NOTE，说明发生了什么、
  以及有没有丢编辑器内部状态。

探针：

```powershell
node tools/spike-gandi-surface.mjs            # 视图模型、可见性、切换、关闭（含"不要用 closeTarget"的说明）
node .spike/live-verify-visibility.mjs        # 端到端：点主页 -> 下一次工具调用把编辑器切回来（需要窗口在屏幕上）
```

## 20. "Gandi 已经开着"这件事：能做什么，不能做什么

用户的原话是"模型会先关掉我的 Gandi 再自己拉一个，我希望它直接用我已经开着的那个"。
实测下来的硬事实：

1. **一个没带 `--remote-debugging-port` 启动的 Gandi，永远无法被附加。**
   Chromium 的 DevTools server 只在浏览器进程启动时创建，运行期没有任何开关能打开它。
   所以"直接用已经开着的那个"只有一条路：**让它一开始就带着开关启动**。
2. **用户自己的快捷方式不带开关。** 实测本机：

   ```
   C:\Users\Public\Desktop\Gandi.lnk                        -> E:\Gandi\Gandi.exe   args: (空)
   C:\ProgramData\…\Start Menu\Programs\Gandi.lnk           -> E:\Gandi\Gandi.exe   args: (空)
   ```

   于是"用户双击图标打开的 Gandi"永远不可附加——这就是"模型先关掉再拉一个"的根因。
   `src/bridge/launcher.mjs` 因此能造一个**我们自己的快捷方式**（用户级开始菜单，
   不需要管理员）把开关写进去；也可以（显式要求时）把开关写进已有快捷方式的参数里。
3. **能附加的那个 Gandi 可能在别的端口上**：命令行的
   `--remote-debugging-port=<n>`（浏览器进程那一行）和
   `%APPDATA%\gandi-desktop\DevToolsActivePort`（第一行是端口，退出后**不会清理**，所以必须验活）
   都能读出来；读端口号需要 PowerShell（`Get-CimInstance Win32_Process`），
   验证"这真的是 Gandi"看 `/json/version` 的 UA 里有没有 `gandi-desktop`。
   **但配置里的端口仍然是权威**：发现别的端口只用来把话说清楚（"有个能附加的在 8315，
   你配置的是 9222"），不偷偷换过去——和 appPath 同一条规矩。
4. **关掉一个不可附加的 Gandi 只有一个礼貌做法**：`CloseMainWindow()`（等于点窗口的 ✕，
   App 有机会问用户要不要保存），然后等它退出。**绝不 taskkill**：
   那条路上用户没保存的作品会跟着走，而这正是以前"话术让模型去关"的代价。
5. 实测确认的行为（`.spike/live-policy.mjs`）：
   一个不带端口的 Gandi 开着时，`gandi_launch` **不关它、也不再拉一个**，而是报错并给出两条出路；
   只有显式 `restart: true` 才会走第 4 条的礼貌关闭。

## 21. 扩展：积木不是项目的一部分，是**运行时**的一部分

"扩展"就是编辑器「添加扩展」里加的那些积木类别：Scratch 官方的 music / pen /
videoSensing / text2speech / translate …，加上共创世界自己的（CCW3D、GandiAIHub、
box2d、WitCat* 等等）。实测这台机器上编辑器一共提供 **93 个**扩展 id。

关键区别，也是这一条存在的理由：

> **扩展积木不在工程文件里，直到扩展被载入运行时。** 一个 `music_*` 积木的 opcode、
> 它的输入名、它下拉菜单的 shadow 类型——这三件事只存在于 `runtime._blockInfo`。
> 所以"支持扩展"不能是一张写死的表，只能"问编辑器"（和 `menus.mjs` 是 dump 出来的一样）。

实测事实（探针：`tools/spike-gandi-extensions.mjs`、`tools/spike-gandi-extension-project.mjs`、
`tools/spike-gandi-extension-dialect.mjs`）：

1. **入口在 `vm.extensionManager`（`vm.runtime.extensionManager` 是同一个）。**
   `loadExtensionURL(id)` 两种都吃：
   - 内置的（`isBuiltinExtension(id)`，本机 13 个：`pen` `wedo2` `microbit` `text2speech`
     `translate` `videoSensing` `ev3` `makeymakey` `boost` `gdxfor` `tw` `teaching` `coreExample`）
     → 直接 `loadExtensionIdSync`，**不联网**；
   - 库里其余的 → 它自己去 `runtime.ccwAPI.getExtensionURLById(id)` 要 bundle 地址再拉。
   传一个不存在的 id 会 reject——这就是"这个编辑器能不能载入它"唯一诚实的答案。
2. **载入后 `runtime._blockInfo` 多一项**：`{id, name, color1, blocks, menus}`。
   `blocks[i].info.opcode` 是**不带前缀**的（`restForBeats`），而写进工程的 opcode
   **带前缀**（`music_restForBeats`）。前缀是注册时加的，插件得自己加。
3. **`info.arguments` 是对象，不是数组**（按参数名键），下拉参数用 `menu` 指向菜单名。
   菜单 shadow 的 opcode 规则是 `<extId>_menu_<menuName>`——但**别自己拼**：
   `_blockInfo` 的菜单项里带着生成好的积木 JSON，它的 `type` 字段就是权威
   （自己拼的时候踩过：`menu` 项上没有 `name`，拼出来是 `music_menu_` 这种空名）。
   同一个 JSON 的 `args0[]` 给出**字段名**（`music_menu_DRUM` 的字段叫 `DRUM`，
   `pen_menu_colorParam` 的叫 `colorParam`——不是同一个词，猜不得）。
4. **`info.text` 决定语句输入**：循环是 `%1 {SUBSTACK} %2`，分支是
   `%1 {SUBSTACK} %2 {SUBSTACK2} %3`。按 `blockType` 猜会把两件事猜错一次。
5. **工程文档里的字节形态**（这是离线编译器必须产出的东西，实测读回来核对过）：

   ```json
   "extensions": ["music"],
   "blocks": {
     "9acoXo": { "opcode": "music_playDrumForBeats", "inputs": {
        "DRUM":  [1, "x5eOLr…"],          // 下拉 = 真实 shadow 积木，按 id 引用
        "BEATS": [1, [4, "0.5"]] }, … },  // 普通输入 = 内联原语
     "x5eOLr…": { "opcode": "music_menu_DRUM", "fields": { "DRUM": ["3"] }, "shadow": true, … }
   }
   ```
6. **`loadProject` 只认 opcode 前缀，`extensions` 数组不是触发器**：把同一个工程里的
   `extensions` 数组删掉再载入，编辑器照样自己把 music 载起来（靠 `opcode.split('_')[0]`）。
   数组仍然要写——别的 Scratch 工具读它——但它不是"能不能打开"的原因。
7. **存取闭环是通的**：载入含 music 的工程 → 编辑器载入扩展 → 存盘 → 再读回来，
   opcode、菜单 shadow、`fields.DRUM` 的值全部**逐字节保持**。
8. **Gandi 的 pen 扩展注册了一个 opcode 是 `undefined` 的积木**
   （`text: "Stage selected: less pen blocks"`）。它不是可写的积木，方言里被过滤掉。
9. **`gandi_save` 不用替编辑器补 `extensions` 数组**：序列化器自己会写（第 7 条）。
10. **整个库都能载入，除了一个**：把目录里 89 个未禁用的扩展逐个载入
    （`tools/spike-gandi-extension-batch.mjs`），**88 个成功**并且都立刻给出了可读的积木信息
    （0 个异步晚到，0 个空积木，0 个菜单没有 `type`）。唯一的失败是 `whiteBoard`：
    编辑器自己抛 `Cannot read properties of undefined (reading 'manifest')`——
    这是**编辑器**载不动它，用户手点「添加扩展」也是同样的错，插件做不了什么。
11. **载入"设备类"扩展会把设备打开。** 这是这次踩到的坑，而且代价是用户的摄像头：
    摄像机相关的扩展（`GandiKamera`、`faceSensing`、`GandiMedia`、`GandiSpineSkeleton`、
    `Gandi4DPocket`、`GandiDolly`、`witCat.dollyPro`、`sipc.ink.Recording`…）**只要被载入**
    就会打开摄像头/麦克风——不需要真的去用它的积木。而且**没有任何东西会把它关掉**：
    Windows 的摄像头使用记录里 `E:\Gandi\Gandi.exe` 留下了 `lastUsedStop=0`（只有它这条），
    一直到把 Gandi 关掉才写回 stop。
    插件现在的处理：`loadExtension` 载入后**扫一遍活的 MediaStreamTrack 并 stop()**，
    把"开了什么、已经关掉"如实写进工具输出；`gandi_extension {action:"list"}` 给这些 id
    打 `[uses a device]` 标记。探针默认**不载入**它们（要 `--devices` 才载）。
    注意这一条与"绝不抢焦点"是同一类原则：插件动用户的设备/窗口之前，先把代价说清楚。

插件侧的落点：`src/bridge/extensions.mjs`（读 + 载入 + 设备回收）、`compileScripts` 的 `dialect` 选项
（扩展积木进方言表后和核心积木**同等严格**地校验）、`verifyProject` 的 `knownExtensions`
（把"没见过的 opcode"和"这个编辑器根本没有的扩展"分开）。

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
node tools/spike-gandi-surface.mjs        # 视图模型：谁在最前、可见性、切换、关闭（第 19 条）
node tools/spike-gandi-view.mjs           # shell 的 preload 暴露了什么、能不能拦（答案是拦不了，只能调了看）
node tools/spike-gandi-extensions.mjs     # 扩展 API 长什么样、库里有什么（第 21 条）
node tools/spike-gandi-extension-project.mjs   # 含扩展积木的工程能不能打开、存出来是什么字节（第 21 条）
node tools/spike-gandi-extension-dialect.mjs music pen   # 插件自己的扩展读取器（走 src/bridge/extensions.mjs）
node tools/spike-gandi-extension-batch.mjs # 把整个库逐个载入一遍（默认跳过设备类；第 21 条第 10 条）
node tools/spike-gandi-extension-write.mjs # 随便挑一批扩展，真的写积木 → 跑 → 读回（第 21 条）

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
- **`tabId` 与 CDP target id 分开对待**（第 13 条）：等待按 URL 里的 `tabId` 匹配，
  不再兜底到"任意编辑器页签"；关视图时按 `tabId` 反查 target id。
- **"用户能不能看见编辑器"成了一个可读的状态**（第 19 条）：`src/bridge/surface.mjs`
  读逐视图的 `visibilityState`，必要时先用 `beforeSwitchView`+`switchView` 把编辑器切回最前，
  切不动才重建视图（并把工程用归档字节搬过去），**从不抢窗口焦点**。
- **"Gandi 已经开着"不再靠关它来解决**（第 20 条）：`src/bridge/launcher.mjs` 能造一个
  带调试端口的快捷方式；`launchRespectingRunning` 在不可附加时**拒绝并说明**，
  只有显式 `restart: true` 才走 `CloseMainWindow` 的礼貌关闭。
- `tools/` 下 TurboWarp 时代的探针没有删：它们仍然是"上游怎么工作"的证据，
  只是连着 `tw-editor://` 跑不通了。
