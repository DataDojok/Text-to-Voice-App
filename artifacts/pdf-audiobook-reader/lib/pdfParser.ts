import { Platform } from 'react-native';
// Text extraction runs through expo-pdf-text-extract, a native module
// (PDFKit on iOS, PDFBox on Android). This replaces an earlier pdfjs-dist
// based implementation: PDF.js's bundled worker script triggers a genuine
// Hermes incompatibility ("Cannot read property 'prototype' of undefined",
// a class-extends-undefined pattern inside PDF.js's own webpack bundle) that
// crashes the app on load, independent of anything in this codebase. Native
// extraction also takes the file:// URI directly, so there is no need to
// read the file into a JS byte array at all.

export type SectionKind = 'chapter' | 'section' | 'reading';

export type ParsedSection = {
  title: string;
  text: string;
  kind: SectionKind;
  pageNumber: number;
};

export type ParsedBook = {
  title: string;
  author: string;
  language: string;
  wordCount: number;
  durationMinutes: number;
  sections: ParsedSection[];
};

export interface ParsedPDFText {
  text: string;
  pageCount: number;
  pages: string[];
}

const WORDS_PER_MINUTE = 150;
const PDF_EXTENSION = /\.pdf$/i;

function cleanText(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wordCount(text: string) {
  return text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length ?? 0;
}

function titleFromFilename(filename: string) {
  const withoutExtension = filename.replace(PDF_EXTENSION, '');
  const title = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return title || 'Untitled PDF';
}

function looksLikeHeading(line: string) {
  const normalized = line.replace(/\s+/g, ' ').trim();
  if (normalized.length < 2 || normalized.length > 120) return false;
  if (/^(chapter|chap\.|part|section|appendix|prologue|epilogue|introduction|preface)\b/i.test(normalized)) {
    return true;
  }
  const words = normalized.split(/\s+/);
  return words.length <= 8 && normalized === normalized.toUpperCase() && /[A-Z]/.test(normalized);
}

function headingKind(heading: string): SectionKind {
  return /^(chapter|chap\.|part|prologue|epilogue)\b/i.test(heading) ? 'chapter' : 'section';
}

/**
 * Extracts selectable text using expo-pdf-text-extract, a native module
 * (PDFKit on iOS, PDFBox on Android). Runs entirely in native code, so it
 * takes the file:// / content:// URI from Expo's document picker directly
 * — no manual byte-reading and no JS-side PDF parsing bundle involved.
 */
export async function parsePDFText(fileUri: string): Promise<ParsedPDFText> {
  if (Platform.OS === 'web') {
    // expo-pdf-text-extract is a native-only module (PDFKit/PDFBox), so it
    // has no web implementation. If web support is needed later, that would
    // require a separate browser-side PDF text extraction path.
    throw new Error('PDF import is not supported on web in this build.');
  }

  const pdfTextExtract = require('expo-pdf-text-extract') as typeof import('expo-pdf-text-extract');
  if (!pdfTextExtract.isAvailable()) {
    throw new Error(
      'PDF extraction is not available in this build. If you are running Expo Go, this feature needs a development build.',
    );
  }

  if (await pdfTextExtract.isPasswordProtected(fileUri)) {
    throw new Error('This PDF is password-protected. Remove the password and try importing it again.');
  }

  const pageCount = await pdfTextExtract.getPageCount(fileUri);
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const pageText = await pdfTextExtract.extractTextFromPage(fileUri, pageNumber);
    pages.push(cleanText(pageText));
  }

  return {
    text: cleanText(pages.filter(Boolean).join('\n\n')),
    pageCount,
    pages,
  };
}

export function isLikelyReadableText(text: string) {
  const normalized = cleanText(text);
  const words = wordCount(normalized);
  const letters = normalized.match(/[\p{L}]/gu)?.length ?? 0;
  return words >= 3 && letters >= 12 && letters / Math.max(1, normalized.length) >= 0.2;
}

export function detectDocumentLanguage(text: string): string {
  const normalized = ` ${text.toLocaleLowerCase()} `;
  const englishMarkers = [' the ', ' and ', ' of ', ' to ', ' in ', ' that ', ' with ', ' is '];
  const spanishMarkers = [' el ', ' la ', ' de ', ' y ', ' que ', ' en ', ' los ', ' las ', ' una ', ' con '];
  const score = (markers: string[]) => markers.reduce((total, marker) => total + (normalized.split(marker).length - 1), 0);
  const englishScore = score(englishMarkers);
  const spanishScore = score(spanishMarkers);
  if (englishScore === 0 && spanishScore === 0) return 'unknown';
  return spanishScore > englishScore ? 'es' : 'en';
}

export async function parsePdf(fileUri: string, filename: string): Promise<ParsedBook> {
  const parsed = await parsePDFText(fileUri);
  const text = cleanText(parsed.text);
  if (!isLikelyReadableText(text)) {
    throw new Error('This PDF does not contain selectable text. Try an OCR or text-based PDF.');
  }

  const sections: ParsedSection[] = parsed.pages
    .map((pageText, index) => {
      const lines = pageText.split('\n').map((line) => line.trim()).filter(Boolean);
      const headingIndex = lines.findIndex(looksLikeHeading);
      const heading = headingIndex >= 0 ? lines[headingIndex] : `Page ${index + 1}`;
      const body = cleanText((headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines).join('\n'));
      return {
        title: heading,
        text: body || pageText,
        kind: headingIndex >= 0 ? headingKind(heading) : 'reading',
        pageNumber: index + 1,
      };
    })
    .filter((section) => section.text.length > 0);

  const totalWords = wordCount(text);
  return {
    title: titleFromFilename(filename),
    author: 'Unknown author',
    language: detectDocumentLanguage(text),
    wordCount: totalWords,
    durationMinutes: Math.max(1, Math.ceil(totalWords / WORDS_PER_MINUTE)),
    sections: sections.length > 0
      ? sections
      : [{ title: 'Reading', text, kind: 'reading', pageNumber: 1 }],
  };
}
