// ============================================================
// docx-extract.js — 纯前端 DOCX 文本提取（不依赖第三方库）
// ============================================================
// 原理：.docx 本质是一个 ZIP 包，正文位于 word/document.xml。
//   1) 解析 ZIP 的中央目录（EOCD + central directory），定位 word/document.xml
//   2) 读取本地文件头，取压缩数据
//   3) 使用浏览器内置 DecompressionStream('deflate-raw') 解压（Chrome/Edge 103+）
//   4) 去掉 XML 标签，保留段落 / 表格的换行与制表符
//
// 对外暴露：
//   window.AF_DOCX.extractTextFromDocx(ArrayBuffer | Uint8Array) -> Promise<string>
//   window.AF_DOCX.xmlToText(xmlString) -> string
// ============================================================

(function (global) {
  "use strict";

  const SIG_LOCAL = 0x04034b50;   // 本地文件头 "PK\x03\x04"
  const SIG_CENTRAL = 0x02014b50; // 中央目录头 "PK\x01\x02"
  const SIG_EOCD = 0x06054b50;    // 目录结尾 "PK\x05\x06"

  const utf8Decoder = new TextDecoder("utf-8");

  function u16(u8, o) {
    return (u8[o] | (u8[o + 1] << 8)) >>> 0;
  }

  function u32(u8, o) {
    return ((u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0);
  }

  /** 从文件尾部向前查找 EOCD（目录结尾记录） */
  function findEOCD(u8) {
    const maxBack = Math.min(u8.length, 66000); // 注释最大 65535 字节
    for (let i = u8.length - 22; i >= u8.length - maxBack; i--) {
      if (i < 0) break;
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        const commentLen = u16(u8, i + 20);
        if (i + 22 + commentLen <= u8.length) return i;
      }
    }
    return -1;
  }

  /** 解析中央目录，返回条目列表 */
  function listEntries(u8) {
    const eocd = findEOCD(u8);
    if (eocd < 0) throw new Error("不是有效的 ZIP/DOCX 文件（找不到目录结尾标记）");

    const count = u16(u8, eocd + 10);
    const cdOffset = u32(u8, eocd + 16);
    const entries = [];
    let off = cdOffset;

    for (let i = 0; i < count && off + 46 <= u8.length; i++) {
      if (u32(u8, off) !== SIG_CENTRAL) break;
      const method = u16(u8, off + 10);
      const compSize = u32(u8, off + 20);
      const uncompSize = u32(u8, off + 24);
      const nameLen = u16(u8, off + 28);
      const extraLen = u16(u8, off + 30);
      const commentLen = u16(u8, off + 32);
      const localOff = u32(u8, off + 42);

      let name = "";
      try {
        name = utf8Decoder.decode(u8.subarray(off + 46, off + 46 + nameLen));
      } catch (e) {
        name = "";
      }

      entries.push({ name, method, compSize, uncompSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
  }

  /** deflate-raw 解压 */
  async function inflateRaw(bytes) {
    if (typeof global.DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持 DecompressionStream，无法解析 .docx（请升级 Chrome/Edge，或改用 .txt）");
    }
    const ds = new global.DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** 读取某个 ZIP 条目的原始数据 */
  async function readEntry(u8, entry) {
    if (u32(u8, entry.localOff) !== SIG_LOCAL) {
      throw new Error("ZIP 本地文件头损坏（" + entry.name + "）");
    }
    const nameLen = u16(u8, entry.localOff + 26);
    const extraLen = u16(u8, entry.localOff + 28);
    const dataStart = entry.localOff + 30 + nameLen + extraLen;
    const data = u8.subarray(dataStart, dataStart + entry.compSize);

    if (entry.method === 0) return data;          // 未压缩
    if (entry.method === 8) return await inflateRaw(data); // deflate
    throw new Error("不支持的 ZIP 压缩算法: " + entry.method);
  }

  /** XML 实体解码 */
  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; }
      })
      .replace(/&#(\d+);/g, (m, d) => {
        try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; }
      })
      .replace(/</g, "<")
      .replace(/>/g, ">")
      .replace(/"/g, '"')
      .replace(/'/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&/g, "&");
  }

  /** WordprocessingML → 纯文本 */
  function xmlToText(xml) {
    let s = String(xml || "");

    // 去掉域代码、修订删除内容
    s = s.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "");
    s = s.replace(/<w:delText[\s\S]*?<\/w:delText>/g, "");

    // 结构映射
    s = s.replace(/<w:tab\b[^>]*\/?>/g, "\t");
    s = s.replace(/<w:br\b[^>]*\/?>/g, "\n");
    s = s.replace(/<\/w:p>/g, "\n");
    s = s.replace(/<\/w:tc>/g, "\t");
    s = s.replace(/<\/w:tr>/g, "\n");

    // 去标签 + 实体解码
    s = s.replace(/<[^>]+>/g, "");
    s = decodeXmlEntities(s);

    // 规整空白
    s = s.replace(/\r\n?/g, "\n");
    s = s.replace(/[ \t\u00a0]+/g, " ");
    s = s.replace(/ *\n */g, "\n");
    s = s.replace(/\t+\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");

    return s.trim();
  }

  /**
   * 从 .docx 二进制中提取正文纯文本
   * @param {ArrayBuffer|Uint8Array} input
   * @returns {Promise<string>}
   */
  async function extractTextFromDocx(input) {
    const u8 = (input instanceof Uint8Array) ? input : new Uint8Array(input);
    if (!(u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b)) {
      throw new Error("文件不是有效的 .docx（ZIP）格式");
    }

    const entries = listEntries(u8);
    const pick =
      entries.find((e) => e.name === "word/document.xml") ||
      entries.find((e) => /(^|\/)document\.xml$/i.test(e.name)) ||
      entries.find((e) => /^word\/.*\.xml$/i.test(e.name));

    if (!pick) throw new Error("docx 内未找到 word/document.xml");

    const data = await readEntry(u8, pick);
    const xml = utf8Decoder.decode(data);
    return xmlToText(xml);
  }

  global.AF_DOCX = {
    extractTextFromDocx,
    xmlToText,
  };
})(typeof window !== "undefined" ? window : self);
