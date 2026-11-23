// ============================================================
// 自动表单填写助手 v4.2.3 - Background Service Worker
// ============================================================
// 功能：
// 1. 管理配置存储（API Key、API 地址、模型、覆盖已有内容、启用开关）
// 2. 提供通用大模型对话接口 CHAT_COMPLETION（供自动表单填写使用）
// 3. 为 popup.js 提供配置读写接口
// 4. 编程式注入 content script（解决 --load-extension 不注入 content_scripts 的问题）
//
// 注：GENERATE_REVIEW / GENERATE_WORK_RECORD 为旧版"论文评语"流程保留，
//     新主流程（Ctrl + / 自动填表）使用 CHAT_COMPLETION。
// ============================================================

// ============================================================
// 🔧 调试工具模块
// ============================================================

/**
 * 生成时间戳字符串 [HH:MM:SS.mmm]
 */
function getTimestamp() {
  const now = new Date();
  return now.toTimeString().slice(0, 8) + "." + String(now.getMilliseconds()).padStart(3, "0");
}

/**
 * 统一调试日志输出
 * 所有日志都会带上统一的 [评语助手][BG][时间戳] 前缀
 */
const BG_DEBUG = {
  /** 是否启用详细调试日志（设为 true 会输出更多细节） */
  VERBOSE: false,

  /** 日志计数器 */
  _counter: 0,

  /** 普通信息日志 */
  log(msg, ...args) {
    console.log(`[评语助手][BG][${getTimestamp()}] ℹ️ ${msg}`, ...args);
  },

  /** 成功日志 */
  success(msg, ...args) {
    console.log(`[评语助手][BG][${getTimestamp()}] ✅ ${msg}`, ...args);
  },

  /** 警告日志 */
  warn(msg, ...args) {
    console.warn(`[评语助手][BG][${getTimestamp()}] ⚠️ ${msg}`, ...args);
  },

  /** 错误日志（含堆栈） */
  error(msg, err, ...args) {
    console.error(`[评语助手][BG][${getTimestamp()}] ❌ ${msg}`, err || "", ...args);
    if (err && err.stack) {
      console.error(`[评语助手][BG][${getTimestamp()}] 📋 错误堆栈:`, err.stack);
    }
  },

  /** 调试详情（仅 VERBOSE 模式下输出） */
  debug(msg, ...args) {
    if (!this.VERBOSE) return;
    console.debug(`[评语助手][BG][${getTimestamp()}] 🔍 ${msg}`, ...args);
  },

  /** 分组日志开始 */
  group(label) {
    console.group(`[评语助手][BG][${getTimestamp()}] 📦 ${label}`);
  },

  /** 分组日志结束 */
  groupEnd() {
    console.groupEnd();
  },

  /** 计时器开始 */
  time(label) {
    console.time(`[评语助手][BG] ⏱ ${label}`);
  },

  /** 计时器结束 */
  timeEnd(label) {
    console.timeEnd(`[评语助手][BG] ⏱ ${label}`);
  },

  /** 输出分隔线 */
  separator() {
    console.log(`[评语助手][BG] ${"=".repeat(60)}`);
  },

  /** 输出关键数据对象（JSON 序列化，隐藏敏感字段） */
  inspect(label, obj) {
    try {
      const sanitized = JSON.parse(JSON.stringify(obj));
      // 隐藏 API Key
      if (sanitized.api_key) sanitized.api_key = sanitized.api_key.slice(0, 6) + "****" + sanitized.api_key.slice(-4);
      this.debug(`${label}:`, JSON.stringify(sanitized, null, 2));
    } catch (e) {
      this.debug(`${label}: [无法序列化]`, obj);
    }
  },
};

// ============================================================
// Content Script 注入管理
// ============================================================

/** 需要注入 content script 的 URL 匹配模式（通用网页 + 本地文件页面） */
const INJECTION_PATTERNS = [
  /^https?:\/\//i,
  /^file:\/\//i,
];

/** 需要注入的 JS 文件列表（按执行顺序） */
const CONTENT_SCRIPTS = ["content.js"];

/**
 * 检查 URL 是否需要注入 content script
 */
function shouldInject(url) {
  if (!url) {
    BG_DEBUG.debug(`shouldInject: url 为空，跳过`);
    return false;
  }
  const matched = INJECTION_PATTERNS.some((pattern) => pattern.test(url));
  BG_DEBUG.debug(`shouldInject: url="${url}" → ${matched ? "✅ 需要注入" : "❌ 不需要注入"}`);
  return matched;
}

