---
name: gandi-scratch-authoring
description: How to write Scratch 3 scripts as scratch-blocks XML and drive a live Gandi editor with the gandi_* tools.
---

# 在 Gandi 里写 Scratch

你有一套 `gandi_*` 工具，能直接读写一个**正在运行的 Gandi 编辑器**，
并在里面跑项目、看画面。工作循环是：

```
gandi_status → (gandi_launch) → gandi_inspect → gandi_apply → gandi_run → 看图 → 改 → 再跑
```

## 一条重要的前置规则

**先读再写。** `gandi_inspect` 打印的 XML 就是 `gandi_apply` 接受的方言，
所以"读出 → 改 → 写回"是闭环的。不要凭记忆拼 opcode 和输入名，读一次比猜十次快。

写之前先用 `gandi_apply` 的 `dryRun: true` 过一遍：它只编译、不碰编辑器。
**会让项目打不开的 XML 会被直接拒绝**（不是警告），这是故意的——半个项目比报错更难查。
拒绝的理由会写清楚是哪个积木的哪个输入、该改成什么。
（带上 `path` 时，`dryRun` 还会把改动套用到一份副本上，按编辑器读它的方式检查一遍。）

## XML 方言

`gandi_apply` 接受 scratch-blocks 的 XML。顶层可以是一个 `<xml>` 包装，也可以直接是一个 `<block>`。

```xml
<xml>
  <variables>
    <variable id="scoreId" type="">score</variable>
  </variables>
  <block type="event_whenflagclicked" x="48" y="48">
    <next>
      <block type="data_setvariableto">
        <field name="VARIABLE" id="scoreId" variabletype="">score</field>
        <value name="VALUE"><shadow type="text"><field name="TEXT">0</field></shadow></value>
        <next>
          <block type="motion_movesteps">
            <value name="STEPS"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
          </block>
        </next>
      </block>
    </next>
  </block>
</xml>
```

### 结构规则（最容易错的地方）

- **`<next>` 是块的子元素，不是兄弟。** 接在 A 后面的块要写成 `<block type="A">…<next><block …/></next></block>`。
  写成并列的两个 `<next>` 会被静默丢弃。
- **`<value name="…">` 放数值/字符串输入，`<statement name="…">` 放 C 型块的内部脚本。**
  写反了会被警告（`SUBSTACK` 一定是 `<statement>`，`CONDITION`/`TIMES`/`MESSAGE` 一定是 `<value>`）。
- 数值/文本输入必须包一层 `<shadow>`，类型要和输入匹配：
  - 数字 → `<shadow type="math_number">`，字段名 `NUM`
  - 整数 → `math_whole_number`，正数 → `math_positive_number`，角度 → `math_angle`
  - 文本 → `<shadow type="text">`，字段名 `TEXT`
  - 颜色 → `colour_picker`，字段名 `COLOUR`
- **变量/列表/广播字段必须带 `id`**，并在 `<variables>` 里声明，两处的 `id` 要一致。
  类型：`type=""` 标量、`type="list"` 列表、`type="broadcast_msg"` 广播。
  `broadcast_msg` 是**变量声明的 type**，不是积木的 shadow type（见下一节——写错会让项目打不开）。
- `id` 可以省略，插件会自动生成；但显式写 id 更利于你后续精确引用。

### 下拉菜单必须用编辑器自己的 shadow 类型

**这是最高频、最贵的坑**：下拉菜单（造型、按键、克隆对象…）的 `<shadow type="…">`
在 sb3 里是一个**真实的积木**，opcode 写错时它不会像数字那样被内联，而是变成一个
运行时查不到的积木 —— `create clone of` 读不到克隆对象，**一个克隆体都不会产生，
却没有任何报错**；写成 `broadcast_msg` 更糟，项目直接打不开
（`Extension not found: broadcast`）。

下表逐个来自 Gandi 编辑器自己的工具箱（`tools/spike-gandi-blocks.mjs` 可以重新导出）：

