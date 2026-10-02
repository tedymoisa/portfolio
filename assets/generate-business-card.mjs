// Generates the print version of the homepage business card (front + back)
// as Inkscape SVGs, then exports print-ready PDF/X-4 files: text converted to
// paths, colours converted to CMYK (FOGRA39, ISO coated) with Ghostscript.
//
//   node assets/generate-business-card.mjs
//
// Geometry is taken 1:1 from the site's CSS (desktop card, 420px wide) and
// scaled to an 85 × 55 mm trim, plus bleed. Requires the JetBrains Mono
// Regular + SemiBold fonts installed locally, Inkscape in /Applications and
// Ghostscript (`brew install ghostscript`).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/lib/database.ts";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const INKSCAPE = "/Applications/Inkscape.app/Contents/MacOS/inkscape";
const GHOSTSCRIPT = "gs";
// FOGRA39L Coated (ISO 12647-2, coated paper) — from TeX Live's colorprofiles
const ICC_PROFILE = join(OUT_DIR, "icc", "FOGRA39L_coated.icc");

// --- Print format -----------------------------------------------------------
const TRIM_W_MM = 85;
const TRIM_H_MM = 55;
const BLEED_MM = 1.5; // Vistaprint: 88 × 58 mm document for an 85 × 55 mm card

// 1 user unit = 1 CSS px of the 420px-wide desktop card
const W = 420;
const PX_PER_MM = W / TRIM_W_MM;
const H = TRIM_H_MM * PX_PER_MM;
const B = BLEED_MM * PX_PER_MM;

// --- Design tokens (src/styles/theme.css) -----------------------------------
const t = {
  cardFront: ["#2b2b2e", "#1c1c1e"],
  cardBack: ["#242426", "#19191b"],
  divider: "#c9a869",
  textPrimary: "#f7f1e1",
  textSecondary: "#c0b9ab",
  textMuted: "#79746a",
  accent: "#b39660",
  accentStrong: "#caa96a",
  border: "#b39660",
  borderOpacity: 0.32,
  font: "JetBrains Mono",
  tracking: 0.12, // em
};

// JetBrains Mono vertical metrics (hhea, per 1000 em) — what Chrome uses to
// place the baseline inside a line box.
const ASC = 1.02;
const DESC = 0.3;
const baseline = (top, lineHeight, size) =>
  top + (lineHeight - (ASC + DESC) * size) / 2 + ASC * size;

const f = (n) => +n.toFixed(3);
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// CSS linear-gradient(angle) mapped onto a box, as SVG userSpace coordinates
function cssGradient(angleDeg, x, y, w, h) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    x1: f(cx - (dx * len) / 2),
    y1: f(cy - (dy * len) / 2),
    x2: f(cx + (dx * len) / 2),
    y2: f(cy + (dy * len) / 2),
  };
}

function text({ x, y, size, fill, weight = 400, tracking = 0, content }) {
  return `<text x="${f(x)}" y="${f(y)}" xml:space="preserve" style="font-family:'${t.font}';font-weight:${weight};font-size:${size}px;letter-spacing:${f(tracking * size)}px;fill:${fill}">${esc(content)}</text>`;
}

const layer = (label, body, { hidden = false, locked = false } = {}) =>
  `<g inkscape:groupmode="layer" inkscape:label="${label}"${hidden ? ' style="display:none"' : ""}${locked ? ' sodipodi:insensitive="true"' : ""}>\n${body}\n</g>`;

// --- Colour helpers ---------------------------------------------------------
// The site uses semi-transparent golds over the card gradient. Transparency in
// a CMYK print file gets blended in CMYK space, which turns those golds grey,
// so every translucent colour is pre-composited here (in sRGB, like the
// browser) into an opaque one.
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) =>
  "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const mix = (top, alpha, under) =>
  hex(rgb(top).map((v, i) => v * alpha + rgb(under)[i] * (1 - alpha)));