/**
 * 向指定标签页注入 content script
 */
async function injectContentScripts(tabId) {
  BG_DEBUG.group(`注入 Content Script → 标签页 ${tabId}`);

  try {
    // 记录已有 content script 的运行状态（仅用于日志，不再跳过注入：
    // 因为弹窗内的 textarea 可能位于子 iframe 中，必须保证每个 frame 都有脚本）
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      BG_DEBUG.log(`标签页 ${tabId} 已有 content script 响应: ${JSON.stringify(pong)}`);
    } catch (e) {
      BG_DEBUG.debug(`标签页 ${tabId} 暂无 content script 响应 (${e.message})`);
    }

    // 逐个注入 JS 文件（优先注入所有 frame，content.js 内部有防重复注入保护）
    const targetCandidates = [
      { tabId, allFrames: true, matchOriginAsFallback: true },
      { tabId, allFrames: true },
      { tabId },
    ];

    for (const jsFile of CONTENT_SCRIPTS) {
      BG_DEBUG.log(`正在注入 ${jsFile}（所有 frame）...`);
      let ok = false;
      for (const target of targetCandidates) {
        try {
          await chrome.scripting.executeScript({
            target,
            files: [jsFile],
            world: "ISOLATED",
          });
          BG_DEBUG.success(`${jsFile} 注入成功 (target=${JSON.stringify(target)})`);
          ok = true;
          break;
        } catch (injectErr) {
          BG_DEBUG.debug(`${jsFile} 注入失败 (target=${JSON.stringify(target)}): ${injectErr.message}`);
        }
      }
      if (!ok) BG_DEBUG.warn(`${jsFile} 所有注入方式均失败`);
    }
    BG_DEBUG.success(`Content scripts 注入流程结束 → 标签页 ${tabId}`);
  } catch (err) {
    BG_DEBUG.error(`注入 content script 失败`, err);
  }

  BG_DEBUG.groupEnd();
}

/**
 * 处理标签页更新事件
 */
function handleTabUpdate(tabId, changeInfo, tab) {
  BG_DEBUG.debug(`tabs.onUpdated → tabId=${tabId}, status=${changeInfo.status}, url=${tab.url || "(无 URL)"}`);
  if (changeInfo.status === "loading" && shouldInject(tab.url)) {
    BG_DEBUG.log(`页面加载中，准备注入 content script → tabId=${tabId}`);
    injectContentScripts(tabId);
  }
}

/**
 * 处理 webNavigation 事件（更可靠地捕获页面导航）
 */
function handleNavigationComplete(details) {
  BG_DEBUG.debug(`webNavigation.onDOMContentLoaded → tabId=${details.tabId}, frameId=${details.frameId}, url=${details.url}`);
  // details.frameId === 0 表示主框架
  if (details.frameId === 0 && shouldInject(details.url)) {
    BG_DEBUG.log(`主框架 DOM 加载完成，准备注入 content script → tabId=${details.tabId}`);
    injectContentScripts(details.tabId);
  }
}

// 注册事件监听器
BG_DEBUG.log("注册 tabs.onUpdated 监听器...");
chrome.tabs.onUpdated.addListener(handleTabUpdate);

BG_DEBUG.log("注册 webNavigation.onDOMContentLoaded 监听器...");
chrome.webNavigation.onDOMContentLoaded.addListener(handleNavigationComplete);

/**
 * 在启动时尝试为现有标签页注入
 */
async function injectExistingTabs() {
  BG_DEBUG.group("注入现有标签页");

  try {
    const tabs = await chrome.tabs.query({});
    BG_DEBUG.log(`查询到 ${tabs.length} 个现有标签页`);
    let injectedCount = 0;

    for (const tab of tabs) {
      BG_DEBUG.debug(`检查标签页 ${tab.id}: url=${tab.url || "(无 URL)"}, title="${tab.title || ""}"`);
      if (shouldInject(tab.url)) {
        BG_DEBUG.log(`标签页 ${tab.id} 需要注入`);
        await injectContentScripts(tab.id);
        injectedCount++;
      }
    }

    BG_DEBUG.success(`已完成：共检查 ${tabs.length} 个标签页，注入 ${injectedCount} 个`);
  } catch (err) {
    BG_DEBUG.error(`injectExistingTabs 失败`, err);
  }

  BG_DEBUG.groupEnd();
}

