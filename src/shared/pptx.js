'use strict';
/**
 * A minimal, dependency-free **PPTX writer**.
 *
 * The Slides surface has to produce a deck that opens in PowerPoint, Keynote
 * and Google Slides, and that the user can keep editing afterwards (the
 * docs: the `.pptx` is "fully editable"). That means real Open XML — not a
 * PDF with a `.pptx` extension.
 *
 * A `.pptx` is a ZIP of XML parts. This module writes the smallest
 * structurally complete set of them:
 *
 *   [Content_Types].xml · _rels/.rels · docProps/*
 *   ppt/presentation.xml (+rels) · ppt/theme/theme1.xml
 *   ppt/slideMasters/slideMaster1.xml (+rels)
 *   ppt/slideLayouts/slideLayout1.xml (+rels)
 *   ppt/slides/slideN.xml (+rels)
 *   ppt/notesMasters/notesMaster1.xml (+rels)
 *   ppt/notesSlides/notesSlideN.xml (+rels)
 *
 * One blank layout is used for every slide and each slide carries its own
 * shapes, which keeps the writer small while still producing a deck whose
 * text is fully editable — which is the part users actually care about.
 *
 * The ZIP itself comes from `shared/zip.js`.
 */
const { buildZip } = require('./zip');

/* ------------------------------------------------------------------ units */

const EMU_PER_INCH = 914400;
const EMU_PER_POINT = 12700;
/** 16:9 at 13.333in x 7.5in — the default modern slide size. */
const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;

const pt = (points) => Math.round(points * EMU_PER_POINT);
const inches = (value) => Math.round(value * EMU_PER_INCH);

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/* ------------------------------------------------------------------- theme */

const DEFAULT_FONT = 'Calibri';
const DEFAULT_FONT_HEADING = 'Calibri Light';

/** A theme part with the given colour scheme and fonts. */
function themeXml({ fontScheme = DEFAULT_FONT, headingFont = DEFAULT_FONT_HEADING } = {}) {
  const solidFill = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`;
  const fillStyles = `
    <a:fillStyleLst>
      <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      <a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill>
      <a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>
    </a:fillStyleLst>`;
  const lineStyles = `
    <a:lnStyleLst>
      <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr">${solidFill}<a:prstDash val="solid"/></a:ln>
      <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">${solidFill}<a:prstDash val="solid"/></a:ln>
      <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr">${solidFill}<a:prstDash val="solid"/></a:ln>
    </a:lnStyleLst>`;
  const effectStyles = `
    <a:effectStyleLst>
      <a:effectStyle><a:effectLst/></a:effectStyle>
      <a:effectStyle><a:effectLst/></a:effectStyle>
      <a:effectStyle><a:effectLst/></a:effectStyle>
    </a:effectStyleLst>`;
  const bgStyles = `
    <a:bgFillStyleLst>
      <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>
      <a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill>
    </a:bgFillStyleLst>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Quansiox">
  <a:themeElements>
    <a:clrScheme name="Quansiox">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1B2030"/></a:dk2>
      <a:lt2><a:srgbClr val="F5F6F8"/></a:lt2>
      <a:accent1><a:srgbClr val="5B8DEF"/></a:accent1>
      <a:accent2><a:srgbClr val="48B884"/></a:accent2>
      <a:accent3><a:srgbClr val="E8A33D"/></a:accent3>
      <a:accent4><a:srgbClr val="D9646E"/></a:accent4>
      <a:accent5><a:srgbClr val="9B7EDE"/></a:accent5>
      <a:accent6><a:srgbClr val="38B6C8"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Quansiox">
      <a:majorFont><a:latin typeface="${escapeXml(headingFont)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="${escapeXml(fontScheme)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Quansiox">
      ${fillStyles}
      ${lineStyles}
      ${effectStyles}
      ${bgStyles}
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;
}

/* ------------------------------------------------------------------ shapes */

/**
 * One text box.
 *
 * @param {object} spec
 * @param {number} spec.id       shape id (unique per slide)
 * @param {number} spec.x        left, in inches
 * @param {number} spec.y        top, in inches
 * @param {number} spec.w        width, in inches
 * @param {number} spec.h        height, in inches
 * @param {Array}  spec.paragraphs  [{ text, size, bold, italic, color, bullet, align, spacing }]
 */
function textBoxXml(spec) {
  const {
    id, x, y, w, h, paragraphs = [], fill = null, line = null, anchor = 't', rotate = 0,
  } = spec;
  const shapeFill = fill
    ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`
    : '<a:noFill/>';
  const lineXml = line
    ? `<a:ln w="${pt(1)}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  const body = paragraphs.map((p) => {
    const size = Math.max(100, Math.round((p.size ?? 18) * 100));
    const align = p.align ? ` algn="${p.align}"` : '';
    const bullet = p.bullet
      ? `<a:buFont typeface="Arial"/><a:buChar char="${escapeXml(p.bullet)}"/>`
      : '<a:buNone/>';
    const margin = p.bullet ? ' marL="285750" indent="-285750"' : '';
    const spacing = p.spacing ? `<a:spcBef><a:spcPts val="${Math.round(p.spacing * 100)}"/></a:spcBef>` : '';
    // A paragraph without explicit runs is one run that inherits the
    // paragraph's own formatting — otherwise the size, weight and colour
    // would silently fall back to the defaults.
    const runs = (Array.isArray(p.runs) && p.runs.length ? p.runs : [{
      text: p.text ?? '',
      size: p.size,
      bold: p.bold,
      italic: p.italic,
      color: p.color,
      font: p.font,
    }])
      .map((run) => {
        // Attributes and child elements have to be kept apart: mixing them
        // puts `<a:solidFill>` inside the start tag and the part stops being
        // valid XML.
        const attributes = [];
        if (run.bold) attributes.push('b="1"');
        if (run.italic) attributes.push('i="1"');
        if (run.underline) attributes.push('u="sng"');
        if (run.size) attributes.push(`sz="${Math.round(run.size * 100)}"`);
        // The child order matters: the fill comes before the typeface.
        const children = [];
        if (run.color) children.push(`<a:solidFill><a:srgbClr val="${run.color}"/></a:solidFill>`);
        children.push(`<a:latin typeface="${escapeXml(run.font ?? DEFAULT_FONT)}"/>`);
        return `<a:r><a:rPr lang="en-US"${attributes.length ? ` ${attributes.join(' ')}` : ''}>${children.join('')}</a:rPr>`
          + `<a:t>${escapeXml(run.text ?? '')}</a:t></a:r>`;
      }).join('');
    return `<a:p><a:pPr${margin}${align}>${spacing}${bullet}</a:pPr>${runs}</a:p>`;
  }).join('');

  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr>
    <a:xfrm${rotate ? ` rot="${Math.round(rotate * 60000)}"` : ''}>
      <a:off x="${inches(x)}" y="${inches(y)}"/><a:ext cx="${inches(w)}" cy="${inches(h)}"/>
    </a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    ${shapeFill}
    ${lineXml}
  </p:spPr>
  <p:txBody>
    <a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr>
    <a:lstStyle/>
    ${body}
  </p:txBody>