| 积木 | input 名 | shadow type | field 名 |
|---|---|---|---|
| `looks_switchcostumeto` / `...andwait` | `COSTUME` | `looks_costume` | `COSTUME` |
| `looks_switchbackdropto` / `...andwait` | `BACKDROP` | `looks_backdrops` | `BACKDROP` |
| `control_create_clone_of` | `CLONE_OPTION` | `control_create_clone_of_menu` | `CLONE_OPTION` |
| `sensing_keypressed` | `KEY_OPTION` | `sensing_keyoptions` | `KEY_OPTION` |
| `sensing_touchingobject` | `TOUCHINGOBJECTMENU` | `sensing_touchingobjectmenu` | `TOUCHINGOBJECTMENU` |
| `sensing_distanceto` | `DISTANCETOMENU` | `sensing_distancetomenu` | `DISTANCETOMENU` |
| `sensing_of` | `OBJECT` | `sensing_of_object_menu` | `OBJECT` |
| `event_broadcast` / `event_broadcastandwait` | `BROADCAST_INPUT` | **`event_broadcast_menu`** | `BROADCAST_OPTION` |
| `sound_play` / `sound_playuntildone` | `SOUND_MENU` | `sound_sounds_menu` | `SOUND_MENU` |
| `motion_goto` | `TO` | `motion_goto_menu` | `TO` |
| `motion_glideto` | `TO` | `motion_glideto_menu` | `TO` |
| `motion_pointtowards` | `TOWARDS` | `motion_pointtowards_menu` | `TOWARDS` |

菜单里的选项名直接用编辑器的说法：`_myself_`（自己）、`_mouse_`（鼠标指针）、
`_random_`（随机位置）、`_edge_`（舞台边缘）、`_stage_`（舞台），键名用 `space`、`left arrow` 等。

**纯 field（不是 shadow）**：`motion_setrotationstyle.STYLE`、`looks_seteffectto.EFFECT`、
`looks_changeeffectby.EFFECT`、`motion_gotofrontback.FRONT_BACK`、`operator_mathop.OPERATOR`、
`control_stop.STOP_OPTION`、`event_whenkeypressed.KEY_OPTION`，
以及 `event_whenbroadcastreceived.BROADCAST_OPTION`（接收广播用字段，不是输入）。

不确定某个块的输入名或 shadow 时：`gandi_inspect` 读一个已经用了该块的脚本，
或者 `dryRun` 一次让它告诉你。**不要猜——猜错的两种结果分别是"静默无效"和"项目打不开"。**

## 常用 opcode / 输入名速查