/**
 * 扩展安装/更新/启动时注入
 * onInstalled + onStartup 覆盖所有场景
 */
chrome.runtime.onInstalled.addListener((details) => {
  BG_DEBUG.log(`扩展已安装/更新 (reason: ${details.reason})，开始注入现有标签页...`);
  BG_DEBUG.debug(`安装详情: ${JSON.stringify(details)}`);
  injectExistingTabs();
});

chrome.runtime.onStartup.addListener(() => {
  BG_DEBUG.log(`浏览器启动，开始注入现有标签页...`);
  injectExistingTabs();
});

// ============================================================
// DeepSeek 配置
// ============================================================

const DEEPSEEK_DEFAULT_CONFIG = {
  base_url: "https://api.deepseek.com",
  model: "deepseek-chat",
  temperature: 0.7,
  max_tokens: 1024,
};

// ------------------------------------------------------------
// 调用后端大模型时固定的角色：毕业设计指导老师
// ------------------------------------------------------------
const SUPERVISOR_ROLE =
  "你是一位高校毕业设计指导老师（毕业设计指导教师），具有多年本科毕业设计指导经验，熟悉学术规范、论文写作与答辩要求。";

/**
 * 确保 system prompt 中明确声明"毕业设计指导老师"角色
 * @param {string} systemPrompt
 * @returns {string}
 */
function ensureSupervisorRole(systemPrompt) {
  const text = String(systemPrompt || "").trim();
  if (!text) return SUPERVISOR_ROLE;
  if (/毕业设计指导(老师|教师)/.test(text)) return text;
  return `${SUPERVISOR_ROLE}\n\n${text}`;
}

// ============================================================
// 配置管理
// ============================================================

/**
 * 获取所有配置
 */
async function getConfig() {
  BG_DEBUG.debug("getConfig: 正在从 chrome.storage.sync 读取配置...");
  const result = await chrome.storage.sync.get([
    "api_key",
    "base_url",
    "model",
    "teacher_text",
    "auto_submit",
    "enabled",
    "fill_overwrite",
    "save_credentials",
    "auto_start",
  ]);
  const config = {
    api_key: result.api_key || "",
    base_url: result.base_url || DEEPSEEK_DEFAULT_CONFIG.base_url,
    model: result.model || DEEPSEEK_DEFAULT_CONFIG.model,
    teacher_text: result.teacher_text || "",
    auto_submit: result.auto_submit || false,
    enabled: result.enabled !== undefined ? result.enabled : true,
    fill_overwrite: result.fill_overwrite || false,
    save_credentials: result.save_credentials !== undefined ? result.save_credentials : true,
    auto_start: result.auto_start !== undefined ? result.auto_start : true,
  };
  BG_DEBUG.inspect("getConfig 结果", config);
  BG_DEBUG.debug(`teacher_text 长度: ${config.teacher_text.length} 字`);
  return config;
}

/**
 * 保存配置
 */
async function saveConfig(config) {
  BG_DEBUG.group("保存配置");
  BG_DEBUG.inspect("待保存的配置", config);

  const toSave = {};
  if (config.api_key !== undefined) toSave.api_key = config.api_key;
  if (config.base_url !== undefined) toSave.base_url = config.base_url;
  if (config.model !== undefined) toSave.model = config.model;
  if (config.teacher_text !== undefined) toSave.teacher_text = config.teacher_text;
  if (config.auto_submit !== undefined) toSave.auto_submit = config.auto_submit;
  if (config.enabled !== undefined) toSave.enabled = config.enabled;
  if (config.fill_overwrite !== undefined) toSave.fill_overwrite = config.fill_overwrite;
  if (config.save_credentials !== undefined) toSave.save_credentials = config.save_credentials;
  if (config.auto_start !== undefined) toSave.auto_start = config.auto_start;

  BG_DEBUG.debug(`实际写入 storage 的字段: ${Object.keys(toSave).join(", ")}`);

  await chrome.storage.sync.set(toSave);
  BG_DEBUG.success("配置已保存到 chrome.storage.sync");

  BG_DEBUG.groupEnd();
}

/**
 * 获取教师评语（供 content.js 使用）
 */
async function getTeacherText() {
  BG_DEBUG.debug("getTeacherText: 读取 teacher_text...");
  const result = await chrome.storage.sync.get(["teacher_text"]);
  const text = result.teacher_text || "";
  BG_DEBUG.debug(`getTeacherText: ${text.length} 字`);
  return text;
}