</p:sp>`;
}

/** A rectangle (used for the accent bar and the background). */
function rectXml(spec) {
  const { id, x, y, w, h, fill, line = null, radius = false } = spec;
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="${inches(x)}" y="${inches(y)}"/><a:ext cx="${inches(w)}" cy="${inches(h)}"/></a:xfrm>
    <a:prstGeom prst="${radius ? 'roundRect' : 'rect'}"><a:avLst/></a:prstGeom>
    <a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>
    ${line ? `<a:ln w="${pt(1)}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>'}
  </p:spPr>
  <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
</p:sp>`;
}

/** A picture shape (for a generated chart or a reference image). */
function pictureXml(spec) {
  const { id, name, x, y, w, h, relId } = spec;
  return `<p:pic>
  <p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
  <p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
  <p:spPr><a:xfrm><a:off x="${inches(x)}" y="${inches(y)}"/><a:ext cx="${inches(w)}" cy="${inches(h)}"/></a:xfrm>
  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>`;
}

/* ------------------------------------------------------------------ slides */

const EMPTY_TREE = `<p:spTree>
  <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
  <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>`;

/** The shape tree with extra shapes appended, as one well-formed element. */
function spTree(shapes = '') {
  return `${EMPTY_TREE.replace('</p:spTree>', '')}${shapes}</p:spTree>`;
}

function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>${spTree(shapes.join(''))}</p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function notesSlideXml(text) {
  const body = String(text ?? '')
    .split('\n')
    .filter((line) => line.trim().length)
    .map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
    .join('') || '<a:p/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:notes>`;
}

/* -------------------------------------------------------------- the writer */

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * Write a PPTX.
 *
 * @param {object} deck
 * @param {string} deck.title
 * @param {Array}  deck.slides   [{ layout, title, bullets, notes, shapes? }]
 * @param {object} deck.theme    { background, foreground, accent, headingFont, bodyFont }
 * @param {Array}  deck.images   [{ name, data }] — media parts
 * @returns {Buffer} the .pptx bytes
 */
