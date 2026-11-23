/* ============================================================
 * 零依赖静态服务器：用于在浏览器中打开 test/ 下的两个网申站点
 * ============================================================
 * 运行：node test/serve.js
 *       默认 http://127.0.0.1:8000 （端口被占用会自动 +1 重试）
 *       启动后自动打开浏览器首页（可用 --no-open 或 NO_OPEN=1 关闭）
 *
 * 自定义端口：set PORT=8080 && node test/serve.js
 * ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const BASE_PORT = parseInt(process.env.PORT || "8000", 10);
const MAX_TRIES = 10;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8" });
  res.end(body);
}

/** 根路径：列出可测试的站点入口 */
function renderIndex() {
  const links = [
    ["site-a/index.html", "站点 A · 星辰招聘（layui 风格）"],
    ["site-a/register.html", "站点 A · 注册账号"],
    ["site-a/apply.html", "站点 A · 填写网申信息"],
    ["site-a/login.html", "站点 A · 登录（复用已保存账号）"],
    ["site-b/index.html", "站点 B · 蓝海人才（表格布局）"],
    ["site-b/register.html", "站点 B · 注册账号（验证码 123456）"],
    ["site-b/apply.html", "站点 B · 填写网申信息"],
    ["resume.txt", "个人简历 · resume.txt"],
    ["resume.docx", "个人简历 · resume.docx"],
  ];

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>自动表单填写助手 · 测试站点</title>
<style>
  body{font-family:"Microsoft YaHei",Arial,sans-serif;background:#f4f6fb;color:#243044;margin:0;padding:36px;}
  .card{max-width:720px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(20,40,90,.1);padding:26px 30px;}
  h1{font-size:20px;margin:0 0 8px;color:#2563eb;}
  p{font-size:13px;color:#5a6478;line-height:1.8;margin:0 0 16px;}
  ol{font-size:13px;color:#334155;line-height:1.9;padding-left:20px;}
  a{color:#2563eb;text-decoration:none;}
  a:hover{text-decoration:underline;}
  ul{list-style:none;padding:0;margin:18px 0 0;border-top:1px solid #eef2f7;padding-top:14px;}
  li{padding:7px 0;font-size:14px;}
  code{background:#f1f5f9;border-radius:4px;padding:1px 6px;font-family:Consolas,monospace;}
</style></head><body>
<div class="card">
  <h1>自动表单填写助手 · 测试站点</h1>
  <p>先确认扩展已在浏览器中加载，并在扩展弹窗里配置了 <b>API Key</b>；然后点击下面任一页面，按 <code>Ctrl + /</code> 导入
  <code>resume.docx</code> 或 <code>resume.txt</code>，点击「开始智能填写」。</p>
  <ol>
    <li>站点 A：注册 → 网申 → 登录（验证已保存账号密码可复用）</li>
    <li>站点 B：注册（验证码 <code>123456</code>）→ 网申</li>
  </ol>
  <ul>
    ${links.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("\n    ")}
  </ul>
</div>
</body></html>`;
}

function handleRequest(req, res) {
  let urlPath = "/";
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (e) {
    return send(res, 400, "Bad Request");
  }

  if (urlPath === "/" || urlPath === "/index.html") {
    const rootIndex = path.join(ROOT, "index.html");
    if (fs.existsSync(rootIndex)) {
      return send(res, 200, fs.readFileSync(rootIndex), TYPES[".html"]);
    }
    return send(res, 200, renderIndex(), TYPES[".html"]);
  }

  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ""));
  const inside = filePath === ROOT || filePath.startsWith(ROOT + path.sep);
  if (!inside) return send(res, 403, "Forbidden");

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not Found: " + urlPath);

    const type = TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** 启动后自动打开浏览器（可用 --no-open / NO_OPEN=1 禁用） */
function openBrowser(url) {
  if (process.env.NO_OPEN === "1" || process.argv.includes("--no-open")) return;
  try {
    let child;
    if (process.platform === "win32") {
      child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch (e) { /* 打不开浏览器不影响服务器 */ }
}

function start(port, triesLeft) {
  const server = http.createServer(handleRequest);

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE" && triesLeft > 0) {
      console.warn("端口 " + port + " 已被占用，尝试 " + (port + 1) + " ...");
      return start(port + 1, triesLeft - 1);
    }
    console.error("服务器启动失败：" + (err && err.message ? err.message : err));
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const base = "http://127.0.0.1:" + port;
    console.log("");
    console.log("静态服务器已启动：" + base + "/");
    console.log("站点 A：" + base + "/site-a/index.html");
    console.log("站点 B：" + base + "/site-b/index.html");
    console.log("");
    console.log("请在扩展弹窗中配置 API Key，然后回到页面按 Ctrl + / 导入 resume.docx / resume.txt 进行测试。");
    console.log("按 Ctrl + C 停止服务器（若未自动打开浏览器，请手动访问上面的地址）。");
    console.log("");
    openBrowser(base + "/");
  });
}

start(BASE_PORT, MAX_TRIES);
