# 协作开发指南（课小伴）

面向参与本项目的同事。按本文操作即可拉取代码、开发、提交，并保证主分支干净。

---

## 一、仓库地址

| 远程名 | 地址 | 用途 |
|---|---|---|
| `origin` | `https://git.weixin.qq.com/Yu1__/kexiaoban.git` | 微信代码托管（**主力仓库**） |
| `github` | `https://github.com/CBrui/kexiaoban.git` | GitHub 镜像（默认分支 `main`） |

> 主分支是 `master`。GitHub 上 `main` 与 `master` 内容保持一致，网页默认打开 `main`。
> 日常开发只需用 `origin`，GitHub 由负责人同步。

---

## 二、首次接入（同事视角）

### 1. 拿权限

把你自己的**微信代码托管账号**告诉项目负责人，由负责人在仓库「成员管理」里添加为开发者。
GitHub 仓库同理，需要负责人邀请为 Collaborator。

### 2. 克隆

```bash
# 微信代码托管（推荐）
git clone https://git.weixin.qq.com/Yu1__/kexiaoban.git
cd kexiaoban

# 配好身份（首次使用 git 才需要）
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
```

### 3.（可选）同时挂上 GitHub

```bash
git remote add github https://github.com/CBrui/kexiaoban.git
```

### 4. 配置微信开发者工具

1. 打开**微信开发者工具** → **导入项目** → 选择 `kexiaoban` 目录
2. AppID 填 `wxcc614b0ea726db2d`（或换你自己的测试 AppID）
3. **不要**提交 `project.private.config.json` —— 这个文件是每台机器独有的本地编译设置，已在 `.gitignore` 中忽略，工具会自动生成，同事之间不共享
4. 未配置云环境时，项目自动降级为本地存储模式（`wx.storage`），可直接调试

### 5. 跑一遍测试确认环境正常

```bash
node test/run.js
```

看到 `86 项断言全部通过` 即接入成功。

---

## 三、日常开发流程

### 分支命名

**每次推送都在新分支上做，不要直接推 `master`。**

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/` | 新功能 | `feat/image-ocr-build` |
| `fix/` | 修 bug | `fix/week-swipe-direction` |
| `chore/` | 配置、文档、依赖 | `chore/repo-collab-setup` |
| `refactor/` | 重构（不改行为） | `refactor/schedule-timeline` |

### 标准四步

```bash
# 1. 从最新 master 拉一条新分支
git checkout master
git pull origin master
git checkout -b feat/你的功能名

# 2. 开发 → 提交（提交信息写清楚改了什么）
git add -A
git commit -m "feat(建表): 新增图片识别入口

新增内容:
- pages/build 增加「拍照/选图」按钮与预览
- logic/ocr-grid 新增网格定位第一步

修改内容:
- config.js 增加 OCR 开关

影响范围:
- 仅建表页,课表页不受影响"

# 3. 推送分支（不是 master）
git push origin feat/你的功能名

# 4. 到微信代码托管网页提「合并请求(Pull Request)」→ 等负责人 review
```

### 提交信息规范

**必须写清「修改了什么、添加了什么功能」**，推荐结构：

```
<类型>(<模块>): <一句话标题>

新增内容:
- ...

修改内容:
- ...

影响范围 / 注意事项:
- ...
```

类型取值：`feat` / `fix` / `chore` / `refactor` / `docs` / `test`。

---

## 四、合并规则

1. 任何人**不得直接 push `master`**
2. 所有改动走分支 + 合并请求，由项目负责人 review 后合并
3. 合并前必须：
   - `node test/run.js` 全部通过
   - 在开发者工具里自测过页面
   - 提交信息写清改动内容
4. 合并后删除已合并的远程分支

---

## 五、常用命令速查

```bash
# 同步最新 master
git checkout master && git pull origin master

# 把 master 的新改动合进自己的分支
git checkout feat/xxx && git merge master

# 查看改动
git status
git diff

# 撤销本地未提交的改动（谨慎）
git checkout -- <文件>

# 删除本地分支
git branch -d feat/xxx
```

---

## 六、避坑清单

| 坑 | 正确做法 |
|---|---|
| 直接 push master 造成冲突 | 永远推自己的分支，走 PR |
| 提交了 `project.private.config.json` | 已在 `.gitignore` 忽略；若不慎提交，用 `git rm --cached` 移出 |
| 提交了真实云环境 ID / AppSecret | `.gitignore` 不覆盖配置文件，请勿把密钥写进 `config.js` 后提交 |
| 分支落后导致冲突一大堆 | 每天开工先 `git pull origin master`，分支上定期 `git merge master` |
| 改了公共文件（`config.js`、`utils/schedule.js`）没告知 | 在 PR 描述里写明影响范围，避免同事的分支被覆盖 |
