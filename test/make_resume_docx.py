# -*- coding: utf-8 -*-
"""把 test/resume.txt 转换成 test/resume.docx（用于测试扩展的 Word 读取能力）。

用法：
    cd test
    python make_resume_docx.py
"""

import os
import zipfile
from xml.sax.saxutils import escape

BASE = os.path.dirname(os.path.abspath(__file__))
TXT = os.path.join(BASE, "resume.txt")
DOCX = os.path.join(BASE, "resume.docx")

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>"""

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def build_document(lines):
    paras = []
    for line in lines:
        text = escape(line)
        if not text.strip():
            paras.append("<w:p/>")
        else:
            paras.append(
                '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % text
            )
    body = "".join(paras)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="%s"><w:body>%s</w:body></w:document>' % (W_NS, body)
    )


def main():
    with open(TXT, "r", encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f]

    with zipfile.ZipFile(DOCX, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/_rels/document.xml.rels", DOC_RELS)
        z.writestr("word/document.xml", build_document(lines))

    print("已生成:", DOCX)


if __name__ == "__main__":
    main()