function buildPptx(deck = {}) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const theme = deck.theme ?? {};
  const images = Array.isArray(deck.images) ? deck.images : [];
  const entries = [];
  const add = (name, data) => entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8') });

  /* -- media ---------------------------------------------------------- */
  const imageIds = new Map();
  images.forEach((image, index) => {
    const extension = (image.name.split('.').pop() || 'png').toLowerCase();
    const partName = `ppt/media/image${index + 1}.${extension}`;
    add(partName, image.data);
    imageIds.set(image.name, { partName, extension });
  });

  /* -- content types --------------------------------------------------- */
  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];
  slides.forEach((_, index) => {
    overrides.push(`<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    if (slides[index]?.notes) {
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`);
    }
  });
  for (const image of images) {
    const extension = image.extension;
    overrides.push(`<Default Extension="${extension}" ContentType="image/${extension === 'jpg' ? 'jpeg' : extension}"/>`);
  }
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${overrides.join('\n  ')}
</Types>`);

  /* -- package rels ---------------------------------------------------- */
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${OFFICE_REL}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

  /* -- docProps -------------------------------------------------------- */
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  add('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(deck.title ?? 'Presentation')}</dc:title>
  <dc:creator>${escapeXml(deck.author ?? 'Quansiox')}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(deck.author ?? 'Quansiox')}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`);
  add('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Quansiox</Application>
  <Slides>${slides.length}</Slides>
  <Company></Company>
</Properties>`);

  /* -- theme ----------------------------------------------------------- */
  add('ppt/theme/theme1.xml', themeXml({
    fontScheme: theme.bodyFont ?? DEFAULT_FONT,
    headingFont: theme.headingFont ?? DEFAULT_FONT_HEADING,
  }));

  /* -- slide master + layout ------------------------------------------ */
  add('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="${escapeXml(theme.background ?? 'FFFFFF')}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    ${spTree()}
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`);
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="${OFFICE_REL}/theme" Target="../theme/theme1.xml"/>
</Relationships>`);
  add('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank">
    ${spTree()}
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`);
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`);

  /* -- notes master ---------------------------------------------------- */
  add('ppt/notesMasters/notesMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    ${spTree()}
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
</p:notesMaster>`);
  add('ppt/notesMasters/_rels/notesMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL}/theme" Target="../theme/theme1.xml"/>
</Relationships>`);

  /* -- slides ---------------------------------------------------------- */
  slides.forEach((slide, index) => {
    const shapes = Array.isArray(slide.shapes) && slide.shapes.length ? slide.shapes : buildSlideShapes(slide, theme);
    add(`ppt/slides/slide${index + 1}.xml`, slideXml(shapes));
    const slideRels = [
      `<Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    (slide.images ?? []).forEach((imageName, imageIndex) => {
      const info = imageIds.get(imageName);
      if (!info) return;
      const relId = `rId${2 + imageIndex}`;
      slideRels.push(`<Relationship Id="${relId}" Type="${OFFICE_REL}/image" Target="../media/${info.partName.split('/').pop()}"/>`);
    });
    if (slide.notes) {
      slideRels.push(`<Relationship Id="rId${2 + (slide.images ?? []).length}" Type="${OFFICE_REL}/notesSlide" Target="../notesSlides/notesSlide${index + 1}.xml"/>`);
      add(`ppt/notesSlides/notesSlide${index + 1}.xml`, notesSlideXml(slide.notes));
      add(`ppt/notesSlides/_rels/notesSlide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId1" Type="${OFFICE_REL}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
  <Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="../slides/slide${index + 1}.xml"/>
</Relationships>`);
    }
    add(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  ${slideRels.join('\n  ')}
</Relationships>`);
  });

  /* -- presentation ---------------------------------------------------- */
  const presentationRels = [
    `<Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
  ];
  const slideIds = [];
  slides.forEach((_, index) => {
    const relId = `rId${index + 2}`;
    presentationRels.push(`<Relationship Id="${relId}" Type="${OFFICE_REL}/slide" Target="slides/slide${index + 1}.xml"/>`);
    slideIds.push(`<p:sldId id="${256 + index}" r:id="${relId}"/>`);
  });
  const notesMasterRelId = `rId${slides.length + 2}`;
  presentationRels.push(`<Relationship Id="${notesMasterRelId}" Type="${OFFICE_REL}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`);
  const themeRelId = `rId${slides.length + 3}`;
  presentationRels.push(`<Relationship Id="${themeRelId}" Type="${OFFICE_REL}/theme" Target="theme/theme1.xml"/>`);

  add('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRelId}"/></p:notesMasterIdLst>
  <p:sldIdLst>${slideIds.join('')}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`);
  add('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  ${presentationRels.join('\n  ')}
</Relationships>`);

  return buildZip(entries);
}

/* ------------------------------------------------------------ slide shapes */

/**
 * Turn a slide model into shapes. The layouts follow the docs' "visual
 * hierarchy": a title slide is big and sparse, a bullet slide has a title
 * band and a body column, a chart slide leaves room for the visual.
 */
