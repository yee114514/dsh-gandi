# Phase 0 去风险报告

对一台真实运行的 TurboWarp Desktop 实测，回答计划里不肯靠假设的四个问题。
所有结论都带可复现的证据，原始日志见 `.spike/spike.log`，截图见 `.spike/stage.png`。

## 实测环境

| 项 | 值 |
| --- | --- |
| TurboWarp | 1.16.0（Windows x64 便携版，`E:\turbowarp-portable\TurboWarp.exe`） |
| 运行时 | Electron 42.2.0 / Chrome 148 / V8 14.8 |
| 调试端口 | `--remote-debugging-port=9222` 启动，约 12 秒内就绪 |
| DSH | Node v24.21.0（全局 `WebSocket`，CDP 客户端零依赖） |
| 编辑器页面 | `tw-editor://./gui/gui.html`，标题「作品」（中文界面） |

## 0.2 跨 surface：宿主面插件在 web 上可用 —— ✅ 通过

把插件装进 `web` profile（`dsh plugin --profile web add`，结果是 `link:E:/dsh-turbowarp`），
注册的 `scratch_probe` **直接出现在本会话的工具目录并成功执行**。本会话就跑在 web surface 上。

探针回报：

```
surface: unknown (DSH_PROFILE=unset)
services: tools=yes  attachments=yes  skills=yes  commands=yes  systemPrompt=yes  llm=yes
platform: win32 x64, node v24.21.0
session.cwd: E:\TurboWarp-desktop
```

结论：

- 宿主面（host-plane）的 `ctx.tools.register()` 会被 web 的 **preset 会话**看到，
  与源码语义一致（`dsh-tools/lib/index.js:2872-2886`「Register globally or in the calling
  agent scope」；`restrict()` 的报错文案「known global tools」也印证全局层的存在）。
  因此**不需要**为 web 单独声明 preset 行。
- web 面上 `attachments` / `skills` / `commands` / `systemPrompt` **全部已挂载**，
  截图走附件服务这条设计成立。
- `session.header.cwd` 可用，作为默认项目路径的来源。
- 探针里的 surface 判定不可靠（`DSH_PROFILE` 在宿主进程里是空的），
  正式插件不应依赖该环境变量判断 surface。

## 0.3 CDP 能到达 `window.vm` —— ✅ 通过

`GET /json/list` 的页面目标就是编辑器，页面主世界里的文档化全局全部可读：

```
{"vm":"object","ScratchBlocks":"object","ReduxStore":"object",
 "workspaceDbs":2,"renderer":true,"requestSnapshot":"function","canvas":"600x450"}
```

项目初始状态：Stage + 角色1 两个 target，各自 0 个积木。整个探针期间页面零报错。

`ScratchBlocks.Workspace.WorkspaceDB_` 里有 2 个 workspace（主工作区 + 积木栏 flyout），
用 `ws.rendered && !ws.isFlyout` 可以唯一选出主工作区——这给了我们一条**不依赖 React 内部**
观察编辑器状态的路子。

## 0.4 `createBlock` + `emitWorkspaceUpdate` 编辑器真的会显示 —— ✅ 通过

这是最关键的一个，因为它决定「能不能局部改脚本而不重载整个项目」：

```
before       { vm: 0, workspaces: [0] }
created      { vm: 1, workspaces: [1] }   ← VM 与 Blockly 工作区同时 +1
afterDelete  { vm: 0, workspaces: [0] }   ← 撤销后同步归零
```

结论：**VM 侧建块 + `vm.emitWorkspaceUpdate()` 会让编辑器界面同步显示**，
且删除后同样同步。计划里「surgical apply」这条设计成立，不必退化成每轮全量
`vm.loadProject`。探针自己负责收尾撤销，用户项目未被改动。

