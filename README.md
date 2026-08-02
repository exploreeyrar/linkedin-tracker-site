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

## 文件

| 文件 | 作用 |
|---|---|
| `data/records.json` | 数据源。**由油猴脚本整文件覆盖写入**，不要手工编辑 |
| `template.html` | 页面模板，`__DATA__` 是数据注入点。想改配色/布局改这里 |
| `build.py` | 读数据 → 清洗校验 → 注入模板 → 输出 `dist/index.html`。只用标准库 |
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

## 日常使用

点「已递交投递」、改状态、写 MEMO —— 每次改动后 5 秒自动推送（连续改动会合并成一次提交）。
标题栏的 `☁ 已同步` / `☁ 失败` 显示当前状态，鼠标悬停看最近同步时间。

不想自动推送就在设置里取消勾选，改用 **☁ → 保存并立即同步** 手动推。

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
- **状态清单在三处定义，改的时候要一起改**：油猴脚本的 `STATUSES`、`build.py` 的 `STATUSES`、
  `template.html` 的 `STATUS_ORDER`（还要在 `STATUS_VAR` 里给新状态配个颜色）。
  数组顺序就是看板与清单的默认排序顺位。改名时在 `STATUS_ALIAS` 里加一条旧名→新名，
  历史记录才不会掉出下拉框。
- **定时构建不精确。** GitHub 的 `schedule` 在高峰期可能延迟几分钟到几十分钟，这是平台行为。
  另外仓库若连续 60 天没有任何提交，定时任务会被自动停用 —— 只要还在投递就不会遇到。
- **页面上的「距今 N 天」「本周新投」在浏览器端实时计算**，所以哪怕构建是几天前跑的，
  你看到的时间信息也是准的。
- Public 仓库的 Actions 用量免费。
