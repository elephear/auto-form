# 测试资源：两个网申站点 + 个人简历

本目录用于验证「自动表单填写助手」在真实页面结构下的表现，包含两个**结构不同**的招聘网申站点，
以及一份用于映射的个人简历。

```
test/
├── resume.txt              # 个人简历（纯文本，可直接粘贴到面板）
├── resume.docx             # 个人简历（Word，由 make_resume_docx.py 生成）
├── make_resume_docx.py     # 生成 resume.docx
├── run-tests.js            # jsdom 端到端测试（真实调用 DeepSeek API）
├── api-config.example.json # API 配置示例（复制为 api-config.json 填 Key）
├── site-a/                 # 站点 A：星辰招聘（layui 风格）
│   ├── index.html
│   ├── register.html       # 注册：用户名 / 邮箱 / 密码 / 确认密码
│   ├── apply.html          # 网申：皮肤单选、隐藏 select、复选组、textarea(maxlength)
│   ├── login.html          # 登录：验证扩展保存的账号密码
│   └── style.css
└── site-b/                 # 站点 B：蓝海人才（表格布局）
    ├── index.html
    ├── register.html       # 注册：邮箱 / 验证码(123456) / 密码(pattern 正则) / 协议勾选
    ├── apply.html          # 网申：表格 th+td、原生可见下拉、身份证/月份/数字/URL 控件
    └── style.css
```

## 两个站点的差异（专门用于覆盖不同 DOM 结构）

| 维度 | 站点 A 星辰招聘 | 站点 B 蓝海人才 |
| --- | --- | --- |
| 布局 | `div.layui-form-item` + `label` | `table > tr > th + td` |
| 下拉框 | 真实 `select` 被 `display:none`，显示自定义 `dd[lay-value]` | 原生可见 `select` |
| 单选/复选 | 隐藏 input + `div.layui-form-radio / layui-form-checkbox` 皮肤 | 原生可见 input + 包裹 `label` |
| 密码规则 | `minlength/maxlength` + 提示文字（8-16 位含大小写数字） | `pattern` 正则 + 提示文字（8-20 位含大小写数字） |
| 注册要素 | 用户名、邮箱、密码、确认密码 | 邮箱、验证码(123456)、密码、确认密码、协议勾选 |
| 网申字段 | 姓名/性别/生日/手机/邮箱/学历/院校/专业/求职意向/城市/技能/简介(100-300字) | 以上 + 身份证/政治面貌/籍贯/毕业时间(month)/薪资(number)/到岗日期/作品集(url)/项目经历/调剂 |
| 站点校验 | JS 校验用户名、邮箱、密码、确认密码、必填项 | JS 校验验证码、pattern、协议、身份证正则、字数下限 |

## 方式一：手动在真实浏览器中测试（推荐体验真实大模型）

1. 在 Chrome/Edge 加载本仓库扩展（`chrome://extensions/` → 加载已解压的扩展程序）。
2. 在扩展弹窗中填写 **API Key**（DeepSeek 或兼容 OpenAI 协议的服务）。
3. **在扩展弹窗「📄 简历 / 用户信息」中导入** `test/resume.docx`（或 `resume.txt`），点「💾 保存简历」。
   之后网页里按 Ctrl + / 会直接使用该简历，**不需要在页面上再导入**。
4. 启动本地静态服务器（`file://` 也可用，但需在扩展详情里开启「允许访问文件网址」）：

   ```bash
   # 零依赖（推荐）：默认 http://127.0.0.1:8000/，端口占用会自动 +1，启动后自动打开浏览器
   node test/serve.js
   # 不想自动打开浏览器：node test/serve.js --no-open
   # 自定义端口：set PORT=8080 && node test/serve.js

   # 或
   cd test
   python -m http.server 8000
   ```

   > 若出现「localhost 拒绝连接」：通常是服务器没在运行或端口不同。请确认终端里打印了
   > `静态服务器已启动：http://127.0.0.1:xxxx/`，并使用该地址访问（不要用 `https://`）。
   > 终端关闭后服务器即停止，需要重新运行命令。