机制（已核对源码）：`vm.emitWorkspaceUpdate()` 触发 GUI 的 `onWorkspaceUpdate`，
它先摘掉 `vm.blockListener` 再 `clearWorkspaceAndLoadFromXml`，所以不会回环
（`scratch-gui/src/containers/blocks.jsx:465-496`）。

## 0.5 `requestSnapshot` 能拿到舞台 PNG —— ✅ 通过（含一个必要的修正）

**第一次实测超时**。根因在 `scratch-render/src/RenderWebGL.js:927-962`：

```js
draw () {
    if (!this.dirty) { return }        // ← 停着的舞台不脏，直接返回
    ...
    const snapshotRequested = this._snapshotCallbacks.length > 0
    ...
    if (snapshotRequested) { const snapshot = gl.canvas.toDataURL(); this._snapshotCallbacks.forEach(cb => cb(snapshot)) }
}
```

快照是在**重绘帧内部**发出的。项目停止时舞台不重绘，回调就永远不触发。

修法：注册回调后调用 `vm.runtime.requestRedraw()`（`scratch-vm/src/engine/runtime.js:3352`）
并置 `renderer.dirty = true`。实测通过：

```
0.5 requestSnapshot: {"ok":true,"bytes":11840,"size":"600x450","file":".spike/stage.png"}
```

产物经人工确认是真实的舞台画面（默认小猫在白色舞台上），不是空白或黑图。
尺寸 600×450 是编辑器当前的画布尺寸（原生 480×360 按舞台缩放/DPR 放大），
对模型观察足够。

**这条修正必须写进正式实现**：任何截图路径都要先请求重绘，否则会静默超时。

## 0.6 运行机制：必须由桥接层自己推进 —— ✅ 通过（含一个关键发现）

把编译好的积木推进真 VM 后，`vm.greenFlag()` 建起了线程（`threads: 1`），
但精灵**一动不动**（`x` 始终为 0）。逐步排查：

| 观察 | 值 |
| --- | --- |
| 脚本注册 | `topLevelScripts: ["dbgHat"]`，hat opcode 正确 |
| `vm.runtime._steppingInterval` | 不存在 |
| 手动 `runtime._step()` × 30 | `threads 1 → 0`，**`x: 0 → 100`** |
| 空等 500ms 的采样 | 只有 2 个点，间隔 **1009ms**（`setInterval(…, 100)` 被节流） |

两个结论：

1. **编译产物语义完全正确**。手动步进后精灵精确移动到 100，
   说明 sb3 输入协议、原语内联、`next`/`parent` 链、影子块物化全部正确。
2. **窗口不在前台时，Chromium 会把渲染进程的 rAF/定时器节流**，
   应用的步进循环因此几乎不跑。任何"发起绿旗 → 等墙上时钟 N 秒 → 读状态"
   的实现都会在用户切走窗口时**静默失败**。

于是桥接层的运行语义定为：**自己调用 `runtime._step()` 推进**，而不是等时间流逝。

- 免疫节流：不依赖窗口焦点。
- 确定性：`runtime._step()` 每个调用把 `currentStepTime` 推进一个帧间隔，
  而 scratch-vm 的计时器读的就是 `currentStepTime`，所以 **N 步 = N 帧的项目时间**，
  与墙上时钟无关。跑 0.5 秒 = 15 步，实测线程正常跑完。
- 可复现：同样的项目 + 同样的步数 = 同样的结果，便于"改一下、跑一下、看一眼"。

端到端实测（`tools/spike-push.mjs`）：

```
after loadProject: {"vmBlocks":3,"workspaceBlocks":[3],"firstBlockInputs":{"X":{...}}}
after greenFlag + manual stepping: {"steps":15,"startedThreads":1,"threadsLeft":0,"xAfterRun":100}
restored original project: {"restoredBlocks":0,"x":0}
PASS
```

## 对计划的修订

1. **surgical apply 保留**为 `scratch_apply` 的默认行为（0.4 已验证）。
2. **截图必须先请求重绘**（`vm.runtime.requestRedraw()` + `renderer.dirty = true`），
   否则会静默超时（0.5）。