| 用途 | opcode | 关键输入 / 字段 |
| --- | --- | --- |
| 绿旗 | `event_whenflagclicked` | — |
| 按键 | `event_whenkeypressed` | 字段 `KEY_OPTION` |
| 点击角色 | `event_whenthisspriteclicked` | — |
| 广播 | `event_whenbroadcastreceived` / `event_broadcast` | 字段 `BROADCAST_OPTION` / 输入 `BROADCAST_INPUT` |
| 移动 | `motion_movesteps` | `STEPS` |
| 坐标 | `motion_gotoxy` / `motion_setx` / `motion_changexby` | `X`、`Y`、`DX` |
| 朝向 | `motion_pointindirection` | `DIRECTION` |
| 碰到边缘 | `motion_ifonedgebounce` | — |
| 说 | `looks_say` / `looks_sayforsecs` | `MESSAGE`（后者还有 `SECS`） |
| 造型 | `looks_switchcostumeto` | `COSTUME` |
| 显示/隐藏 | `looks_show` / `looks_hide` | — |
| 等待 | `control_wait` | `DURATION`（秒，可以是小数） |
| 重复 | `control_repeat` | `TIMES`，内部脚本放 `SUBSTACK` |
| 永远 | `control_forever` | 内部脚本放 `SUBSTACK` |
| 如果 | `control_if` | `CONDITION`（布尔），内部脚本 `SUBSTACK` |
| 如果否则 | `control_if_else` | `CONDITION`，`SUBSTACK` / `SUBSTACK2` |
| 克隆 | `control_create_clone_of` | `CLONE_OPTION` |
| 设变量 | `data_setvariableto` / `data_changevariableby` | 字段 `VARIABLE`，输入 `VALUE` |
| 运算 | `operator_add` / `operator_subtract` / `operator_multiply` / `operator_divide` | `NUM1`、`NUM2` |
| 随机 | `operator_random` | `FROM`、`TO` |
| 比较 | `operator_lt` / `operator_gt` / `operator_equals` | `OPERAND1`、`OPERAND2` |
| 与或非 | `operator_and` / `operator_or` / `operator_not` | `OPERAND1`、`OPERAND2` |
| 碰到 | `sensing_touchingobject` | `TOUCHINGOBJECTMENU` |
| 按键按下 | `sensing_keypressed` | `KEY_OPTION` |
| 计时器 | `sensing_timer` / `sensing_resettimer` | — |
| 鼠标 | `sensing_mousex` / `sensing_mousey` / `sensing_mousedown` | — |
| 广播并等待 | `event_broadcastandwait` | `BROADCAST_INPUT` |

## 坐标与尺寸

- 舞台是 **480 × 360**，中心在 (0, 0)。
- x 范围 −240…240（右为正），y 范围 −180…180（**上为正**）。
- 角色默认在 (0, 0)，方向 90（右），大小 100%。

## 运行与"看"

`gandi_run` 会按下绿旗、把项目推进 N 秒、然后返回运行时状态和**一张舞台截图**。

- **步进率是确定的 30 帧/秒**：跑的时候插件会**暂停编辑器自己的循环**，只由插件按
  `1000 / currentStepTime` 的真实节奏推进。同一条命令跑两次结果一样，而且**和 Gandi
  窗口在不在前台无关**。
  （曾经的"实测约 60 fps"是假象：用户点过绿旗之后，编辑器自己那个 30 Hz 的循环还在跑，
  插件再推进 30 次，一秒就走了 60 帧——前台时翻倍、后台时正常。第一版技能文档按 60 fps
  "纠正"过这一点，是纠正错了方向。）
- 计时块读的是真实时钟，所以 `wait 1 seconds` 和用户手动点绿旗一样。
- **绿旗会停掉所有脚本、重置计时器，但不会重置变量**——那是脚本自己的事。
  `gandi_run` 会列出"这一轮里变了的变量"（`changed during the run: 帧 0 -> 29`），
  跨轮累积的值一眼就能看出来。要强制归零用 `resetVariables: true`（标量置 0、列表清空；
  这不是恢复存档时的初值，广播消息不动）。
- 跑的时候页面如果抛了错，会带出来（`page errors during the run:`）——这类错误平时是
  无声的 promise rejection，正是"什么都没发生"的常见原因。
- 图里能看到角色在哪、造型是什么。**看完再改，不要盲写。**
  - 如果输出里出现 **"byte-identical to the previous one"**，那张图不可信：换成
    `gandi_screenshot {savePath:'…png'}` 再读文件。
- 只想看当前状态而不跑，用 `gandi_screenshot`。
- 想知道变量值、角色坐标、**克隆体数量**，用 `gandi_observe` 或 `gandi_status`
  （比截图更精确；"0 clones"是最强的失败信号）。

## 角色与美术

没有"新建空白角色"这种操作，但画一个自己的演员是完全可行的：

1. `gandi_sprite {action:'duplicate'}` 复制一个已有角色（造型会一起复制过来）。
2. `gandi_costume {target:'新名字', name:'球', svg:'<svg …/>'}` 把自己画的造型加进去，
   它会被自动设为当前造型。**一次加好几张就传 `costumes: [{name, svg}, …]`**，一次调用搞定。