// Shared pieces ---------------------------------------------------------------
// .card-face has a 1px border; the gradient is laid out on its padding box.
// Returns the background plus `paint(color, alpha)`, which composites a
// translucent colour over the card and returns an opaque gradient for it.
function background(id, [from, to]) {
  const g = cssGradient(135, 1, 1, W - 2, H - 2);
  const geometry = `gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}"`;
  const defs = [
    `<linearGradient id="${id}" ${geometry}>
  <stop offset="0" stop-color="${from}"/>
  <stop offset="0.6" stop-color="${to}"/>
</linearGradient>`,
  ];

  // Card colour at a point: project onto the gradient line (stops at 0 / 60%)
  const len2 = (g.x2 - g.x1) ** 2 + (g.y2 - g.y1) ** 2;
  const at = (x, y) => {
    const p = ((x - g.x1) * (g.x2 - g.x1) + (y - g.y1) * (g.y2 - g.y1)) / len2;
    const k = Math.min(Math.max(p / 0.6, 0), 1);
    return mix(to, k, from);
  };

  // Blending is linear, so compositing the two stops is exact everywhere
  let count = 0;
  const paint = (color, alpha) => {
    const paintId = `${id}-paint-${++count}`;
    defs.push(`<linearGradient id="${paintId}" ${geometry}>
  <stop offset="0" stop-color="${mix(color, alpha, from)}"/>
  <stop offset="0.6" stop-color="${mix(color, alpha, to)}"/>
</linearGradient>`);
    return `url(#${paintId})`;
  };

  // A horizontal fade from `alpha` to transparent over the card, sampled
  // along the line (the product of two gradients isn't linear)
  const fade = (color, alpha, x1, x2, y) => {
    const fadeId = `${id}-fade-${++count}`;
    const stops = Array.from({ length: 17 }, (_, i) => {
      const s = i / 16;
      const c = mix(color, alpha * (1 - s), at(x1 + (x2 - x1) * s, y));
      return `  <stop offset="${f(s)}" stop-color="${c}"/>`;
    });
    defs.push(
      `<linearGradient id="${fadeId}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="0" x2="${x2}" y2="0">\n${stops.join("\n")}\n</linearGradient>`,
    );
    return `url(#${fadeId})`;
  };

  return {
    defs: () => defs.join("\n"),
    paint,
    fade,
    body: `<rect id="bg" x="${f(-B)}" y="${f(-B)}" width="${f(W + 2 * B)}" height="${f(H + 2 * B)}" fill="url(#${id})"/>`,
  };
}

// .card-face border (1px, radius 10px) + inset highlight. Sits exactly on the
// cut line, so it's kept in a hidden layer: a 1mm cutting tolerance would make
// it uneven or cut it off.
const cardEdge = (bg) =>
  `<rect x="0.5" y="0.5" width="${W - 1}" height="${f(H - 1)}" rx="9.5" fill="none" stroke="${bg.paint(t.border, t.borderOpacity)}" stroke-width="1"/>
<rect x="1.5" y="1.5" width="${W - 3}" height="${f(H - 3)}" rx="8.5" fill="none" stroke="${bg.paint("#ffffff", 0.03)}" stroke-width="1"/>`;

// .card-inner-border::before — inset 12px inside the 1px card border, radius 6px
const innerBorder = (bg) =>
  `<rect x="13.5" y="13.5" width="${W - 27}" height="${f(H - 27)}" rx="5.5" fill="none" stroke="${bg.paint(t.border, t.borderOpacity)}" stroke-width="1"/>`;

const guides = `<rect x="0" y="0" width="${W}" height="${f(H)}" fill="none" stroke="#ff00ff" stroke-width="0.5"/>
<rect x="${f(3 * PX_PER_MM)}" y="${f(3 * PX_PER_MM)}" width="${f(W - 6 * PX_PER_MM)}" height="${f(H - 6 * PX_PER_MM)}" fill="none" stroke="#00ffff" stroke-width="0.5" stroke-dasharray="2 2"/>`;