3. **运行由桥接层手动步进**，不用墙上时钟（0.6）。`scratch_run({seconds})`
   折算为步数，并把"窗口是否在前台"降级为一个可选的可见性优化，而不是正确性前提。
4. 原语表按上游实际值修正（计划里的表有两处错）：
   `event_broadcast` → 应为 `event_broadcast_menu`（11）；
   `data_variable` 才是 12，`data_listcontents` 是 **13**。
   来源 `scratch-vm/src/serialization/sb3.js:61-96`。
5. 每轮全量 `vm.loadProject` 降级为**结构性变更**（增删角色/资产）的路径，
   而不是常规编辑路径。
6. surface 判定不能靠 `DSH_PROFILE`（宿主进程里是空的）；需要区分就软探测服务或
   环境变量 `DSH_WEB_URL`。
7. `blocks.createBlock` 的 `inputs` 需要**引擎形态**（`{name, block, shadow}`，
   原语要物化成独立的影子块），而 `vm.loadProject` 需要**压缩形态**（sb3 文件形态）。
   编译器只产出压缩形态，两个消费者共用一份 IR；surgical 路径需要时再做一次
   形态转换（`src/scratch/engine.mjs`）。

## 复现方式

```powershell
# 1. 取得并启动 TurboWarp（便携版会转发调试端口参数）
Start-Process E:\turbowarp-portable\TurboWarp.exe -ArgumentList '--remote-debugging-port=9222'

# 2. 跑探针
cd E:\dsh-turbowarp
node tools/spike.mjs
```

---

# 后续实测中的额外发现（Phase 1–3）

下面这些不是"验证计划"，而是**实现过程中被真机打回来**的地方。
每一条都改了代码，留在这里是因为它们都属于"照直觉写必错"的类型。

## A. 资产：`createAsset` 是五个参数，且造型要写历史属性名 `md5`

给角色加造型需要自己把资产塞进 runtime 的 storage。两个坑：

1. `ScratchStorage.createAsset(assetType, dataFormat, data, id, generateId)` 是**五个**参数。
   按四个调（把 `false` 当 `generateId`）会让 `id` 收到布尔值，最终 `asset.assetId` 不是字符串——
   报错是 `assetId.split is not a function`。正确调法：`createAsset(assetType, fmt, bytes, null, true)`，
   此时 `assetId` 是数据的 md5（**不含扩展名**），`md5ext` 要自己拼成 `assetId + '.' + fmt`。
2. `serializeCostume` 写的是 `sb3.js:451` 的 `obj.md5ext = costumeToSerialize.md5` ——
   它读的是**历史属性名 `md5`**，不是 `md5ext`。反序列化时两者都会设（`sb3.js:1074-1076`），
   所以从文件读进来的造型没问题；但手搓的造型对象只设 `md5ext` 时，序列化会写出 `md5ext: undefined`，
   于是**资产被打进归档、却没有任何东西引用它**。这个 bug 在编辑器里完全看不出来（造型显示正常），
   只有在把导出的 `.sb3` 重新解析、做引用一致性检查时才暴露。

3. `assetType` 应该是真正的 `AssetType` 枚举对象而不是字符串 `'costume'`（scratch-storage 会读它的字段）。
   页面里拿不到那个模块导出——但**可以从 `runtime.storage.AssetType` 拿**（`load-costume.js:465`
   自己就是这么取的），里面有 `ImageVector` 与 `ImageBitmap`。按 `dataFormat === 'svg'` 选，
   否则给位图造型会取到向量类型而导致加载失败。早期版本是"从已有造型的
   `costume.asset.assetType` 借一个"，对 SVG 能用、对 PNG 错。

## A2. 给舞台加背景走的是另一个方法