3. 画错的造型可以收拾：`gandi_costume {action:'rename'|'delete', name:'…'}`。
4. `gandi_place` 摆好位置；`gandi_sprite {action:'delete'|'rename'}` 收拾角色。

**写 SVG 的要点**：

- 根元素上写 `width` / `height`（或 `viewBox`）。插件用它推断旋转中心——
  不给尺寸的话旋转中心会落在左上角，转起来看着像 bug。
- 舞台是 480×360，所以角色造型做到 50–100 px 比较合适；太大的话记得用 `gandi_place` 调 `size`。
- 用 `<circle>` `<rect>` `<polygon>` `<path>` 这些基本形状就够了，颜色写 `fill="#22cc55"`。
- 不要用外部引用（`<image href="http://…">`）、不要用 `<script>`——它们在 Scratch 里都不会生效。
- 造型加完记得 `gandi_screenshot` 看一眼，确认画出来的东西是你想的样子。

**背景**：同一个工具，target 写 `stage`。

```
gandi_costume {target:'stage', name:'夜空',
                rotationCenterX:240, rotationCenterY:180,
                svg:'<svg width="480" height="360">…</svg>'}
```

满幅 480×360 的背景，旋转中心要写 **`(240, 180)`**。背景和角色一样是**按中心定位**的：
写 `0,0` 会让它整体偏出去，画面上只剩右下四分之一，其余是白的。
它会被自动设为当前背景。

## 变量与列表

```
gandi_variable {action:'create', name:'分数'}          # 全局，落在舞台
gandi_variable {action:'set',    name:'分数', value:'0'}
gandi_variable {action:'create', name:'道具', type:'list'}
gandi_variable {action:'create', name:'我的编号', scope:'local', target:'敌人'}
```

- **默认全局**（舞台上），所有角色都能用。
- **脚本里的 `<variables>` 声明永远落在舞台**，哪怕 `target` 写的是某个角色。
  想建**角色私有**变量只有 `gandi_variable {scope:'local', target:'…'}` 一条路，
  建完用 `gandi_inspect {target:'敌人'}` 复核它挂在那个角色名下。
  这对克隆模式是致命的：`我是克隆`/`我的编号` 一旦成了全局，所有克隆体互相覆盖。
- 在脚本里引用变量时，`<field name="VARIABLE" id="…">` 的 id 要和声明一致。
  最省事的做法是先用这个工具建好变量，再 `gandi_inspect` 读出它的 id。
- 列表的初始内容用逗号分隔的字符串一次给进去。

## 声音

不用去找音频文件——直接合成：

```
gandi_sound {name:'跳跃', frequency:420, sweepTo:880, seconds:0.12, waveform:'square'}
gandi_sound {name:'金币', frequency:988, sweepTo:1319, seconds:0.09, waveform:'square'}
gandi_sound {name:'受伤', frequency:300, sweepTo:120,  seconds:0.25, waveform:'sawtooth'}
```

- `sweepTo` 是"音高滑到哪"，**上滑=跳跃/得分，下滑=失败/受伤**，游戏音效基本就这两类。
- 波形：`sine` 圆润、`square` 电子（8-bit 味）、`triangle` 柔和、`sawtooth` 尖锐。
- 时长 0.08–0.3 秒最像游戏音效；再长就变成"音乐"了。
- 改名/删除：`gandi_sound {action:'rename', name:'跳跃', newName:'跳'}`、
  `gandi_sound {action:'delete', name:'跳'}`。rename 会顺手改掉脚本里所有引用它名字的
  `sound_play`；**delete 不会**，删掉的音效在脚本里会变成一个播放不出声的名字。
- 已经生成好的音效，脚本里用 `sound_play`：

```xml
<block type="sound_play">
  <value name="SOUND_MENU">
    <shadow type="sound_sounds_menu"><field name="SOUND_MENU">跳跃</field></shadow>
  </value>
</block>
```

