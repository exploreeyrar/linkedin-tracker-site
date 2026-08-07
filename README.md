# 投递清单看板

把油猴脚本 `linkedin-applied-tracker.user.js` 记录在本地的 LinkedIn 投递清单，
变成一个公开的 GitHub Pages 页面，并由 GitHub Actions 自动重建。

```
LinkedIn 职位页
   └─ 油猴脚本「已递交投递」        记录存浏览器本地
        └─ ☁ 自动推送 (GitHub API)  写入 data/records.json
             └─ push 触发 workflow  python build.py → dist/index.html
                  └─ 部署 Pages     https://<用户名>.github.io/<仓库名>/
```

另有每天一次的定时构建（`schedule`）作为兜底，即使某次推送没触发成功，页面也会被重建。

## 安装与自动更新（油猴脚本）

脚本已经在这个仓库里，头部带了 `@updateURL` / `@downloadURL`，所以只需要**装一次**：

浏览器打开
<https://raw.githubusercontent.com/exploreeyrar/linkedin-tracker-site/main/linkedin-applied-tracker.user.js>
→ Tampermonkey 弹出安装页 → 安装。

之后 Tampermonkey 会定期（默认每天，也可以在管理面板手动「检查更新」）去那个地址比对版本，
远端 `@version` 更大就自动换成新版，不用再手动复制粘贴。

几点要注意：

- **改完代码必须把 `@version` 往上加**，否则推上去也不会更新 —— 这是最容易忘的一步
- `raw.githubusercontent.com` 有约 5 分钟 CDN 缓存，push 完不会立刻可见；想马上验证就等几分钟再点「检查更新」
- 第一次必须从上面那个 URL 装。手动粘贴进编辑器的那份没有来源信息，Tampermonkey 不知道去哪儿查更新
- 元数据里新增 `@connect` / `@grant` 时，更新可能会弹一次确认，不是每次都静默
- **安全上要清楚**：开了自动更新，等于「谁能往 `main` 推代码，谁就能在你的 LinkedIn 页面里跑任意脚本」——
  而这个脚本手里有 GitHub PAT、`@connect *` 和 `GM_xmlhttpRequest`。别把仓库写权限给别人

## 文件

| 文件 | 作用 |
|---|---|
| `linkedin-applied-tracker.user.js` | 油猴脚本本体。装到 Tampermonkey 里跑，见下面「安装与自动更新」 |
| `data/records.json` | 数据源（投递记录 + 通知板）。**由油猴脚本整文件覆盖写入**，不要手工编辑 |
| `config.json` | 站点配置。目前只有 Telegram 中继地址 |
| `template.html` | 投递清单页模板，`__DATA__` 是数据注入点。想改配色/布局改这里 |
| `channel.html` | Telegram 群 / 频道消息的镜像页模板，`__CONFIG__` 是配置注入点 |
| `build.py` | 读数据 → 清洗校验 → 注入模板 → 输出 `dist/index.html` 与 `dist/channel.html`。只用标准库 |
| `worker/` | Cloudflare Worker：Telegram 中继，Bot Token 只存在这里 |
| `.github/workflows/pages.yml` | 构建与部署 |

## 一次性设置

### 1. 建仓库并推送

```bash
cd linkedin-tracker-site && git init -b main && git add . && git commit -m "feat: 投递清单看板"
```

```bash
gh repo create job-tracker --public --source=. --push
```

（没装 `gh` 就去 github.com 手动建一个 public 仓库，再 `git remote add origin … && git push -u origin main`）

### 2. 打开 Pages

仓库 → **Settings** → **Pages** → **Source** 选 **GitHub Actions**。

不要选 "Deploy from a branch"，这套流程用的是 Actions 部署。

### 3. 建一个 fine-grained PAT

**Settings**（你的账号，不是仓库）→ **Developer settings** → **Personal access tokens** →
**Fine-grained tokens** → **Generate new token**：