5. 打开 <http://127.0.0.1:8000/site-a/index.html>（端口以服务器输出为准）：
   - 进入「注册账号」页 → 按 **Ctrl + /**：面板自动载入已保存简历并**自动开始填写**（可在弹窗关闭「自动开始」）
   - 面板显示生成的账号/密码并提示「已保存到本机」与复制提示；点击页面「注册」按钮完成注册
   - 进入「填写网申信息」→ Ctrl + / → 自动填写 → 点击「提交网申」，页面提示申请编号
   - 进入「登录」→ Ctrl + / → 自动填入已保存的账号密码（或点面板中的「填入」）→ 页面提示登录成功
6. 打开 <http://127.0.0.1:8000/site-b/index.html>，重复注册与网申流程（验证码提示为 123456）。

## 方式二（可选）：Node 自动化测试（使用真实 DeepSeek 大模型）

> 浏览器方式一里 Key 配置在**扩展弹窗**（存在扩展存储），网站测试无需额外配置。
> Node 进程读不到扩展的 `chrome.storage`，因此本自动化脚本需要**单独**提供 Key；
> 未提供 Key 时脚本只打印提示并正常退出（跳过），不会报错。

`run-tests.js` 用 jsdom 加载上面两个站点，桩掉 `chrome.*` API，但 **`CHAT_COMPLETION` 会真实请求 DeepSeek**：
内容脚本生成的提示词（含简历与表单结构）直接发给模型，模型返回的 JSON 再被解析并填入表单；
最后点击站点自身的「注册 / 提交 / 登录」按钮，验证站点校验通过。

### 1. 单独提供 API Key（任选其一）

```bash
# cmd 环境变量
set DEEPSEEK_API_KEY=sk-xxxxxxxx
node test/run-tests.js

# PowerShell
$env:DEEPSEEK_API_KEY="sk-xxxxxxxx"; node test/run-tests.js
```

或直接把 Key 作为参数（最简）：

```bash
node test/run-tests.js sk-xxxxxxxx
```

或复制 `api-config.example.json` 为 `api-config.json` 并填写：

```json
{
  "api_key": "sk-xxxxxxxx",
  "base_url": "https://api.deepseek.com",
  "model": "deepseek-chat"
}
```

也可以把 Key 放到 `test/key.txt`（首行 `sk-...`，已被 `.gitignore` 忽略），运行 `node test/run-tests.js` 会自动读取。

> 可选环境变量：`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`（支持兼容 OpenAI 协议的网关）。
> `api-config.json` / `key.txt` 已被 `.gitignore` 忽略，请勿把真实 Key 提交到仓库。

### 2. 安装依赖并运行

```bash
# 推荐：在 test 目录安装（已提供 test/package.json）
cd test
npm install
cd ..
node test/run-tests.js

# 或在项目根目录临时安装
npm install jsdom --no-save
node test/run-tests.js
```

> 若忘记安装依赖，脚本会提示安装命令而不是抛出堆栈。

运行时会打印每次真实调用的耗时，例如：

```
[LLM] 真实大模型：https://api.deepseek.com / deepseek-chat
[LLM] #1 完成：6.2s，返回 86 字
...
========================================
RESULT 69/69
```

> 具体填写内容由模型生成，断言校验其是否符合 `resume.txt` 与页面规则；若模型输出不满足页面要求（如验证码、字数下限），
> 对应断言会失败并打印面板/接口错误，便于定位提示词或规则问题。网络波动或限流也会导致失败，可重试。

覆盖点包括：

- 两个注册页均被识别为「注册模式」，生成符合页面规则的密码（含 `pattern` 正则场景）
- 注册后账号/密码写入 `chrome.storage.local`（按 origin 分组），且与页面填写值一致
- 注册完成后面板醒目提示「请复制保存账号密码」，并提供「📋 一键复制账号密码」按钮（复制后按钮变为「已复制」）
- 两个网申页的字段（含皮肤单选/复选、隐藏下拉、表格 th 标签、日期/月份/数字/URL 控件）均被正确填写
- 站点自身的前端校验全部通过（说明填写结果真实有效）
- 登录页能读取已保存的登录信息并填入，站点登录校验通过
- 大模型调用次数符合预期（登录模式不调用大模型）