## 从零开始一个项目

`gandi_new` 会给你舞台 + 一个蓝色圆形角色（比只有一个舞台有用——没有角色连脚本都挂不上）。
要多个自绘演员：

```
gandi_new {sprite:'玩家'}                                  # 起始项目
gandi_costume {target:'玩家', name:'小人', svg:'…'}         # 换成你画的
gandi_sprite {action:'create', name:'敌人', svg:'…'}        # 再建一个空角色（自带造型）
```

`action:'create'` 建出来的是**真空角色**：没有脚本、没有私有变量、只有一个你给的造型。
想让它长得像已有角色就用 `action:'duplicate'`。

## 测试键盘/鼠标

游戏类项目**必须**用 `gandi_input` 才能真正验到：

```
gandi_input {key:'space', isDown:true}    # 按住
gandi_run   {seconds:0.5}                 # 跑一段
gandi_input {key:'space', isDown:false}   # 松开
```

两条容易踩的：

- **按键"按住"是持续状态**，不会自己松开，也不随项目还原而清空。测完记得 `isDown:false`，
  否则下一次运行会带着一个"幽灵按键"。
- **键名写自然的说法就行**（`space`、`left`、`enter`、`a`）。插件会转成运行时需要的
  DOM 键值——直接传 `space` 给底层是**静默无效**的（会被当成修饰键丢掉），这层转换就是为此存在的。
- 鼠标坐标是舞台坐标（−240…240 / −180…180），`click:true` 会在该点按下再松开。

**按键要按在"跑的过程中"**，用 `gandi_run` 的 `input`：

```
gandi_run {seconds: 1, input: [{atSeconds: 0, key: 'space', isDown: true}]}
```

**不要先 `gandi_input` 再 `gandi_run`**：点绿旗会 `stopAll()` 并清空按键缓存，
跑之前按下的键会被丢掉；而且 `当按下空格键` 这类帽子是靠 KEY_PRESSED 事件启动的，
不是每帧轮询。按住 → 松开写成两条 `input`（`isDown: false` 那条晚一点），
一次 `gandi_run` 就能测完"按住会走、松开就停"。

## 常见坑

1. **异步块**：`looks_sayforsecs`、`control_wait`、`motion_glidesecstoxy`、
   `event_broadcastandwait` 都会让脚本暂停。想让"说一句话然后立刻做别的"，
   要么用 `looks_say`（不等），要么把等待时间算进去。
2. **一帧里的工作量比你想的大**：非等待类积木（移动、改变量、判断…）在一个 `_step()` 内
   会一直执行到用掉这一帧 75% 的时间预算。所以循环体里没有任何等待的
   `永远 { 改变量 帧 1 }`，一秒会自增**几十万次**——它不是一个帧计数器。
   要数帧就在循环体里放一个 `wait 0 seconds`，它恰好让出一帧。
3. **绿旗后不会自动重绘**：如果只改了积木没跑，舞台可能还是旧画面——截图会先请求重绘，不用担心。
4. **克隆体上限 300**。`control_create_clone_of` 放在 `control_forever` 里且没有删除逻辑，会很快触顶。
   克隆没出现时先看 `gandi_status` 里的 `clone(s)` 计数。
5. **角色必须先存在**。`gandi_apply` 只能给已有角色加脚本；要新角色就
   `gandi_sprite {action:'duplicate'}`，再用 `gandi_costume` 换造型（见上一节）。
6. **一次改一个角色的一块脚本**，跑一次，看一眼。一次写五个脚本再跑，出问题时很难定位。

## 写长脚本：`<next>` 链子

`<next>` 是**块的子元素**，一条 30 条语句的链就是 30 层嵌套——闭合成对写错时，
报错只说 `element <next> closed by </block>`，**不告诉你在第几行**。

- **一条链不要超过 6 条语句。** 超了就拆成多个自定义积木，或者拆成多个同帽脚本
  （Scratch 允许同一个绿旗帽子有多条，它们并行跑，对"每帧各干各的"反而更清楚）。