角色与背景在运行时里是同一件东西（舞台的 costume 就是它的背景），`loadCostume` 也共用，
但安装入口不同：角色用 `vm.addCostume(md5ext, obj, targetId)`，舞台用
`vm.addBackdrop(md5ext, obj)`（`virtual-machine.js:1303`，它自己取舞台）。
另外目标名不能写 `'stage'` 就指望匹配上——舞台的 `getName()` 返回的是 `Stage`。
现在 `target: "stage"` 是一个显式约定（大小写不敏感）。

## F. 变量：id 必须是真的，改名/删除要按 map 的键

`Target.createVariable(id, name, type)` 传 `null` 会怎样？实测（探针 `peek-vars`）：

| 操作 | 结果 |
| --- | --- |
| `createVariable(null, …)` | 变量**存在键 `"null"` 下**，而对象自身的 `id` 是另生成的 uid |
| 再 `createVariable(null, …)` 建列表 | **完全没生效**——键 `"null"` 已被占用 |
| 按 `v.id` `renameVariable` / `deleteVariable` | **静默无效**（那个 id 不是键） |
| 传显式 id | create / rename / delete **全部正常** |

两条修法：建变量时**自己生成唯一 id**；改名/删除**按 `Object.entries(variables)` 的键**，
而不是对象自报的 `id`。这类"看起来成功了、其实什么也没发生"的失败最难查——
工具返回的文本一切正常。

## G. 改积木图之前必须停线程

在脚本还在跑的时候替换它的积木，线程会继续引用已删除的块，随后运行时尝试让它发光就抛
`Tried to glow stack on block that does not exist`——**报错点离真正的病因很远**。
`applyFragment` 与 `clearScripts` 现在都先 `vm.stopAll()`。改一个正在运行的项目本来也没有意义。

## H. 监视器状态的形状

`runtime.getMonitorState()` 返回的不是"监视器值映射"，而是记录容器：它自己的键是
`{ map, dirty }`，记录在 `map` 里（一个 `Map`）。按值映射读会让每一行都变成
`undefined undefined = undefined`。现在按 `map` 走，并且**原样透传记录**而不是编造字段名；
没有可见监视器时它是空的。项目计时器另外取自
`runtime.ioDevices.clock.projectTimer()`。

## B. 异步页面函数不要把 `JSON.stringify` 套在 Promise 外面

`JSON.stringify((async () => {...})())` 恒等于 `"{}"`，解析出来是空对象——
调用方拿到 `undefined` 属性，报错点离病根很远。页面源码里凡是 async IIFE，
必须在函数内部 `return JSON.stringify(...)`。

## C. 参数校验要先于任何 I/O

`scratch_sprite` 一开始把 action 的校验写在"取连接"之后，于是 action 拼错时报的是
"连不上编辑器"。参数错误应该在任何 I/O 之前报出来，否则排查方向会被带偏。
（这条是单元测试抓到的。）

## D. 端到端验收结果

`tools/e2e.mjs` 通过插件自己的工具面驱动真编辑器，**43/43 通过**，覆盖：

状态与挂接 → dry run 编译 → 就地改脚本（8 个引擎块）→ 建变量 → 读回 XML →
跑 1 秒（精灵精确到 120,−60、变量=7、截图是合法 PNG）→ 自绘 SVG 造型
（旋转中心由 SVG 尺寸推出 20,20）→ 复制角色 → 摆位置 → 删除副本 →
导出 `.sb3` → 重新解析校验引用一致性 → 再打开 →
键盘操控（松开不动、按住移动）→ **给舞台加背景** → **加位图造型（自造 PNG）** →
变量的建/设/改/删与列表 → 还原原项目。

## D2. 写页面源码时的固定坑

桥接层是把 JavaScript 当字符串发给编辑器的，所以 `ops.mjs` 里有大量模板字符串装着页面代码。
**在那里面写注释时不能出现反引号**——一个反引号就会提前闭合模板字符串，而报错是
"missing ) after argument list"，位置在几十行之外。这个坑在本次实现里踩了三次，
现在由 `test/page-source.test.mjs` 静态守住（覆盖 `src/` 与 `tools/`）。