- **Repository access**：Only select repositories → 只勾这一个仓库
- **Permissions** → Repository permissions → **Contents: Read and write**（其它全部保持 No access）
- **Expiration**：按需，到期后要回来换一次

### 4. 填进油猴脚本

LinkedIn 职位页 → 清单面板标题栏 → **☁ 未配置** → 填仓库 `你的用户名/job-tracker` 和 Token
→ **保存并立即同步**。

看到「已推送 N 条记录」就成功了。约一分钟后 Pages 上线。

### 5. 部署 Telegram 中继（Cloudflare Worker）

和 FDA-TSK 一样：页面与油猴脚本都不持有 Bot Token，只把正文 POST 给 Worker，
Token 作为 Cloudflare Secret 保存。发送目标群写在 `worker/wrangler.toml` 的 `TG_CHAT`
（已填 `-1003974378230`）。

```bash
cd linkedin-tracker-site/worker && npx wrangler login && npx wrangler deploy
```

部署完再把 Bot Token 作为 Secret 存进去（命令会提示你粘贴，不要写进任何文件）：

```bash
cd linkedin-tracker-site/worker && npx wrangler secret put TG_TOKEN
```

把 `wrangler deploy` 输出的 URL 填两个地方：

- `config.json` 的 `tgEndpoint` —— 看板页面的 ✏️ 提醒按钮用
- 油猴脚本 ☁ GitHub 设置里的「Telegram 中继地址」—— ✈ 通知全部按钮用

Bot 必须已经在那个群里，且群里允许它发言。`wrangler.toml` 的 `ALLOWED_ORIGINS`
已经放行了 GitHub Pages 与 linkedin.com；换域名要同步改。

### 6. 把 Telegram 群 / 频道的消息同步到看板（可选）

装完之后，`channel.html`（看板右上角「📡 Telegram 频道」进去）会实时镜像那个群 /
频道里的消息。链路是 Telegram webhook → Worker → Durable Object → WebSocket 推给页面，
新消息毫秒级到达，不靠轮询。

先让 bot 真的能看见消息：

- **频道**：把 bot 设成频道管理员。
- **群**：在 BotFather 里 `/setprivacy` → **Disable**（否则 bot 只收得到 @它 的消息），
  改完把 bot 移出群再拉回来才生效。

然后部署并接上 webhook：

```bash
cd linkedin-tracker-site/worker && npx wrangler deploy
```

```bash
cd linkedin-tracker-site/worker && npx wrangler secret put WEBHOOK_SECRET
```

```bash
curl -X POST "https://api.telegram.org/bot<TG_TOKEN>/setWebhook" -d "url=https://<你的-worker>.workers.dev/tg/webhook" -d "secret_token=<上一步那个密钥>" -d 'allowed_updates=["message","channel_post","edited_message","edited_channel_post"]'
```

几件要知道的事：

- **拿不到 bot 加入之前的历史消息。** Bot API 没有回溯接口，只能从接上那一刻起往后攒。
  想补某几条：**去 Telegram 里编辑一下那条老消息**（哪怕只加个空格），编辑事件会把它
  连同原始时间戳一起送过来。页面顶部会按 msgId 缺号提示还差哪几条。
- **Telegram 不会通知「消息被删了」。** Bot API 就是没有这种 update，所以自动同步删除
  做不到。替代办法两个：页面上每条消息右上角的 🗑（只删看板、不动 Telegram 里的原消息）；
  或者在 Telegram 里把那条消息**编辑成 `/del`**，看板收到编辑事件就把它撤掉。
- **编辑会自动同步**，原地更新，不会变成新的一条。
- **图片能显示。** Worker 拿 `file_id` 去换真实地址再把字节流回来，Bot Token 全程留在
  服务端。只放行确实出现在收件箱里的 `file_id`，所以这个接口不会变成任人使用的下载代理。
  受 Telegram `getFile` 限制，超过 20MB 的文件取不到，页面上会注明。视频 / 非图片文件
  显示缩略图。