function buildSlideShapes(slide, theme) {
  const bg = theme.background ?? 'FFFFFF';
  const fg = theme.foreground ?? '1B2030';
  const accent = theme.accent ?? '5B8DEF';
  const shapes = [];
  let shapeId = 2;

  // The background.
  shapes.push(rectXml({ id: shapeId++, x: 0, y: 0, w: 13.333, h: 7.5, fill: bg }));
  const layout = slide.layout ?? 'bullets';

  if (layout === 'title') {
    shapes.push(rectXml({ id: shapeId++, x: 0.9, y: 2.5, w: 1.4, h: 0.09, fill: accent }));
    shapes.push(textBoxXml({
      id: shapeId++, x: 0.9, y: 2.8, w: 11.5, h: 1.6,
      paragraphs: [{ text: slide.title ?? '', size: 44, bold: true, color: fg }],
    }));
    if (slide.subtitle) {
      shapes.push(textBoxXml({
        id: shapeId++, x: 0.9, y: 4.4, w: 10.5, h: 0.9,
        paragraphs: [{ text: slide.subtitle, size: 20, color: accent }],
      }));
    }
    return shapes;
  }

  if (layout === 'section') {
    shapes.push(textBoxXml({
      id: shapeId++, x: 0.9, y: 2.9, w: 11.5, h: 1.2,
      paragraphs: [{ text: slide.title ?? '', size: 36, bold: true, color: accent }],
    }));
    return shapes;
  }

  if (layout === 'quote') {
    shapes.push(textBoxXml({
      id: shapeId++, x: 1.4, y: 2.4, w: 10.5, h: 2.2,
      paragraphs: [{ text: `“${slide.quote ?? slide.title ?? ''}”`, size: 30, italic: true, color: fg }],
    }));
    if (slide.attribution) {
      shapes.push(textBoxXml({
        id: shapeId++, x: 1.4, y: 4.7, w: 10, h: 0.6,
        paragraphs: [{ text: `— ${slide.attribution}`, size: 16, color: accent }],
      }));
    }
    return shapes;
  }

  if (layout === 'chart') {
    shapes.push(textBoxXml({
      id: shapeId++, x: 0.9, y: 0.5, w: 11.5, h: 0.9,
      paragraphs: [{ text: slide.title ?? '', size: 28, bold: true, color: fg }],
    }));
    // The visual itself is a picture, added by the caller when there is one.
    if (slide.chartTitle) {
      shapes.push(textBoxXml({
        id: shapeId++, x: 0.9, y: 5.9, w: 11.5, h: 0.6,
        paragraphs: [{ text: slide.chartTitle, size: 14, color: accent }],
      }));
    }
    return shapes;
  }

  if (layout === 'closing') {
    shapes.push(textBoxXml({
      id: shapeId++, x: 0.9, y: 3.1, w: 11.5, h: 1.4,
      paragraphs: [{ text: slide.title ?? '', size: 34, bold: true, color: fg }],
    }));
    if (slide.subtitle) {
      shapes.push(textBoxXml({
        id: shapeId++, x: 0.9, y: 4.5, w: 11.5, h: 0.8,
        paragraphs: [{ text: slide.subtitle, size: 18, color: accent }],
      }));
    }
    return shapes;
  }

  // 'bullets' / 'two-column' — a title band and a body column.
  shapes.push(rectXml({ id: shapeId++, x: 0, y: 0, w: 13.333, h: 0.16, fill: accent }));
  shapes.push(textBoxXml({
    id: shapeId++, x: 0.9, y: 0.55, w: 11.6, h: 1.0,
    paragraphs: [{ text: slide.title ?? '', size: 28, bold: true, color: fg }],
  }));
  if (slide.subtitle) {
    shapes.push(textBoxXml({
      id: shapeId++, x: 0.9, y: 1.45, w: 11.6, h: 0.6,
      paragraphs: [{ text: slide.subtitle, size: 15, color: accent }],
    }));
  }
  const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
  const columnWidth = layout === 'two-column' ? 5.4 : 11.6;
  const columnX = layout === 'two-column' ? 0.9 : 0.9;
  const rightX = 6.9;
  bullets.forEach((bullet, index) => {
    const inRight = layout === 'two-column' && index % 2 === 1;
    const x = inRight ? rightX : columnX;
    const y = 2.3 + Math.floor(index / (layout === 'two-column' ? 1 : 1)) * 0.75;
    if (y > 6.3) return;
    shapes.push(textBoxXml({
      id: shapeId++, x, y, w: columnWidth, h: 0.7,
      paragraphs: [{ text: String(bullet), size: 17, color: fg, bullet: '•' }],
    }));
  });
  return shapes;
}

module.exports = {
  buildPptx,
  spTree,
  buildSlideShapes,
  themeXml,
  textBoxXml,
  rectXml,
  pictureXml,
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
};
