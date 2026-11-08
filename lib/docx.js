import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, PageBreak } from 'docx';

function mdParagraphs(md) {
  const out = [];
  for (const rawLine of String(md || '').split(/\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { out.push(new Paragraph({ text: '' })); continue; }
    if (line.startsWith('### ')) out.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    else if (line.startsWith('## ')) out.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    else if (line.startsWith('# ')) out.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_2 }));
    else {
      // simple **bold** run support
      const runs = line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((seg) =>
        seg.startsWith('**') && seg.endsWith('**')
          ? new TextRun({ text: seg.slice(2, -2), bold: true })
          : new TextRun(seg)
      );
      out.push(new Paragraph({ children: runs, spacing: { after: 160 } }));
    }
  }
  return out;
}

export async function generateDocx(book) {
  const children = [];

  // Title page
  children.push(new Paragraph({ text: book.title || 'Untitled Book', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { before: 3200, after: 400 } }));
  if (book.author) children.push(new Paragraph({ text: book.author, alignment: AlignmentType.CENTER, spacing: { after: 200 } }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Contents
  children.push(new Paragraph({ text: 'Contents', heading: HeadingLevel.HEADING_1 }));
  book.chapters.forEach((c, i) => {
    children.push(new Paragraph({ text: `${i + 1}. ${c.title}`, spacing: { after: 80 } }));
  });
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // Preface
  if (book.preface) {
    children.push(new Paragraph({ text: 'Preface', heading: HeadingLevel.HEADING_1 }));
    children.push(...mdParagraphs(book.preface));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // Chapters
  book.chapters.forEach((c, i) => {
    children.push(new Paragraph({ text: `Chapter ${i + 1}: ${c.title}`, heading: HeadingLevel.HEADING_1 }));
    if (c.sourceVideo) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `Source message: https://www.youtube.com/watch?v=${c.sourceVideo}`, italics: true, size: 18, color: '666666' })],
        spacing: { after: 240 },
      }));
    }
    children.push(...mdParagraphs(c.body));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  });

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

export function slugify(s) {
  return String(s || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'book';
}
