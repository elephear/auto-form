/*!
 * 自动表单填写助手 (Auto Form Filler) v4.2.3 — Content Script
 * Copyright 2025-2026 向雄 (Xiong Xiang) <公众号：思之益>
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0. See the LICENSE file.
 */

// ============================================================
// 自动表单填写助手 v4.2.3 — Content Script
// ============================================================
// 触发方式：Ctrl + /（macOS 为 Cmd + /）
//
// 处理流程（严格按需求执行）：
//   1) 弹出填写面板，读取用户上传的 Word(.docx) / PDF / TXT 文件，得到用户信息
//   2) 扫描当前页面（含同源 iframe / Shadow DOM）上的表单控件，生成结构化描述
//   3) 调用大模型分析表单结构，把用户信息映射到各个字段
//   4) 将映射结果自动写入表单控件（input / textarea / select / radio / checkbox）
//
// 设计要点：
// - 不做页面监控：只有 Ctrl + / 被按下（或 popup 主动请求）时才启动流程。
// - 面板使用 Shadow DOM 隔离样式，避免与宿主页面 CSS 冲突。
// - 只填充"能根据用户信息确定"的字段，不确定的字段一律留给人工。
// ============================================================

(function () {
  "use strict";

  // 防止 manifest 注入与 background 编程式注入重复执行
  if (window.__AUTO_FORM_FILLER_LOADED__) {
    try { console.debug("[自动填表] 本 frame 已初始化，跳过重复注入"); } catch (e) { /* ignore */ }
    return;
  }
  window.__AUTO_FORM_FILLER_LOADED__ = true;

  const VERSION = "4.2.3";
  /** 单次最多分析的字段数（避免 prompt 过长） */
  const MAX_FIELDS = 150;
  const PANEL_HOST_ID = "__af_form_filler_host__";

  const IS_TOP = (function () {
    try { return window === window.top; } catch (e) { return false; }
  })();

  // ============================================================
  // 调试工具
  // ============================================================

  const AF_DEBUG = {
    VERBOSE: false,
    log(msg, ...args) {
      if (!this.VERBOSE) return;
      try { console.log("[自动填表] ℹ️ " + msg, ...args); } catch (e) { /* ignore */ }
    },
    success(msg, ...args) {
      if (!this.VERBOSE) return;
      try { console.log("[自动填表] ✅ " + msg, ...args); } catch (e) { /* ignore */ }
    },
    warn(msg, ...args) {
      try { console.warn("[自动填表] ⚠️ " + msg, ...args); } catch (e) { /* ignore */ }
    },
    error(msg, err, ...args) {
      try { console.error("[自动填表] ❌ " + msg, err || "", ...args); } catch (e) { /* ignore */ }
    },
  };

  // ============================================================
  // 状态
  // ============================================================

  const STATE = {
    panelHost: null,
    shadow: null,
    refs: null,
    stepNodes: [],
    registry: [],       // [{ id, kind, el, els, doc, meta }]
    undoStack: [],      // [{ type: "value"|"checked", el, prev }]
    busy: false,
    open: false,
    lastAnalysis: null,
    resumeText: "",     // 从扩展配置读取的简历（页面内不可编辑）
    config: { fill_overwrite: false, enabled: true },
  };

  const STEP_DEFS = [
    "获取已保存的简历",
    "扫描页面表单结构",
    "大模型分析字段映射",
    "自动填写表单",
  ];

  const PANEL_HTML = `
<style>
  :host { all: initial; }
  .mask {
    position: fixed; inset: 0; background: rgba(15, 23, 42, .45);
    backdrop-filter: blur(2px);
  }
  .panel {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(640px, 94vw); max-height: 88vh;
    display: flex; flex-direction: column;
    background: #fff; border-radius: 14px; overflow: hidden;
    box-shadow: 0 24px 72px rgba(0, 0, 0, .38);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 13px; color: #1f2937; line-height: 1.5;
    animation: af-in .16s ease-out;
  }
  @keyframes af-in {
    from { opacity: 0; transform: translate(-50%, -47%) scale(.98); }
    to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 13px 18px; color: #fff;
    background: linear-gradient(135deg, #2563eb, #1e40af);
    font-size: 15px; font-weight: 600; flex: 0 0 auto;
  }
  header .ver { font-size: 11px; font-weight: 400; opacity: .82; }
  header .close {
    margin-left: auto; background: transparent; border: none; color: #fff;
    font-size: 22px; line-height: 1; cursor: pointer; opacity: .85; padding: 0 2px;
  }
  header .close:hover { opacity: 1; }
  .body {
    padding: 14px 18px; overflow: auto; display: flex; flex-direction: column; gap: 10px;
  }
  .drop {
    border: 1px solid #dbeafe; border-radius: 10px; padding: 10px 12px;
    text-align: left; font-size: 12px; color: #4b5563; background: #f8faff;
    line-height: 1.65;
  }
  .file-row { display: flex; align-items: center; gap: 8px; }
  .file-row .name {
    font-size: 12px; color: #6b7280;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  textarea.info {
    width: 100%; min-height: 130px; max-height: 240px; resize: vertical;
    border: 1px solid #d1d5db; border-radius: 8px; padding: 10px;
    font-size: 12.5px; line-height: 1.65; color: #111827; background: #fff;
    font-family: ui-monospace, SFMono-Regular, Consolas, "Microsoft YaHei", monospace;
  }
  textarea.info:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .15); }
  textarea.info[readonly] { background: #f8fafc; color: #374151; cursor: default; }
  .opts { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12.5px; color: #374151; }
  .opts label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
  .steps { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
  .step { display: flex; align-items: center; gap: 8px; color: #9ca3af; }
  .step .dot {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid #d1d5db;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; flex: 0 0 auto;
  }
  .step .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .step.active { color: #2563eb; }
  .step.active .dot { border-color: #2563eb; border-top-color: transparent; animation: af-spin .8s linear infinite; }
  .step.done { color: #059669; }
  .step.done .dot { border-color: #059669; background: #059669; color: #fff; }
  .step.error { color: #dc2626; }
  .step.error .dot { border-color: #dc2626; background: #dc2626; color: #fff; }
  @keyframes af-spin { to { transform: rotate(360deg); } }
  .report {
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px;
    background: #fafafa; font-size: 12px; max-height: 190px; overflow: auto;
  }
  .report .item { display: flex; gap: 8px; padding: 3px 0; border-bottom: 1px dashed #eee; }
  .report .item:last-child { border-bottom: none; }
  .report .k { color: #6b7280; flex: 0 0 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .report .v { color: #111827; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 12px; color: #6b7280; min-height: 16px; }
  .hint { font-size: 11.5px; color: #9ca3af; }
  .info-src { font-size: 11.5px; color: #9ca3af; }
  .mode-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: #374151; }
  .mode-row select {
    border: 1px solid #d1d5db; border-radius: 6px; padding: 4px 8px;
    font-size: 12.5px; color: #111827; background: #fff; font-family: inherit;
  }
  .mode-hint { color: #6b7280; font-size: 12px; }
  .accounts { border: 1px solid #dbeafe; background: #f5f9ff; border-radius: 8px; padding: 8px 10px; }
  .accounts-title { font-size: 12px; font-weight: 600; color: #1d4ed8; margin-bottom: 6px; }
  .acc-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px dashed #dbeafe; }
  .acc-item:last-child { border-bottom: none; }
  .acc-info { flex: 1; min-width: 0; }
  .acc-name { font-size: 12.5px; color: #111827; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acc-meta { font-size: 11px; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cred { border: 1px solid #d1fae5; background: #f3fdf8; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
  .cred-title { font-weight: 600; color: #059669; margin-bottom: 6px; }
  .cred-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
  .cred-row .k { flex: 0 0 46px; color: #6b7280; }
  .cred-row .v {
    flex: 1; min-width: 0; color: #111827; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  .btn.mini {
    padding: 4px 10px; font-size: 12px; border-radius: 6px;
    background: #2563eb; color: #fff;
  }
  .btn.mini.ghost { background: #fff; color: #374151; border: 1px solid #d1d5db; }
  .btn.mini.primary { background: #059669; color: #fff; }
  .btn.mini:disabled { opacity: .65; cursor: default; }
  .cred-tip {
    color: #b45309; background: #fffbeb; border: 1px solid #fde68a;
    border-radius: 6px; padding: 6px 8px; font-size: 11.5px; line-height: 1.6;
    margin: 6px 0 8px;
  }
  footer {
    display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px;
    border-top: 1px solid #eef2f7; background: #fbfdff; flex: 0 0 auto;
  }
  .btn {
    border: none; border-radius: 8px; padding: 9px 16px;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: .15s;
    font-family: inherit;
  }
  .btn.primary { background: #2563eb; color: #fff; }
  .btn.primary:hover { background: #1d4ed8; }
  .btn.primary:disabled { opacity: .5; cursor: not-allowed; }
  .btn.ghost { background: #fff; color: #374151; border: 1px solid #d1d5db; }
  .btn.ghost:hover { background: #f3f4f6; }
  .btn.ghost:disabled { opacity: .45; cursor: not-allowed; }
</style>
<div class="mask"></div>
<div class="panel" role="dialog" aria-label="自动表单填写">
  <header>
    <span>🪄 自动表单填写</span>
    <span class="ver">Ctrl + /</span>
    <button class="close" id="af-close" title="关闭（Esc）">×</button>
  </header>
  <div class="body">
    <div class="steps" id="af-steps"></div>
    <div class="cred" id="af-cred" style="display:none"></div>
    <div class="report" id="af-report" style="display:none"></div>
    <div class="status" id="af-status"></div>
  </div>
  <footer>
    <button class="btn ghost" id="af-undo" disabled>↩︎ 撤销填写</button>
    <button class="btn ghost" id="af-cancel">关闭</button>
  </footer>
</div>
`;

  // ============================================================
  // 基础工具
  // ============================================================

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const EXT_INVALIDATED_RE = /(Extension context invalidated|Extension context was invalidated|The message port closed|message port closed)/i;
  const EXT_RELOAD_TIP = "扩展已更新或重新加载，请刷新当前网页（Ctrl + R）后再按 Ctrl + / 重试";

  /** 把扩展被重载导致的通信错误转换成可操作的中文提示 */
  function normalizeRuntimeError(err) {
    const msg = String((err && err.message) || err || "");
    if (EXT_INVALIDATED_RE.test(msg)) {
      const e = new Error(EXT_RELOAD_TIP);
      e.isExtensionInvalidated = true;
      return e;
    }
    return err instanceof Error ? err : new Error(msg || "与扩展后台通信失败");
  }

  function sendToBackground(message) {
    return new Promise((resolve, reject) => {
      try {
        // 扩展被更新/重载后，旧页面里的 content script 会失去 chrome.runtime 上下文
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
          reject(normalizeRuntimeError(new Error("Extension context invalidated.")));
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          try {
            if (chrome.runtime.lastError) {
              reject(normalizeRuntimeError(new Error(chrome.runtime.lastError.message)));
            } else {
              resolve(response);
            }
          } catch (e) {
            reject(normalizeRuntimeError(e));
          }
        });
      } catch (e) {
        reject(normalizeRuntimeError(e));
      }
    });
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function truncate(str, max) {
    const s = String(str || "");
    if (!max || s.length <= max) return s;
    return s.slice(0, max) + "…";
  }

  /** 归一化：去空白、去标点、转小写，便于做选项模糊匹配 */
  function norm(str) {
    return String(str == null ? "" : str)
      .replace(/[\s\u00a0]+/g, "")
      .replace(/[：:，,。.、"'"'（）()\[\]【】<>《》\-_/\\|]/g, "")
      .toLowerCase();
  }

  function textOf(el) {
    if (!el) return "";
    const raw = (typeof el.innerText === "string" && el.innerText) ? el.innerText : (el.textContent || "");
    return String(raw).replace(/\s+/g, " ").trim();
  }

  function cleanLabel(str) {
    return String(str || "")
      .replace(/[\s\u00a0]+/g, " ")
      .replace(/[*＊:：]+$/g, "")
      .trim();
  }

  function cssEscape(str) {
    try {
      if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(str);
    } catch (e) { /* ignore */ }
    return String(str).replace(/["\\]/g, "\\$&");
  }

  function describeEl(el) {
    if (!el) return "null";
    try {
      const cls = typeof el.className === "string" ? el.className.slice(0, 40) : "";
      return `${el.tagName}${el.id ? "#" + el.id : ""}${cls ? "." + cls.replace(/\s+/g, ".") : ""}`;
    } catch (e) {
      return (el && el.tagName) || "元素";
    }
  }

  /** 尽量把各种日期写法转成 YYYY-MM-DD */
  function parseDateLoose(value) {
    const t = String(value || "")
      .replace(/[年月./]/g, "-")
      .replace(/日/g, "");
    let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    m = t.match(/(\d{4})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad2(m[2])}-01`;
    return "";
  }

  /** 智能解码文本（UTF-8 优先，乱码时回退 GBK） */
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

  // ============================================================
  // 文档遍历（含同源 iframe、Shadow DOM）
  // ============================================================

  function getRootDoc() {
    try {
      let win = window;
      let depth = 0;
      while (win !== win.top && depth < 8) {
        const parent = win.parent;
        if (!parent) break;
        // 触发访问以检测跨域
        void parent.document.documentElement;
        win = parent;
        depth++;
      }
      return win.document;
    } catch (e) {
      return document;
    }
  }

  function collectDocs() {
    const out = [];
    const seen = new Set();

    const walk = (doc, depth) => {
      if (!doc || depth > 5 || seen.has(doc)) return;
      let root = null;
      try { root = doc.documentElement; } catch (e) { root = null; }
      if (!root) return;
      seen.add(doc);
      out.push(doc);

      let frames = [];
      try { frames = Array.from(doc.querySelectorAll("iframe, frame")); } catch (e) { frames = []; }
      for (const f of frames) {
        let d = null;
        try { d = f.contentDocument || (f.contentWindow && f.contentWindow.document); } catch (e) { d = null; }
        if (d && d.documentElement) walk(d, depth + 1);
      }
    };

    walk(getRootDoc(), 0);
    // 当前 frame 自身也要包含（例如跨域 iframe 场景）
    walk(document, 0);
    return out;
  }

  /** 收集所有候选表单元素（穿透 Shadow DOM） */
  function collectRawElements(docs) {
    const els = [];
    const seen = new Set();

    for (const doc of docs) {
      const visit = (root, depth) => {
        if (!root || depth > 5) return;

        let list = [];
        try { list = Array.from(root.querySelectorAll("input, textarea, select")); } catch (e) { list = []; }
        for (const el of list) {
          if (seen.has(el)) continue;
          seen.add(el);
          els.push(el);
        }

        let all = [];
        try { all = Array.from(root.querySelectorAll("*")); } catch (e) { all = []; }
        for (const el of all) {
          if (el.id === PANEL_HOST_ID) continue; // 跳过自身面板
          if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
        }
      };
      visit(doc, 0);
    }

    return els;
  }

  // ============================================================
  // 控件判定 / 字段标签解析
  // ============================================================

  const FILLABLE_INPUT_TYPES = new Set([
    "text", "email", "tel", "number", "search", "url",
    "date", "datetime-local", "month", "week", "time",
    "radio", "checkbox", "password",
  ]);

  function isShown(el) {
    try {
      if (!el || !el.isConnected) return false;
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      const style = win ? win.getComputedStyle(el) : null;
      if (style) {
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  /** 组件库中代表"单选 / 复选 / 开关"的皮肤节点类名 */
  const CHOICE_SKIN_CLASSES = [
    "layui-form-radio", "layui-form-checkbox", "layui-form-switch",
    "el-radio", "el-checkbox", "ant-radio-wrapper", "ant-checkbox-wrapper",
  ];

  function isChoiceSkin(el) {
    if (!el || !el.classList) return false;
    return CHOICE_SKIN_CLASSES.some((c) => el.classList.contains(c));
  }

  /**
   * 单选 / 复选的可见性：layui / Element / Ant 会把真实 input 隐藏，
   * 只显示皮肤节点（如 div.layui-form-radio、label.el-radio），
   * 此时只要皮肤节点可见，就认为该控件可填写。
   */
  function isChoiceShown(el) {
    if (isShown(el)) return true;
    try {
      if (isChoiceSkin(el.nextElementSibling) && isShown(el.nextElementSibling)) return true;
      if (isChoiceSkin(el.previousElementSibling) && isShown(el.previousElementSibling)) return true;
      const wrap = el.closest(".el-radio, .el-checkbox, .ant-radio-wrapper, .ant-checkbox-wrapper, .layui-form-radio, .layui-form-checkbox");
      if (wrap && isShown(wrap)) return true;
      const box = el.closest(".layui-input-block, .layui-form-item");
      if (box) {
        const skin = box.querySelector(".layui-form-radio, .layui-form-checkbox");
        if (skin && isShown(skin)) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * select 可见性：layui / Element / Ant 等组件会把真实 select 隐藏，
   * 只显示自定义下拉容器，因此这里要对这些容器做一次可见性回退判断。
   */
  function isSelectShown(select) {
    if (isShown(select)) return true;
    try {
      const holder = select.closest(
        ".layui-form-select, .el-select, .ant-select, .ivu-select, .select2-container, .chosen-container"
      );
      if (holder) return isShown(holder);
      const box = select.parentElement;
      if (box) {
        const track = box.querySelector(".layui-form-select, .layui-select-title, .el-input, .ant-select");
        if (track) return isShown(track);
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * 更严格的可见性判断：用于密码框与页面模式识别。
   * 很多站点会在页头/弹窗里预置隐藏登录表单，仅用 display/visibility
   * 无法排除 0×0、透明或移出视口的控件，容易把申请页误判为登录页。
   */
  function isStrictlyVisible(el) {
    if (!isShown(el)) return false;
    try {
      const rect = el.getBoundingClientRect();
      if (!rect || rect.width < 2 || rect.height < 2) return false;
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      if (win) {
        const vw = win.innerWidth || 0;
        const vh = win.innerHeight || 0;
        if (vw && vh && (rect.right < -2 || rect.bottom < -2 || rect.left > vw + 2 || rect.top > vh + 2)) {
          return false;
        }
      }
      if (el.getClientRects && el.getClientRects().length === 0) return false;
      let p = el;
      for (let i = 0; p && i < 10; i++, p = p.parentElement) {
        if (p.getAttribute && p.getAttribute("aria-hidden") === "true") return false;
        const st = p.style;
        if (st && (st.display === "none" || st.visibility === "hidden")) return false;
      }
      const cs = win ? win.getComputedStyle(el) : null;
      if (cs) {
        if (parseFloat(cs.opacity || "1") === 0) return false;
        if (cs.visibility === "hidden" || cs.display === "none") return false;
      }
    } catch (e) {
      return true;
    }
    return true;
  }

  const UPLOAD_HINT_RE = /(上传|附件|文件上传|选择文件|点击上传|照片|相片|证件照|头像|简历附件|upload|attachment|dropzone|file\s*upload)/i;

  /**
   * 文件上传相关控件：文件选择必须由用户亲自完成（浏览器也不允许脚本设置
   * input[type=file] 的 value），因此自动填写时一律忽略。
   */
  function isUploadRelated(el) {
    try {
      if (!el || !el.tagName) return false;
      if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "file") return true;

      // Element / Ant / layui 等上传组件：容器内存在真实的 file 控件
      const holder = el.closest(
        ".upload, .uploader, .el-upload, .ant-upload, .layui-upload, .dropzone, " +
        ".el-upload-dragger, .ant-upload-drag, [id*='dropzone']"
      );
      if (holder && holder.querySelector('input[type="file"]')) return true;

      // 文件名展示框：标签/占位符明确是上传，且同一表单项内有 file 控件
      const label = `${findLabel(el)} ${el.getAttribute("placeholder") || ""} ${el.name || ""} ${el.id || ""}`;
      if (UPLOAD_HINT_RE.test(label)) {
        const box = el.closest(
          ".layui-form-item, .form-item, .form-group, .el-form-item, .ant-form-item, td, " +
          ".upload, .uploader, .dropzone"
        );
        if (box && box.querySelector('input[type="file"]')) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function isFillableElement(el) {
    if (!el || !el.tagName) return false;
    if (el.disabled || el.readOnly) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return isShown(el);
    if (tag === "SELECT") return isSelectShown(el);
    if (tag !== "INPUT") return false;
    const type = (el.type || "text").toLowerCase();
    // 文件上传控件由用户自行选择文件，自动填写时忽略
    if (type === "file") return false;
    if (!FILLABLE_INPUT_TYPES.has(type)) return false;
    if (type === "radio" || type === "checkbox") return isChoiceShown(el);
    return isShown(el);
  }

  /** 解析字段名称 */
  function findLabel(el) {
    if (!el) return "";
    const doc = el.ownerDocument;
    try {
      // 0) 单选 / 复选：优先取表单项标题，避免把「男」「阅读」这类选项文本当成字段名
      if (el.tagName === "INPUT" && /^(radio|checkbox)$/i.test(el.type || "")) {
        const item0 = el.closest(".layui-form-item, .form-item, .form-group, .el-form-item, .ant-form-item, tr");
        if (item0) {
          const lab0 = item0.querySelector("label.d-title, label.layui-form-label, .layui-form-label, .el-form-item__label");
          if (lab0 && !lab0.contains(el)) {
            const t0 = cleanLabel(textOf(lab0));
            if (t0 && t0.length <= 40) return t0;
          }
          const th0 = item0.querySelector("th");
          if (th0) {
            const t0 = cleanLabel(textOf(th0));
            if (t0 && t0.length <= 40) return t0;
          }
        }
        const td0 = el.closest("td");
        if (td0) {
          let p0 = td0.previousElementSibling;
          while (p0) {
            const t0 = cleanLabel(textOf(p0));
            if (t0 && t0.length <= 40) return t0;
            p0 = p0.previousElementSibling;
          }
        }
      }

      // 1) 原生 label
      if (el.labels && el.labels.length) {
        const t = cleanLabel(textOf(el.labels[0]));
        if (t) return t;
      }
      // 2) label[for]
      if (el.id) {
        const l = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
        if (l) {
          const t = cleanLabel(textOf(l));
          if (t) return t;
        }
      }
      // 3) layui / 常见表单项容器
      const item = el.closest(".layui-form-item, .form-item, .form-group, .el-form-item, .ant-form-item, tr");
      if (item) {
        const lab = item.querySelector("label.d-title, label.layui-form-label, .layui-form-label, .el-form-item__label, label");
        if (lab && !lab.contains(el)) {
          const t = cleanLabel(textOf(lab));
          if (t && t.length <= 40) return t;
        }
        const th = item.querySelector("th");
        if (th) {
          const t = cleanLabel(textOf(th));
          if (t && t.length <= 40) return t;
        }
      }
      // 4) 表格布局：前一个单元格
      const td = el.closest("td");
      if (td) {
        let prev = td.previousElementSibling;
        while (prev) {
          const t = cleanLabel(textOf(prev));
          if (t && t.length <= 40) return t;
          prev = prev.previousElementSibling;
        }
      }
      // 5) aria-label / placeholder
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return cleanLabel(aria);
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return cleanLabel(ph);
      // 6) 前置文本节点
      const prev = el.previousElementSibling;
      const pt = cleanLabel(textOf(prev));
      if (pt && pt.length <= 30) return pt;
    } catch (e) { /* ignore */ }
    return "";
  }

  /** 字段旁的辅助说明（字数范围、格式提示等） */
  function findHint(el) {
    try {
      const scope = el.closest(".layui-form-item, .form-item, .form-group, .el-form-item, td") || el.parentElement;
      if (!scope) return "";
      const cand = scope.querySelector(
        "p.d-rightTips, .d-rightTips, .layui-form-mid, .form-text, .help-block, .hint, .tip, small"
      );
      const t = cand ? textOf(cand) : "";
      if (t && t.length <= 80) return t;
    } catch (e) { /* ignore */ }
    return "";
  }

  // ============================================================
  // 表单扫描 → 字段注册表
  // ============================================================

  // ============================================================
  // 页面模式识别（普通 / 注册 / 登录）
  // ============================================================

  const REG_PATTERN = /(注册|创建账号|创建账户|新建账号|新建账户|免费注册|新用户|register|registration|sign\s*up|create\s*account|join\s*(now|us))/i;
  const LOGIN_PATTERN = /(登录|登陆|sign\s*in|log\s*in|login)/i;
  const APPLICATION_PATTERN = /(个人简历|我的简历|申请职位|投递简历|工作经历|教育背景|项目经历|实习经历|校园经历|自我评价|技能特长|期望职位|期望薪资|申请表单|教育经历|工作经验)/i;
  const ACCOUNT_FIELD_RE = /(用户名|账号|帐户|账户|user\s*name|username|account|login|昵称|nick\s*name|邮箱|email|手机号|手机|mobile|phone)/i;
  const EMAIL_FIELD_RE = /(邮箱|email|mail)/i;

  /** 采样页面文本（标题 / 表单文本 / 按钮文字），用于识别注册页与登录页 */
  function pageTextSample() {
    const parts = [];
    try { parts.push(document.title || ""); } catch (e) { /* ignore */ }

    const docs = collectDocs();
    for (const doc of docs) {
      try {
        const forms = Array.from(doc.querySelectorAll("form")).slice(0, 4);
        for (const f of forms) parts.push(textOf(f).slice(0, 1500));
      } catch (e) { /* ignore */ }

      try {
        const btns = Array.from(
          doc.querySelectorAll("button, input[type=submit], input[type=button], a.btn, a.button")
        ).slice(0, 40);
        for (const b of btns) {
          const t = String(b.textContent || b.value || "").trim();
          if (t && t.length <= 20) parts.push(t);
        }
      } catch (e) { /* ignore */ }
    }

    return parts.join(" ").replace(/\s+/g, " ").slice(0, 6000);
  }

  /** 注册表中所有“真正可见”的密码控件（隐藏的登录弹窗控件不算） */
  function passwordEntries(registry) {
    const reg = registry || STATE.registry || [];
    return reg.filter((e) => {
      try {
        return e.kind === "text" && e.el && e.el.tagName === "INPUT" &&
          (e.el.type || "").toLowerCase() === "password" && isStrictlyVisible(e.el);
      } catch (err) {
        return false;
      }
    });
  }

  /** 招聘 / 简历 / 职位申请类页面：这类页面即使带密码框也不应当作登录页 */
  function looksLikeApplicationForm(registry, text) {
    try {
      const url = (location.pathname || "") + (location.search || "") + (location.hash || "");
      // 明确的登录 / 注册入口优先按原逻辑处理
      if (/(login|sign[_-]?in|register|sign[_-]?up)/i.test(url)) return false;
      if (/(recruit|recruitment|apply|application|job|position|resume|social)/i.test(url)) return true;
    } catch (e) { /* ignore */ }
    // 出现简历模块标题，基本可以确定是招聘申请表单
    if (APPLICATION_PATTERN.test(text || "")) return true;
    // 字段数量较多时，通常不是单纯的登录/注册表单
    return (registry || []).length >= 6;
  }

  /**
   * 识别页面模式
   * @returns {{ mode: string, isRegistration: boolean, isLogin: boolean, passwordCount: number, text: string }}
   */
  function analyzePageMode(registry) {
    const reg = registry || STATE.registry || [];
    const pw = passwordEntries(reg);
    const text = pageTextSample();
    const regByText = REG_PATTERN.test(text);
    const loginByText = LOGIN_PATTERN.test(text);

    let confirmLike = 0;
    for (const e of reg) {
      try {
        if ((e.el.type || "").toLowerCase() !== "password") continue;
        const label = `${e.meta.label || ""} ${e.meta.name || ""} ${e.el.id || ""}`;
        if (/确认|重复|再次|confirm|repeat|retype/i.test(label)) confirmLike++;
      } catch (err) { /* ignore */ }
    }

    // 修改 / 重置 / 找回密码页：可能出现多个密码框，但既不是注册也不是登录
    const changePw = /(修改密码|更改密码|重置密码|找回密码|change\s*password|reset\s*password|forgot\s*password)/i.test(text);

    // 招聘 / 简历 / 职位申请页：页面里可能带有隐藏登录控件或“登录”入口，
    // 不能仅凭一个密码框就判定为登录页。
    const applicationLike = looksLikeApplicationForm(reg, text);
    const regStrong = regByText && !loginByText;

    const isRegistration = !changePw && pw.length > 0 &&
      (pw.length >= 2 || confirmLike > 0 || regStrong) &&
      !(applicationLike && !regStrong && pw.length < 2);

    const isLogin = !changePw && !isRegistration && pw.length > 0 &&
      (loginByText || !regByText) && !applicationLike;

    return {
      mode: isRegistration ? "register" : isLogin ? "login" : "normal",
      isRegistration,
      isLogin,
      changePw,
      applicationLike,
      passwordCount: pw.length,
      regByText,
      loginByText,
      text,
    };
  }

  // ------------------------------------------------------------
  // 密码规则解析与生成
  // ------------------------------------------------------------

  function readPasswordHints(entries) {
    const hints = [];
    for (const e of entries) {
      const el = e.el;
      ["placeholder", "title", "aria-label"].forEach((attr) => {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v) hints.push(v);
      });
      const h = findHint(el);
      if (h) hints.push(h);
      if (e.meta.label) hints.push(e.meta.label);
      if (e.meta.name) hints.push(e.meta.name);
    }
    return hints.join(" ");
  }

  /** 从控件属性与页面提示中解析密码规则 */
  function parsePasswordRules(entries) {
    const rules = { min: 8, max: 32, lower: true, upper: true, digit: true, symbol: false, pattern: "", text: "" };

    const text = readPasswordHints(entries);
    rules.text = text;

    for (const e of entries) {
      const el = e.el;
      const min = parseInt(el.getAttribute("minlength") || el.minLength || "", 10);
      const max = parseInt(el.getAttribute("maxlength") || el.maxLength || "", 10);
      if (min > 0) rules.min = Math.max(rules.min, min);
      if (max > 0 && max < rules.max) rules.max = max;
      const p = el.getAttribute("pattern");
      if (p) rules.pattern = p;
    }

    const range = text.match(/(\d+)\s*[-~至到]\s*(\d+)\s*(?:位|个字符|字符)/);
    if (range) {
      rules.min = Math.max(rules.min, parseInt(range[1], 10));
      rules.max = Math.min(rules.max, parseInt(range[2], 10));
    } else {
      const atLeast = text.match(/(?:至少|不少于|不小于|minimum|min)\D{0,6}(\d+)\s*(?:位|个字符|字符)/i);
      if (atLeast) rules.min = Math.max(rules.min, parseInt(atLeast[1], 10));
    }

    if (/大写|upper/i.test(text)) rules.upper = true;
    if (/小写|lower/i.test(text)) rules.lower = true;
    if (/数字|digit|number/i.test(text)) rules.digit = true;
    if (/特殊字符|符号|标点|special|symbol/i.test(text)) rules.symbol = true;
    if (/(不含|不允许|禁止|不能)[^。；;]{0,10}(特殊字符|符号|标点)/.test(text)) rules.symbol = false;

    if (rules.min < 6) rules.min = 6;
    if (!(rules.max >= rules.min)) rules.max = Math.min(64, rules.min + 6);
    if (rules.max > 64) rules.max = 64;
    return rules;
  }

  function randomInt(max) {
    if (max <= 1) return 0;
    const arr = new Uint32Array(1);
    try {
      crypto.getRandomValues(arr);
      return arr[0] % max;
    } catch (e) {
      return Math.floor(Math.random() * max);
    }
  }

  /** 按页面规则生成密码（满足长度与字符类别，尽量满足 pattern 正则） */
  function generatePassword(rules) {
    const lowers = "abcdefghijkmnpqrstuvwxyz";
    const uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const syms = "!@#$%^&*?";

    const wantLen = Math.min(Math.max(Math.max(rules.min, 12), rules.min), rules.max || 16);

    let regex = null;
    if (rules.pattern) {
      try { regex = new RegExp("^(?:" + rules.pattern + ")$"); } catch (e) { regex = null; }
    }

    for (let attempt = 0; attempt < 80; attempt++) {
      const pools = [];
      if (rules.lower) pools.push(lowers);
      if (rules.upper) pools.push(uppers);
      if (rules.digit) pools.push(digits);
      if (rules.symbol) pools.push(syms);
      if (!pools.length) pools.push(lowers);

      const chars = pools.map((p) => p[randomInt(p.length)]);
      const all = pools.join("");
      while (chars.length < wantLen) chars.push(all[randomInt(all.length)]);

      for (let i = chars.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        const t = chars[i];
        chars[i] = chars[j];
        chars[j] = t;
      }

      const pwd = chars.join("");
      if (pwd.length < rules.min || pwd.length > rules.max) continue;
      if (rules.lower && !/[a-z]/.test(pwd)) continue;
      if (rules.upper && !/[A-Z]/.test(pwd)) continue;
      if (rules.digit && !/[0-9]/.test(pwd)) continue;
      if (rules.symbol && !/[^A-Za-z0-9]/.test(pwd)) continue;
      if (regex && !regex.test(pwd)) continue;
      return pwd;
    }

    return "Ab" + String(Date.now()).slice(-8) + "!1";
  }

  // ------------------------------------------------------------
  // 登录信息本地存储（chrome.storage.local）
  // ------------------------------------------------------------

  const ACCOUNTS_KEY = "af_accounts";
  const MAX_ACCOUNTS_PER_SITE = 20;

  function currentOrigin() {
    try {
      if (location.origin && location.origin !== "null") return location.origin;
      return location.protocol + "//" + (location.host || "");
    } catch (e) {
      return "unknown";
    }
  }

  async function loadAccountsAll() {
    try {
      const r = await chrome.storage.local.get([ACCOUNTS_KEY]);
      const all = r && r[ACCOUNTS_KEY];
      return all && typeof all === "object" && !Array.isArray(all) ? all : {};
    } catch (e) {
      return {};
    }
  }

  async function loadAccountsForOrigin(origin) {
    const all = await loadAccountsAll();
    const list = all[origin || currentOrigin()];
    return Array.isArray(list) ? list : [];
  }

  async function saveAccountRecord(record) {
    const all = await loadAccountsAll();
    const origin = record.origin || currentOrigin();
    const list = Array.isArray(all[origin]) ? all[origin] : [];
    const idx = list.findIndex((x) => (x.account || "") === (record.account || ""));
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(record);
    all[origin] = list.slice(0, MAX_ACCOUNTS_PER_SITE);
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: all });
  }

  async function isSaveCredentialsEnabled() {
    try {
      const cfg = await sendToBackground({ type: "GET_CONFIG" });
      return !cfg || cfg.save_credentials !== false;
    } catch (e) {
      return true;
    }
  }

  // ------------------------------------------------------------
  // 注册资料生成提示词
  // ------------------------------------------------------------

  function buildRegisterPrompt(userInfo, metaList, rules, pageText) {
    const system = [
      "你是账号注册信息生成助手。用户会提供【用户信息】（其上传的 Word/PDF/TXT 提取内容，可能含姓名、邮箱、手机、学校等）与【页面注册表单字段】。",
      "任务：生成一套符合页面要求的注册资料，并为每个字段给出应填写的值。",
      "",
      "只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释：",
      '{"fields":[{"f":"f1","v":"zhangsan2024"},{"f":"f2","v":"张三"}]}',
      "",
      "规则：",
      "1. 只输出能确定或可合理生成的字段，不要输出空值、占位符或“未知”。",
      "2. 用户名/账号：优先使用用户信息中的邮箱前缀或英文名；否则用姓名拼音/英文名 + 2-4 位数字，6-20 位，仅使用字母、数字、下划线（若字段 label/hint 有字符限制请遵守），确保看起来像未被占用的账号。",
      "3. 昵称/姓名：使用用户信息中的姓名；没有则用用户名。",
      "4. 邮箱：优先使用用户信息中的邮箱；若缺失且该字段必填或需邮箱格式，生成 \"<用户名>@example.com\" 形式。",
      "5. 手机号：优先使用用户信息中的手机号；用户信息没有时不要编造。",
      "6. 性别、生日、学校、专业、地址等按用户信息填写；用户信息中没有的不要编造。",
      "7. 绝对不要输出密码类字段（type=password），密码由系统按页面规则生成。",
      "8. 日期统一 YYYY-MM-DD；短输入框只填简短值。",
    ].join("\n");

    const ruleText = [
      `长度 ${rules.min}-${rules.max} 位`,
      rules.upper ? "包含大写字母" : "",
      rules.lower ? "包含小写字母" : "",
      rules.digit ? "包含数字" : "",
      rules.symbol ? "包含特殊字符" : "不含特殊字符",
      rules.pattern ? `正则约束 ${rules.pattern}` : "",
    ].filter(Boolean).join("，");

    const user = [
      "【用户信息】",
      truncate(userInfo, 12000),
      "",
      "【页面注册表单字段】",
      JSON.stringify(metaList),
      "",
      "【页面密码规则】",
      ruleText,
      "",
      "【页面文本片段】",
      truncate(pageText || "", 1500),
      "",
      '请只输出 JSON：{"fields":[{"f":"字段id","v":"值"}]}',
    ].join("\n");

    return { system, user };
  }

  /** 依据已填写结果构造登录信息记录 */
  function buildCredentialRecord(filled, password) {
    const reg = STATE.registry || [];
    const filledIds = new Set((filled || []).map((f) => f.id));
    const isPw = (e) => {
      try { return (e.el.type || "").toLowerCase() === "password"; } catch (err) { return false; }
    };
    const labelName = (e) => `${e.meta.label || ""} ${e.meta.name || ""} ${e.el.id || ""}`;

    const pickAcc = reg.find(
      (e) => filledIds.has(e.id) && !isPw(e) && /(用户名|账号|帐户|账户|user\s*name|username|account|login)/i.test(labelName(e))
    );
    const pickEmail = reg.find(
      (e) => filledIds.has(e.id) && !isPw(e) && (EMAIL_FIELD_RE.test(labelName(e)) || (e.el.type || "") === "email")
    );
    const pickFirst = reg.find((e) => filledIds.has(e.id) && !isPw(e));
    const accEntry = pickAcc || pickEmail || pickFirst || null;

    return {
      origin: currentOrigin(),
      url: location.href,
      title: document.title || "",
      account: accEntry ? (accEntry.el.value || "").trim() : "",
      account_label: accEntry ? (accEntry.meta.label || accEntry.meta.name || "") : "",
      email: pickEmail ? (pickEmail.el.value || "").trim() : "",
      password: password || "",
      fields: (filled || []).slice(0, 20).map((f) => ({ label: f.label, value: f.value })),
      createdAt: Date.now(),
    };
  }

  /** 复制文本（面板按钮触发，有用户手势，clipboard 通常可用） */
  async function copyText(text) {
    const value = String(text == null ? "" : text);
    if (!value) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (e) { /* fallback */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ------------------------------------------------------------
  // 面板：模式提示 / 已保存账号 / 生成结果
  // ------------------------------------------------------------

  function updateModeHint(analysis) {
    const el = STATE.refs && STATE.refs.modeHint;
    if (!el) return;
    if (analysis.isRegistration) {
      el.textContent = `检测到注册表单（${analysis.passwordCount} 个密码框）→ 将生成注册资料并保存`;
      el.style.color = "#2563eb";
    } else if (analysis.isLogin) {
      el.textContent = "检测到登录表单 → 可使用本网站已保存的账号密码";
      el.style.color = "#059669";
    } else if (analysis.changePw) {
      el.textContent = "检测到修改 / 重置密码页 → 按普通模式处理（不自动填写密码）";
      el.style.color = "#b45309";
    } else if (analysis.applicationLike) {
      el.textContent = "检测到招聘 / 申请表单 → 按普通模式用简历填写";
      el.style.color = "#6b7280";
    } else {
      el.textContent = "普通表单 → 按用户信息填写";
      el.style.color = "#6b7280";
    }
  }

  async function refreshAccountsBox() {
    if (!STATE.refs || !STATE.refs.accountsList) return;
    const list = await loadAccountsForOrigin(currentOrigin());
    if (!STATE.refs || !STATE.refs.accountsList) return;

    const box = STATE.refs.accounts;
    const listBox = STATE.refs.accountsList;
    listBox.textContent = "";

    if (!list.length) {
      if (box) box.style.display = "none";
      return;
    }
    if (box) box.style.display = "block";

    for (const acc of list) {
      const row = document.createElement("div");
      row.className = "acc-item";

      const info = document.createElement("div");
      info.className = "acc-info";
      const name = document.createElement("div");
      name.className = "acc-name";
      name.textContent = acc.account || "(未命名账号)";
      const meta = document.createElement("div");
      meta.className = "acc-meta";
      const when = acc.createdAt ? new Date(acc.createdAt).toLocaleString() : "";
      meta.textContent = [when, acc.email || ""].filter(Boolean).join(" · ");
      info.appendChild(name);
      info.appendChild(meta);

      const fillBtn = document.createElement("button");
      fillBtn.className = "btn mini";
      fillBtn.textContent = "填入";
      fillBtn.addEventListener("click", () => {
        fillSavedAccount(acc).catch((err) => panelStatus(`填入失败：${err.message}`, "error"));
      });

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn mini ghost";
      copyBtn.textContent = "复制密码";
      copyBtn.addEventListener("click", async () => {
        const ok = await copyText(acc.password || "");
        panelStatus(ok ? "密码已复制到剪贴板" : "复制失败", ok ? "success" : "error");
      });

      row.appendChild(info);
      row.appendChild(fillBtn);
      row.appendChild(copyBtn);
      listBox.appendChild(row);
    }
  }

  function maskText(value) {
    const s = String(value || "");
    return "•".repeat(Math.min(16, Math.max(6, s.length)));
  }

  function renderCredential(rec, isPreview, isLogin) {
    const box = STATE.refs && STATE.refs.cred;
    if (!box) return;
    box.textContent = "";

    if (!rec) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";

    const isRegisterResult = !isLogin && !isPreview;

    const title = document.createElement("div");
    title.className = "cred-title";
    title.textContent = isLogin
      ? "已填入的登录信息"
      : (isPreview ? "注册资料预览（未写入页面 / 未保存）" : "注册信息（已保存到本机）");
    box.appendChild(title);

    // 注册结果：醒目提示用户复制保存账号密码
    if (isRegisterResult) {
      const tip = document.createElement("div");
      tip.className = "cred-tip";
      tip.textContent = "⚠️ 请立即复制并妥善保存账号与密码：注册提交后页面可能跳转，扩展内保存的记录仅在本机，可在工具栏弹窗中查看或删除。";
      box.appendChild(tip);
    }

    const addRow = (label, value, secret) => {
      const row = document.createElement("div");
      row.className = "cred-row";

      const k = document.createElement("span");
      k.className = "k";
      k.textContent = label;

      const v = document.createElement("span");
      v.className = "v";
      v.textContent = secret ? maskText(value) : String(value || "（空）");

      const showBtn = document.createElement("button");
      showBtn.className = "btn mini ghost";
      showBtn.textContent = "显示";
      if (!secret) showBtn.style.display = "none";
      let shown = !secret;
      showBtn.addEventListener("click", () => {
        shown = !shown;
        v.textContent = shown ? String(value || "") : maskText(value);
        showBtn.textContent = shown ? "隐藏" : "显示";
      });

      const copyBtn = document.createElement("button");
      copyBtn.className = "btn mini";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", async () => {
        const ok = await copyText(String(value || ""));
        panelStatus(ok ? `${label}已复制` : "复制失败", ok ? "success" : "error");
      });

      row.appendChild(k);
      row.appendChild(v);
      row.appendChild(showBtn);
      row.appendChild(copyBtn);
      box.appendChild(row);
    };

    addRow("网址", rec.origin || "", false);
    addRow("账号", rec.account || "", false);
    if (rec.email) addRow("邮箱", rec.email, false);
    addRow("密码", rec.password || "", true);

    // 注册结果：一键复制账号 + 密码，复制后按钮变为"已复制"
    if (isRegisterResult) {
      const copyAll = document.createElement("button");
      copyAll.className = "btn mini primary";
      copyAll.id = "af-copy-all";
      copyAll.style.marginTop = "8px";
      copyAll.textContent = "📋 一键复制账号密码";
      copyAll.addEventListener("click", async () => {
        const lines = [
          "网站：" + (rec.origin || ""),
          "账号：" + (rec.account || ""),
        ];
        if (rec.email) lines.push("邮箱：" + rec.email);
        lines.push("密码：" + (rec.password || ""));
        lines.push("时间：" + new Date(rec.createdAt || Date.now()).toLocaleString());
        const ok = await copyText(lines.join("\n"));
        if (ok) {
          copyAll.textContent = "✅ 已复制，请妥善保存";
          copyAll.disabled = true;
          panelStatus("账号与密码已复制到剪贴板，请粘贴到安全的位置保存", "success");
        } else {
          panelStatus("复制失败：请点「显示」后手动选中复制", "error");
        }
      });
      box.appendChild(copyAll);
    }

    try {
      box.scrollIntoView({ block: "nearest" });
    } catch (e) { /* ignore */ }
  }

  async function fillSavedAccount(acc) {
    const scanned = buildRegistry();
    const reg = scanned.registry;
    const pw = passwordEntries(reg);
    if (!pw.length) throw new Error("当前页面未发现密码框");

    const labelName = (e) => `${e.meta.label || ""} ${e.meta.name || ""} ${(e.el && e.el.id) || ""}`;
    const accEntry =
      reg.find((e) => e.kind === "text" && (e.el.type || "") !== "password" && ACCOUNT_FIELD_RE.test(labelName(e))) ||
      reg.find((e) => (e.el.type || "") === "email") ||
      reg.find((e) => e.kind === "text" && (e.el.type || "") !== "password") ||
      null;

    STATE.undoStack = [];
    let count = 0;
    if (accEntry && acc.account) {
      pushUndoValue(accEntry.el);
      if (setNativeValue(accEntry.el, acc.account)) { highlight(accEntry.el); count++; }
    }
    for (const e of pw) {
      pushUndoValue(e.el);
      if (setNativeValue(e.el, acc.password || "")) { highlight(e.el); count++; }
    }

    if (STATE.refs) {
      STATE.refs.undo.disabled = count === 0;
      if (STATE.refs.report) STATE.refs.report.style.display = "none";
    }
    resetSteps();
    setStep(1, "done", `发现 ${reg.length} 个可填写字段`);
    setStep(2, "done", "使用本网站已保存的登录信息（未调用大模型）");
    setStep(3, "done", `已填入 ${count} 个控件`);
    renderCredential(acc, false, true);
    panelStatus(`✅ 已填入已保存的登录信息（${acc.account || "账号"}）`, "success");
  }

  const docIds = new WeakMap();
  let docSeq = 0;
  function docIdOf(doc) {
    if (!doc) return "none";
    if (!docIds.has(doc)) docIds.set(doc, ++docSeq);
    return "d" + docIds.get(doc);
  }

  /**
   * 选项文本：单选/复选的"选项名"不能直接用组的字段名，
   * 因此优先取 title、包裹 label、相邻文本，最后才退回 findLabel。
   */
  function optionLabelOf(el) {
    if (!el) return "";

    const title = (el.getAttribute("title") || "").trim();
    if (title) return title;

    try {
      if (el.labels && el.labels.length) {
        const t = cleanLabel(textOf(el.labels[el.labels.length - 1]));
        if (t && t.length <= 20) return t;
      }
    } catch (e) { /* ignore */ }

    try {
      const next = el.nextElementSibling;
      if (next) {
        const t = cleanLabel(textOf(next));
        if (t && t.length <= 20) return t;
      }
      const prev = el.previousElementSibling;
      if (prev) {
        const t = cleanLabel(textOf(prev));
        if (t && t.length <= 20) return t;
      }
    } catch (e) { /* ignore */ }

    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;

    if (el.value && el.value !== "on") return el.value;

    return findLabel(el) || "";
  }

  function buildMeta(el, kind) {
    const tag = el.tagName;
    const type = tag === "INPUT" ? (el.type || "text").toLowerCase() : tag.toLowerCase();

    const meta = {
      f: "",
      tag: tag.toLowerCase(),
      type: type,
      label: findLabel(el),
      name: el.name || "",
      ph: el.getAttribute("placeholder") || "",
      req: !!(el.required || el.getAttribute("aria-required") === "true"),
      cur: truncate((el.value || "").trim(), 40),
    };

    if (!meta.label) delete meta.label;
    if (!meta.name) delete meta.name;
    if (!meta.ph) delete meta.ph;
    if (!meta.cur) delete meta.cur;
    if (!meta.req) delete meta.req;

    const hint = findHint(el);
    if (hint) meta.hint = hint;

    if (tag === "SELECT") {
      meta.opts = Array.from(el.options || [])
        .map((o) => (o.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 60);
      // select 的 cur 用选项文本，比 option value 更容易让模型理解；
      // 占位项（如"请选择"）不算已有值，避免误导模型
      try {
        const idx = el.selectedIndex;
        const sel = el.options && el.options[idx];
        const selText = sel ? (sel.textContent || "").trim() : "";
        const isPlaceholder = idx <= 0 && /^(请选择|请选取|--|全部|无)$/.test(selText);
        if (selText && !isPlaceholder) meta.cur = truncate(selText, 40);
        else delete meta.cur;
      } catch (e) { /* ignore */ }
    }
    if (kind === "radio" || kind === "checkbox-group") {
      meta.opts = null;      // 由调用方填充
      delete meta.cur;       // radio/checkbox 的 value 无业务含义，改用选中项文本
    }
    if (el.maxLength && el.maxLength > 0 && el.maxLength < 100000 && tag !== "SELECT") {
      meta.max = el.maxLength;
    }
    return meta;
  }

  /**
   * 扫描页面，生成字段注册表
   * @returns {{ meta: object[], registry: object[], truncated: boolean, docs: number }}
   */
  function buildRegistry() {
    const docs = collectDocs();
    const raw = collectRawElements(docs);
    const registry = [];
    const meta = [];
    const groupMap = new Map();
    let seq = 0;

    const pushEntry = (entry) => {
      entry.id = "f" + (++seq);
      entry.meta.f = entry.id;
      registry.push(entry);
      meta.push(entry.meta);
    };

    for (const el of raw) {
      if (!isFillableElement(el)) continue;
      if (isUploadRelated(el)) continue; // 文件上传控件交由用户手动填写

      const tag = el.tagName;
      const type = tag === "INPUT" ? (el.type || "text").toLowerCase() : "";

      // 单选 / 复选组
      if ((type === "radio" || type === "checkbox") && el.name) {
        const key = docIdOf(el.ownerDocument) + "|" + type + "|" + el.name;
        let entry = groupMap.get(key);
        if (!entry) {
          entry = {
            id: "",
            kind: type === "radio" ? "radio" : "checkbox-group",
            el: el,
            els: [],
            doc: el.ownerDocument,
            meta: null,
          };
          entry.meta = buildMeta(el, entry.kind);
          entry.meta.opts = [];
          groupMap.set(key, entry);
          pushEntry(entry);
        }
        entry.els.push(el);
        const lbl = optionLabelOf(el);
        if (lbl && entry.meta.opts.indexOf(lbl) < 0) entry.meta.opts.push(lbl);
        if (el.checked) entry.meta.cur = entry.meta.cur || lbl;
        continue;
      }

      // 单个 checkbox
      if (type === "checkbox") {
        const entry = {
          id: "",
          kind: "checkbox",
          el: el,
          els: [el],
          doc: el.ownerDocument,
          meta: buildMeta(el, "checkbox"),
        };
        const lbl = optionLabelOf(el);
        entry.meta.opts = lbl ? [lbl] : [];
        pushEntry(entry);
        continue;
      }

      if (type === "radio") continue; // 无名单选，忽略

      // 普通文本 / 下拉
      const kind = tag === "SELECT" ? "select" : "text";
      const entry = {
        id: "",
        kind: kind,
        el: el,
        els: [el],
        doc: el.ownerDocument,
        meta: buildMeta(el, kind),
      };
      pushEntry(entry);
    }

    // 只有一项的复选组按单个复选框处理（如"我已阅读并同意用户协议"）
    for (const e of registry) {
      if (e.kind === "checkbox-group" && e.els.length === 1) {
        e.kind = "checkbox";
        const lbl = optionLabelOf(e.els[0]);
        e.meta.opts = lbl ? [lbl] : [];
      }
    }

    let truncated = false;
    if (registry.length > MAX_FIELDS) {
      truncated = true;
      registry.length = MAX_FIELDS;
      meta.length = MAX_FIELDS;
    }

    STATE.registry = registry;
    AF_DEBUG.log(`扫描完成：${registry.length} 个字段（文档 ${docs.length} 个）`);
    return { meta, registry, truncated, docs: docs.length };
  }

  // ============================================================
  // 大模型提示词
  // ============================================================

  function buildFillPrompt(userInfo, metaList) {
    const system = [
      "你是网页表单自动填写助手。用户会提供【用户信息】（来自其上传的 Word / PDF / TXT 文件）与【网页表单字段】（JSON 数组）。",
      "你的任务：判断每个字段应当填写什么值。只依据【用户信息】中明确出现的事实，绝不编造或推测不存在的个人信息。",
      "",
      "输出要求：只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字，格式如下：",
      '{"fields":[{"f":"f1","v":"张伟"},{"f":"f7","v":"男"},{"f":"f9","v":"2024-09-01"}]}',
      "",
      "规则：",
      "1. 只为能根据【用户信息】确定的字段输出条目；无法确定的字段一律省略，不要输出空值、占位符或“未知”。",
      "2. 字段对象的 f 必须与输入字段的 f 完全一致；v 是要填写的值（字符串）。",
      "3. type 为 select / radio / checkbox 时，v 必须与 opts 中的某一项原文一致；checkbox 组可用英文逗号分隔多个选项。",
      "4. 日期一律输出 YYYY-MM-DD；时间输出 HH:mm；电话、证件号、编号等保持原文数字。",
      "5. 短输入框只填简短值（姓名、学校、专业、电话等）；textarea 可填写较完整的表述（个人简介、项目经历、备注），注意不要超过字段的 max。",
      "6. 字段有 hint（如字数范围、格式要求）时请遵守；有 cur（当前值）且与用户信息一致时可省略，若冲突则以用户信息为准。",
      "7. 宁可少填，不要错填：不确定的字段一律省略。",
    ].join("\n");

    const user = [
      "【用户信息】",
      truncate(userInfo, 14000),
      "",
      "【网页表单字段】",
      JSON.stringify(metaList),
      "",
      '请只输出 JSON：{"fields":[{"f":"字段id","v":"值"}]}',
    ].join("\n");

    return { system, user };
  }

  function parseMappingResponse(content) {
    let s = String(content || "").trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/g, "").trim();

    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);

    let obj = null;
    try {
      obj = JSON.parse(s);
    } catch (e) {
      throw new Error("大模型返回的不是合法 JSON：" + truncate(s, 120));
    }

    let arr = obj && (obj.fields || obj.data || obj.result || obj.mapping);
    if (!Array.isArray(arr)) arr = [];

    return arr
      .filter((x) => x && typeof x === "object")
      .map((x) => {
        const f = String(x.f || x.field_id || x.field || x.id || "").trim();
        let v = x.v;
        if (v === undefined) v = x.value;
        if (v === undefined) v = x.option;
        if (v === undefined) v = x.text;
        return { f, v };
      })
      .filter((x) => x.f && x.v !== undefined && x.v !== null && String(x.v).trim() !== "");
  }

  // ============================================================
  // 写值动作
  // ============================================================

  const BAD_VALUES = /^(未知|不详|暂无|没有|未提供|无法确定|不确定|null|undefined|n\/?a|none|-+|—+|\?+)$/i;

  function cleanValue(raw) {
    if (raw === true) return "是";
    if (raw === false) return "否";
    let v = String(raw == null ? "" : raw).trim();
    v = v.replace(/^["'“”]+|["'“”]+$/g, "").trim();
    if (!v || BAD_VALUES.test(v)) return "";
    return v;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    try {
      try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      const proto = el.constructor && el.constructor.prototype;
      const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      AF_DEBUG.warn(`写入 ${describeEl(el)} 失败: ${e.message}`);
      return false;
    }
  }

  function highlight(el) {
    try {
      el.style.transition = "box-shadow .25s ease";
      el.style.boxShadow = "0 0 0 3px rgba(37,99,235,.45)";
      setTimeout(() => {
        try { el.style.boxShadow = ""; } catch (e) { /* ignore */ }
      }, 2200);
    } catch (e) { /* ignore */ }
  }

  function pushUndoValue(el) {
    if (!el) return;
    if (STATE.undoStack.some((u) => u.el === el)) return;
    STATE.undoStack.push({ type: "value", el: el, prev: el.value });
  }

  function pushUndoChecked(els) {
    for (const el of els || []) {
      if (STATE.undoStack.some((u) => u.el === el)) continue;
      STATE.undoStack.push({ type: "checked", el: el, prev: !!el.checked });
    }
  }

  function adaptValueForElement(el, raw) {
    let v = String(raw).trim();
    const type = el.tagName === "INPUT" ? (el.type || "text").toLowerCase() : "";

    if (type === "date" || type === "datetime-local") {
      const d = parseDateLoose(v);
      if (d) return type === "date" ? d : d + "T00:00";
    }
    if (type === "month") {
      const d = parseDateLoose(v);
      if (d) return d.slice(0, 7);
    }
    if (type === "week") {
      const d = parseDateLoose(v);
      if (d) {
        const dt = new Date(d + "T00:00:00");
        if (!isNaN(dt.getTime())) {
          const target = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
          const dayNum = (target.getUTCDay() + 6) % 7;
          target.setUTCDate(target.getUTCDate() - dayNum + 3);
          const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
          const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
          return `${target.getUTCFullYear()}-W${pad2(week)}`;
        }
      }
    }
    if (type === "time") {
      const m = v.match(/(\d{1,2}):(\d{2})/);
      if (m) return `${pad2(m[1])}:${m[2]}`;
    }
    if (type === "number") {
      const num = v.replace(/[^\d.\-]/g, "");
      if (num) return num;
    }
    if (el.maxLength && el.maxLength > 0 && v.length > el.maxLength) {
      v = v.slice(0, el.maxLength);
    }
    return v;
  }

  function matchOption(candidates, wanted) {
    const w = norm(wanted);
    if (!w) return null;

    let hit = candidates.find((c) => norm(c.value) === w);
    if (hit) return hit;
    hit = candidates.find((c) => norm(c.label) === w);
    if (hit) return hit;
    hit = candidates.find((c) => {
      const l = norm(c.label);
      return l && (l.includes(w) || w.includes(l));
    });
    return hit || null;
  }

  function isSelectEmpty(select) {
    const v = (select.value || "").trim();
    if (!v) return true;
    const idx = select.selectedIndex;
    if (idx <= 0) {
      const first = select.options && select.options[0];
      const firstLabel = first ? (first.textContent || "").trim() : "";
      if (first && (!first.value || /^(请选择|请选取|--|全部|无)$/.test(firstLabel))) return true;
    }
    return false;
  }

  function applySelectValue(select, value) {
    // layui 自定义下拉：点击对应 dd 触发其内部逻辑
    try {
      const box = select.closest(".layui-form-item") || select.parentElement;
      const dd = box ? box.querySelector(`dd[lay-value="${String(value).replace(/"/g, '\\"')}"]`) : null;
      if (dd) {
        ["mousedown", "mouseup", "click"].forEach((type) => {
          dd.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        });
        if (select.value === value) return true;
      }
    } catch (e) { /* ignore */ }

    try {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      AF_DEBUG.warn(`select 赋值失败: ${e.message}`);
      return false;
    }
  }

  function choiceSkinOf(el) {
    try {
      if (isChoiceSkin(el.nextElementSibling)) return el.nextElementSibling;
      if (isChoiceSkin(el.previousElementSibling)) return el.previousElementSibling;
      const wrap = el.closest(".el-radio, .el-checkbox, .ant-radio-wrapper, .ant-checkbox-wrapper");
      if (wrap && wrap !== el) return wrap;
    } catch (e) { /* ignore */ }
    return null;
  }

  function setChoiceChecked(el, want) {
    if (!el) return false;
    if (!!el.checked === !!want) return false;

    const doc = el.ownerDocument;
    const view = doc ? doc.defaultView : window;
    const skin = choiceSkinOf(el);

    if (skin) {
      skin.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: view }));
      if (!!el.checked !== !!want) {
        el.checked = !!want;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }

    try {
      el.click();
    } catch (e) { /* ignore */ }
    if (!!el.checked !== !!want) {
      el.checked = !!want;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  function radioOptionCandidates(entry) {
    return entry.els.map((el) => ({ value: el.value, label: optionLabelOf(el), el: el }));
  }

  function entryConnected(entry) {
    if (!entry) return false;
    const els = entry.els || [];
    return els.some((el) => {
      try { return !!(el && el.isConnected); } catch (e) { return false; }
    }) || (entry.el && entry.el.isConnected);
  }

  /**
   * 应用单条映射
   * @returns {{ ok: boolean, value?: string, reason?: string, noop?: boolean }}
   */
  function applyEntry(entry, rawValue, opts) {
    const overwrite = !!(opts && opts.overwrite);
    const dryRun = !!(opts && opts.dryRun);

    // 双保险：文件上传控件永远不由脚本填写
    if (entry && entry.el && entry.el.tagName === "INPUT" && (entry.el.type || "").toLowerCase() === "file") {
      return { ok: false, reason: "文件上传字段需手动选择文件" };
    }

    const value = cleanValue(rawValue);
    if (!value) return { ok: false, reason: "值为空" };

    if (entry.kind === "text") {
      const el = entry.el;

      // 密码字段只在注册 / 登录流程显式允许时才写入
      if ((el.type || "").toLowerCase() === "password" && !(opts && opts.allowPassword)) {
        return { ok: false, reason: "普通模式不填写密码字段" };
      }
      if (!overwrite && (el.value || "").trim()) return { ok: false, reason: "已有内容（未开启覆盖）" };
      const val = adaptValueForElement(el, value);
      if (dryRun) return { ok: true, value: val };
      pushUndoValue(el);
      const wrote = setNativeValue(el, val);
      if (wrote) highlight(el);
      return wrote ? { ok: true, value: val } : { ok: false, reason: "写入失败" };
    }

    if (entry.kind === "select") {
      const select = entry.el;
      if (!overwrite && !isSelectEmpty(select)) return { ok: false, reason: "已有选项（未开启覆盖）" };

      const candidates = Array.from(select.options || []).map((o) => ({
        value: o.value,
        label: (o.textContent || "").trim(),
      }));
      const hit = matchOption(candidates, value);
      if (!hit) return { ok: false, reason: `无可匹配选项（${truncate(value, 12)}）` };
      if (dryRun) return { ok: true, value: hit.label || hit.value };

      pushUndoValue(select);
      const ok = applySelectValue(select, hit.value);
      if (ok) highlight(select);
      return ok ? { ok: true, value: hit.label || hit.value } : { ok: false, reason: "写入失败" };
    }

    if (entry.kind === "radio") {
      const candidates = radioOptionCandidates(entry);
      const hit = matchOption(candidates, value);
      if (!hit) return { ok: false, reason: `无可匹配选项（${truncate(value, 12)}）` };

      const current = entry.els.find((el) => el.checked);
      if (current === hit.el) return { ok: true, value: hit.label, noop: true };
      if (current && !overwrite) return { ok: false, reason: "已有选项（未开启覆盖）" };
      if (dryRun) return { ok: true, value: hit.label };

      pushUndoChecked(entry.els);
      setChoiceChecked(hit.el, true);
      highlight(hit.el);
      return { ok: true, value: hit.label };
    }

    if (entry.kind === "checkbox-group") {
      const parts = String(value).split(/[,，、;；|/]+/).map((s) => s.trim()).filter(Boolean);
      const candidates = radioOptionCandidates(entry);
      const targets = [];
      for (const p of parts) {
        const hit = matchOption(candidates, p);
        if (hit && targets.indexOf(hit.el) < 0) targets.push(hit.el);
      }
      if (!targets.length) return { ok: false, reason: `无可匹配选项（${truncate(value, 12)}）` };
      if (dryRun) return { ok: true, value: targets.map((el) => optionLabelOf(el)).join("、") };

      const anyChecked = entry.els.some((el) => el.checked);
      if (anyChecked && !overwrite) return { ok: false, reason: "已有勾选（未开启覆盖）" };

      pushUndoChecked(entry.els);
      if (overwrite) {
        for (const el of entry.els) if (targets.indexOf(el) < 0) setChoiceChecked(el, false);
      }
      for (const el of targets) setChoiceChecked(el, true);
      highlight(targets[0]);
      return { ok: true, value: targets.map((el) => optionLabelOf(el)).join("、") };
    }

    if (entry.kind === "checkbox") {
      const el = entry.el;
      const label = optionLabelOf(el);
      const yes = /^(true|yes|1|是|同意|选中|勾选|checked|on)$/i.test(value) ||
        (label && norm(value) === norm(label));
      const no = /^(false|no|0|否|不同意|不勾选|unchecked|off)$/i.test(value);

      if (!yes && !no) return { ok: false, reason: `无法判定勾选状态（${truncate(value, 12)}）` };
      if (!!el.checked === yes) return { ok: true, value: yes ? "已勾选" : "未勾选", noop: true };
      if (!overwrite && el.checked) return { ok: false, reason: "已勾选（未开启覆盖）" };
      if (dryRun) return { ok: true, value: yes ? "已勾选" : "未勾选" };

      pushUndoChecked([el]);
      setChoiceChecked(el, yes);
      highlight(el);
      return { ok: true, value: yes ? "已勾选" : "未勾选" };
    }

    return { ok: false, reason: "不支持的控件类型" };
  }

  /**
   * 按大模型返回的映射批量填写
   * @returns {Promise<{filled: object[], skipped: string[]}>}
   */
  async function fillByMapping(mappings, opts) {
    const byId = new Map();
    for (const entry of STATE.registry) byId.set(entry.id, entry);

    const filled = [];
    const skipped = [];

    for (const m of mappings) {
      const entry = byId.get(m.f);
      if (!entry) {
        skipped.push(`${m.f}：未找到对应控件`);
        continue;
      }
      if (!entryConnected(entry)) {
        skipped.push(`${entry.meta.label || m.f}：控件已失效`);
        continue;
      }

      let result;
      try {
        result = applyEntry(entry, m.v, opts);
      } catch (e) {
        result = { ok: false, reason: e.message };
      }

      if (result.ok) {
        filled.push({
          id: entry.id,
          label: entry.meta.label || entry.meta.name || entry.id,
          value: result.value,
        });
        if (!result.noop) await sleep(20);
      } else {
        skipped.push(`${entry.meta.label || entry.id}：${result.reason || "未填写"}`);
      }
    }

    if (!opts || !opts.dryRun) {
      const firstEl = STATE.registry.find((e) => e.id === (filled[0] && filled[0].id));
      if (firstEl && firstEl.el) {
        try { firstEl.el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* ignore */ }
      }
    }

    return { filled, skipped };
  }

  // ============================================================
  // 面板 UI
  // ============================================================

  function setStep(index, state, message) {
    const node = STATE.stepNodes[index];
    if (!node) return;
    node.row.className = "step " + state;
    node.dot.textContent = state === "done" ? "✓" : state === "error" ? "!" : state === "active" ? "" : "•";
    node.txt.textContent = `${index + 1}. ${node.label}${message ? " — " + message : ""}`;
  }

  function resetSteps() {
    for (let i = 0; i < STATE.stepNodes.length; i++) setStep(i, "pending", "");
  }

  function markActiveStepError(message) {
    for (let i = 0; i < STATE.stepNodes.length; i++) {
      if (STATE.stepNodes[i].row.classList.contains("active")) {
        setStep(i, "error", message);
      }
    }
  }

  function panelStatus(message, type) {
    const el = STATE.refs && STATE.refs.status;
    if (!el) return;
    el.textContent = message || "";
    el.style.color = type === "error" ? "#dc2626" : type === "success" ? "#059669" : "#6b7280";
  }

  function renderReport(filled, skipped, dryRun) {
    const box = STATE.refs && STATE.refs.report;
    if (!box) return;
    box.textContent = "";

    if ((!filled || !filled.length) && (!skipped || !skipped.length)) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";

    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:6px;color:" + (dryRun ? "#2563eb" : "#059669");
    title.textContent = dryRun
      ? `预览：将填写 ${filled.length} 个字段`
      : `已填写 ${filled.length} 个字段` + (skipped.length ? `，跳过 ${skipped.length} 个` : "");
    box.appendChild(title);

    for (const item of filled) {
      const row = document.createElement("div");
      row.className = "item";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = item.label;
      k.title = item.label;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = item.value;
      v.title = item.value;
      row.appendChild(k);
      row.appendChild(v);
      box.appendChild(row);
    }

    if (skipped.length) {
      const more = document.createElement("div");
      more.style.cssText = "margin-top:6px;color:#9ca3af;font-size:11.5px;";
      more.textContent = "跳过：" + skipped.slice(0, 6).join("；") + (skipped.length > 6 ? " …" : "");
      box.appendChild(more);
    }
  }

  function bindPanelEvents() {
    const refs = STATE.refs;
    if (!refs) return;

    const close = () => closePanel();
    refs.close.addEventListener("click", close);
    refs.cancel.addEventListener("click", close);
    refs.mask.addEventListener("click", close);

    // 阻止整个面板内的拖拽默认行为（避免浏览器直接打开文件）
    STATE.shadow.addEventListener("dragover", (e) => e.preventDefault());
    STATE.shadow.addEventListener("drop", (e) => e.preventDefault());

    refs.undo.addEventListener("click", () => undoAll());
  }

  function buildPanel() {
    if (STATE.panelHost && STATE.panelHost.isConnected) return;

    const host = document.createElement("div");
    host.id = PANEL_HOST_ID;
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = PANEL_HTML;

    STATE.panelHost = host;
    STATE.shadow = shadow;
    STATE.open = true;

    const q = (sel) => shadow.querySelector(sel);
    STATE.refs = {
      mask: q(".mask"),
      steps: q("#af-steps"),
      cred: q("#af-cred"),
      report: q("#af-report"),
      status: q("#af-status"),
      close: q("#af-close"),
      cancel: q("#af-cancel"),
      undo: q("#af-undo"),
    };

    // 步骤节点
    STATE.stepNodes = [];
    STEP_DEFS.forEach((label, i) => {
      const row = document.createElement("div");
      row.className = "step";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.textContent = "•";
      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = `${i + 1}. ${label}`;
      row.appendChild(dot);
      row.appendChild(txt);
      STATE.refs.steps.appendChild(row);
      STATE.stepNodes.push({ row, dot, txt, label });
    });

    bindPanelEvents();

    (document.body || document.documentElement).appendChild(host);

    // 载入配置与已保存简历，然后直接开始填写（面板只展示结果）
    (async () => {
      let disabled = false;

      try {
        const cfg = await sendToBackground({ type: "GET_CONFIG" });
        if (!STATE.refs) return; // 面板可能在等待期间被关闭
        if (cfg && cfg.enabled === false) {
          disabled = true;
          panelStatus("扩展当前已禁用，请在扩展配置中重新启用", "error");
        }
        STATE.config.fill_overwrite = !!(cfg && cfg.fill_overwrite);
      } catch (e) {
        AF_DEBUG.warn(`读取配置失败: ${e.message}`);
      }

      // 简历只从扩展配置读取，页面内不提供输入
      try {
        const cached = await chrome.storage.local.get(["af_resume", "af_last_info"]);
        if (!STATE.refs) return;
        const resume = cached && cached.af_resume;
        const legacy = cached && cached.af_last_info;

        if (resume && resume.text) {
          STATE.resumeText = String(resume.text);
          const when = resume.updatedAt ? new Date(resume.updatedAt).toLocaleString() : "";
          setStep(
            0,
            "done",
            `已载入简历${resume.filename ? "（" + resume.filename + "）" : ""}${when ? "，" + when : ""}`
          );
        } else if (legacy) {
          STATE.resumeText = String(legacy);
          setStep(0, "done", `已载入简历（${STATE.resumeText.length} 字）`);
        } else {
          STATE.resumeText = "";
          setStep(0, "error", "尚未在扩展配置中导入简历");
          panelStatus("请点击浏览器工具栏扩展图标 →「📄 简历 / 用户信息」导入并保存简历，再按 Ctrl + /", "error");
        }
      } catch (e) {
        AF_DEBUG.warn(`读取简历失败: ${e.message}`);
      }

      if (disabled) return;

      // 预扫描：识别注册 / 登录页
      try {
        if (!STATE.refs) return;
        const scanned = buildRegistry();
        STATE.lastAnalysis = analyzePageMode(scanned.registry);
      } catch (e) {
        AF_DEBUG.warn(`预扫描失败: ${e.message}`);
      }

      // 直接开始：有简历，或登录页（可填入已保存账号）
      const hasResume = !!STATE.resumeText.trim();
      const analysis = STATE.lastAnalysis;
      if (!hasResume && !(analysis && analysis.isLogin)) return;

      setTimeout(() => {
        if (STATE.refs && !STATE.busy) startFill();
      }, 260);
    })();
  }

  function closePanel() {
    if (STATE.panelHost) {
      try { STATE.panelHost.remove(); } catch (e) { /* ignore */ }
    }
    STATE.panelHost = null;
    STATE.shadow = null;
    STATE.refs = null;
    STATE.stepNodes = [];
    STATE.open = false;
  }

  function openPanel() {
    if (STATE.panelHost && STATE.panelHost.isConnected) return;
    buildPanel();
    resetSteps();
    panelStatus("");
  }

  // ============================================================
  // 主流程
  // ============================================================

  /** 调用大模型并解析字段映射（普通 / 注册共用） */
  async function callLlmMapping(prompt) {
    let resp;
    try {
      resp = await sendToBackground({
        type: "CHAT_COMPLETION",
        system_prompt: prompt.system,
        user_prompt: prompt.user,
        json_mode: true,
        max_tokens: 2600,
        temperature: 0.1,
      });
    } catch (err) {
      if (err && err.isExtensionInvalidated) throw err;
      throw new Error(`与后台通信失败：${err.message}`);
    }

    if (!resp || !resp.success) {
      throw new Error((resp && resp.error) || "大模型调用失败");
    }
    return parseMappingResponse(resp.content);
  }

  /** 普通模式：按用户信息填写现有表单 */
  async function runNormalFlow(infoText, overwrite, dryRun, scanned) {
    setStep(2, "active", "正在调用大模型分析表单结构并匹配用户信息…");
    const metaForPrompt = scanned.meta.filter((m) => m.type !== "password" && m.type !== "file");
    const mappings = await callLlmMapping(buildFillPrompt(infoText, metaForPrompt));
    if (!mappings.length) {
      throw new Error("大模型未返回可填写的字段映射（用户信息可能不足以匹配任何字段）");
    }
    setStep(2, "done", `返回 ${mappings.length} 条字段映射`);

    setStep(3, "active", dryRun ? "预览模式：不写入页面…" : "正在填写表单…");
    STATE.undoStack = [];
    const result = await fillByMapping(mappings, { overwrite, dryRun });

    if (dryRun) {
      setStep(3, "done", `预览：将填写 ${result.filled.length} 个字段`);
      panelStatus(`预览完成：可填写 ${result.filled.length} 个字段（未写入页面）`, "info");
    } else if (result.filled.length) {
      setStep(
        3,
        "done",
        `已填写 ${result.filled.length} 个字段` + (result.skipped.length ? `，跳过 ${result.skipped.length} 个` : "")
      );
      panelStatus(`✅ 完成：已自动填写 ${result.filled.length} 个字段`, "success");
    } else {
      setStep(3, "error", "没有字段被填写");
      panelStatus(`没有字段被填写${result.skipped.length ? "（" + result.skipped[0] + "）" : ""}`, "error");
    }

    renderReport(result.filled, result.skipped, dryRun);
    if (STATE.refs) STATE.refs.undo.disabled = dryRun || STATE.undoStack.length === 0;
  }

  /** 注册模式：根据页面要求生成注册资料 -> 填写 -> 保存登录信息 */
  async function runRegisterFlow(infoText, dryRun, scanned, analysis) {
    const pwEntries = passwordEntries(scanned.registry);
    if (!pwEntries.length) throw new Error("注册模式需要页面包含密码输入框，但未找到");

    const rules = parsePasswordRules(pwEntries);
    setStep(2, "active", "正在调用大模型生成注册资料…");

    const metaForPrompt = scanned.meta.filter((m) => m.type !== "password" && m.type !== "file");
    const mappings = await callLlmMapping(buildRegisterPrompt(infoText, metaForPrompt, rules, analysis.text));

    // 密码由本地按页面规则生成，确保满足长度与字符类别
    const pwd = generatePassword(rules);
    const passwordMappings = pwEntries.map((e) => ({ f: e.id, v: pwd }));
    setStep(2, "done", `生成 ${mappings.length} 项注册资料 + 1 个密码（${rules.min}-${rules.max} 位）`);

    setStep(3, "active", dryRun ? "预览模式：不写入页面…" : "正在填写注册表单…");
    STATE.undoStack = [];

    const result = await fillByMapping(mappings.concat(passwordMappings), {
      overwrite: true,
      dryRun,
      allowPassword: true,
    });

    const record = buildCredentialRecord(result.filled, pwd);
    renderReport(result.filled, result.skipped, dryRun);
    renderCredential(record, dryRun, false);

    if (dryRun) {
      setStep(3, "done", `预览：将填写 ${result.filled.length} 个字段（未写入 / 未保存）`);
      panelStatus(`预览完成：注册资料将填写 ${result.filled.length} 个字段（未写入页面）`, "info");
      if (STATE.refs) STATE.refs.undo.disabled = true;
      return;
    }

    setStep(
      3,
      "done",
      `已填写 ${result.filled.length} 个字段` + (result.skipped.length ? `，跳过 ${result.skipped.length} 个` : "")
    );
    if (STATE.refs) STATE.refs.undo.disabled = STATE.undoStack.length === 0;

    const save = await isSaveCredentialsEnabled();
    if (!save) {
      panelStatus("✅ 注册信息已填写（未开启本机保存）。请点击「📋 一键复制账号密码」妥善保存", "success");
      return;
    }
    if (!record.account) {
      panelStatus("✅ 注册信息已填写，但未识别到账号字段。请点击「📋 一键复制账号密码」自行保存", "info");
      return;
    }

    try {
      await saveAccountRecord(record);
      await refreshAccountsBox();
      panelStatus(
        `✅ 注册信息已填写，账号已保存到本机（${record.account}）。请点击「📋 一键复制账号密码」妥善保存`,
        "success"
      );
    } catch (e) {
      panelStatus(`✅ 注册信息已填写，但保存失败：${e.message}。请点击「📋 一键复制账号密码」妥善保存`, "error");
    }
  }

  /** 登录模式：使用本网站已保存的登录信息 */
  async function runLoginFlow(scanned) {
    setStep(1, "done", `发现 ${scanned.meta.length} 个可填写字段`);
    const list = await loadAccountsForOrigin(currentOrigin());
    if (!list.length) {
      throw new Error("本网站还没有保存的登录信息，请先在注册页用本扩展填写一次");
    }

    setStep(2, "done", "使用本网站已保存的登录信息（未调用大模型）");
    setStep(3, "active", "正在填入登录信息…");

    const reg = scanned.registry;
    const labelName = (e) => `${e.meta.label || ""} ${e.meta.name || ""} ${(e.el && e.el.id) || ""}`;
    const accountEntry =
      reg.find((e) => e.kind === "text" && (e.el.type || "") !== "password" && ACCOUNT_FIELD_RE.test(labelName(e))) ||
      reg.find((e) => (e.el.type || "") === "email") ||
      reg.find((e) => e.kind === "text" && (e.el.type || "") !== "password") ||
      null;
    const pwEntries = passwordEntries(reg);
    if (!pwEntries.length) throw new Error("当前页面未发现密码框");

    const acc = list[0];
    STATE.undoStack = [];
    let count = 0;
    if (accountEntry && acc.account) {
      pushUndoValue(accountEntry.el);
      if (setNativeValue(accountEntry.el, acc.account)) { highlight(accountEntry.el); count++; }
    }
    for (const e of pwEntries) {
      pushUndoValue(e.el);
      if (setNativeValue(e.el, acc.password || "")) { highlight(e.el); count++; }
    }

    if (STATE.refs) {
      STATE.refs.undo.disabled = count === 0;
      STATE.refs.report.style.display = "none";
    }
    setStep(3, "done", `已填入 ${count} 个控件`);
    renderCredential(acc, false, true);
    panelStatus(`✅ 已填入已保存的登录信息（${acc.account || "账号"}）`, "success");
  }

  async function startFill() {
    if (!STATE.refs || STATE.busy) return;

    const infoText = (STATE.resumeText || "").trim();
    const overwrite = !!STATE.config.fill_overwrite;
    const dryRun = false;

    STATE.busy = true;
    STATE.refs.undo.disabled = true;
    STATE.refs.report.style.display = "none";
    if (STATE.refs.cred) STATE.refs.cred.style.display = "none";
    resetSteps();
    panelStatus("");

    try {
      // ── 步骤 1：扫描表单结构 ──
      setStep(1, "active", "正在扫描页面表单控件…");
      await sleep(50);
      const scanned = buildRegistry();

      if (!scanned.meta.length) {
        setStep(1, "error", "未找到可填写的表单控件");
        panelStatus("当前页面（含同源 iframe）未找到可填写的 input / textarea / select", "error");
        return;
      }
      const analysis = analyzePageMode(scanned.registry);
      const mode = analysis.mode;
      const modeName = mode === "register" ? "注册" : mode === "login" ? "登录" : "普通";
      setStep(
        1,
        "done",
        `发现 ${scanned.meta.length} 个可填写字段（模式：${modeName}）` +
          (scanned.truncated ? `，仅分析前 ${MAX_FIELDS} 个` : "")
      );

      // 登录模式：直接用本网站已保存的登录信息
      if (mode === "login") {
        let hasSaved = false;
        try {
          hasSaved = (await loadAccountsForOrigin(currentOrigin())).length > 0;
        } catch (e) {
          hasSaved = false;
        }
        // 兜底：招聘 / 申请类页面若被误判为登录页，且没有已保存账号，
        // 有简历时改为按普通表单填写，避免直接报错卡住流程。
        if (!hasSaved && infoText && (analysis.applicationLike || scanned.meta.length >= 6)) {
          setStep(2, "done", "未找到已保存的登录信息，改为按普通表单填写");
          await runNormalFlow(infoText, overwrite, dryRun, scanned);
          return;
        }
        await runLoginFlow(scanned);
        return;
      }

      // 其余模式需要用户信息
      if (!infoText) {
        setStep(0, "error", "尚未导入简历");
        panelStatus("请先在扩展配置中导入简历（点击浏览器工具栏图标 →「📄 简历 / 用户信息」）", "error");
        return;
      }
      setStep(0, "done", `简历已就绪（${infoText.length} 字）`);

      // 注册模式：生成注册资料并保存登录信息
      if (mode === "register") {
        await runRegisterFlow(infoText, dryRun, scanned, analysis);
        return;
      }

      // ── 步骤 2：大模型分析 ──
      await runNormalFlow(infoText, overwrite, dryRun, scanned);
    } catch (err) {
      markActiveStepError(err.message);
      panelStatus(`❌ ${err.message}`, "error");
      AF_DEBUG.error("填写流程失败", err);
    } finally {
      STATE.busy = false;
    }
  }

  function undoAll() {
    if (!STATE.undoStack.length) return;
    let count = 0;

    for (let i = STATE.undoStack.length - 1; i >= 0; i--) {
      const u = STATE.undoStack[i];
      try {
        if (u.type === "value") {
          setNativeValue(u.el, u.prev == null ? "" : u.prev);
          count++;
        } else if (u.type === "checked") {
          const el = u.el;
          if (!!el.checked !== !!u.prev) {
            setChoiceChecked(el, u.prev);
          }
          count++;
        }
      } catch (e) { /* ignore */ }
    }

    STATE.undoStack = [];
    if (STATE.refs) {
      STATE.refs.undo.disabled = true;
      if (STATE.refs.report) STATE.refs.report.style.display = "none";
    }
    resetSteps();
    if (STATE.resumeText) {
      setStep(0, "done", `简历已就绪（${STATE.resumeText.length} 字）`);
    }
    panelStatus(`↩︎ 已撤销 ${count} 处填写`, "info");
  }

  // ============================================================
  // 触发：Ctrl + /
  // ============================================================

  function isTriggerKey(event) {
    if (!(event.ctrlKey || event.metaKey)) return false;
    if (event.altKey || event.shiftKey) return false;
    if (event.key === "/" || event.key === "?" || event.keyCode === 191) return true;
    return event.code === "Slash" || event.code === "NumpadDivide";
  }

  function onGlobalKeyDown(event) {
    // Esc 关闭面板
    if (event.key === "Escape" && STATE.open) {
      closePanel();
      return;
    }
    if (!isTriggerKey(event)) return;

    event.preventDefault();
    event.stopPropagation();

    if (STATE.open) {
      // 面板已打开时重新载入配置中的简历并再次执行
      if (!STATE.busy) {
        closePanel();
        openPanel();
      }
      return;
    }
    openPanel();
  }

  // ============================================================
  // 消息通道
  // ============================================================

  function getStatus() {
    return {
      success: true,
      version: VERSION,
      frame: IS_TOP ? "top" : "child",
      active: true,
      processing: STATE.busy,
      panelOpen: STATE.open,
      trigger: "Ctrl + /",
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message && message.type) {
      case "PING":
        sendResponse({ success: true, version: VERSION, frame: IS_TOP ? "top" : "child" });
        return true;

      case "GET_STATUS":
        sendResponse(getStatus());
        return true;

      case "OPEN_FILL_PANEL":
        if (!IS_TOP) {
          sendResponse({ success: false, error: "该 frame 不是顶层页面，请直接按 Ctrl + /" });
          return true;
        }
        openPanel();
        sendResponse({ success: true });
        return true;

      default:
        return false;
    }
  });

  // ============================================================
  // 初始化
  // ============================================================

  function init() {
    try {
      // 捕获阶段监听，尽量先于页面脚本拿到按键
      window.addEventListener("keydown", onGlobalKeyDown, true);
      AF_DEBUG.success(`自动填表 v${VERSION} 就绪（${IS_TOP ? "TOP" : "FRAME"}）：Ctrl + / 唤出填写面板`);
    } catch (e) {
      AF_DEBUG.error("初始化失败", e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // 调试入口：控制台执行 __AF_FILLER__.open() / scan() / status()
  window.__AF_FILLER__ = {
    version: VERSION,
    open: openPanel,
    close: closePanel,
    status: getStatus,
    scan() {
      const s = buildRegistry();
      return { count: s.meta.length, truncated: s.truncated, docs: s.docs, fields: s.meta };
    },
    prompt: buildFillPrompt,
    registry: () => STATE.registry,
    // 直接跑一次映射（调试用）：__AF_FILLER__.fill([{f:"f1",v:"张三"}], {overwrite:true})
    fill: (mappings, opts) => fillByMapping(mappings || [], opts || {}),
    // 注册 / 登录相关调试
    analyze() {
      const s = buildRegistry();
      return analyzePageMode(s.registry);
    },
    passwordRules() {
      const s = buildRegistry();
      const entries = passwordEntries(s.registry);
      return { rules: parsePasswordRules(entries), sample: generatePassword(parsePasswordRules(entries)) };
    },
    accounts: () => loadAccountsForOrigin(currentOrigin()),
    registerPrompt: buildRegisterPrompt,
  };
})();
