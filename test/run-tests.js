/* ============================================================
 * 端到端测试：在两个网申站点上驱动「自动表单填写助手」
 * ============================================================
 * 依赖：jsdom（npm i jsdom --no-save）
 * 运行：node test/run-tests.js
 *
 * ⚠️ 本测试使用【真实 DeepSeek 大模型】（与扩展线上逻辑一致），不再使用模拟结果。
 *
 * 配置 API Key（任选其一）：
 *   1) 环境变量：DEEPSEEK_API_KEY=sk-xxx（可选 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL）
 *   2) 配置文件：复制 test/api-config.example.json 为 test/api-config.json 并填写
 *
 * 测试方式：
 *   - 用 jsdom 加载 test/site-a、test/site-b 的页面（页面自带校验脚本会真实执行）
 *   - chrome.runtime.sendMessage 桩会真实请求 `${base_url}/v1/chat/completions`
 *   - 驱动内容脚本打开面板 → 点击「开始智能填写」→ 断言页面控件值
 *   - 再点击站点自身的「注册 / 提交 / 登录」按钮，验证站点校验通过
 * ============================================================ */

const path = require("path");
const fs = require("fs");

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (e) {
  console.error(
    [
      "缺少依赖 jsdom，无法运行测试。",
      "",
      "请任选一种方式安装后重跑：",
      "  1) 在 test 目录安装（推荐）：",
      "     cd test",
      "     npm install",
      "     cd ..",
      "     node test/run-tests.js",
      "",
      "  2) 在项目根目录临时安装：",
      "     npm install jsdom --no-save",
      "     node test/run-tests.js",
    ].join("\n")
  );
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const CONTENT = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const RESUME = fs.readFileSync(path.join(__dirname, "resume.txt"), "utf8");

const ORIGIN_A = "https://xc.example.com";
const ORIGIN_B = "https://lh.example.com";

const stores = {};       // origin -> chrome.storage.local 数据
let chatCalls = 0;       // 大模型调用次数
const checks = [];

function check(name, ok, extra) {
  checks.push({ name, ok: !!ok, extra: extra == null ? "" : String(extra) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 12000, step = 60) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
}

/* ---------------- 解析简历 ---------------- */
function buildResumeMap(text) {
  const one = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : "";
  };
  const email = one(/邮箱[：:]\s*([^\s\n]+)/);
  const summary = one(/个人简介\s*\n([\s\S]*?)\n\s*六、项目经历/).replace(/\s+/g, "");
  const projects = one(/项目经历\s*\n([\s\S]*?)\n\s*七、自我评价/).replace(/\s*\n\s*/g, " ").trim();

  return {
    name: one(/姓名[：:]\s*([^\n]+)/),
    sex: one(/性别[：:]\s*([^\n]+)/),
    birth: one(/出生日期[：:]\s*([0-9-]+)/),
    idcard: one(/身份证号[：:]\s*([0-9Xx]+)/),
    phone: one(/手机[：:]\s*([0-9]+)/),
    email,
    political: one(/政治面貌[：:]\s*([^\n]+)/),
    hometown: one(/籍贯[：:]\s*([^\n]+)/),
    school: one(/毕业院校[：:]\s*([^\n]+)/),
    major: one(/专业[：:]\s*([^\n]+)/),
    degree: one(/学历[：:]\s*([^\n]+)/),
    gradMonth: one(/毕业时间[：:]\s*([0-9-]+)/),
    jobs: one(/求职意向[：:]\s*([^\n]+)/),
    city: one(/期望城市[：:]\s*([^\n]+)/),
    salary: one(/期望薪资[：:]\s*([0-9]+)/),
    available: one(/可到岗日期[：:]\s*([0-9-]+)/),
    adjust: one(/是否服从调剂[：:]\s*([^\n]+)/),
    portfolio: one(/作品集[：:]\s*([^\s\n]+)/),
    skills: one(/技能[：:]\s*([^\n]+)/).split(/[、,，\/]+/).map((s) => s.trim()).filter(Boolean),
    summary,
    projects,
    username: (email.split("@")[0] || "zhangwei2002").replace(/[^A-Za-z0-9_]/g, ""),
  };
}

const R = buildResumeMap(RESUME);

/* ---------------- 真实大模型配置（DeepSeek / 兼容 OpenAI 协议） ---------------- */

const API_TIMEOUT = 90000;

function loadApiConfig() {
  const cfgPath = path.join(__dirname, "api-config.json");
  let fileCfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch (e) {
      console.error("无法解析 test/api-config.json: " + e.message);
    }
  }

  // 兼容 test/key.txt（首行 sk-xxxx，便于把 Key 放在本地且被 .gitignore 忽略）
  let txtKey = "";
  const keyTxtPath = path.join(__dirname, "key.txt");
  if (fs.existsSync(keyTxtPath)) {
    try {
      const line =
        fs
          .readFileSync(keyTxtPath, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean) || "";
      if (/^sk-/i.test(line)) txtKey = line;
    } catch (e) { /* ignore */ }
  }

  const cliKey = String(process.argv[2] || "").trim();

  return {
    api_key: String(
      process.env.DEEPSEEK_API_KEY ||
        fileCfg.api_key ||
        (txtKey || "") ||
        (cliKey.startsWith("sk-") ? cliKey : "")
    ).trim(),
    base_url: String(process.env.DEEPSEEK_BASE_URL || fileCfg.base_url || "https://api.deepseek.com")
      .trim()
      .replace(/\/+$/, ""),
    model: String(process.env.DEEPSEEK_MODEL || fileCfg.model || "deepseek-chat").trim(),
  };
}