同一个测试还断言 `src/` 下每个模块都能 import——页面源码里的语法错误只有被 import 时才暴露，
而对插件来说那意味着 DSH 启动时炸。`tools/` 故意不放进这条：import 一个工具脚本会**执行**它
（它们是会连上编辑器的顶层程序），那不是单元测试该做的事。

## E. 环境备注

- Windows 便携版会转发生成 `--remote-debugging-port`，实测 12 秒内端口就绪。
- `dsh plugin --profile <p> add <本地路径>` 第一次可能因下载中断而**静默回滚**（package.json 不变）；
  重跑一次即可，装完要看 `dsh --profile <p> --dump-config` 里是否真的出现那一行。

# 离线路径（不启动编辑器）

## I. `.sb3` 里三种声明是三种形状

`sb3.js:491-515` 的 `serializeVariables` 把 `target.variables` 拆成三个顶层映射，形状各不相同：

| 映射 | 形状 |
| --- | --- |
| `variables` | `{ id: [name, value] }`（云变量还会多一个 `true`） |
| `lists` | `{ id: [name, value] }`，其中 value 是**条目数组** |
| `broadcasts` | `{ id: name }` —— **裸字符串**，注释原文是 "name and value is the same for broadcast msgs" |

按统一形状去读会把广播读成 `undefined`。

## J. 删脚本要自己走一遍级联

运行时删积木是整摞删的（`Blocks.deleteBlock` 会走整棵树），但**项目文件是一张扁平的
id → block 表**：只删掉顶层那条，它的子块会作为**孤儿**留在表里，`parent` 指着一个
不存在的 id。离线编辑必须自己从顶层块出发，沿 `next` 与各 input 走一遍再一起删
（`collectScript`）。这一点不做的话，导出的项目里会慢慢堆积看不见的垃圾块。

## K. 写回格式由目标扩展名决定

`project.json` 和 `.sb3` 是两种东西（一个是 JSON 文档，一个是装着它的 ZIP）。
无条件用 ZIP 写回会让一个名叫 `project.json` 的文件变成二进制——**而且是静默的**，
直到有人去解析它。现在按目标扩展名选：`.json` 写 JSON，其余写归档。
这个缺陷是离线测试抓到的，不是看代码看出来的。

## L. 用 JSON 载入一个带造型的项目会**永远挂住**

`vm.loadProject(projectJsonObject)`（不带归档）在项目带资产时不会失败，而是**不 settle**：
造型加载器会去 storage 找一个谁也注册不了的资产，然后一直等。表现是
`Runtime.evaluate` 120 秒超时——而项目已经**部分应用**了（舞台换了、角色没进来），
所以现场看起来像"项目被清空了"。

修法：凡是要装东西进编辑器的项目，一律走**归档字节**（`writeSb3` → `vm.loadProject(arrayBuffer)`），
资产随之而来。`scratch_new` 就是这么做的。JSON 载入只留给"本来就没有资产"的文档。

这条花了整整一个调试周期才定位，因为症状（超时 + 空项目）和病因（资产查找永不返回）
隔得很远。定位靠探针：`runtime.targets` 里一个角色都没有，而日志显示项目已经换过。

顺带一个副作用值得知道：**载入一个舞台没有造型的项目，VM 会自己补一个默认背景**。
所以"只有舞台"的项目在运行时里其实不是秃的。

## M. 声音：`loadSound` 认 `sound.asset`，格式字段留空

`load-sound.js:88-105` 读的是**历史属性名 `sound.md5`**（不是 `md5ext`），从中切出扩展名，
然后 `(sound.asset && Promise.resolve(sound.asset)) || storage.load(...)`。
和造型一样，直接给 `asset` 就不必往 storage 里注册任何东西。
`rate` / `sampleCount` 会被解码后的 buffer 覆盖（`:30-31`），所以传什么都行；
`format` 对未压缩 PCM 是**空字符串**。