- `wrangler.toml` 里的 Durable Object 迁移（`new_sqlite_classes`）必须跟着 deploy 一起生效。
  万一没生效，Worker 会自动退回用 KV 存 —— 页面照常能看，只是新消息最多可能晚 60 秒
  （KV 是最终一致的），页面顶部的状态会显示「轮询中（未启用实时）」。
- 只有 `TG_CHAT` 那个群 / 频道的消息会被收下，别人把 bot 拉进别的群也灌不进来。
- webhook 和 `getUpdates` 二选一，设了 webhook 就不能再用 `getUpdates` 拉消息了。

## 日常使用

点「已递交投递」、改状态、写 MEMO —— 每次改动后 5 秒自动推送（连续改动会合并成一次提交）。
标题栏的 `☁ 已同步` / `☁ 失败` 显示当前状态，鼠标悬停看最近同步时间。

不想自动推送就在设置里取消勾选，改用 **☁ → 保存并立即同步** 手动推。

### 当日速报

每天 **JST 21:30** 由 Worker 的 Cron 自动发一条；看板右上角的「📣 当日速报」可以提前手动发，
一天只会发出去一条。

- **统计窗口是滚动的**：从上一批发出的时刻算到现在，首次运行或游标失效时退回「前一日 21:30」。
  因此 21:30 到零点之间的变化不会两边都漏掉。
- **这一批没有任何符合条件的状态变化时，当天的定时批次不发**（只在 KV 上打一个「空」标记做节流）。
  这个标记不占用「今天已发过」，所以之后手动点还是能发。
- 每个项目名下面附职位链接，项目顺序照清单里的显示顺位（重要度 → 状态顺位 → 更新时间）。
- 「已投递等联络」不算新情况，不进速报。

### 处理期限（deadline）

状态改成下面这三种之一时，油猴脚本会**自动弹窗**要一个日期：

- 等己方处理(XR ball)
- 已安排面试、面试准备中
- 対方来联络了

日期只精确到天，但**倒计时的终点是设定日前一天的 21:00（JST）** —— 提前一晚收工，
别拖到当天。选 8/10 就是倒计时到 8/09 21:00 JST。存的是「那天 0 点（JST）」的毫秒，
减 3 小时正好是前一日 21:00。

看板清单的**第一列「截止处理时间」**显示 `X天 X小时X分X秒`，秒级跳动；不到一天转成
琥珀色，过了终点还没改状态就显示**「已超时」**（红色）。点表头可以按紧急程度排序。

三种收尾方式：

| 在哪 | 怎么做 | 结果 |
|---|---|---|
| 看板 | 点那个倒计时 → 确认 | 删掉 deadline，格子回到 `—`，改动排队回传 |
| 油猴清单 | 点状态下方的 ⏳ → 「删除 deadline」 | 同上 |
| 油猴清单 | 点 ⏳ → 「✅ 标为已处理」 | 保留日期但停止倒计时，格子回到 `—` |

状态名在设置里改过也不影响触发 —— 匹配时会先去掉空白与标点、统一 `対`/`对`
（比如「等己方 处理(XR ball)」照样认得出来）。

### 跟进提醒

油猴清单里点 🕐（或看板上**右键某一行** / 详情页的「🕐 跟进提醒」）设一个日期。
设定后状态下方显示 🕐，到了那天打开页面会弹一个**只有「取消」能关掉**的全屏提示，
并尝试发一条 Chrome 通知。

看板是静态页，自己写不了 `records.json`。它把改动排进 `localStorage` 的待回传队列，
**由油猴脚本回写** —— 脚本的 `@match` 已经包含 `https://*.github.io/*`，在看板页上它不建任何
界面，只负责把队列取出来合并进本地记录再推回仓库。页面底部会显示「N 项改动待回传」直到落地。

> 这条回传链依赖油猴存储（GM storage）在站点之间共享同一份记录。
> 没装 Tampermonkey 时脚本退回 localStorage，那是分站点的，回传不了。