const API = loadApiConfig();

if (!API.api_key) {
  // 这是「可选」的自动化测试：浏览器里扩展弹窗配置的 Key 存在 chrome.storage，
  // Node 进程读不到，所以未提供 Key 时只给提示，不报错。
  console.log(
    [
      "[i] 未检测到 DeepSeek API Key，已跳过 Node 自动化测试（不是错误）。",
      "",
      "在浏览器中用扩展测试（推荐，无需本脚本）：",
      "  1. 在 Chrome/Edge 加载本扩展，并在扩展弹窗里配置 API Key",
      "  2. 运行静态服务器：node test/serve.js   （或 cd test && python -m http.server 8000）",
      "  3. 打开 http://localhost:8000/site-a/index.html 或 site-b/index.html",
      "  4. 按 Ctrl + / 导入 resume.docx / resume.txt 进行真实填写测试",
      "",
      "如需运行本 Node 自动化测试（会直接调用 API 并产生少量费用），请显式提供 Key：",
      "  node test/run-tests.js sk-xxxxxxxx",
      "  或设置环境变量 DEEPSEEK_API_KEY / 配置 test/api-config.json",
      "",
      "（Node 进程无法读取扩展的 chrome.storage，因此需要单独提供 Key；可选 DEEPSEEK_BASE_URL / DEEPSEEK_MODEL。）",
    ].join("\n")
  );
  process.exit(0);
}

console.log(`[LLM] 真实大模型：${API.base_url} / ${API.model}`);

function chatCompletionsUrl() {
  return /\/v1$/i.test(API.base_url)
    ? API.base_url + "/chat/completions"
    : API.base_url + "/v1/chat/completions";
}

let apiSeq = 0;

/**
 * 真实调用大模型（等价于 background.js 里的 CHAT_COMPLETION）
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {Promise<string>} 模型返回的文本（内容脚本会按 JSON 解析）
 */
async function callRealLlm(systemPrompt, userPrompt) {
  const payload = {
    model: API.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 2600,
    stream: false,
    response_format: { type: "json_object" },
  };

  const doFetch = () => {
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + API.api_key,
      },
      body: JSON.stringify(payload),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(API_TIMEOUT);
    }
    return fetch(chatCompletionsUrl(), init);
  };

  const seq = ++apiSeq;
  const t0 = Date.now();
  let res;

  try {
    res = await doFetch();
    // 部分网关不支持 response_format，降级重试一次（与扩展行为一致）
    if (!res.ok && payload.response_format && res.status === 400) {
      delete payload.response_format;
      res = await doFetch();
    }
  } catch (err) {
    throw new Error(`网络请求失败: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = String(
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ""
  ).trim();

  if (!content) throw new Error("模型返回内容为空");

  console.log(
    `[LLM] #${seq} 完成：${((Date.now() - t0) / 1000).toFixed(1)}s，返回 ${content.length} 字`
  );
  return content;
}