合成比上传更有用：模型说"一个短促的上滑音"就能得到真声音，而且结果确定、无需音频硬件即可测。
WAV 是 44 字节头 + 16 位 PCM，两端各 fade 5ms 防爆音——都在 `src/scratch/wav.mjs` 里，
单测覆盖（过零率验证频率、前后半段对比验证滑音）。

## N. 建角色没有走 `addSprite`

`vm.addSprite` 只吃 `scratch-parser` 能校验的东西，而精灵引用的资产必须**已经在 storage 里**——
公开 API 不接受调用方传入资产对象。上游的正路是上传 `.sprite3`（一个 zip，含 `sprite.json` + 资产），
但 zip 条目名之类的细节需要再核，我没有把握。

所以 `action:'create'` 走的是**复制 → 清空脚本与私有变量 → 换成新造型 → 删掉其余造型**：
每一步都是已经真机验证过的操作，零未知。代价是必须有一个源角色可复制——
这就是为什么 `scratch_new` 现在会带一个起始角色（一个只有舞台的 `.sb3` 其实没法用，
连脚本都挂不上）。

## O. 测试基准必须是确定的

失败的运行会把编辑器留在半路状态，而 e2e 是"快照当前项目、最后还原"，
所以**下一次运行会把上次的残骸当成原始项目**。表现是一连串看起来像真 bug 的失败：
项目里是上一轮的 `e2e-start-xxx`、造型重名被加了后缀、导出的归档缺资产。

`tools/cleanup-editor.mjs --reset` 用归档字节载入一个全新项目，是唯一能从
"资产缺失的项目"里恢复的办法——那种项目导不出忠实结果，删脚本删造型都救不回来。
e2e 里凡是需要角色名的地方，也从报告里**读**而不是写死（默认项目在中文环境叫 `角色1`）。

而且它会**先把当前项目导出备份**再动手。这个脚本操作的"调试端口上那个编辑器"，
无从分辨那是可丢弃的测试实例还是别人正在做的东西——替换项目是不可逆的
（TurboWarp 不保留历史），所以唯一诚实的做法是先落盘一份并告诉你路径在哪。
e2e 同理：快照除了留在内存里，也写一份 `original-backup.sb3`，因为还原只在跑完时执行，
中途崩掉就没有回头路了。

## P. `getScripts()` 返回的是运行时的**活动数组**

这条是本项目最难发现的 bug。`Blocks.getScripts()` 交出来的不是副本，而
`deleteBlock` 会把它**就地缩短**。于是这个到处都是的写法：

    for (const id of target.blocks.getScripts()) { target.blocks.deleteBlock(id) }

**会每隔一个脚本漏掉一个**。证据很干脆：循环开始前捕获的那个数组，循环结束后变成了空数组。

它躲过了很久的测试，因为**单脚本目标上完全正确**——删掉第 0 个，长度变 0，迭代器正好结束。
只有目标有 2 个以上脚本时才出错，而且不报错，只是"少删了一个"。

同一个写法当时存在于四处：`applyFragment`（主写入路径）、`stripSprite`、`clearScripts`
和清理脚本。修法一律是先快照：`[...target.blocks.getScripts()]`。
现在 e2e 专门有一条断言：给目标加到 4 个脚本再 replace，必须只剩**一个脚本、一个积木**。

## Q. 删除脚本会留下孤儿积木

`deleteBlock` 会级联删掉整摞，但**复制**自定义积木时 scratch-vm 会多留下几个块
（实测：复制后比原件多 1 个块，删完脚本还剩 2 个 `argument_reporter`）。
它们在编辑器里完全看不见（没有脚本能到达它们），但在项目文件里是真实的，而且会越积越多。