## 本地预览

```bash
cd linkedin-tracker-site && python3 build.py && open dist/index.html
```

## 几件需要知道的事

- **页面是公开的。** 公司名、岗位、HR 姓名与主页链接、MEMO 全部对任何拿到链接的人可见，
  也可能被搜索引擎收录。不想公开某条信息就别写进 MEMO，或在 `build.py` 的 `normalize()` 里
  把对应字段置空。
- **Token 存在浏览器本地**（油猴存储）。换电脑要重新填；不用了在设置里「清除 Token」。
  权限已经限到最小 —— 只能读写这一个仓库的文件。
- **`data/records.json` 会被整文件覆盖。** 油猴脚本是唯一数据源，在 GitHub 网页上直接编辑
  这个文件的话，下次同步就没了。
- **状态可以在油猴脚本里直接改名 / 新增 / 删除**（清单标题栏 → **⚙ 状态管理**），不用改代码。
  拖 ⠿ 排序，点名字就能改，勾「落」表示这条算已落选（清单里划掉置灰）。
  改名会**自动把用到旧名字的记录一起改掉**，并留一条别名，之后再导入的老数据也能对上。
  每条状态带一个永不变的 id，所以改名不会破坏行为：
  - 标「默认」的那条 = 新记录的初始状态，也是速报里「不算新情况」的那条
  - 标「超时」的那条 = 超 30 天无响应时自动落到的状态（删掉它就等于关掉这个自动判定）
  - 有记录正在使用的状态不允许删除，会提示还剩几条
- **改完状态后要同步一次**，看板才会跟上（整份定义 `statusDefs` 会随记录一起推上去）。
  自定义状态在看板上没有专门调过的配色，会按名字算一个稳定的色相。
- 三份代码里各留了一份**内置状态清单**（油猴脚本 `BUILTIN_STATUSES`、`build.py` `STATUSES`、
  `template.html` `STATUS_VAR` 配色）——它们只是「数据里没带定义时」的兜底，
  日常改状态不需要动它们。
- **通知板不是即时通讯。** LinkedIn 侧写完留言 → 5 秒后推送到仓库 → Actions 重建 → 看板更新，
  整条链路大约一分钟。看板页面本身是静态的，不会自己轮询。
- **Chrome 通知只在看板页面打开着（或被打开）时才会弹。** 静态页面没有 Service Worker 与推送
  订阅，做不到关掉标签页还能收推送。想要真正的后台推送，就看 Telegram 群里的消息。
- **「人事主动 scout 的」勾选框只在 LinkedIn 侧的清单里**，看板上不显示这一列，
  而是在状态下方加一个 🌟，并提供独立筛选按钮。重要度同理，显示成对应数量的 ✨。
- **重要度压过一切排序**：设了 ★ 的项目一定排在最上面，与状态顺位、时间新旧无关。
  手动点表头按别的列排序时不适用 —— 那是明确的「我要按这一列看」。
- **看板上的显示设置（中位任职 / 小红点 / 通知 / 跟进提醒）只存在本机浏览器**，换设备要重设。
- **看板上多选项目**：按住 Shift 划过或点击若干行，右下角出现「📣 发送速报」。
  选中模式下单击是「选 / 不选」，不再弹详情，点「清空」才退出。
- **通知板有未读时，打开看板就会自动展开**，直到手动点「全部标为已读」（点完顺手收起）或「收起」。
  每条留言都有 🔗 直达链接，从链接进来会自动展开并最大化通知板、滚到那一条。
- **定时构建不精确。** GitHub 的 `schedule` 在高峰期可能延迟几分钟到几十分钟，这是平台行为。
  另外仓库若连续 60 天没有任何提交，定时任务会被自动停用 —— 只要还在投递就不会遇到。
- **页面上的「距今 N 天」「本周新投」在浏览器端实时计算**，所以哪怕构建是几天前跑的，
  你看到的时间信息也是准的。
- Public 仓库的 Actions 用量免费。
