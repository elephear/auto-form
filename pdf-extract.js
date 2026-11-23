/*!
 * pdf-extract.js — 纯前端 PDF 文本提取（不依赖任何第三方库）
 * Copyright 2025-2026 向雄 (Xiong Xiang) <公众号：思之益>
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0. See the LICENSE file.
 */

// ============================================================
// pdf-extract.js — 纯前端 PDF 文本提取（不依赖任何第三方库）
// ============================================================
// 实现思路：
//   1) 扫描文件中所有 "N G obj" 对象，解析 PDF 对象（字典/数组/字符串/引用）
//   2) 展开对象流（/Type /ObjStm，PDF 1.5+ 常见）
//   3) 通过 /Root → /Pages → /Kids 遍历页面，继承 /Resources
//   4) 解码页面内容流（FlateDecode / ASCIIHex / ASCII85 / LZW / RunLength
//      + PNG 预测器），再用内置 DecompressionStream 完成 Flate 解压
//   5) 解析字体 /ToUnicode CMap，把字符编码映射成 Unicode
//   6) 模拟文本状态（Tm / Td / T* / TJ），按行重组纯文本
//
// 对外暴露：
//   window.AF_PDF.extractTextFromPdf(ArrayBuffer | Uint8Array) -> Promise<string>
// ============================================================