所以"清空脚本"之后还要走一遍可达性清理（`PRUNE_ORPHANS_SOURCE`），
`applyFragment` 的 replace 分支和 `stripSprite` 共用它。判断标准很简单：
**从顶层块出发走不到的，就是垃圾**。

## R. 发光（glow）会在脚本被替换后炸，而且报错离病因极远

症状：替换脚本之后运行项目，抛
`Tried to glow stack on block that does not exist.` ——没有调用栈（它是**被拒绝的 promise
里的一个字符串**，CDP 给不出 frames），也没说是哪个积木、哪次编辑干的。

原因：发光状态是按 block id 记在 **UI 层**的。运行时会广播"该点亮某个顶层块"，
编辑器拿这个 id 去自己的工作区里找——脚本刚被替换过，那个 id 已经不在了。

修法不是加延时，而是**别请求这个动画**：`thread.js:520` 的判断是
`if (!this.blockContainer.forceNoGlow) { this.blockGlowInFrame = this.topBlock; ... }`，
所以运行期间把每个 target 的 `blocks.forceNoGlow` 置真、并清掉
`runtime._scriptGlowsPreviousFrame` 里残留的 id，跑完再恢复。
桥接驱动的运行本来也没人看动画。

顺带一条：桥接抛出的页面错误现在会带上**页面侧调用栈**（`cdp.mjs`），
这条错之所以还是没栈，是因为它压根不是从我的 evaluate 里抛出来的。

## S. 注释：`toXML()` 要**传注释**，创建要用 `createComment`

`Blocks.toXML()` 不带参数时**一条注释都不输出**——注释不在积木图里，而在 target 上，
`emitWorkspaceUpdate()` 是这么调的：`toXML(this.editingTarget.comments)`。
只调 `toXML()` 会静默丢掉所有批注，这也是本插件现在自己渲染 XML 的原因之一。

`target.comments` 里必须是 **`Comment` 实例**：渲染走的是 `comment.toXML()`。
写普通对象进去，下一次 `emitWorkspaceUpdate()` 就会 `toXML is not a function` ——
**一加注释就把编辑器的工作区同步弄崩**。创建要用
`Target.createComment(id, blockId, text, x, y, width, height, minimized)`（注意参数顺序），
它负责 new 一个真实例。

另外 `emitWorkspaceUpdate` 会把每条注释**发两次**（工作区级一次、块内一次），
所以编译器按 id 合并，否则读回编辑器自己的 XML 会产生重复。

## T. 自定义积木的短写法

规范形态是三个地方共用一份 mutation：`procedures_definition` 里挂一个
`procedures_prototype` 影子，mutation 带 `proccode`/`argumentids`/`argumentnames`/
`argumentdefaults`/`warp`；每个 `procedures_call` 再带一份 `proccode`/`argumentids`/`warp`，
**参数值输入的名字就是参数 id**；而 `argument_reporter_*` 用
`<field name="VALUE">参数名</field>`（用名字，不是 id）。

这些转义 JSON 数组要三处一致，正是最容易写错的地方。所以编译器接受短写法：
definition 上的 `<mutation proccode="nudge %n" argumentnames="amount" argumentdefaults="10"/>`，
调用处只写 `<mutation proccode="nudge %n"/>` 加一个**以参数名命名**的 `<value>`。
id 由编译器生成、prototype 由编译器补上、调用处的输入名从参数名映射到 id。

逗号分隔的列表与 JSON 数组都收（参数名里不可能有逗号，所以无歧义；含逗号的**默认值**
要用 JSON 形式，写错会以"数量不匹配"的告警暴露出来）。

权威形态不是猜的：`tools/spike-procedures.mjs` 按线格式构造一个带自定义积木的项目、
载入编辑器、打印它自己 `toXML()` 的输出，并且**真的跑一遍**确认参数传对了
（`movedBy: 25`）。光看 XML 一致是不够的——自定义积木写错时照样能写入、能读回、
在编辑器里也长得对，只有运行起来才暴露。


