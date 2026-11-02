import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
	NOT_A_PDF_MESSAGE,
	extractPages,
	formatSize,
	mergePdfs,
	openPdf,
	parsePageInput,
	splitByRange,
	splitEveryN
} from './pdf';

async function pdfFile(pages: number, fileName = 'doc.pdf'): Promise<File> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pages; i++) doc.addPage([100 + i, 100]); // page i is 100+i wide
	return new File([(await doc.save()) as BlobPart], fileName);
}

const widths = async (bytes: Uint8Array) =>
	(await PDFDocument.load(bytes)).getPages().map((page) => page.getWidth() - 100);

describe('parsePageInput', () => {
	test('reads pages, ranges and ranges to the end', () => {
		assert.deepEqual(parsePageInput('1, 3, 5-7', 10), [1, 3, 5, 6, 7]);
		assert.deepEqual(parsePageInput('7-5', 10), [5, 6, 7]);
		assert.deepEqual(parsePageInput('8-', 10), [8, 9, 10]);
		assert.deepEqual(parsePageInput('2,2, 1-2', 10), [1, 2]);
	});

	test('explains input it cannot use', () => {
		assert.throws(() => parsePageInput('', 10), /Enter the pages/);
		assert.throws(() => parsePageInput(' , ', 10), /Enter the pages/);
		assert.throws(() => parsePageInput('a', 10), /"a" isn't a page number/);
		assert.throws(() => parsePageInput('-3', 10), /"-3" isn't a page number/);
		assert.throws(() => parsePageInput('0', 10), /Invalid pages: 0\. Document has 10 pages/);
		assert.throws(() => parsePageInput('3, 12', 10), /Invalid pages: 12\./);
		assert.throws(() => parsePageInput('11-', 10), /Invalid pages: 11\./);
		assert.throws(() => parsePageInput('1-99999999', 10), /Invalid pages: 99999999\./);
	});
});

describe('splitting', () => {
	test('extracts a range, and refuses one that would be empty', async () => {
		const file = await pdfFile(5);
		assert.deepEqual(await widths(await splitByRange(file, 2, 4)), [1, 2, 3]);
		for (const [start, end] of [[4, 2], [0, 2], [2, 6], [Number.NaN, 2]]) {
			await assert.rejects(splitByRange(file, start, end), /Pick pages between 1 and 5/);
		}
	});

	test('extracts chosen pages in order', async () => {
		assert.deepEqual(await widths(await extractPages(await pdfFile(5), [1, 3, 5])), [0, 2, 4]);
	});

	test('splits every N pages, and refuses a step that would never finish', async () => {
		const file = await pdfFile(5, 'report.pdf');
		const parts = await splitEveryN(file, 2);
		assert.deepEqual(parts.map((p) => p.name), ['report_part1.pdf', 'report_part2.pdf', 'report_part3.pdf']);
		assert.deepEqual(await widths(parts[2].data), [4]);
		for (const n of [0, -1, 1.5, Number.NaN, null as unknown as number]) {
			await assert.rejects(splitEveryN(file, n), /whole number, 1 or more/);
		}
	});
});

describe('opening files', () => {
	test('a file that is not a PDF gets a plain message', async () => {
		await assert.rejects(openPdf(new TextEncoder().encode('just some notes')), { message: NOT_A_PDF_MESSAGE });
		await assert.rejects(openPdf(new Uint8Array(0)), { message: NOT_A_PDF_MESSAGE });
	});

	test('a merge says which file failed', async () => {
		const notes = new File(['just some notes'], 'notes.pdf');
		await assert.rejects(mergePdfs([await pdfFile(1), notes]), {
			message: `notes.pdf: ${NOT_A_PDF_MESSAGE}`
		});
	});
});

test('formatSize switches units at the rounded value', () => {
	assert.equal(formatSize(0), '0 B');
	assert.equal(formatSize(1023), '1023 B');
	assert.equal(formatSize(1024), '1.0 KB');
	assert.equal(formatSize(1536), '1.5 KB');
	assert.equal(formatSize(1048524), '1023.9 KB');
	assert.equal(formatSize(1048575), '1.0 MB');
	assert.equal(formatSize(52 * 1048576), '52.0 MB');
});