(function (global) {
  "use strict";

  const latin1 = new TextDecoder("latin1");

  // ============================================================
  // 基础词法工具
  // ============================================================

  function isWS(code) {
    return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a || code === 0x0c || code === 0x00;
  }

  function isDelim(ch) {
    return ch === "(" || ch === ")" || ch === "<" || ch === ">" || ch === "[" || ch === "]" ||
      ch === "{" || ch === "}" || ch === "/" || ch === "%";
  }

  function skipWS(s, i) {
    const len = s.length;
    while (i < len) {
      const code = s.charCodeAt(i);
      if (isWS(code)) { i++; continue; }
      if (s[i] === "%") {
        while (i < len && s[i] !== "\n" && s[i] !== "\r") i++;
        continue;
      }
      break;
    }
    return i;
  }

  function parseName(s, i) {
    let j = i + 1;
    let name = "";
    while (j < s.length) {
      const ch = s[j];
      if (isWS(s.charCodeAt(j)) || isDelim(ch)) break;
      if (ch === "#" && /^[0-9a-fA-F]{2}$/.test(s.substr(j + 1, 2))) {
        name += String.fromCharCode(parseInt(s.substr(j + 1, 2), 16));
        j += 3;
        continue;
      }
      name += ch;
      j++;
    }
    return { value: name, pos: j };
  }

  function parseLiteralString(s, i) {
    let j = i + 1;
    let depth = 1;
    const out = [];
    while (j < s.length) {
      let ch = s[j];
      if (ch === "\\") {
        j++;
        const e = s[j++];
        if (e === undefined) break;
        if (e === "n") out.push(0x0a);
        else if (e === "r") out.push(0x0d);
        else if (e === "t") out.push(0x09);
        else if (e === "b") out.push(0x08);
        else if (e === "f") out.push(0x0c);
        else if (e === "(") out.push(0x28);
        else if (e === ")") out.push(0x29);
        else if (e === "\\") out.push(0x5c);
        else if (e === "\r") { if (s[j] === "\n") j++; }
        else if (e === "\n") { /* 续行 */ }
        else if (e >= "0" && e <= "7") {
          let oct = e;
          for (let k = 0; k < 2 && s[j] >= "0" && s[j] <= "7"; k++) oct += s[j++];
          out.push(parseInt(oct, 8) & 0xff);
        } else {
          out.push(e.charCodeAt(0) & 0xff);
        }
        continue;
      }
      if (ch === "(") { depth++; out.push(0x28); j++; continue; }
      if (ch === ")") {
        depth--;
        j++;
        if (depth === 0) break;
        out.push(0x29);
        continue;
      }
      out.push(ch.charCodeAt(0) & 0xff);
      j++;
    }
    return { bytes: Uint8Array.from(out), pos: j };
  }

  function parseHexString(s, i) {
    let j = i + 1;
    let hex = "";
    while (j < s.length && s[j] !== ">") {
      const ch = s[j];
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      j++;
    }
    if (s[j] === ">") j++;
    if (hex.length % 2 === 1) hex += "0";
    const bytes = new Uint8Array(hex.length / 2);
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
    return { bytes, pos: j };
  }

  function parseDict(s, i) {
    let j = i + 2;
    const map = Object.create(null);
    let guard = 0;
    while (j < s.length && guard++ < 2000000) {
      j = skipWS(s, j);
      if (j >= s.length) break;
      if (s[j] === ">" && s[j + 1] === ">") { j += 2; break; }
      if (s[j] !== "/") {
        const r = parseValue(s, j);
        if (!r || r.pos <= j) j++;
        else j = r.pos;
        continue;
      }
      const key = parseName(s, j);
      j = skipWS(s, key.pos);
      const r = parseValue(s, j);
      if (r && r.pos > j) {
        map[key.value] = r.value;
        j = r.pos;
      } else {
        break;
      }
    }
    return { value: { t: "dict", map }, pos: j };
  }

  function parseValue(s, i) {
    i = skipWS(s, i);
    if (i >= s.length) return { value: null, pos: i };
    const ch = s[i];
    const code = s.charCodeAt(i);

    if (ch === "/") {
      const r = parseName(s, i);
      return { value: { t: "name", v: r.value }, pos: r.pos };
    }

    if (ch === "(") {
      const r = parseLiteralString(s, i);
      return { value: { t: "str", bytes: r.bytes }, pos: r.pos };
    }

    if (ch === "<") {
      if (s[i + 1] === "<") return parseDict(s, i);
      const r = parseHexString(s, i);
      return { value: { t: "str", bytes: r.bytes }, pos: r.pos };
    }

    if (ch === "[") {
      let j = i + 1;
      const arr = [];
      while (j < s.length) {
        j = skipWS(s, j);
        if (s[j] === "]") { j++; break; }
        if (j >= s.length) break;
        const r = parseValue(s, j);
        if (!r || r.pos <= j) { j++; continue; }
        arr.push(r.value);
        j = r.pos;
      }
      return { value: { t: "arr", v: arr }, pos: j };
    }

    if (ch === "]" || ch === ">" || ch === ")" || ch === "}") {
      return { value: null, pos: i + 1 };
    }

    // 数字 / 间接引用
    if (ch === "+" || ch === "-" || ch === "." || (code >= 48 && code <= 57)) {
      let j = i;
      if (s[j] === "+" || s[j] === "-") j++;
      let has = false;
      while (j < s.length && s[j] >= "0" && s[j] <= "9") { j++; has = true; }
      if (s[j] === ".") {
        j++;
        while (j < s.length && s[j] >= "0" && s[j] <= "9") { j++; has = true; }
      }
      if (has) {
        const tok = s.slice(i, j);
        if (/^[+-]?\d+$/.test(tok)) {
          const rm = /^\s+(\d+)\s+R(?=[\s\/*\[\]<>(){}%]|$)/.exec(s.slice(j));
          if (rm) {
            return {
              value: { t: "ref", num: parseInt(tok, 10), gen: parseInt(rm[1], 10) },
              pos: j + rm[0].length,
            };
          }
        }
        return { value: { t: "num", v: parseFloat(tok) }, pos: j };
      }
    }

    // 关键字
    let j = i;
    while (j < s.length && !isWS(s.charCodeAt(j)) && !isDelim(s[j])) j++;
    if (j === i) j = i + 1;
    const kw = s.slice(i, j);
    if (kw === "true") return { value: { t: "bool", v: true }, pos: j };
    if (kw === "false") return { value: { t: "bool", v: false }, pos: j };
    if (kw === "null") return { value: { t: "null" }, pos: j };
    return { value: { t: "kw", v: kw }, pos: j };
  }

  function nameOf(v) {
    return v && v.t === "name" ? v.v : "";
  }

  function numOf(v, dflt) {
    return v && v.t === "num" ? v.v : dflt;
  }

  // ============================================================
  // 流解码
  // ============================================================

  async function inflateBytes(bytes, mode) {
    if (typeof global.DecompressionStream !== "function") {
      throw new Error("当前浏览器不支持 DecompressionStream，无法解析 PDF（请升级 Chrome/Edge）");
    }
    const ds = new global.DecompressionStream(mode);
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function asciiHexDecode(data) {
    let hex = "";
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if ((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)) {
        hex += String.fromCharCode(b);
      } else if (b === 62) { // '>'
        break;
      }
    }
    if (hex.length % 2 === 1) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function ascii85Decode(data) {
    const out = [];
    let group = [];
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (isWS(b)) continue;
      if (b === 126) break; // '~'
      if (b === 122 && group.length === 0) { // 'z'
        out.push(0, 0, 0, 0);
        continue;
      }
      if (b < 33 || b > 117) continue;
      group.push(b - 33);
      if (group.length === 5) {
        let n = 0;
        for (let k = 0; k < 5; k++) n = n * 85 + group[k];
        out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
        group = [];
      }
    }
    if (group.length) {
      const n0 = group.length;
      while (group.length < 5) group.push(84);
      let n = 0;
      for (let k = 0; k < 5; k++) n = n * 85 + group[k];
      const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
      for (let k = 0; k < n0 - 1; k++) out.push(bytes[k]);
    }
    return Uint8Array.from(out);
  }

  function runLengthDecode(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      const len = data[i++];
      if (len === 128) break;
      if (len < 128) {
        for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]);
      } else {
        const count = 257 - len;
        const b = data[i++];
        for (let k = 0; k < count; k++) out.push(b);
      }
    }
    return Uint8Array.from(out);
  }

  function lzwDecode(data, earlyChange) {
    if (earlyChange === undefined) earlyChange = 1;
    let dict = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < 256; i++) dict[i] = [i];
      dict[256] = null;
      dict[257] = null;
    };
    reset();
    let codeLen = 9;
    let next = 258;
    let prev = null;
    let bitPos = 0;
    const out = [];

    const readCode = () => {
      if (bitPos + codeLen > data.length * 8) return null;
      let code = 0;
      for (let k = 0; k < codeLen; k++) {
        const p = bitPos + k;
        const byte = data[p >> 3];
        const bit = (byte >> (7 - (p & 7))) & 1;
        code = (code << 1) | bit;
      }
      bitPos += codeLen;
      return code;
    };

    while (true) {
      const code = readCode();
      if (code === null || code === 257) break;
      if (code === 256) { reset(); codeLen = 9; next = 258; prev = null; continue; }
      let entry;
      if (code < next && dict[code]) entry = dict[code];
      else if (code === next && prev) entry = prev.concat([prev[0]]);
      else break;
      for (let k = 0; k < entry.length; k++) out.push(entry[k]);
      if (prev) {
        dict[next++] = prev.concat([entry[0]]);
        if (next + earlyChange >= (1 << codeLen) && codeLen < 12) codeLen++;
      }
      prev = entry;
    }
    return Uint8Array.from(out);
  }

  function applyPredictor(data, parms) {
    if (!parms) return data;
    const predictor = numOf(parms.Predictor, 1);
    if (predictor < 10) return data;
    const colors = numOf(parms.Colors, 1);
    const bpc = numOf(parms.BitsPerComponent, 8);
    const columns = numOf(parms.Columns, 1);
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rowLen = Math.ceil((colors * bpc * columns) / 8);
    const rows = Math.floor(data.length / (rowLen + 1));
    const out = new Uint8Array(rows * rowLen);
    let prevRow = new Uint8Array(rowLen);
    let src = 0;

    for (let r = 0; r < rows; r++) {
      const ft = data[src++];
      const row = data.subarray(src, src + rowLen);
      src += rowLen;
      const cur = new Uint8Array(rowLen);
      for (let i = 0; i < rowLen; i++) {
        const left = i >= bpp ? cur[i - bpp] : 0;
        const up = prevRow[i];
        const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
        let val = row[i];
        if (ft === 1) val = (val + left) & 0xff;
        else if (ft === 2) val = (val + up) & 0xff;
        else if (ft === 3) val = (val + ((left + up) >> 1)) & 0xff;
        else if (ft === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          val = (val + pred) & 0xff;
        }
        cur[i] = val;
      }
      out.set(cur, r * rowLen);
      prevRow = cur;
    }
    return out;
  }

  async function applyFilter(name, data, parms) {
    switch (name) {
      case "FlateDecode":
      case "Fl":
        try {
          return applyPredictor(await inflateBytes(data, "deflate"), parms);
        } catch (e) {
          return applyPredictor(await inflateBytes(data, "deflate-raw"), parms);
        }
      case "ASCIIHexDecode":
      case "AHx":
        return asciiHexDecode(data);
      case "ASCII85Decode":
      case "A85":
        return ascii85Decode(data);
      case "RunLengthDecode":
      case "RL":
        return runLengthDecode(data);
      case "LZWDecode":
      case "LZW":
        return applyPredictor(lzwDecode(data, numOf(parms && parms.EarlyChange, 1)), parms);
      case "Crypt":
        return data;
      default:
        // 图片类过滤器（DCT/JPX/CCITT/JBIG2 等）不参与文本提取
        return new Uint8Array(0);
    }
  }

  // ============================================================
  // 对象扫描与上下文
  // ============================================================

  async function decodeStreamRec(rec, ctx) {
    if (!rec || !rec.stream || !rec.value || rec.value.t !== "dict") return new Uint8Array(0);
    const dict = rec.value.map;
    let data = rec.stream;

    const filtersVal = ctx.resolve(dict.Filter);
    const parmsVal = ctx.resolve(dict.DecodeParms);
    const filters = filtersVal ? (filtersVal.t === "arr" ? filtersVal.v : [filtersVal]) : [];
    const parms = parmsVal ? (parmsVal.t === "arr" ? parmsVal.v : [parmsVal]) : [];

    for (let i = 0; i < filters.length; i++) {
      const fname = nameOf(ctx.resolve(filters[i]));
      const parm = ctx.resolve(parms[i]);
      data = await applyFilter(fname, data, parm && parm.t === "dict" ? parm.map : null);
    }
    return data;
  }

  function createContext(u8, str) {
    const objects = new Map();
    const ctx = {
      u8,
      str,
      objects,
      resolve(v) {
        let depth = 0;
        while (v && v.t === "ref" && depth++ < 32) {
          const rec = objects.get(v.num);
          v = rec ? rec.value : null;
        }
        return v;
      },
      getObj(v) {
        if (!v) return null;
        if (v.t === "ref") return objects.get(v.num) || null;
        if (v.t === "dict") return { num: -1, value: v, stream: null };
        return null;
      },
    };
    return ctx;
  }

  function scanObjects(ctx) {
    const { u8, str, objects } = ctx;
    const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m;
    while ((m = re.exec(str))) {
      const num = parseInt(m[1], 10);
      const start = skipWS(str, re.lastIndex);
      let r;
      try {
        r = parseValue(str, start);
      } catch (e) {
        continue;
      }
      if (!r || !r.value || r.pos <= start) continue;

      let streamStart = -1;
      if (r.value.t === "dict") {
        let p = skipWS(str, r.pos);
        if (str.startsWith("stream", p)) {
          p += 6;
          if (str.charCodeAt(p) === 13) p++;
          if (str.charCodeAt(p) === 10) p++;
          streamStart = p;
        }
      }
      // 后出现的同号对象覆盖前面的（增量更新）
      objects.set(num, { num, value: r.value, stream: null, streamStart });
    }

    // 第二遍解析 /Length（可能是间接引用），并截取流数据
    for (const rec of objects.values()) {
      if (!(rec.streamStart >= 0)) continue;
      let lenVal = rec.value.map.Length;
      if (lenVal && lenVal.t === "ref") {
        const lrec = objects.get(lenVal.num);
        lenVal = lrec ? lrec.value : null;
      }
      let len = lenVal && lenVal.t === "num" ? lenVal.v : -1;
      if (!(len >= 0) || rec.streamStart + len > u8.length) {
        let end = str.indexOf("endstream", rec.streamStart);
        if (end < 0) { rec.streamStart = -1; continue; }
        // PDF 规范允许 endstream 前有一个 EOL，不属于流数据
        if (str.charCodeAt(end - 1) === 10) end--;
        if (str.charCodeAt(end - 1) === 13) end--;
        len = end - rec.streamStart;
      }
      if (len > 0) rec.stream = u8.subarray(rec.streamStart, rec.streamStart + len);
      delete rec.streamStart;
    }
  }

  async function expandObjectStreams(ctx) {
    const list = [];
    for (const rec of ctx.objects.values()) {
      if (rec.stream && rec.value.t === "dict" && nameOf(rec.value.map.Type) === "ObjStm") list.push(rec);
    }
    for (const rec of list) {
      try {
        const data = await decodeStreamRec(rec, ctx);
        const s = latin1.decode(data);
        const n = numOf(ctx.resolve(rec.value.map.N), 0);
        const first = numOf(ctx.resolve(rec.value.map.First), 0);
        if (!(n > 0) || !(first >= 0) || first > s.length) continue;
        const header = s.slice(0, first).trim();
        const nums = header ? header.split(/\s+/).map(Number) : [];
        const total = Math.min(n, Math.floor(nums.length / 2));
        for (let i = 0; i < total; i++) {
          const objNum = nums[i * 2];
          const off = nums[i * 2 + 1];
          if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue;
          if (ctx.objects.has(objNum)) continue;
          const r = parseValue(s, first + off);
          if (r && r.value) ctx.objects.set(objNum, { num: objNum, value: r.value, stream: null });
        }
      } catch (e) { /* 忽略单个对象流错误 */ }
    }
  }

  function findCatalog(ctx) {
    let best = null;
    for (const rec of ctx.objects.values()) {
      if (rec.value.t !== "dict") continue;
      const type = nameOf(rec.value.map.Type);
      // XRef 流里带 /Root，是 PDF 1.5+ 最权威的入口
      if (type === "XRef" && rec.value.map.Root) {
        const root = ctx.resolve(rec.value.map.Root);
        if (root && root.t === "dict") return root;
      }
      if (type === "Catalog") {
        // 增量更新时后写入的目录对象编号通常更大
        if (!best || rec.num > best.num) best = { num: rec.num, value: rec.value };
      }
    }
    if (best) return best.value;
    for (const rec of ctx.objects.values()) {
      if (rec.value.t === "dict" && rec.value.map.Root) {
        const root = ctx.resolve(rec.value.map.Root);
        if (root && root.t === "dict") return root;
      }
    }
    return null;
  }

  function collectPages(ctx) {
    const pages = [];
    const catalog = findCatalog(ctx);
    const walk = (node, inheritedRes, depth) => {
      if (!node || node.t !== "dict" || depth > 64) return;
      const type = nameOf(node.map.Type);
      const res = node.map.Resources ? ctx.resolve(node.map.Resources) : inheritedRes;
      if (type === "Pages" || node.map.Kids) {
        const kids = ctx.resolve(node.map.Kids);
        if (kids && kids.t === "arr") {
          for (const kid of kids.v) walk(ctx.resolve(kid), res, depth + 1);
        }
        return;
      }
      pages.push({
        dict: node,
        resources: res && res.t === "dict" ? res.map : null,
      });
    };

    if (catalog) {
      const root = ctx.resolve(catalog.map.Pages);
      walk(root, null, 0);
    }

    if (!pages.length) {
      const arr = [];
      for (const rec of ctx.objects.values()) {
        if (rec.value.t === "dict" && nameOf(rec.value.map.Type) === "Page") arr.push(rec);
      }
      arr.sort((a, b) => a.num - b.num);
      for (const rec of arr) {
        const res = ctx.resolve(rec.value.map.Resources);
        pages.push({ dict: rec.value, resources: res && res.t === "dict" ? res.map : null });
      }
    }
    return pages;
  }

  // ============================================================
  // 字体与编码映射
  // ============================================================

  const fontCache = new WeakMap();

  function winAnsiTable() {
    if (winAnsiTable._t) return winAnsiTable._t;
    const table = new Array(256);
    for (let i = 0; i < 256; i++) table[i] = "";
    for (let i = 32; i < 127; i++) table[i] = String.fromCharCode(i);
    let decoded = "";
    try {
      const bytes = new Uint8Array(128);
      for (let i = 0; i < 128; i++) bytes[i] = 128 + i;
      decoded = new TextDecoder("windows-1252").decode(bytes);
    } catch (e) {
      decoded = "";
    }
    for (let i = 0; i < 128 && i < decoded.length; i++) table[128 + i] = decoded[i];
    table[9] = " ";
    table[10] = "\n";
    table[13] = "\n";
    winAnsiTable._t = table;
    return table;
  }

  function glyphToUnicode(name) {
    if (!name) return "";
    if (name.length === 1) return name;
    const common = {
      space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%",
      ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*",
      plus: "+", comma: ",", hyphen: "-", period: ".", slash: "/", zero: "0", one: "1",
      two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
      nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">",
      question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]",
      asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|",
      braceright: "}", asciitilde: "~", bullet: "•", endash: "–", emdash: "—",
      quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”",
      ellipsis: "…", nbspace: " ", periodcentered: "·", middot: "·",
    };
    if (common[name] !== undefined) return common[name];
    const uni = /^uni([0-9a-fA-F]{4,6})$/.exec(name);
    if (uni) {
      try { return String.fromCodePoint(parseInt(uni[1], 16)); } catch (e) { return ""; }
    }
    const u = /^u([0-9a-fA-F]{4,6})$/.exec(name);
    if (u) {
      try { return String.fromCodePoint(parseInt(u[1], 16)); } catch (e) { return ""; }
    }
    return "";
  }

  function parseDifferences(ctx, dict) {
    const enc = ctx.resolve(dict.map.Encoding);
    if (!enc) return null;
    if (enc.t !== "dict") return null;
    const diffs = ctx.resolve(enc.map.Differences);
    if (!diffs || diffs.t !== "arr") return null;
    const out = new Map();
    let code = 0;
    for (const item of diffs.v) {
      if (!item) continue;
      if (item.t === "num") code = item.v;
      else if (item.t === "name") {
        const ch = glyphToUnicode(item.v);
        if (ch) out.set(code, ch);
        code++;
      }
    }
    return out;
  }

  function hexToUnicode(hex) {
    if (!hex) return "";
    let out = "";
    for (let i = 0; i < hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.substr(i, 4).padEnd(4, "0"), 16));
    }
    return out;
  }

  function parseCMap(text) {
    const map = new Map();
    let codeLen = 0;
    let m;

    const csRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
    while ((m = csRe.exec(text))) {
      const hexes = m[1].match(/<([0-9a-fA-F]+)>/g);
      if (hexes && hexes.length) {
        const bytes = (hexes[0].length - 2) / 2;
        if (bytes === 1 || bytes === 2) codeLen = Math.max(codeLen, bytes);
      }
    }

    const bcRe = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = bcRe.exec(text))) {
      const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
      let p;
      while ((p = pairRe.exec(m[1]))) {
        if (!codeLen) codeLen = p[1].length === 2 ? 1 : p[1].length === 4 ? 2 : 0;
        map.set(parseInt(p[1], 16), hexToUnicode(p[2]));
      }
    }

    const brRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = brRe.exec(text))) {
      const body = m[1];
      const itemRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[\s\S]*?\]|<[0-9a-fA-F]*>)/g;
      let p;
      while ((p = itemRe.exec(body))) {
        const lo = parseInt(p[1], 16);
        const hi = parseInt(p[2], 16);
        if (!codeLen) codeLen = p[1].length === 2 ? 1 : 2;
        if (p[3].charAt(0) === "[") {
          const arr = p[3].match(/<([0-9a-fA-F]*)>/g) || [];
          for (let k = 0; k < arr.length && lo + k <= hi; k++) {
            map.set(lo + k, hexToUnicode(arr[k].slice(1, -1)));
          }
        } else {
          const baseHex = p[3].slice(1, -1);
          const start = [];
          for (let k = 0; k < baseHex.length; k += 4) {
            start.push(parseInt(baseHex.substr(k, 4).padEnd(4, "0"), 16));
          }
          if (!start.length) start.push(0);
          const count = Math.min(hi - lo + 1, 65536);
          for (let k = 0; k < count; k++) {
            const units = start.slice();
            let carry = k;
            for (let q = units.length - 1; q >= 0 && carry > 0; q--) {
              const nv = units[q] + carry;
              units[q] = nv & 0xffff;
              carry = nv >> 16;
            }
            map.set(lo + k, String.fromCharCode.apply(null, units));
          }
        }
      }
    }
    return { map, codeLen };
  }

  function emptyFont() {
    return {
      codeLen: 1,
      map: new Map(),
      fallback(code) { return winAnsiTable()[code] || ""; },
    };
  }

  async function loadFont(ctx, fontVal) {
    const rec = ctx.getObj(fontVal);
    if (!rec || !rec.value || rec.value.t !== "dict") return emptyFont();
    const dict = rec.value;
    if (fontCache.has(dict)) return fontCache.get(dict);

    const subtype = nameOf(dict.map.Subtype);
    let codeLen = subtype === "Type0" ? 2 : 1;
    let map = new Map();

    const tuRec = ctx.getObj(dict.map.ToUnicode);
    if (tuRec && tuRec.stream) {
      try {
        const data = await decodeStreamRec(tuRec, ctx);
        const cm = parseCMap(latin1.decode(data));
        if (cm.map.size) {
          map = cm.map;
          if (subtype !== "Type0" && cm.codeLen) codeLen = cm.codeLen;
        }
      } catch (e) { /* 忽略 CMap 错误 */ }
    }

    const diffs = parseDifferences(ctx, dict);
    const table = winAnsiTable();
    const info = {
      codeLen,
      map,
      fallback(code) {
        if (subtype === "Type0") return "";
        if (diffs && diffs.has(code)) return diffs.get(code);
        return table[code] || "";
      },
    };
    fontCache.set(dict, info);
    return info;
  }

  async function loadFonts(ctx, resources) {
    const fonts = Object.create(null);
    const fontDictVal = resources ? ctx.resolve(resources.Font) : null;
    if (fontDictVal && fontDictVal.t === "dict") {
      const keys = Object.keys(fontDictVal.map);
      for (const key of keys) fonts[key] = await loadFont(ctx, fontDictVal.map[key]);
    }
    return fonts;
  }

  function decodeWithFont(bytes, font) {
    const f = font || emptyFont();
    let out = "";
    if (f.codeLen === 2) {
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        const ch = f.map.get(code);
        out += ch !== undefined ? ch : f.fallback(code);
      }
    } else {
      for (let i = 0; i < bytes.length; i++) {
        const code = bytes[i];
        const ch = f.map.get(code);
        out += ch !== undefined ? ch : f.fallback(code);
      }
    }
    return out;
  }

  // ============================================================
  // 内容流 → 文本
  // ============================================================

  const IDENTITY = [1, 0, 0, 1, 0, 0];

  function translateMatrix(m, tx, ty) {
    return [m[0], m[1], m[2], m[3], tx * m[0] + ty * m[2] + m[4], tx * m[1] + ty * m[3] + m[5]];
  }

  function lastNumber(ops) {
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i] && ops[i].t === "num") return ops[i].v;
    }
    return null;
  }

  function lastNumbers(ops, count) {
    const nums = [];
    for (let i = ops.length - 1; i >= 0 && nums.length < count; i--) {
      if (ops[i] && ops[i].t === "num") nums.unshift(ops[i].v);
    }
    return nums.length === count ? nums : null;
  }

  /** 粗略估算一段文字在给定字号下的宽度（单位：文本空间） */
  function estimateWidth(text, size) {
    let w = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0x20 || cp === 0x3000) w += size * 0.3;
      else if (cp >= 0x2e80) w += size;
      else w += size * 0.55;
    }
    return w;
  }

  function emitText(sink, text, size, y) {
    if (!text) return;
    const x = sink.lastX || 0;
    const sz = size || 10;

    // 部分编辑器导出 PDF 时会把同一段文字重复绘制（伪粗体/描边），
    // 这里按“文本相同 + 位置极其接近”去重。
    if (sink.runs) {
      for (let i = sink.runs.length - 1; i >= 0 && i >= sink.runs.length - 80; i--) {
        const r = sink.runs[i];
        if (r.text === text && Math.abs(r.y - y) <= 2 && Math.abs(r.x - x) <= 3) return;
      }
      sink.runs.push({ text, x, y });
      if (sink.runs.length > 160) sink.runs.splice(0, sink.runs.length - 160);
    }

    if (sink.trace) sink.trace.push({ text, x, y, size: sz });

    if (!text.replace(/[\s\u3000]/g, "")) {
      sink.text += text;
      sink.lastRun = { text, x, y, size: sz };
      return;
    }

    // 同一行内出现明显横向间隔时补一个空格（多栏/表格排版常见）
    if (sink.lastRun && Math.abs(y - sink.lastRun.y) <= 2) {
      const expected = sink.lastRun.x + estimateWidth(sink.lastRun.text, sink.lastRun.size);
      if (x - expected > Math.max(3, sz * 1.2) &&
        !/[\s\u3000]$/.test(sink.text) && !/^[\s\u3000]/.test(text)) {
        sink.text += " ";
      }
    }
    if (sink.lastY !== null) {
      const dy = Math.abs(y - sink.lastY);
      const ref = Math.max(1.2, Math.min(size || 10, sink.lastSize || 10) * 0.55);
      if (dy > ref) {
        sink.text += "\n";
        if (dy > Math.max(6, Math.max(size || 10, sink.lastSize || 10) * 1.8)) sink.text += "\n";
      }
    }
    sink.text += text;
    sink.lastRun = { text, x, y, size: sz };
    sink.lastY = y;
    sink.lastSize = sz;
  }

  function findInlineImageEnd(str, i) {
    const re = /(?:^|[\s\0])EI(?=[\s\0]|$)/g;
    re.lastIndex = i;
    const m = re.exec(str);
    return m ? m.index + m[0].length : str.length;
  }

  async function runContent(str, st) {
    const state = {
      tm: IDENTITY.slice(),
      tlm: IDENTITY.slice(),
      leading: 0,
      fontSize: 10,
      font: null,
    };
    let i = 0;
    let ops = [];
    const len = str.length;

    while (i < len) {
      i = skipWS(str, i);
      if (i >= len) break;
      const ch = str[i];
      const code = str.charCodeAt(i);

      if (ch === "(" || ch === "<" || ch === "[" || ch === "/" ||
        ch === "+" || ch === "-" || ch === "." || (code >= 48 && code <= 57)) {
        let r = null;
        try {
          r = parseValue(str, i);
        } catch (e) {
          r = null;
        }
        if (r && r.pos > i) {
          ops.push(r.value);
          i = r.pos;
          continue;
        }
      }

      if (ch === "]" || ch === ">" || ch === ")" || ch === "}" || ch === "{") {
        i++;
        continue;
      }

      let j = i;
      while (j < len) {
        const cc = str.charCodeAt(j);
        if (isWS(cc) || isDelim(str[j])) break;
        j++;
      }
      if (j === i) j = i + 1;
      const op = str.slice(i, j);
      i = j;

      await applyOperator(op, ops, state, st);
      ops = [];

      if (op === "ID") i = findInlineImageEnd(str, i);
    }
  }

  async function applyOperator(op, ops, state, st) {
    switch (op) {
      case "BT":
        state.tm = IDENTITY.slice();
        state.tlm = IDENTITY.slice();
        break;

      case "Tf": {
        for (let i = ops.length - 1; i >= 0; i--) {
          if (ops[i] && ops[i].t === "name") {
            state.font = st.fonts[ops[i].v] || null;
            break;
          }
        }
        const size = lastNumber(ops);
        if (size !== null) state.fontSize = size;
        break;
      }

      case "TL": {
        const n = lastNumber(ops);
        if (n !== null) state.leading = n;
        break;
      }

      case "Td":
      case "TD": {
        const n = lastNumbers(ops, 2);
        if (n) {
          state.tlm = translateMatrix(state.tlm, n[0], n[1]);
          state.tm = state.tlm.slice();
          if (op === "TD") state.leading = -n[1];
        }
        break;
      }

      case "Tm": {
        const n = lastNumbers(ops, 6);
        if (n) {
          state.tm = n.slice();
          state.tlm = n.slice();
        }
        break;
      }

      case "T*": {
        state.tlm = translateMatrix(state.tlm, 0, -state.leading);
        state.tm = state.tlm.slice();
        break;
      }

      case "Tj": {
        st.sink.lastX = state.tm[4];
        for (const o of ops) {
          if (o && o.t === "str") {
            emitText(st.sink, decodeWithFont(o.bytes, state.font), state.fontSize, state.tm[5]);
          }
        }
        break;
      }

      case "'":
      case '"': {
        state.tlm = translateMatrix(state.tlm, 0, -state.leading);
        state.tm = state.tlm.slice();
        st.sink.lastX = state.tm[4];
        for (const o of ops) {
          if (o && o.t === "str") {
            emitText(st.sink, decodeWithFont(o.bytes, state.font), state.fontSize, state.tm[5]);
          }
        }
        break;
      }

      case "TJ": {
        let arr = null;
        for (let i = ops.length - 1; i >= 0; i--) {
          if (ops[i] && ops[i].t === "arr") { arr = ops[i]; break; }
        }
        if (!arr) break;
        let text = "";
        let pendingSpace = false;
        for (const el of arr.v) {
          if (!el) continue;
          if (el.t === "num") {
            if (el.v <= -120) pendingSpace = true;
            continue;
          }
          if (el.t !== "str") continue;
          const piece = decodeWithFont(el.bytes, state.font);
          if (!piece) continue;
          if (pendingSpace && text && !/[\s\u3000]$/.test(text) && !/^[\s\u3000]/.test(piece)) {
            text += " ";
          }
          pendingSpace = false;
          text += piece;
        }
        st.sink.lastX = state.tm[4];
        emitText(st.sink, text, state.fontSize, state.tm[5]);
        break;
      }

      case "Do": {
        if (st.depth >= 4) break;
        let target = null;
        for (let i = ops.length - 1; i >= 0; i--) {
          if (ops[i] && ops[i].t === "name") { target = ops[i].v; break; }
        }
        if (!target) break;
        const xobjVal = st.resources ? st.ctx.resolve(st.resources.XObject) : null;
        if (!xobjVal || xobjVal.t !== "dict") break;
        const rec = st.ctx.getObj(xobjVal.map[target]);
        if (!rec || !rec.stream || !rec.value || rec.value.t !== "dict") break;
        if (nameOf(rec.value.map.Subtype) !== "Form") break;
        const subResVal = rec.value.map.Resources ? st.ctx.resolve(rec.value.map.Resources) : null;
        const subRes = subResVal && subResVal.t === "dict" ? subResVal.map : st.resources;
        const fonts = await loadFonts(st.ctx, subRes);
        const data = await decodeStreamRec(rec, st.ctx);
        await runContent(latin1.decode(data), {
          ctx: st.ctx,
          resources: subRes,
          fonts,
          sink: st.sink,
          depth: st.depth + 1,
        });
        break;
      }

      default:
        break;
    }
  }

  async function extractPageText(ctx, page) {
    const resources = page.resources || null;
    const fonts = await loadFonts(ctx, resources);
    const sink = {
      text: "",
      lastX: 0,
      lastY: null,
      lastSize: 10,
      lastRun: null,
      runs: [],
    };

    const contentsVal = ctx.resolve(page.dict.map.Contents);
    const chunks = [];
    if (contentsVal && contentsVal.t === "arr") {
      for (const c of contentsVal.v) {
        const rec = ctx.getObj(c);
        if (rec) chunks.push(latin1.decode(await decodeStreamRec(rec, ctx)));
      }
    } else {
      const rec = ctx.getObj(page.dict.map.Contents);
      if (rec) chunks.push(latin1.decode(await decodeStreamRec(rec, ctx)));
    }

    if (chunks.length) {
      await runContent(chunks.join("\n"), {
        ctx,
        resources,
        fonts,
        sink,
        depth: 0,
      });
    }
    return sink.text;
  }

  function tidyText(s) {
    return String(s || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      // 图标字体的私有区字形（常见于装饰符号/分隔符）
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/[ \t\u3000]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ============================================================
  // 对外接口
  // ============================================================

  async function extractTextFromPdf(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!(u8.length > 8 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46)) {
      throw new Error("文件不是有效的 PDF 格式");
    }

    const str = latin1.decode(u8);
    if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(str)) {
      throw new Error("该 PDF 已加密，请先解除密码保护后再导入");
    }

    const ctx = createContext(u8, str);
    scanObjects(ctx);
    await expandObjectStreams(ctx);

    const pages = collectPages(ctx);
    if (!pages.length) throw new Error("PDF 中未找到页面内容");

    const parts = [];
    for (const page of pages) {
      try {
        const text = await extractPageText(ctx, page);
        if (text) parts.push(text);
      } catch (e) { /* 单页失败不影响其它页 */ }
    }

    const text = tidyText(parts.join("\n\n"));
    if (!text) {
      throw new Error("PDF 中未提取到文字（可能是扫描件或纯图片，请改用可复制文字的 PDF / Word）");
    }
    return text;
  }

  global.AF_PDF = {
    extractTextFromPdf,
    // 供调试/测试使用
    _decodeStreamRec: decodeStreamRec,
    _parseCMap: parseCMap,
    _internals: {
      latin1,
      createContext,
      scanObjects,
      expandObjectStreams,
      collectPages,
      decodeStreamRec,
      extractPageText,
      loadFonts,
      runContent,
      tidyText,
    },
  };
})(typeof window !== "undefined" ? window : self);