/* ---------------- chrome.* stub ---------------- */
function chromeStub(origin) {
  const store = stores[origin] || (stores[origin] = {});
  return {
    runtime: {
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.type === "GET_CONFIG") {
          return cb({
            api_key: API.api_key,
            base_url: API.base_url,
            model: API.model,
            enabled: true,
            fill_overwrite: false,
            save_credentials: true,
          });
        }
        if (msg.type === "CHAT_COMPLETION") {
          chatCalls++;
          callRealLlm(msg.system_prompt || "", msg.user_prompt || "")
            .then((content) => cb({ success: true, content }))
            .catch((err) => cb({ success: false, error: "大模型调用失败: " + err.message }));
          return;
        }
        return cb({ success: false, error: "unexpected message: " + msg.type });
      },
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          return out;
        },
        async set(obj) {
          Object.assign(store, obj);
        },
      },
    },
  };
}

/* ---------------- 页面加载 / 面板驱动 ---------------- */
function loadPage(relPath, origin, seedLocalStorage) {
  let html = fs.readFileSync(path.join(__dirname, relPath), "utf8");

  // 站点脚本在解析时就会读取 localStorage，因此把种子数据插到 <body> 最前面
  if (seedLocalStorage) {
    const script =
      "<script>try{" +
      Object.entries(seedLocalStorage)
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)});`)
        .join("") +
      "}catch(e){}</script>";
    html = html.replace(/<body>/, "<body>" + script);
  }

  const virtualConsole = new VirtualConsole(); // 静默 jsdom 的导航提示
  const dom = new JSDOM(html, {
    url: origin + "/" + relPath.replace(/\\/g, "/"),
    runScripts: "dangerously",
    virtualConsole,
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const doc = win.document;
  win.chrome = chromeStub(origin);
  win.eval(CONTENT);

  return { dom, win, doc, filler: win.__AF_FILLER__ };
}

async function runPanel(page, options) {
  const opts = options || {};
  const doc = page.doc;

  page.filler.open();
  const hostReady = await waitFor(() => {
    const host = doc.getElementById("__af_form_filler_host__");
    return !!(host && host.shadowRoot);
  }, 4000);
  if (!hostReady) return { shadow: null, status: "(面板未能打开)" };

  const shadow = doc.getElementById("__af_form_filler_host__").shadowRoot;
  await sleep(150); // 等待面板异步加载配置 / 历史用户信息 / 已保存账号

  if (opts.info != null) shadow.querySelector("#af-info").value = opts.info;
  if (opts.mode) shadow.querySelector("#af-mode").value = opts.mode;

  shadow.querySelector("#af-start").click();

  await waitFor(() => {
    const t = (shadow.querySelector("#af-status").textContent || "").trim();
    return /✅|❌|预览完成|没有字段被填写|缺少用户信息/.test(t);
  }, opts.timeout || 90000);

  const status = (shadow.querySelector("#af-status").textContent || "").trim();
  if (/❌/.test(status)) console.error("[面板错误] " + status);
  return { shadow, status };
}

/* ---------------- 测试主流程 ---------------- */
(async () => {
  /* ============ 站点 A：注册 ============ */
  const A_REG = loadPage("site-a/register.html", ORIGIN_A);
  check("A 注册页 -> 识别为注册模式", A_REG.filler.analyze().mode === "register");

  const aRegPanel = await runPanel(A_REG, { info: RESUME });
  check("A 注册流程完成并提示已保存", /已保存/.test(aRegPanel.status), aRegPanel.status);

  const aDoc = A_REG.doc;
  const aUser = aDoc.querySelector('[name="username"]').value;
  const aEmail = aDoc.querySelector('[name="email"]').value;
  const aPwd = aDoc.querySelector('[name="password"]').value;
  const aConfirm = aDoc.querySelector('[name="confirm"]').value;

  check("A 已生成合规用户名", /^[A-Za-z0-9_]{6,20}$/.test(aUser), aUser);
  check("A 已填写邮箱", /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(aEmail), aEmail);
  check("A 密码满足 8-16 位且含大小写数字",
    aPwd.length >= 8 && aPwd.length <= 16 && /[a-z]/.test(aPwd) && /[A-Z]/.test(aPwd) && /[0-9]/.test(aPwd), aPwd);
  check("A 确认密码与密码一致", aConfirm === aPwd);

  // 注册后应醒目提示复制保存账号密码，并提供一键复制
  const aCredText = aRegPanel.shadow.querySelector("#af-cred").textContent || "";
  check("A 面板提示复制保存账号密码",
    aCredText.indexOf("复制") >= 0 && aCredText.indexOf("妥善保存") >= 0, aCredText.slice(0, 80));

  const aCopyBtn = aRegPanel.shadow.querySelector("#af-copy-all");
  check("A 面板提供『一键复制账号密码』按钮", !!aCopyBtn && /一键复制/.test(aCopyBtn.textContent));

  let copiedText = "";
  try {
    Object.defineProperty(A_REG.win.navigator, "clipboard", {
      value: { writeText: async (t) => { copiedText += String(t); } },
      configurable: true,
    });
  } catch (e) { /* ignore */ }

  if (aCopyBtn) {
    aCopyBtn.click();
    await waitFor(() => !!copiedText, 2000);
    await sleep(150); // 等按钮文案在微任务后更新为「已复制」
    check("A 复制内容包含账号与密码",
      copiedText.indexOf(aUser) >= 0 && copiedText.indexOf(aPwd) >= 0,
      copiedText.replace(/\n/g, " | "));
    check("A 复制后按钮提示已复制", /已复制/.test(aCopyBtn.textContent), aCopyBtn.textContent);
  } else {
    check("A 复制内容包含账号与密码", false, "缺少复制按钮");
    check("A 复制后按钮提示已复制", false, "缺少复制按钮");
  }

  const aSaved = ((stores[ORIGIN_A] || {}).af_accounts || {})[ORIGIN_A] || [];
  check("A 登录信息已保存到本机", aSaved.length === 1, JSON.stringify(aSaved.map((x) => x.account)));
  check("A 保存的账号与页面一致", aSaved[0] && aSaved[0].account === aUser);
  check("A 保存的密码与页面一致", aSaved[0] && aSaved[0].password === aPwd);

  aDoc.getElementById("btnRegister").click();
  check("A 站点注册校验通过", /注册成功/.test(aDoc.getElementById("msg").textContent), aDoc.getElementById("msg").textContent);

  const aUsersLS = A_REG.win.localStorage.getItem("siteA_users");
  const aCurrentLS = A_REG.win.localStorage.getItem("siteA_current");
  check("A 站点已写入注册记录", !!aUsersLS && JSON.parse(aUsersLS).length === 1);

  /* ============ 站点 A：网申 ============ */
  const A_APPLY = loadPage("site-a/apply.html", ORIGIN_A, {
    siteA_users: aUsersLS,
    siteA_current: aCurrentLS,
  });
  check("A 网申页 -> 识别为普通模式", A_APPLY.filler.analyze().mode === "normal");

  const aApplyPanel = await runPanel(A_APPLY, { info: RESUME });
  const ad = A_APPLY.doc;

  check("A 网申：姓名", ad.querySelector('[name="name"]').value === R.name, ad.querySelector('[name="name"]').value);
  check("A 网申：性别=男", !!ad.querySelector('[name="sex"][value="男"]').checked);
  check("A 网申：出生日期", ad.querySelector('[name="birth"]').value === R.birth, ad.querySelector('[name="birth"]').value);
  check("A 网申：手机号", ad.querySelector('[name="phone"]').value === R.phone);
  check("A 网申：邮箱", ad.querySelector('[name="email"]').value === R.email);
  check("A 网申：学历=本科", ad.querySelector('select[name="degree"]').value === "本科", ad.querySelector('select[name="degree"]').value);
  check("A 网申：毕业院校", ad.querySelector('[name="school"]').value === R.school);
  check("A 网申：专业", ad.querySelector('[name="major"]').value === R.major);
  check("A 网申：求职意向=前端开发工程师",
    ad.querySelector('select[name="job"]').value === "前端开发工程师", ad.querySelector('select[name="job"]').value);
  check("A 网申：期望城市", ad.querySelector('[name="city"]').value === R.city);

  const aSkills = Array.from(ad.querySelectorAll('input[name="skills"]')).filter((x) => x.checked).map((x) => x.value);
  check("A 网申：技能标签已勾选(>=2)", aSkills.length >= 2, aSkills.join(","));

  const aSummary = ad.querySelector('[name="summary"]').value;
  check("A 网申：个人简介 100-300 字", aSummary.length >= 100 && aSummary.length <= 300, aSummary.length + " 字");

  ad.getElementById("btnSubmit").click();
  check("A 网申提交校验通过", /提交成功/.test(ad.getElementById("msg").textContent), ad.getElementById("msg").textContent);

  /* ============ 站点 A：登录 ============ */
  const A_LOGIN = loadPage("site-a/login.html", ORIGIN_A, { siteA_users: aUsersLS });
  check("A 登录页 -> 识别为登录模式", A_LOGIN.filler.analyze().mode === "login");

  const aLoginPanel = await runPanel(A_LOGIN, { mode: "login" });
  check("A 登录：账号已填入", A_LOGIN.doc.querySelector('[name="username"]').value === aUser);
  check("A 登录：密码已填入", A_LOGIN.doc.querySelector('[name="password"]').value === aPwd);
  check("A 登录：面板显示已保存账号",
    !!aLoginPanel.shadow && aLoginPanel.shadow.querySelectorAll("#af-accounts-list .acc-item").length >= 1);

  A_LOGIN.doc.getElementById("btnLogin").click();
  check("A 站点登录校验通过", /登录成功/.test(A_LOGIN.doc.getElementById("msg").textContent), A_LOGIN.doc.getElementById("msg").textContent);

  /* ============ 站点 B：注册 ============ */
  const B_REG = loadPage("site-b/register.html", ORIGIN_B);
  check("B 注册页 -> 识别为注册模式", B_REG.filler.analyze().mode === "register");

  const bRegPanel = await runPanel(B_REG, { info: RESUME });
  check("B 注册流程完成并提示已保存", /已保存/.test(bRegPanel.status), bRegPanel.status);

  const bd = B_REG.doc;
  const bEmail = bd.querySelector('[name="email"]').value;
  const bCode = bd.querySelector('[name="code"]').value;
  const bPwd = bd.querySelector('[name="password"]').value;
  const bConfirm = bd.querySelector('[name="confirm"]').value;
  const B_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,20}$/;

  check("B 已填写邮箱", /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(bEmail), bEmail);
  check("B 已填写验证码 123456", bCode === "123456", bCode);
  check("B 密码满足 pattern 正则", B_PATTERN.test(bPwd), bPwd);
  check("B 确认密码与密码一致", bConfirm === bPwd);
  check("B 已勾选用户协议", bd.getElementById("agree").checked === true);

  const bSaved = ((stores[ORIGIN_B] || {}).af_accounts || {})[ORIGIN_B] || [];
  check("B 登录信息已保存到本机", bSaved.length === 1);
  check("B 保存的账号=邮箱", bSaved[0] && bSaved[0].account === bEmail);
  check("B 保存的密码与页面一致", bSaved[0] && bSaved[0].password === bPwd);

  const bCredText = bRegPanel.shadow.querySelector("#af-cred").textContent || "";
  check("B 面板提示复制保存账号密码",
    bCredText.indexOf("复制") >= 0 && bCredText.indexOf("妥善保存") >= 0, bCredText.slice(0, 80));
  check("B 面板提供『一键复制账号密码』按钮",
    !!bRegPanel.shadow.querySelector("#af-copy-all"));

  bd.getElementById("btnRegister").click();
  check("B 站点注册校验通过", /注册成功/.test(bd.getElementById("msg").textContent), bd.getElementById("msg").textContent);

  const bUsersLS = B_REG.win.localStorage.getItem("siteB_users");
  const bCurrentLS = B_REG.win.localStorage.getItem("siteB_current");

  /* ============ 站点 B：网申 ============ */
  const B_APPLY = loadPage("site-b/apply.html", ORIGIN_B, {
    siteB_users: bUsersLS,
    siteB_current: bCurrentLS,
  });
  check("B 网申页 -> 识别为普通模式", B_APPLY.filler.analyze().mode === "normal");

  await runPanel(B_APPLY, { info: RESUME, timeout: 15000 });
  const b = B_APPLY.doc;

  check("B 网申：姓名", b.querySelector('[name="name"]').value === R.name);
  check("B 网申：性别=男", !!b.querySelector('[name="sex"][value="男"]').checked);
  check("B 网申：出生日期", b.querySelector('[name="birth"]').value === R.birth);
  check("B 网申：身份证号", b.querySelector('[name="idcard"]').value === R.idcard, b.querySelector('[name="idcard"]').value);
  check("B 网申：手机号", b.querySelector('[name="phone"]').value === R.phone);
  check("B 网申：邮箱", b.querySelector('[name="email"]').value === R.email);
  check("B 网申：政治面貌=共青团员",
    b.querySelector('select[name="political"]').value === "共青团员", b.querySelector('select[name="political"]').value);
  check("B 网申：籍贯含江苏", b.querySelector('[name="hometown"]').value.indexOf("江苏") >= 0, b.querySelector('[name="hometown"]').value);
  check("B 网申：毕业院校", b.querySelector('[name="school"]').value === R.school);
  check("B 网申：专业", b.querySelector('[name="major"]').value === R.major);
  check("B 网申：学历=本科", b.querySelector('select[name="degree"]').value === "本科");
  check("B 网申：毕业时间=2026-06", b.querySelector('[name="gradMonth"]').value === "2026-06", b.querySelector('[name="gradMonth"]').value);
  check("B 网申：应聘岗位=软件开发工程师",
    b.querySelector('select[name="job"]').value === "软件开发工程师", b.querySelector('select[name="job"]').value);
  check("B 网申：期望薪资=12000", b.querySelector('[name="salary"]').value === "12000", b.querySelector('[name="salary"]').value);
  check("B 网申：可到岗日期", b.querySelector('[name="available"]').value === R.available, b.querySelector('[name="available"]').value);
  check("B 网申：作品集链接", /^https?:\/\//.test(b.querySelector('[name="portfolio"]').value), b.querySelector('[name="portfolio"]').value);
  check("B 网申：个人简介 >=200 字", b.querySelector('[name="summary"]').value.length >= 200, b.querySelector('[name="summary"]').value.length + " 字");
  check("B 网申：项目经历 >=20 字", b.querySelector('[name="projects"]').value.length >= 20, b.querySelector('[name="projects"]').value.length + " 字");
  check("B 网申：是否接受调剂=是", !!b.querySelector('[name="adjust"][value="是"]').checked);

  b.getElementById("btnSubmit").click();
  check("B 网申提交校验通过", /提交成功/.test(b.getElementById("msg").textContent), b.getElementById("msg").textContent);

  /* ============ 汇总 ============ */
  check("大模型共调用 4 次（A注册/A网申/B注册/B网申）", chatCalls === 4, "实际 " + chatCalls + " 次");

  let pass = 0;
  for (const c of checks) {
    console.log((c.ok ? "PASS " : "FAIL ") + c.name + (c.ok ? "" : "  →  " + c.extra));
    if (c.ok) pass++;
  }
  console.log("========================================");
  console.log("RESULT " + pass + "/" + checks.length);
  process.exit(pass === checks.length ? 0 : 1);
})().catch((err) => {
  console.error("TEST_ERROR", err);
  process.exit(1);
});
