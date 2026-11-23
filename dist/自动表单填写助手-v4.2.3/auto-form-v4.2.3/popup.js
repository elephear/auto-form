// ============================================================
// 自动表单填写助手 v4.2.3 - Popup Script
// ============================================================
// 功能：
// 1. 加载 / 保存配置（API、覆盖模式、保存登录信息、自动开始、启用开关）
// 2. 在扩展内导入并保存简历（.docx / .pdf / .txt），网页 Ctrl + / 时直接使用
// 3. 显示当前页面 content script 状态
// 4. 一键打开页面内的填写面板
// 5. 管理当前网站已保存的登录信息（复制密码 / 删除）
// ============================================================

(function () {
  "use strict";

  const ACCOUNTS_KEY = "af_accounts";
  const RESUME_KEY = "af_resume";
  const LEGACY_INFO_KEY = "af_last_info";

  // ============================================================
  // DOM 引用
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const els = {
    api_key: $("api_key"),
    base_url: $("base_url"),
    model: $("model"),
    fill_overwrite: $("fill_overwrite"),
    save_credentials: $("save_credentials"),
    auto_start: $("auto_start"),
    enabled: $("enabled"),
    resume_file: $("resume_file"),
    btn_pick_resume: $("btn_pick_resume"),
    resume_name: $("resume_name"),
    resume_text: $("resume_text"),
    resume_status: $("resume_status"),
    btn_save_resume: $("btn_save_resume"),
    btn_clear_resume: $("btn_clear_resume"),
    btn_save: $("btn_save"),
    btn_open: $("btn_open"),
    status_dot: $("status_dot"),
    status_text: $("status_text"),
    accounts_hint: $("accounts_hint"),
    accounts_list: $("accounts_list"),
    toast: $("toast"),
  };

  // ============================================================
  // 消息发送
  // ============================================================

  /** 扩展被更新/重载后，旧上下文会报 Extension context invalidated */
  function normalizeChromeError(msg) {
    const s = String(msg || "");
    if (/Extension context invalidated|message port closed/i.test(s)) {
      return "扩展已更新或重新加载，请关闭并重新打开扩展面板后重试";
    }
    return s;
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            if (chrome.runtime.lastError) {
              reject(new Error(normalizeChromeError(chrome.runtime.lastError.message)));
            } else {
              resolve(response);
            }
          } catch (e) {
            reject(new Error(normalizeChromeError(e.message)));
          }
        });
      } catch (e) {
        reject(new Error(normalizeChromeError(e.message)));
      }
    });
  }

  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          reject(new Error("未找到激活的标签页"));
          return;
        }
        resolve(tabs[0]);
      });
    });
  }

  function sendToTopFrame(message) {
    return getActiveTab().then(
      (tab) =>
        new Promise((resolve, reject) => {
          try {
            chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }, (response) => {
              try {
                if (chrome.runtime.lastError) {
                  reject(new Error(normalizeChromeError(chrome.runtime.lastError.message)));
                } else {
                  resolve(response);
                }
              } catch (e) {
                reject(new Error(normalizeChromeError(e.message)));
              }
            });
          } catch (e) {
            reject(new Error(normalizeChromeError(e.message)));
          }
        })
    );
  }

  // ============================================================
  // Toast
  // ============================================================

  let toastTimer = null;

  function showToast(msg, type = "info") {
    if (toastTimer) clearTimeout(toastTimer);
    els.toast.textContent = msg;
    els.toast.className = `toast ${type} show`;
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
    }, 2600);
  }

  function setResumeStatus(text, type) {
    if (!els.resume_status) return;
    els.resume_status.textContent = text || "";
    els.resume_status.style.color =
      type === "error" ? "#e53935" : type === "success" ? "#43a047" : "#888";
  }

  // ============================================================
  // 配置加载 / 保存
  // ============================================================

  async function loadConfig() {
    try {
      const config = await sendToBackground({ type: "GET_CONFIG" });
      if (!config || config.error) {
        showToast(`加载配置失败: ${(config && config.error) || "未知错误"}`, "error");
        return;
      }
      els.api_key.value = config.api_key || "";
      els.base_url.value = config.base_url || "https://api.deepseek.com";
      els.model.value = config.model || "deepseek-chat";
      els.fill_overwrite.checked = config.fill_overwrite || false;
      els.save_credentials.checked = config.save_credentials !== false;
      els.auto_start.checked = config.auto_start !== false;
      els.enabled.checked = config.enabled !== undefined ? config.enabled : true;
    } catch (err) {
      console.error("[自动填表][Popup] 加载配置失败", err);
      showToast(`加载配置失败: ${err.message}`, "error");
    }
  }

  async function saveConfig() {
    const config = {
      api_key: els.api_key.value.trim(),
      base_url: els.base_url.value.trim(),
      model: els.model.value.trim(),
      fill_overwrite: els.fill_overwrite.checked,
      save_credentials: els.save_credentials.checked,
      auto_start: els.auto_start.checked,
      enabled: els.enabled.checked,
    };

    if (!config.api_key) {
      showToast("请填写 API Key", "error");
      els.api_key.focus();
      return;
    }
    if (!config.base_url) {
      showToast("请填写 API 地址", "error");
      els.base_url.focus();
      return;
    }
    if (!config.model) {
      showToast("请填写模型名称", "error");
      els.model.focus();
      return;
    }

    try {
      const result = await sendToBackground({ type: "SAVE_CONFIG", config });
      if (result && result.success) {
        showToast("配置已保存 ✅", "success");
      } else {
        showToast(`保存失败: ${(result && result.error) || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`保存失败: ${err.message}`, "error");
    }
  }

  // ============================================================
  // 简历：在扩展内导入 / 保存 / 清空
  // ============================================================

  /** 文本解码（UTF-8 优先，乱码回退 GBK） */
  function decodeTextSmart(u8) {
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(u8);
    } catch (e) {
      text = "";
    }
    const bad = (text.match(/\uFFFD/g) || []).length;
    if (!text || bad > Math.max(3, text.length * 0.01)) {
      try {
        const gbk = new TextDecoder("gbk").decode(u8);
        if (gbk) return gbk.replace(/^\uFEFF/, "");
      } catch (e) { /* ignore */ }
    }
    return text.replace(/^\uFEFF/, "");
  }

  const RESUME_EXTS = ["docx", "pdf", "txt", "md", "json", "csv"];

  /** 在前 1KB 内查找 %PDF- 头，兼容带 BOM / 前导空白的 PDF */
  function hasPdfHeader(u8) {
    const n = Math.min(u8.length, 1024);
    for (let i = 0; i + 5 < n; i++) {
      if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 &&
        u8[i + 3] === 0x46 && u8[i + 4] === 0x2d) {
        return true;
      }
    }
    return false;
  }

  /** 判断文本是否其实是 PDF 源码（防止把二进制当文本导入） */
  function looksLikePdfText(text) {
    const head = String(text || "").slice(0, 2000);
    return /^\s*%PDF-\d/.test(head) ||
      (/^\s*\d+\s+\d+\s+obj\b/.test(head) && /\/Type\s*\/Catalog/.test(head));
  }

  /** 图片 / 二进制文件不允许当作简历文本导入 */
  function detectUnsupportedFile(name, u8) {
    const ext = (String(name || "").match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    if (ext && RESUME_EXTS.indexOf(ext) < 0) {
      return `不支持 .${ext} 文件，请上传 .docx / .pdf / .txt`;
    }
    const b = u8;
    const isPng = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const isJpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const isGif = b.length > 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
    const isBmp = b.length > 2 && b[0] === 0x42 && b[1] === 0x4d;
    const isWebp = b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    if (isPng || isJpg || isGif || isBmp || isWebp) {
      return "检测到图片文件：请上传 .pdf / .docx / .txt；图片简历请先转换为可复制文字的 PDF/Word";
    }
    return "";
  }

  function looksBinary(u8) {
    const n = Math.min(u8.length, 4096);
    if (!n) return false;
    let ctrl = 0;
    for (let i = 0; i < n; i++) {
      const b = u8[i];
      if (b === 0) return true;
      if (b < 7 || (b > 13 && b < 32)) ctrl++;
    }
    return ctrl > n * 0.1;
  }

  async function readResumeFile(file) {
    const name = (file.name || "").toLowerCase();
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    if (!u8.length) throw new Error("文件内容为空");

    const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b;
    const isOle = u8.length > 8 && u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0;
    const isPdf = hasPdfHeader(u8);
    if (isOle) throw new Error("检测到旧版 .doc，请另存为 .docx、.pdf 或 .txt");

    if (isPdf || name.endsWith(".pdf")) {
      if (!window.AF_PDF || typeof window.AF_PDF.extractTextFromPdf !== "function") {
        throw new Error("pdf 解析模块未加载，请重新打开扩展");
      }
      const text = await window.AF_PDF.extractTextFromPdf(buf);
      if (!text) throw new Error("PDF 中未提取到文字");
      if (looksLikePdfText(text)) {
        throw new Error("PDF 解析失败，请重新导入；仍失败时请将简历另存为 .docx 或 .txt");
      }
      return text;
    }

    if (isZip || name.endsWith(".docx")) {
      if (!window.AF_DOCX || typeof window.AF_DOCX.extractTextFromDocx !== "function") {
        throw new Error("docx 解析模块未加载，请重新打开扩展");
      }
      const text = await window.AF_DOCX.extractTextFromDocx(buf);
      if (!text) throw new Error("docx 中未提取到文字");
      return text;
    }

    const unsupported = detectUnsupportedFile(name, u8);
    if (unsupported) throw new Error(unsupported);
    if (looksBinary(u8)) {
      throw new Error("文件不是文本格式（可能是图片或压缩包），请上传 .docx / .pdf / .txt");
    }

    const text = decodeTextSmart(u8);
    if (!text.trim()) throw new Error("文件中未提取到文字");
    if (looksLikePdfText(text)) {
      throw new Error("检测到 PDF 内容但解析失败，请重新导入；仍失败时请将简历另存为 .docx 或 .txt");
    }
    return text;
  }

  async function loadResume() {
    try {
      const data = await chrome.storage.local.get([RESUME_KEY, LEGACY_INFO_KEY]);
      const resume = data && data[RESUME_KEY];
      const legacy = data && data[LEGACY_INFO_KEY];

      if (resume && resume.text) {
        els.resume_text.value = resume.text;
        const when = resume.updatedAt ? new Date(resume.updatedAt).toLocaleString() : "";
        els.resume_name.textContent = "已保存简历：" + (resume.filename || "（未命名）") + (when ? " · " + when : "");
        setResumeStatus(`已保存 ${resume.text.length} 字，网页 Ctrl + / 将直接使用`, "success");
        return;
      }
      if (legacy) {
        els.resume_text.value = legacy;
        els.resume_name.textContent = "已导入历史用户信息（未命名文件）";
        setResumeStatus(`已载入 ${legacy.length} 字，点击「保存简历」后生效`, "info");
        return;
      }
      els.resume_name.textContent = "未导入简历";
      setResumeStatus("简历仅保存在本机，不会上传。", "info");
    } catch (e) {
      setResumeStatus(`读取简历失败：${e.message}`, "error");
    }
  }

  async function handleResumeFile(file) {
    if (!file) return;
    els.resume_name.textContent = "正在读取 " + file.name + " …";
    setResumeStatus("正在解析文件…", "info");
    try {
      const text = await readResumeFile(file);
      els.resume_text.value = text;
      els.resume_name.textContent = "已读取：" + file.name;
      els.resume_name.dataset.filename = file.name;
      setResumeStatus(`已读取 ${text.length} 字，点击「保存简历」后生效`, "info");
    } catch (err) {
      els.resume_name.textContent = "未导入简历";
      setResumeStatus(`读取失败：${err.message}`, "error");
      showToast(`简历读取失败: ${err.message}`, "error");
    }
  }

  async function saveResume() {
    const text = (els.resume_text.value || "").trim();
    if (!text) {
      showToast("简历内容为空，请先导入或粘贴", "error");
      els.resume_text.focus();
      return;
    }
    const filename = els.resume_name.dataset.filename || "手动粘贴";
    const record = { text, filename, updatedAt: Date.now() };

    try {
      await chrome.storage.local.set({ [RESUME_KEY]: record, [LEGACY_INFO_KEY]: text });
      els.resume_name.dataset.filename = filename;
      els.resume_name.textContent =
        "已保存简历：" + filename + " · " + new Date(record.updatedAt).toLocaleString();
      setResumeStatus(`已保存 ${text.length} 字，网页 Ctrl + / 将直接使用`, "success");
      showToast("简历已保存 ✅", "success");
    } catch (e) {
      setResumeStatus(`保存失败：${e.message}`, "error");
      showToast(`简历保存失败: ${e.message}`, "error");
    }
  }

  async function clearResume() {
    try {
      await chrome.storage.local.remove([RESUME_KEY, LEGACY_INFO_KEY]);
      els.resume_text.value = "";
      delete els.resume_name.dataset.filename;
      els.resume_name.textContent = "未导入简历";
      setResumeStatus("已清空简历；网页 Ctrl + / 后将需要重新导入或粘贴用户信息", "info");
      showToast("简历已清空", "success");
    } catch (e) {
      showToast(`清空失败: ${e.message}`, "error");
    }
  }

  // ============================================================
  // 已保存的登录信息
  // ============================================================

  async function getActiveOrigin() {
    try {
      const tab = await getActiveTab();
      if (tab && tab.url) return new URL(tab.url).origin;
    } catch (e) { /* ignore */ }
    return "";
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(String(text || ""));
        return true;
      }
    } catch (e) { /* fallback */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = String(text || "");
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function loadAccounts() {
    const origin = await getActiveOrigin();
    els.accounts_hint.textContent = origin
      ? /^chrome-extension:/i.test(origin)
        ? "在网页上点击扩展图标即可查看 / 管理该网站的登录信息"
        : `网站：${origin}`
      : "在网页上点击扩展图标即可查看 / 管理该网站的登录信息";

    let all = {};
    try {
      const r = await chrome.storage.local.get([ACCOUNTS_KEY]);
      all = (r && r[ACCOUNTS_KEY]) || {};
    } catch (e) {
      all = {};
    }

    const list = origin && Array.isArray(all[origin]) ? all[origin] : [];
    els.accounts_list.textContent = "";

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "acc-empty";
      empty.textContent = "本网站还没有保存的登录信息。在注册页按 Ctrl + / 完成填写后会自动保存到这里。";
      els.accounts_list.appendChild(empty);
      return;
    }

    for (const acc of list) {
      const row = document.createElement("div");
      row.className = "acc-row";

      const main = document.createElement("div");
      main.className = "acc-main";
      const name = document.createElement("div");
      name.className = "acc-acc";
      name.textContent = acc.account || "(未命名账号)";
      const sub = document.createElement("div");
      sub.className = "acc-sub";
      const when = acc.createdAt ? new Date(acc.createdAt).toLocaleString() : "";
      sub.textContent = [acc.email || "", when].filter(Boolean).join(" · ");
      main.appendChild(name);
      main.appendChild(sub);

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn mini";
      copyBtn.textContent = "复制密码";
      copyBtn.addEventListener("click", async () => {
        const ok = await copyText(acc.password || "");
        showToast(ok ? "密码已复制" : "复制失败", ok ? "success" : "error");
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn mini danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        await deleteAccount(origin, acc.account || "");
      });

      row.appendChild(main);
      row.appendChild(copyBtn);
      row.appendChild(delBtn);
      els.accounts_list.appendChild(row);
    }
  }

  async function deleteAccount(origin, account) {
    try {
      const r = await chrome.storage.local.get([ACCOUNTS_KEY]);
      const all = (r && r[ACCOUNTS_KEY]) || {};
      const list = Array.isArray(all[origin]) ? all[origin] : [];
      all[origin] = list.filter((x) => (x.account || "") !== account);
      if (!all[origin].length) delete all[origin];
      await chrome.storage.local.set({ [ACCOUNTS_KEY]: all });
      showToast("已删除该条登录信息", "success");
      await loadAccounts();
    } catch (e) {
      showToast(`删除失败: ${e.message}`, "error");
    }
  }

  // ============================================================
  // 状态检测
  // ============================================================

  async function updateStatus() {
    try {
      const result = await sendToTopFrame({ type: "GET_STATUS" });
      if (!result) {
        els.status_dot.className = "status-dot inactive";
        els.status_text.textContent = "未检测到页面";
        return;
      }
      if (result.processing) {
        els.status_dot.className = "status-dot processing";
        els.status_text.textContent = "正在生成/填写中...";
      } else if (result.panelOpen) {
        els.status_dot.className = "status-dot active";
        els.status_text.textContent = "填写面板已打开";
      } else {
        els.status_dot.className = "status-dot active";
        els.status_text.textContent = "待命：Ctrl + / 触发";
      }
    } catch (err) {
      if (location.protocol === "chrome-extension:") {
        els.status_dot.className = "status-dot";
        els.status_text.textContent = "扩展配置页（打开网页后可检测状态）";
        return;
      }
      els.status_dot.className = "status-dot inactive";
      els.status_text.textContent = "当前页面不可用";
    }
  }

  // ============================================================
  // 打开填写面板
  // ============================================================

  async function openFillPanel() {
    els.btn_open.disabled = true;
    els.btn_open.textContent = "⏳ 打开中...";
    try {
      const result = await sendToTopFrame({ type: "OPEN_FILL_PANEL" });
      if (result && result.success) {
        showToast("填写面板已打开 🪄", "success");
        window.close();
      } else {
        showToast(`打开失败: ${(result && result.error) || "未知错误"}`, "error");
      }
    } catch (err) {
      if (/Receiving end does not exist|Could not establish connection/i.test(err.message)) {
        showToast("当前页面不支持（请刷新页面后重试）", "error");
      } else {
        showToast(`打开失败: ${err.message}`, "error");
      }
    } finally {
      els.btn_open.disabled = false;
      els.btn_open.textContent = "🪄 打开填写面板";
    }
  }

  // ============================================================
  // 事件绑定
  // ============================================================

  function bindEvents() {
    els.btn_save.addEventListener("click", () => saveConfig());
    els.btn_open.addEventListener("click", () => openFillPanel());

    // 简历
    els.btn_pick_resume.addEventListener("click", () => els.resume_file.click());
    els.resume_file.addEventListener("change", () => {
      const f = els.resume_file.files && els.resume_file.files[0];
      if (f) handleResumeFile(f);
      els.resume_file.value = "";
    });
    els.btn_save_resume.addEventListener("click", () => saveResume());
    els.btn_clear_resume.addEventListener("click", () => clearResume());

    [els.api_key, els.base_url, els.model].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveConfig();
      });
    });

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveConfig();
      }
    });
  }

  // ============================================================
  // 初始化
  // ============================================================

  async function init() {
    await loadConfig();
    await loadResume();
    await loadAccounts();
    await updateStatus();
    bindEvents();

    setInterval(() => {
      updateStatus();
    }, 3000);
  }

  if (document.readyState === "complete") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