- 闭合标签**逐级缩进**写：一行一对、缩进递减，肉眼可数。
- 经验公式：**N 个块 → N 对 (`</next>`, `</block>`)**，最后一对同时闭掉帽子块本身，
  后面**不能再跟** `</block>`。
- 与其重发 16 KB 的 XML 去补一个标签，不如用 `mode:'replaceScript'` 只换出错的那一段。

## 自定义积木

**不要手写 `argumentids`**——编译器会生成，并保证定义、原型、每个调用三处一致：

```xml
<block type="procedures_definition" x="20" y="560">
  <mutation proccode="跳跃 %n" argumentnames="高度" argumentdefaults="10"/>
  <next>
    <block type="motion_changeyby">
      <value name="DY">
        <!-- 读参数用 argument_reporter_*，field 里写"参数名"，不是 id -->
        <block type="argument_reporter_string_number"><field name="VALUE">高度</field></block>
      </value>
    </block>
  </next>
</block>
```

调用时参数用**名字**当输入名：

```xml
<block type="procedures_call">
  <mutation proccode="跳跃 %n"/>
  <value name="高度"><shadow type="math_number"><field name="NUM">30</field></shadow></value>
</block>
```

- `proccode` 里 `%n` 数字、`%s` 文本、`%b` 布尔，**数量必须与 `argumentnames` 对上**。
- 名字用逗号分隔（`argumentnames="高度,速度"`）或 JSON 数组都行。
  含逗号的**默认值**要用 JSON：`argumentdefaults='["a,b"]'`。
- `warp="true"` = "运行时不刷新屏幕"。
- 定义和调用可以写在同一个 XML 里。
- **跨片段调用也能用了**：往已有项目里 `append` 或改一段时，编译器会去**目标角色已有的
  自定义积木**里按 `proccode` 找到那对 argument id 自动补上。找不到就直接报错，
  不会写一个参数永远传不进去的调用。

## 加注释

写在它批注的积木里面：

```xml
<block type="event_whenflagclicked" id="hat" x="40" y="40">
  <comment id="note1">先判断再移动，否则会卡在墙里</comment>
  <next>…</next>
</block>
```

`x` `y` `w` `h` `minimized` 可给可不给，不给就自动摆在脚本旁边。
注释是给**人**看的：写"为什么这么做"，不要复述积木本身在做什么。

## 保存与打开：两份东西，别搞混

```
gandi_save {path:'game.sb3'}      # 编辑器 → 磁盘（整份覆盖目标文件）
gandi_open {path:'game.sb3'}      # 磁盘 → 编辑器（整份替换当前工程）
```

- **`gandi_save` 导出的是"编辑器里现在这个工程"**，不是磁盘上那个文件。
  磁盘上的合并成果如果比编辑器新，`gandi_save` 会把它覆盖掉。保存前先想清楚哪边是新的。
- 两个方向都是**整份替换**，没有合并。
- 导出到本地文件是**唯一的落盘方式**：编辑器那边是 Gandi 的在线作品，
  你不会、也不应该替用户去动他账号里的云端作品。
- 路径相对于会话工作目录；默认不允许写到工作目录之外。

## 动手之前先验一遍

```
gandi_verify {path:'game.sb3'}              # 离线：这个文件编辑器打得开吗？
gandi_verify {path:'game.sb3', live:true}   # 再让编辑器真的加载一次（会还原原来打开的工程）
```

它会一次性报出那些"打开才知道、报错还指错地方"的问题：opcode 不是积木
（编辑器会当成扩展去加载 → `Extension not found`）、自定义积木的 `<mutation>` 少了
编辑器要读的字段（`Cannot read properties of undefined`）、下拉 shadow 用错、
字段引用了一个没人声明的变量、造型引用了归档里没有的素材。

