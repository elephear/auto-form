# 自动表单填写助手（Auto Form Filler）

> 按一下 `Ctrl + /`，让它读懂你导入的简历，帮你把网申表单填好。

一个零第三方依赖的 Chrome / Edge 扩展（Manifest V3）：
在扩展里导入一次简历（`.docx` / `.pdf` / `.txt`），之后在任何网页按 `Ctrl + /`，
插件会扫描页面表单、调用大模型做字段映射，并把能确定的字段自动填好，不确定的留空。

- 版本：4.2.3
- 作者：向雄（公众号：思之益）
- 许可：[Apache License 2.0](LICENSE)

## 特性

- **一次导入，处处可用**：简历解析成纯文本后保存在本机 `chrome.storage.local`，页面内不再重复导入。
- **零依赖解析**：`.docx` 用 ZIP 中央目录 + 原生 `DecompressionStream` 解析；`.pdf` 手写对象流、`FlateDecode`、`/ToUnicode` CMap 解析。
- **表单理解**：穿透同源 iframe 与 Shadow DOM 扫描控件，生成 `label / type / placeholder / opts` 描述发给大模型，由模型返回 `{"fields":[{"f":"f1","v":"张伟"}]}`。
- **只映射，不编造**：提示词与代码双重约束——简历里没有的信息一律留空。
- **兼容“假控件”**：layui / Element UI / Ant Design 的皮肤下拉、皮肤单选、皮肤复选。
- **可控可撤销**：默认只填空字段；每次写入都进撤销栈，一键回滚。
- **注册 / 登录辅助**：注册页按页面规则生成资料并保存账号（仅本机），登录页一键填入。

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角「开发者模式」；
2. 点击「加载已解压的扩展程序」，选择本项目根目录；
3. 点击扩展图标，填入大模型 API Key（默认 DeepSeek，支持兼容 OpenAI 协议的服务），保存配置；
4. 在「简历 / 用户信息」中导入简历并「保存简历」。

## 使用

| 场景 | 操作 |
| --- | --- |
| 网申 / 报名表单 | 按 `Ctrl + /`（macOS `Cmd + /`），核对清单后提交 |
| 注册页 | 按 `Ctrl + /`，自动生成账号密码并提示复制 |
| 登录页 | 按 `Ctrl + /`，填入本站已保存的账号密码 |

## 目录结构

```
.
├── manifest.json          # MV3 清单
├── background.js          # Service Worker：配置、DeepSeek 调用、content script 注入
├── content.js             # 面板 UI、表单扫描、提示词、写值逻辑
├── docx-extract.js        # 纯前端 .docx 文本提取（ZIP + Inflate）
├── pdf-extract.js         # 纯前端 .pdf 文本提取（对象流 + CMap）
├── popup.html / popup.js  # 扩展配置页、简历导入
├── review-templates.js    # 旧版“论文评语”流程模板（保留兼容）
├── icons/                 # 扩展图标
└── test/                  # 两个模拟网申站点 + 端到端测试脚本
```

## 本地测试

```bat
cd test
npm install
npm test
```

`test/serve.js` 可启动两个本地模拟网申站点（layui 风格 / 传统表格布局），
用于验证皮肤控件、iframe 表单等边界情况。

## 隐私说明

- 简历与已保存的登录信息只写入本机 `chrome.storage.local`，不上传任何自建服务器；
- API Key 保存在 `chrome.storage.sync`（会随浏览器账号同步，介意可改用 `local`）；
- 除调用你所配置的模型接口外，插件不发起任何网络请求。

## 许可证

本项目基于 **Apache License, Version 2.0** 发布。

```
Copyright 2025-2026 向雄 (Xiong Xiang)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

完整条款见 [LICENSE](LICENSE)，署名信息见 [NOTICE](NOTICE)。

---

公众号：**思之益**　|　作者：**向雄**
