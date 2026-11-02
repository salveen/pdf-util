import { PDFDocument, type LoadOptions } from 'pdf-lib';

export const LOCKED_PDF_MESSAGE =
	"This PDF is locked with a password or against editing, so it can't be opened here. Open it in your PDF viewer, save or print a copy without the lock, and use that copy.";

export const NOT_A_PDF_MESSAGE =
	"This file isn't a readable PDF. It may be damaged, or another kind of file renamed to .pdf.";

/** `PDFDocument.load`, with pdf-lib's developer-facing errors swapped for ones people can act on. */
export async function openPdf(bytes: Uint8Array, options: LoadOptions = {}): Promise<PDFDocument> {
	// pdf-lib's error classes are compiled to ES5, where `instanceof` fails for subclasses of
	// Error, so encryption is checked on the loaded document and parse failures by wording.
	let doc: PDFDocument;
	try {
		doc = await PDFDocument.load(bytes, { ...options, ignoreEncryption: true });
	} catch (e) {
		if (e instanceof Error && e.message.startsWith('Failed to parse PDF document')) {
			throw new Error(NOT_A_PDF_MESSAGE, { cause: e });
		}
		throw e;
	}
	if (doc.isEncrypted) throw new Error(LOCKED_PDF_MESSAGE);
	return doc;
}

export async function mergePdfs(files: File[]): Promise<Uint8Array> {
	const merged = await PDFDocument.create();
	for (const file of files) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		// with several files, say which one failed
		const doc = await openPdf(bytes).catch((e: unknown) => {
			throw new Error(`${file.name}: ${e instanceof Error ? e.message : e}`, { cause: e });
		});
		const pages = await merged.copyPages(doc, doc.getPageIndices());
		for (const page of pages) {
			merged.addPage(page);
		}
	}
	return merged.save();
}

export async function getPageCount(file: File): Promise<number> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const doc = await openPdf(bytes);
	return doc.getPageCount();
}

export async function splitByRange(
	file: File,
	start: number,
	end: number
): Promise<Uint8Array> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const src = await openPdf(bytes);
	const count = src.getPageCount();
	// a reversed or out-of-range span would otherwise make an empty PDF
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > count || start > end) {
		throw new Error(`Pick pages between 1 and ${count}, with the start page no later than the end page.`);
	}
	const out = await PDFDocument.create();
	// pages are 0-indexed in pdf-lib, user provides 1-indexed
	const indices = [];
	for (let i = start - 1; i < end; i++) {
		indices.push(i);
	}
	const pages = await out.copyPages(src, indices);
	for (const p of pages) out.addPage(p);
	return out.save();
}

export async function extractPages(
	file: File,
	pageNumbers: number[]
): Promise<Uint8Array> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	const src = await openPdf(bytes);
	const out = await PDFDocument.create();
	const indices = pageNumbers.map((p) => p - 1).filter((i) => i >= 0 && i < src.getPageCount());
	const pages = await out.copyPages(src, indices);
	for (const p of pages) out.addPage(p);
	return out.save();
}

export async function splitEveryN(
	file: File,
	n: number
): Promise<{ name: string; data: Uint8Array }[]> {
	// an empty, zero or negative step would never reach the last page and freeze the tab
	if (!Number.isInteger(n) || n < 1) throw new Error('Pages per file must be a whole number, 1 or more.');
	const bytes = new Uint8Array(await file.arrayBuffer());
	const src = await openPdf(bytes);
	const total = src.getPageCount();
	const results: { name: string; data: Uint8Array }[] = [];
	const baseName = file.name.replace(/\.pdf$/i, '');

	for (let start = 0; start < total; start += n) {
		const end = Math.min(start + n, total);
		const out = await PDFDocument.create();
		const indices = [];
		for (let i = start; i < end; i++) indices.push(i);
		const pages = await out.copyPages(src, indices);
		for (const p of pages) out.addPage(p);
		const part = Math.floor(start / n) + 1;
		results.push({
			name: `${baseName}_part${part}.pdf`,
			data: await out.save()
		});
	}
	return results;
}

export function parsePageInput(input: string, maxPage: number): number[] {
	const pages: number[] = [];
	const invalid = new Set<number>();
	const parts = input.replace(/\s/g, '').split(',').filter(Boolean);
	if (!parts.length) throw new Error('Enter the pages to extract, for example 1, 3, 5-7.');
	for (const part of parts) {
		// "5" is one page, "5-7" a range, and "5-" runs to the last page
		const match = /^(\d+)(-(\d*))?$/.exec(part);
		if (!match) throw new Error(`"${part}" isn't a page number or a range like 5-7.`);
		const a = Number(match[1]);
		const b = match[2] === undefined ? a : match[3] ? Number(match[3]) : maxPage;
		// check the ends before expanding, so "1-99999999" can't build a huge list
		const outside = [a, b].filter((p) => p < 1 || p > maxPage);
		for (const p of outside) invalid.add(p);
		if (outside.length) continue;
		for (let i = Math.min(a, b); i <= Math.max(a, b); i++) pages.push(i);
	}
	if (invalid.size) {
		const list = [...invalid].sort((a, b) => a - b).join(', ');
		throw new Error(`Invalid pages: ${list}. Document has ${maxPage} pages.`);
	}
	const unique = [...new Set(pages)].sort((a, b) => a - b);
	return unique;
}

export function downloadBlob(data: Uint8Array, filename: string) {
	const blob = new Blob([data as BlobPart], { type: 'application/pdf' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function downloadZip(
	_files: { name: string; data: Uint8Array }[],
	_zipName: string
) {
	// Minimal ZIP implementation — we avoid a dep for this.
	// Each file as a separate download instead.
	for (const f of _files) {
		downloadBlob(f.data, f.name);
	}
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	// round first, so 1023.97 KB shows as 1.0 MB rather than 1024.0 KB
	const kb = Math.round((bytes / 1024) * 10) / 10;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