**合并出来的、脚本拼出来的 `.sb3`，在 `gandi_open` 之前先验一遍**——这一条能省掉整轮排查。

## 多个 agent 一起做一个项目

几个写手同时写一个 Scratch 工程，最省事的范式是**各写各的文件，最后合并**，
而不是抢同一个编辑器：

1. **主控先冻骨架**：`gandi_new` + `gandi_costume`/`gandi_variable` 把舞台、背景、
   全部**全局**变量/列表/广播 id 建好，`gandi_save` 出一份 `skeleton.sb3`。
2. **写一份 SPEC**：变量名与 id、列表语义、坐标系、渲染公式、每个角色归谁。
3. **每个写手只碰自己名下的角色**，各自复制一份 `skeleton.sb3` 当起点，
   全程走 `gandi_apply {path:'我的副本.sb3'}` —— 磁盘通道不需要编辑器，也不会抢租约。
4. **编辑器只留一个人用**（做造型、音效这类必须联机的活）。
5. **主控合并**：`gandi_merge {from:'写手.sb3', path:'main.sb3', targets:['玩家']}`。
   它会把那个角色的脚本、**它自己的变量/列表**、造型/音效**连同素材字节**一起搬过来，
   并把来源里的全局变量并进舞台（同 id 不同名会报出来）。
   手工只搬 `blocks` 会让几百处变量引用悬空，而且工程照样打得开——这正是它存在的理由。
6. **最后一次验收**：`gandi_open` + `gandi_run`，合并前后各 `gandi_verify` 一遍。

### 租约：什么时候会挡住你

改动编辑器的工具都要先拿"编辑租约"，防止两个会话同时写同一个工程。

- 被挡住时的报错会写清楚是谁、闲了多久，以及三条出路：**等**、
  `force: true`（本次调用强行接管）、`gandi_lease {action:'take'}`（明确接管）。
- **`force: true` 是所有会改编辑器的工具都有的参数**，不是话术。
- 空闲 **60 秒**后租约自动失效（`leaseIdleMs` 可配）。持牌人已经死了的时候别干等：
  `gandi_lease {action:'take'}` 或 `force: true`。
- 手头这轮活干完了就 `gandi_lease {action:'release'}`，别让别人等。

## 没有编辑器时怎么办

如果 Gandi 没开（`gandi_status` 说端口关着），你仍然能读写磁盘上的项目文件：

```
gandi_inspect {path:'game.sb3'}                         # 读角色、脚本、变量，脚本以 XML 给出
gandi_apply   {path:'game.sb3', target:'角色1', xml}     # 改脚本并写回文件
gandi_apply   {path:'game.sb3', outPath:'v2.sb3', xml}   # 另存一份，原件不动
gandi_verify  {path:'game.sb3'}                         # 检查它打得开吗
gandi_merge   {from:'a.sb3', path:'main.sb3'}            # 合并另一个写手的角色
```

- 用的是**同一套 XML 方言**，所以"离线读出来 → 改 → 写回"是闭环的。
- 离线只管脚本和变量声明；**画造型、建变量、跑起来看**都需要编辑器。
- 想做完整循环（改一下、跑一下、看一眼）就先 `gandi_launch`。

## Gandi 与 Scratch 的差别（会踩到的几条）

- **打开编辑器**：Gandi 启动后停在"我的作品"列表页，编辑器是单独一个页面。
  `gandi_launch` 会替你开一个编辑器页签；`gandi_status` 里的 `editor tab:` 说明有没有。
- **要联网**：编辑器本体是 `www.ccw.site` 上的网页，断网时开不出来。
- **`gandi_new` 是新建一个本地项目**：舞台 + 一个起始角色，不占用户账号的作品位。
- **新建角色**是"复制一个已有角色 → 清空 → 换造型"，所以项目里至少要有一个角色可复制——
  这就是 `gandi_new` 自带起始角色的原因。
- **云变量、Gandi 插件/扩展积木**都没做，别承诺。