/**
 * 获取自动提交开关状态
 */
async function getAutoSubmit() {
  BG_DEBUG.debug("getAutoSubmit: 读取 auto_submit...");
  const result = await chrome.storage.sync.get(["auto_submit"]);
  const val = result.auto_submit || false;
  BG_DEBUG.debug(`getAutoSubmit: ${val}`);
  return val;
}

// ============================================================
// DeepSeek API 调用
// ============================================================

/**
 * 调用 DeepSeek API 生成评语
 */
async function callDeepSeekAPI(systemPrompt, userPrompt, options = {}) {
  const {
    enforceRole = true,
    temperature = DEEPSEEK_DEFAULT_CONFIG.temperature,
    max_tokens = DEEPSEEK_DEFAULT_CONFIG.max_tokens,
    json_mode = false,
  } = options;

  BG_DEBUG.group("大模型 API 调用");

  const config = await getConfig();

  if (!config.api_key) {
    BG_DEBUG.groupEnd();
    throw new Error("DeepSeek API Key 未配置，请在扩展弹窗中设置");
  }

  // 旧评语流程：统一角色为"毕业设计指导老师"；通用表单填写不强制角色
  if (enforceRole) {
    systemPrompt = ensureSupervisorRole(systemPrompt);
    BG_DEBUG.log("角色设定: 毕业设计指导老师");
  }

  const baseUrl = config.base_url.replace(/\/+$/, "");
  const url = `${baseUrl}/v1/chat/completions`;

  BG_DEBUG.log(`API 地址: ${url}`);
  BG_DEBUG.log(`模型: ${config.model}`);
  BG_DEBUG.log(`systemPrompt 长度: ${systemPrompt.length} 字`);
  BG_DEBUG.log(`userPrompt 长度: ${userPrompt.length} 字`);
  BG_DEBUG.debug(`systemPrompt 前100字: ${systemPrompt.substring(0, 100)}...`);
  BG_DEBUG.debug(`userPrompt 前100字: ${userPrompt.substring(0, 100)}...`);

  const payload = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: temperature,
    max_tokens: max_tokens,
    stream: false,
  };

  // 要求模型输出严格 JSON（DeepSeek 支持 response_format）
  if (json_mode) payload.response_format = { type: "json_object" };

  BG_DEBUG.debug(`请求 payload (不含 messages): ${JSON.stringify({ model: payload.model, temperature: payload.temperature, max_tokens: payload.max_tokens })}`);

  BG_DEBUG.log("发送 API 请求...");

  const doRequest = async () =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.api_key}`,
      },
      body: JSON.stringify(payload),
    });

  let response;
  try {
    response = await doRequest();
  } catch (fetchErr) {
    BG_DEBUG.error("网络请求失败（可能是跨域/网络问题）", fetchErr);
    BG_DEBUG.groupEnd();
    throw new Error(`网络请求失败: ${fetchErr.message}`);
  }

  BG_DEBUG.log(`API 响应状态: ${response.status} ${response.statusText}`);

  // 某些兼容网关不支持 response_format，降级重试一次
  if (!response.ok && payload.response_format && response.status === 400) {
    try {
      BG_DEBUG.warn("response_format 可能不被支持，去掉后重试一次");
      delete payload.response_format;
      response = await doRequest();
      BG_DEBUG.log(`重试响应状态: ${response.status} ${response.statusText}`);
    } catch (retryErr) {
      BG_DEBUG.error("重试请求失败", retryErr);
      BG_DEBUG.groupEnd();
      throw new Error(`网络请求失败: ${retryErr.message}`);
    }
  }

  if (!response.ok) {
    const errorText = await response.text();
    BG_DEBUG.error(`API 返回错误 (${response.status})`, null, `响应正文: ${errorText}`);
    BG_DEBUG.groupEnd();
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  BG_DEBUG.log("正在解析 API 响应 JSON...");
  const data = await response.json();
  BG_DEBUG.debug(`API 响应结构: ${Object.keys(data).join(", ")}`);
  BG_DEBUG.debug(`usage: ${JSON.stringify(data.usage || "无 usage 信息")}`);

  if (!data.choices || data.choices.length === 0) {
    BG_DEBUG.error("API 返回异常", null, `完整响应: ${JSON.stringify(data).slice(0, 500)}`);
    BG_DEBUG.groupEnd();
    throw new Error("API 返回异常: 无 choices");
  }

  const content = (data.choices[0].message?.content || "").trim();
  BG_DEBUG.log(`API 返回的 finish_reason: ${data.choices[0].finish_reason || "未知"}`);
  BG_DEBUG.log(`API 返回内容长度: ${content.length} 字`);
  BG_DEBUG.debug(`API 返回内容前200字: ${content.substring(0, 200)}`);
  BG_DEBUG.debug(`API 返回内容后100字: ${content.substring(Math.max(0, content.length - 100))}`);

  if (!content) {
    BG_DEBUG.groupEnd();
    throw new Error("API 返回内容为空");
  }

  BG_DEBUG.success("API 调用成功");
  BG_DEBUG.groupEnd();
  return content;
}

/**
 * 通用对话调用（供"自动表单填写"使用，不强制角色、可要求 JSON 输出）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {{ temperature?: number, max_tokens?: number, json_mode?: boolean }} options
 * @returns {Promise<string>} 模型返回的文本内容
 */
async function callChatCompletion(systemPrompt, userPrompt, options = {}) {
  return callDeepSeekAPI(systemPrompt, userPrompt, {
    enforceRole: false,
    temperature: 0.1,
    max_tokens: 2600,
    ...options,
  });
}

// ============================================================
// 消息处理
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderInfo = sender.tab ? `tab=${sender.tab.id}, url="${sender.tab.url || ""}"` : `extension=${sender.id || "未知"}`;
  BG_DEBUG.group(`收到消息: ${message.type} (来自 ${senderInfo})`);
  BG_DEBUG.debug(`完整消息: ${JSON.stringify(message).slice(0, 300)}`);

  switch (message.type) {
    // === 配置相关 ===
    case "GET_CONFIG":
      BG_DEBUG.log("处理 GET_CONFIG 请求");
      getConfig().then((config) => {
        BG_DEBUG.success("GET_CONFIG 响应已发送");
        BG_DEBUG.groupEnd();
        sendResponse(config);
      }).catch((err) => {
        BG_DEBUG.error("GET_CONFIG 失败", err);
        BG_DEBUG.groupEnd();
        sendResponse({ error: err.message });
      });
      return true; // 保持消息通道开放

    case "SAVE_CONFIG":
      BG_DEBUG.log("处理 SAVE_CONFIG 请求");
      saveConfig(message.config).then(() => {
        BG_DEBUG.success("SAVE_CONFIG 完成");
        BG_DEBUG.groupEnd();
        sendResponse({ success: true });
      }).catch((err) => {
        BG_DEBUG.error("SAVE_CONFIG 失败", err);
        BG_DEBUG.groupEnd();
        sendResponse({ success: false, error: err.message });
      });
      return true;

    case "GET_TEACHER_TEXT":
      BG_DEBUG.log("处理 GET_TEACHER_TEXT 请求");
      getTeacherText().then((text) => {
        BG_DEBUG.debug(`GET_TEACHER_TEXT 返回 ${text.length} 字`);
        BG_DEBUG.groupEnd();
        sendResponse(text);
      });
      return true;

    case "GET_AUTO_SUBMIT":
      BG_DEBUG.log("处理 GET_AUTO_SUBMIT 请求");
      getAutoSubmit().then((val) => {
        BG_DEBUG.debug(`GET_AUTO_SUBMIT 返回: ${val}`);
        BG_DEBUG.groupEnd();
        sendResponse(val);
      });
      return true;

    // === DeepSeek API 调用 ===
    case "GENERATE_REVIEW":
      BG_DEBUG.log("处理 GENERATE_REVIEW 请求");
      (async () => {
        try {
          const config = await getConfig();
          if (!config.enabled) {
            BG_DEBUG.warn("评语助手已禁用，拒绝请求");
            BG_DEBUG.groupEnd();
            sendResponse({ success: false, error: "评语助手已禁用，请在扩展弹窗中启用" });
            return;
          }

          const d = message.data || {};
          const { review_type, cid1_content, cid3_content, project_title, user_input_text, word_range } = d;
          BG_DEBUG.log(`审核类型: ${review_type}`);
          BG_DEBUG.log(`审核对象: ${d.audit_target || "(未标注)"}`);
          BG_DEBUG.log(`课题名称: ${project_title || "(未获取)"}`);
          BG_DEBUG.log(`cid1_content 长度: ${(cid1_content || "").length} 字`);
          BG_DEBUG.log(`cid3_content 长度: ${(cid3_content || "").length} 字`);
          BG_DEBUG.log(`user_input_text 长度: ${(user_input_text || "").length} 字`);
          BG_DEBUG.log(`字数范围: ${word_range ? `${word_range.min}-${word_range.max}字` : "(未获取)"}`);

          const tabId = sender.tab?.id;
          BG_DEBUG.debug(`发送者 tabId: ${tabId}`);

          let system_prompt = "";
          let user_prompt = "";

          if (d.system_prompt && d.user_prompt) {
            // ✅ 推荐路径：content script 已按"与表单位于同一弹出 div"的内容构建好 prompt
            system_prompt = d.system_prompt;
            user_prompt = d.user_prompt;
            BG_DEBUG.success("使用 content script 直接提供的 prompt（角色：毕业设计指导老师）");
          } else {
            // 兼容路径：向 content script 请求模板
            if (!tabId) {
              BG_DEBUG.warn("无法获取发送者标签页 ID");
              BG_DEBUG.groupEnd();
              sendResponse({ success: false, error: "无法获取标签页 ID" });
              return;
            }

            BG_DEBUG.log("正在向 content script 请求 BUILD_PROMPT...");

            let templateResponse;
            try {
              templateResponse = await chrome.tabs.sendMessage(tabId, {
                type: "BUILD_PROMPT",
                data: {
                  review_type,
                  cid1_content,
                  cid3_content,
                  project_title,
                  teacher_text: config.teacher_text,
                  user_input_text: user_input_text || "",
                  word_range,
                },
              });
            } catch (msgErr) {
              BG_DEBUG.error("向 content script 发送 BUILD_PROMPT 失败", msgErr);
              BG_DEBUG.groupEnd();
              sendResponse({ success: false, error: `与 content script 通信失败: ${msgErr.message}` });
              return;
            }

            if (!templateResponse || !templateResponse.success) {
              BG_DEBUG.warn(`BUILD_PROMPT 返回错误: ${templateResponse && templateResponse.error}`);
              BG_DEBUG.groupEnd();
              sendResponse({ success: false, error: (templateResponse && templateResponse.error) || "获取评语模板失败" });
              return;
            }

            BG_DEBUG.success(`BUILD_PROMPT 成功，模板: ${templateResponse.name}`);
            system_prompt = templateResponse.system_prompt;
            user_prompt = templateResponse.user_prompt;
          }

          BG_DEBUG.log(`system_prompt 长度: ${system_prompt.length} 字, user_prompt 长度: ${user_prompt.length} 字`);

          // 调用 DeepSeek API（内部会强制角色：毕业设计指导老师）
          BG_DEBUG.log("开始调用 callDeepSeekAPI...");
          const review = await callDeepSeekAPI(system_prompt, user_prompt);

          BG_DEBUG.success(`评语生成完成: ${review.length} 字`);
          BG_DEBUG.debug(`评语全文: ${review}`);

          BG_DEBUG.groupEnd();
          sendResponse({ success: true, review });
        } catch (err) {
          BG_DEBUG.error("GENERATE_REVIEW 处理异常", err);
          BG_DEBUG.groupEnd();
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    // === 新增工作记录 ===
    case "GENERATE_WORK_RECORD":
      BG_DEBUG.log("处理 GENERATE_WORK_RECORD 请求");
      (async () => {
        try {
          const config = await getConfig();
          if (!config.enabled) {
            BG_DEBUG.warn("评语助手已禁用，拒绝请求");
            BG_DEBUG.groupEnd();
            sendResponse({ success: false, error: "评语助手已禁用，请在扩展弹窗中启用" });
            return;
          }

          const d = message.data || {};
          const { user_input_text, word_range } = d;
          BG_DEBUG.log(`user_input_text 长度: ${(user_input_text || "").length} 字`);
          BG_DEBUG.log(`字数范围: ${word_range ? `${word_range.min}-${word_range.max}字` : "(未获取)"}`);

          const tabId = sender.tab?.id;

          let system_prompt = "";
          let user_prompt = "";

          if (d.system_prompt && d.user_prompt) {
            // ✅ 推荐路径：content script 已构建好 prompt
            system_prompt = d.system_prompt;
            user_prompt = d.user_prompt;
            BG_DEBUG.success("使用 content script 直接提供的 prompt（角色：毕业设计指导老师）");
          } else {
            if (!tabId) {
              BG_DEBUG.warn("无法获取发送者标签页 ID");
              BG_DEBUG.groupEnd();
              sendResponse({ success: false, error: "无法获取标签页 ID" });
              return;
            }

            BG_DEBUG.log("正在向 content script 请求 BUILD_WORK_RECORD_PROMPT...");

            let templateResponse;
            try {
              templateResponse = await chrome.tabs.sendMessage(tabId, {
                type: "BUILD_WORK_RECORD_PROMPT",
                data: {
                  user_input_text: user_input_text || "",
                  word_range: word_range,
                },
              });
            } catch (msgErr) {
              BG_DEBUG.error("向 content script 发送 BUILD_WORK_RECORD_PROMPT 失败", msgErr);
              BG_DEBUG.groupEnd();
              sendResponse({ success: false, error: `与 content script 通信失败: ${msgErr.message}` });
              return;
            }

            if (!templateResponse || !templateResponse.success) {
              BG_DEBUG.warn(`BUILD_WORK_RECORD_PROMPT 返回错误: ${templateResponse && templateResponse.error}`);
              BG_DEBUG.groupEnd();
              sendResponse({ success: false, error: (templateResponse && templateResponse.error) || "获取工作记录模板失败" });
              return;
            }

            BG_DEBUG.success("BUILD_WORK_RECORD_PROMPT 成功");
            system_prompt = templateResponse.system_prompt;
            user_prompt = templateResponse.user_prompt;
          }

          BG_DEBUG.log(`system_prompt 长度: ${system_prompt.length} 字, user_prompt 长度: ${user_prompt.length} 字`);

          // 调用 DeepSeek API（内部会强制角色：毕业设计指导老师）
          BG_DEBUG.log("开始调用 callDeepSeekAPI...");
          const resultText = await callDeepSeekAPI(system_prompt, user_prompt);

          // 尝试解析 JSON
          let parsed;
          try {
            // 清理可能的 markdown 代码块标记
            const cleaned = resultText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
            parsed = JSON.parse(cleaned);
          } catch (parseErr) {
            BG_DEBUG.warn(`DeepSeek 返回内容无法解析为 JSON: ${parseErr.message}`);
            BG_DEBUG.debug(`原始返回: ${resultText}`);
            BG_DEBUG.groupEnd();
            sendResponse({ success: false, error: `DeepSeek 返回格式错误: ${parseErr.message}`, raw: resultText });
            return;
          }

          // 验证必要字段
          if (!parsed.content) {
            BG_DEBUG.warn("DeepSeek 返回缺少 content 字段");
            BG_DEBUG.groupEnd();
            sendResponse({ success: false, error: "返回数据缺少指导内容(content)" });
            return;
          }

          BG_DEBUG.success(`工作记录数据解析成功`);
          BG_DEBUG.debug(`解析结果: ${JSON.stringify(parsed)}`);

          BG_DEBUG.groupEnd();
          sendResponse({ success: true, data: parsed });
        } catch (err) {
          BG_DEBUG.error("GENERATE_WORK_RECORD 处理异常", err);
          BG_DEBUG.groupEnd();
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    // === 通用大模型对话（自动表单填写）===
    case "CHAT_COMPLETION":
      BG_DEBUG.log("处理 CHAT_COMPLETION 请求");
      (async () => {
        try {
          const config = await getConfig();
          if (!config.enabled) {
            BG_DEBUG.warn("助手已禁用，拒绝 CHAT_COMPLETION 请求");
            BG_DEBUG.groupEnd();
            sendResponse({ success: false, error: "助手已禁用，请在扩展弹窗中启用" });
            return;
          }

          const content = await callChatCompletion(message.system_prompt || "", message.user_prompt || "", {
            json_mode: message.json_mode === true,
            max_tokens: message.max_tokens,
            temperature: message.temperature,
          });

          BG_DEBUG.success(`CHAT_COMPLETION 完成: ${content.length} 字`);
          BG_DEBUG.groupEnd();
          sendResponse({ success: true, content });
        } catch (err) {
          BG_DEBUG.error("CHAT_COMPLETION 处理异常", err);
          BG_DEBUG.groupEnd();
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;

    default:
      BG_DEBUG.warn(`未知消息类型: ${message.type}`);
      BG_DEBUG.groupEnd();
      sendResponse({ success: false, error: `未知消息类型: ${message.type}` });
      return true;
  }
});