function document(title, { defs, layers }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
     width="${TRIM_W_MM + 2 * BLEED_MM}mm" height="${TRIM_H_MM + 2 * BLEED_MM}mm"
     viewBox="${f(-B)} ${f(-B)} ${f(W + 2 * B)} ${f(H + 2 * B)}">
<title>${esc(title)}</title>
<sodipodi:namedview pagecolor="#ffffff" inkscape:document-units="mm"/>
<defs>
${defs}
</defs>
${layers.join("\n")}
</svg>
`;
}

// --- Front ------------------------------------------------------------------
function front() {
  const bg = background("card-front-gradient", t.cardFront);

  // Content box: 1px card border + 40px padding (--space-7)
  const left = 41;
  const right = W - 41;
  const top = 41;
  const bottom = H - 41;

  // .header: name (20px, lh 1) + gap 8px + eyebrow (8px, lh 1.25)
  const nameTop = top;
  const eyebrowTop = nameTop + 20 + 8;
  const headerBottom = eyebrowTop + 10;

  // .divider: 2px, margin 16px 0
  const dividerTop = headerBottom + 16;
  const contactsTop = dividerTop + 2 + 16;

  // .contact-row: label 8px/lh 1.25 + link 12px/lh 1.25, baseline-aligned.
  // Row height 15px, gap 8px. Link starts after a 2.8em label + 12px gap.
  const rowBaseline = baseline(0, 15, 12);
  const linkX = left + 2.8 * 8 + 12;
  const rows = [
    ["TEL", db.phone],
    ["MAIL", db.email],
    ["WEB", db.website],
  ]
    .map(([label, value], i) => {
      const y = contactsTop + i * (15 + 8) + rowBaseline;
      return [
        text({
          x: left,
          y,
          size: 8,
          fill: t.textMuted,
          tracking: t.tracking,
          content: label,
        }),
        text({ x: linkX, y, size: 12, fill: t.textSecondary, content: value }),
      ].join("\n");
    })
    .join("\n");

  // .footer: AWS badge on the left; print-only "Web & Cloud" tag on the right,
  // in the slot of the résumé button. The tag is outlined like the logo badge
  // on the back: 8px / lh 1.25 text, 4px 12px padding, 1px border → 20px tall.
  const footerHeight = 20;
  const footerTop = bottom - footerHeight;
  const footerMid = footerTop + footerHeight / 2;

  const aws = `<circle cx="${left + 2}" cy="${f(footerMid)}" r="2" fill="${t.accent}"/>
${text({ x: left + 4 + 8, y: baseline(footerMid - 4, 8, 8), size: 8, fill: t.accent, tracking: t.tracking, content: "AWS CERTIFIED" })}`;

  const tagLabel = "WEB & CLOUD";
  // monospace advance 0.6em + letter-spacing after every glyph (as in CSS)
  const tagTextWidth = tagLabel.length * (0.6 + t.tracking) * 8;
  const tagWidth = tagTextWidth + 2 * 12 + 2;
  const tagX = right - tagWidth;
  const tag = `<rect x="${f(tagX + 0.5)}" y="${f(footerTop + 0.5)}" width="${f(tagWidth - 1)}" height="${footerHeight - 1}" rx="3.5" fill="none" stroke="${bg.paint(t.border, t.borderOpacity)}" stroke-width="1"/>
${text({ x: tagX + 1 + 12, y: baseline(footerTop + 1 + 4, 10, 8), size: 8, fill: t.accentStrong, tracking: t.tracking, content: tagLabel })}`;

  const content = [
    text({
      x: left,
      y: baseline(nameTop, 20, 20),
      size: 20,
      weight: 600,
      tracking: -0.01,
      fill: t.textPrimary,
      content: `${db.name} ${db.surname}`,
    }),
    text({
      x: left,
      y: baseline(eyebrowTop, 10, 8),
      size: 8,
      fill: t.accent,
      tracking: t.tracking,
      content: db.profession.toUpperCase(),
    }),
    `<rect x="${left}" y="${dividerTop}" width="${right - left}" height="2" fill="${bg.fade(t.divider, 0.5, left, right, dividerTop + 1)}"/>`,
    rows,
    aws,
    tag,
  ].join("\n");

  // Layers first: building them registers the gradients that go into <defs>
  const layers = [
    layer("Sfondo", bg.body),
    layer("Bordo esterno (sul taglio)", cardEdge(bg), { hidden: true }),
    layer("Bordo interno", innerBorder(bg)),
    layer("Contenuto", content),
    layer("Guide (taglio / sicurezza)", guides, { hidden: true, locked: true }),
  ];

  return document(`${db.name} ${db.surname} — fronte`, {
    defs: bg.defs(),
    layers,
  });
}

// --- Back -------------------------------------------------------------------
function back() {
  const bg = background("card-back-gradient", t.cardBack);
  const cx = W / 2;
  const cy = H / 2;

  // .badge: 28px logo + 8px padding + 1px border = 46px, radius 4px
  const logo = `<g transform="translate(${f(cx - 14)} ${f(cy - 14)}) scale(0.28) translate(-1.5 0.5)">
  <g fill="none" stroke="${t.accentStrong}" stroke-width="10" stroke-linecap="butt" stroke-linejoin="round">
    <path d="M34 10V66A18 18 0 0 0 52 84H62"/>
    <path d="M16 34H62"/>
  </g>
  <circle cx="80" cy="80" r="7" fill="${t.accentStrong}"/>
</g>`;
  const badge = `<rect x="${f(cx - 22.5)}" y="${f(cy - 22.5)}" width="45" height="45" rx="3.5" fill="none" stroke="${bg.paint(t.border, t.borderOpacity)}" stroke-width="1"/>`;

  const layers = [
    layer("Sfondo", bg.body),
    layer("Bordo esterno (sul taglio)", cardEdge(bg), { hidden: true }),
    layer("Bordo interno", innerBorder(bg)),
    layer("Logo", `${badge}\n${logo}`),
    layer("Guide (taglio / sicurezza)", guides, { hidden: true, locked: true }),
  ];

  return document(`${db.name} ${db.surname} — retro`, {
    defs: bg.defs(),
    layers,
  });
}

// --- Write + export ---------------------------------------------------------
const PT_PER_MM = 72 / 25.4;
const pt = (mm) => f(mm * PT_PER_MM);

// Ghostscript PDF/X-4 definition: output intent with the embedded ICC
// profile, plus TrimBox/BleedBox so the printer knows where to cut. In PDF/X
// mode Ghostscript writes the page boxes itself, so they're set through its
// distiller params (offsets in pt: left, top, right, bottom).
function pdfxDefinition(title) {
  const b = pt(BLEED_MM);
  return `%!
<< /PDFXTrimBoxToMediaBoxOffset [${b} ${b} ${b} ${b}] /PDFXSetBleedBoxToMediaBox true >> setdistillerparams
[ /GTS_PDFXVersion (PDF/X-4) /Title (${title}) /Trapped /False /DOCINFO pdfmark
[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[{icc_PDFX} << /N 4 >> /PUT pdfmark
[{icc_PDFX} (${ICC_PROFILE}) (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[{OutputIntent_PDFX} <<
  /Type /OutputIntent
  /S /GTS_PDFX
  /OutputCondition (Offset printing, ISO 12647-2:2004/Amd 1, paper type 1 or 2, coated)
  /OutputConditionIdentifier (FOGRA39)
  /Info (FOGRA39L Coated)
  /RegistryName (http://www.color.org)
  /DestOutputProfile {icc_PDFX}
>> /PUT pdfmark
[{Catalog} << /OutputIntents [ {OutputIntent_PDFX} ] >> /PUT pdfmark
`;
}

const tmp = mkdtempSync(join(tmpdir(), "business-card-"));
try {
  for (const [side, svg] of [
    ["front", front()],
    ["back", back()],
  ]) {
    const svgPath = join(OUT_DIR, `business-card-${side}.svg`);
    const rgbPdf = join(tmp, `${side}-rgb.pdf`);
    const pdfxDef = join(tmp, `${side}-pdfx.ps`);
    writeFileSync(svgPath, svg);
    writeFileSync(
      pdfxDef,
      pdfxDefinition(`${db.name} ${db.surname} - business card ${side}`),
    );

    execFileSync(INKSCAPE, [
      svgPath,
      "--export-type=pdf",
      "--export-area-page",
      "--export-text-to-path",
      `--export-filename=${rgbPdf}`,
    ]);

    // RGB → CMYK, relative colorimetric (intent 1) with black point compensation
    execFileSync(GHOSTSCRIPT, [
      "-q",
      "-dPDFX=4",
      "-dBATCH",
      "-dNOPAUSE",
      "-dNOOUTERSAVE",
      "-sDEVICE=pdfwrite",
      "-sColorConversionStrategy=CMYK",
      `-sOutputICCProfile=${ICC_PROFILE}`,
      "-dRenderIntent=1",
      "-dBlackPtComp=1",
      `--permit-file-read=${ICC_PROFILE}`,
      `-sOutputFile=${join(OUT_DIR, `business-card-${side}.pdf`)}`,
      pdfxDef,
      rgbPdf,
    ]);
    console.log(`✓ business-card-${side}.svg / .pdf (PDF/X-4, CMYK)`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
