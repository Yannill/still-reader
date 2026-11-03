/* pdfsave.js —— 标注 ⇄ PDF 标准注释
 *  导出：用 pdf-lib 写入标准 /Highlight、/Underline 注释（含 QuadPoints、颜色、评论 /Contents、外观流 /AP），
 *        Acrobat、macOS 预览、Chrome/Edge、WPS、福昕等阅读器都能看到。
 *  导入：用 pdf.js 读取 PDF 里已有的高亮/下划线注释，转成可继续编辑的标注。
 *  防重复：保存前先删掉 PDF 中旧的高亮/下划线（它们已被导入到编辑器里），再整体写回。
 */
'use strict';
R.pdfsave = (() => {
  const MARKUP = { 9: 'highlight', 10: 'underline', 11: 'underline', 12: 'underline' }; // pdf.js AnnotationType

  /** 从 pdf.js 读取已有注释 */
  async function importFromPdf(pages) {
    const list = [];
    for (const p of pages) {
      let annots = [];
      try { annots = await p.page.getAnnotations({ intent: 'display' }); } catch { continue; }
      for (const a of annots) {
        const type = MARKUP[a.annotationType];
        if (!type) continue;
        const quads = normalizeQuads(a.quadPoints, a.rect);
        const rects = quads.map((q) => {
          const pts = q.map((pt) => p.vp1.convertToViewportPoint(pt.x, pt.y));
          const xs = pts.map((v) => v[0]), ys = pts.map((v) => v[1]);
          const x = Math.min(...xs), y = Math.min(...ys);
          return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
        }).filter((r) => r.w > 0.5 && r.h > 0.5);
        if (!rects.length) continue;
        const c = a.color ? R.rgbToHex(a.color[0], a.color[1], a.color[2]) : '#ffd54f';
        const comment = (a.contentsObj && a.contentsObj.str) || a.contents || '';
        list.push({
          id: R.uid('n'), page: p.i, type, color: c, rects, comment,
          text: '', created: Date.now(), imported: true,
        });
      }
    }
    return list;
  }

  // pdf.js 3.x: [[{x,y}×4], ...]；4.x: Float32Array 扁平数组
  function normalizeQuads(qp, rect) {
    if (!qp || !qp.length) {
      if (!rect) return [];
      const [x1, y1, x2, y2] = rect;
      return [[{ x: x1, y: y2 }, { x: x2, y: y2 }, { x: x1, y: y1 }, { x: x2, y: y1 }]];
    }
    if (Array.isArray(qp[0])) return qp;
    const out = [];
    for (let i = 0; i + 7 < qp.length; i += 8) {
      out.push([{ x: qp[i], y: qp[i + 1] }, { x: qp[i + 2], y: qp[i + 3] }, { x: qp[i + 4], y: qp[i + 5] }, { x: qp[i + 6], y: qp[i + 7] }]);
    }
    return out;
  }

  const f = (n) => (Math.round(n * 100) / 100).toString();

  /** 写出带标注的新 PDF（Uint8Array） */
  async function exportPdf(originalBytes, annotations, pages) {
    const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFHexString, PDFString } = PDFLib;
    const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true, updateMetadata: false });
    const ctx = doc.context;
    const pdfPages = doc.getPages();
    const REMOVE = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut'].map((n) => PDFName.of(n)));
    const POPUP = PDFName.of('Popup');

    // 1) 清除旧的高亮/下划线（及其弹出框），避免重复
    for (const page of pdfPages) {
      const annots = page.node.Annots();
      if (!(annots instanceof PDFArray)) continue;
      const removed = new Set();
      for (let i = annots.size() - 1; i >= 0; i--) {
        const ref = annots.get(i);
        const dict = ctx.lookupMaybe(ref, PDFDict);
        if (!dict) continue;
        if (REMOVE.has(dict.get(PDFName.of('Subtype')))) {
          if (ref instanceof PDFRef) removed.add(ref.toString());
          annots.remove(i);
        }
      }
      for (let i = annots.size() - 1; i >= 0; i--) {
        const dict = ctx.lookupMaybe(annots.get(i), PDFDict);
        if (!dict || dict.get(PDFName.of('Subtype')) !== POPUP) continue;
        const parent = dict.get(PDFName.of('Parent'));
        if (parent && removed.has(parent.toString())) annots.remove(i);
      }
    }

    // 2) 写入当前所有标注
    const now = pdfDate(new Date());
    for (const a of annotations) {
      const page = pdfPages[a.page];
      const vp1 = pages[a.page] && pages[a.page].vp1;
      if (!page || !vp1 || !a.rects.length) continue;
      const quads = [];
      const allPts = [];
      for (const r of a.rects) {
        const tl = vp1.convertToPdfPoint(r.x, r.y);
        const tr = vp1.convertToPdfPoint(r.x + r.w, r.y);
        const bl = vp1.convertToPdfPoint(r.x, r.y + r.h);
        const br = vp1.convertToPdfPoint(r.x + r.w, r.y + r.h);
        quads.push([tl, tr, bl, br]);
        allPts.push(tl, tr, bl, br);
      }
      const xs = allPts.map((p) => p[0]), ys = allPts.map((p) => p[1]);
      const rect = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
      const [r, g, b] = R.hexToRgb(a.color).map((v) => v / 255);
      const isHi = a.type !== 'underline';

      // 外观流：保证所有阅读器绘制一致
      let ops = '';
      if (isHi) {
        ops = `/GS0 gs ${f(r)} ${f(g)} ${f(b)} rg\n`;
        for (const [tl, tr, bl, br] of quads) {
          ops += `${f(tl[0])} ${f(tl[1])} m ${f(tr[0])} ${f(tr[1])} l ${f(br[0])} ${f(br[1])} l ${f(bl[0])} ${f(bl[1])} l h f\n`;
        }
      } else {
        ops = `${f(r)} ${f(g)} ${f(b)} RG\n`;
        for (const [tl, tr, bl, br] of quads) {
          const hgt = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
          const t = 0.07;
          const p0 = [bl[0] + (tl[0] - bl[0]) * t, bl[1] + (tl[1] - bl[1]) * t];
          const p1 = [br[0] + (tr[0] - br[0]) * t, br[1] + (tr[1] - br[1]) * t];
          ops += `${f(Math.max(0.8, hgt * 0.07))} w ${f(p0[0])} ${f(p0[1])} m ${f(p1[0])} ${f(p1[1])} l S\n`;
        }
      }
      const ap = ctx.stream(ops, {
        Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect,
        Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: 0.45, ca: 0.45, BM: 'Multiply' } } },
      });
      const apRef = ctx.register(ap);

      const qp = [];
      quads.forEach((q) => q.forEach((pt) => qp.push(pt[0], pt[1])));
      const fields = {
        Type: 'Annot',
        Subtype: isHi ? 'Highlight' : 'Underline',
        Rect: rect,
        QuadPoints: qp,
        C: [r, g, b],
        CA: isHi ? 0.45 : 1,
        F: 4,
        T: PDFHexString.fromText('ADHD Reader'),
        NM: PDFString.of(a.id),
        M: PDFString.of(now),
        AP: { N: apRef },
      };
      if (a.comment) {
        fields.Contents = PDFHexString.fromText(a.comment);
        fields.Subj = PDFHexString.fromText('评论');
      }
      const annotRef = ctx.register(ctx.obj(fields));
      page.node.addAnnot(annotRef);
    }
    return doc.save();
  }

  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  return { importFromPdf, exportPdf };
})();
