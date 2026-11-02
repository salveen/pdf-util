import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import {
	PDFContext,
	PDFDict,
	PDFDocument,
	PDFHexString,
	PDFName,
	PDFRawStream,
	PDFStream,
	PDFString,
	StandardFonts,
	type PDFObject
} from 'pdf-lib';
import { compressBytes, readableImage, unpredictPng } from './compress';
import { LOCKED_PDF_MESSAGE, mergePdfs, openPdf } from './pdf';

// Node has no canvas, so these tests cover everything except the JPEG re-encoding itself:
// at Medium and above, images come through untouched here.

const name = (n: string) => PDFName.of(n);

/** Every object in the file as text, streams inflated, so a marker anywhere in it shows up. */
async function allText(bytes: Uint8Array): Promise<string> {
	const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
	const parts: string[] = [];
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		if (obj instanceof PDFRawStream) {
			const flate = obj.dict.get(name('Filter')) === name('FlateDecode');
			parts.push(obj.dict.toString(), Buffer.from(flate ? inflateSync(obj.contents) : obj.contents).toString('latin1'));
		} else {
			parts.push(obj.toString());
		}
	}
	return parts.join('\n');
}

async function inventory(bytes: Uint8Array) {
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	let images = 0;
	let fonts = 0;
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
		if (dict?.get(name('Subtype')) === name('Image')) images++;
		if (dict?.get(name('Type')) === name('Font')) fonts++;
	}
	return { images, fonts, pages: doc.getPageCount() };
}

/** A small RGBA PNG, so pdf-lib embeds an image plus a soft mask. */
function png(width: number, height: number): Uint8Array {
	const stride = width * 4 + 1;
	const raw = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			raw.set([x * 4, y * 5, (x + y) * 2, 200], y * stride + 1 + x * 4);
		}
	}
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc32(body), body.length + 4);
		return out;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

const asFile = (bytes: Uint8Array, fileName: string) => new File([bytes as BlobPart], fileName);

describe('compressBytes', () => {
	test('removes metadata, application data, thumbnails and orphans', async () => {
		const doc = await PDFDocument.create({ updateMetadata: false });
		const ctx = doc.context;
		const page = doc.addPage([200, 200]);
		page.drawText('Hello', { x: 20, y: 100, size: 12 });
		ctx.trailerInfo.Info = ctx.register(
			ctx.obj({
				Title: PDFString.of('INFO-TITLE-SECRET'),
				Author: PDFString.of('INFO-AUTHOR-SECRET'),
				Company: PDFString.of('INFO-CUSTOM-SECRET')
			})
		);
		const xmp = ctx.stream('<x:xmpmeta>XMP-SECRET</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' });
		doc.catalog.set(name('Metadata'), ctx.register(xmp));
		page.node.set(name('PieceInfo'), ctx.obj({ App: { Private: PDFString.of('PIECEINFO-SECRET') } }));
		page.node.set(name('Thumb'), ctx.register(ctx.stream('THUMB-SECRET')));
		ctx.register(ctx.obj({ Leftover: PDFString.of('ORPHAN-SECRET') }));
		const originalId = PDFHexString.of('AB'.repeat(16));
		ctx.trailerInfo.ID = ctx.obj([originalId, originalId]);
		const input = await doc.save({ useObjectStreams: false });

		const markers = ['INFO-TITLE', 'INFO-AUTHOR', 'INFO-CUSTOM', 'XMP', 'PIECEINFO', 'THUMB', 'ORPHAN'];
		const before = await allText(input);
		for (const marker of markers) assert.ok(before.includes(`${marker}-SECRET`), `fixture has ${marker}`);

		const out = await compressBytes(input, 'LOW');
		const after = await allText(out);
		for (const marker of markers) assert.ok(!after.includes(`${marker}-SECRET`), `${marker} removed`);
		const cleaned = await PDFDocument.load(out, { updateMetadata: false });
		assert.equal(cleaned.context.trailerInfo.Info, undefined);
		const id = cleaned.context.trailerInfo.ID?.toString() ?? '';
		assert.match(id, /^\[ <[0-9a-f]{32}> <[0-9a-f]{32}> \]$/i, 'a new file identifier');
		assert.ok(!id.includes('ABAB'), 'not the original identifier');
		assert.equal(cleaned.catalog.has(name('AcroForm')), false, 'no empty form added');
		assert.equal(cleaned.getPageCount(), 1);
	});

	test('drops a page that was removed but left inside the file', async () => {
		const doc = await PDFDocument.create();
		for (const n of [1, 2, 3]) {
			const page = doc.addPage([200, 200]);
			const contents = doc.context.flateStream(`% PAGE-${n}-MARKER\n0 0 m 10 10 l S\n`);
			page.node.set(name('Contents'), doc.context.register(contents));
		}
		doc.removePage(1);
		const input = await doc.save();
		assert.ok((await allText(input)).includes('PAGE-2-MARKER'), 'pdf-lib keeps the removed page');

		const out = await compressBytes(input, 'LOW');
		const text = await allText(out);
		assert.ok(!text.includes('PAGE-2-MARKER'));
		assert.ok(text.includes('PAGE-1-MARKER') && text.includes('PAGE-3-MARKER'));
		assert.equal((await inventory(out)).pages, 2);
	});

	test('merges the fonts and images that a merge repeats', async () => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const image = await doc.embedPng(png(64, 48));
		const page = doc.addPage([300, 300]);
		page.drawImage(image, { x: 20, y: 150, width: 128, height: 96 });
		page.drawText('Statement', { x: 20, y: 100, size: 14, font });
		const statement = await doc.save();

		const merged = await mergePdfs([1, 2, 3].map((n) => asFile(statement, `s${n}.pdf`)));
		assert.deepEqual(await inventory(merged), { images: 6, fonts: 3, pages: 3 });

		const out = await compressBytes(merged, 'LOW');
		// one image and its soft mask, one font
		assert.deepEqual(await inventory(out), { images: 2, fonts: 1, pages: 3 });
		assert.ok(out.length < merged.length * 0.6, `${out.length} vs ${merged.length}`);
	});

	test('deflates a stream stored with no compression, losslessly', async () => {
		const doc = await PDFDocument.create();
		const ops = '0 0 m 100 100 l S\n'.repeat(50);
		doc.addPage([200, 200]).node.set(name('Contents'), doc.context.register(doc.context.stream(ops)));
		const out = await compressBytes(await doc.save(), 'LOW');

		const contents = (await PDFDocument.load(out)).getPage(0).node.Contents();
		assert.ok(contents instanceof PDFRawStream);
		assert.equal(contents.dict.get(name('Filter')), name('FlateDecode'));
		assert.equal(Buffer.from(inflateSync(contents.contents)).toString('latin1'), ops);
	});

	test('keeps a text document intact at Low and Medium', async () => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.TimesRoman);
		for (const line of ['First page', 'Second page']) {
			doc.addPage([300, 200]).drawText(line, { x: 20, y: 100, size: 16, font });
		}
		const input = await doc.save();
		for (const level of ['LOW', 'MEDIUM'] as const) {
			const out = await compressBytes(input, level);
			assert.deepEqual(await inventory(out), { images: 0, fonts: 1, pages: 2 }, level);
			assert.match(await allText(out), /Tj/, level);
		}
	});

	test('refuses a locked PDF with a message people can act on', async () => {
		const doc = await PDFDocument.create();
		doc.addPage();
		const ctx = doc.context;
		ctx.trailerInfo.Encrypt = ctx.register(
			ctx.obj({ Filter: 'Standard', V: 1, R: 2, P: -44, O: PDFString.of('o'), U: PDFString.of('u') })
		);
		const locked = await doc.save();
		await assert.rejects(openPdf(locked), { message: LOCKED_PDF_MESSAGE });
		await assert.rejects(compressBytes(locked, 'LOW'), { message: LOCKED_PDF_MESSAGE });
	});
});

describe('readableImage', () => {
	const ctx = PDFContext.create();
	const icc = (n: number) => ctx.obj([name('ICCBased'), ctx.register(ctx.stream('profile', { N: n }))]);

	/** An 8-bit 10x10 RGB image dictionary with `changes` applied (null deletes a key). */
	function image(changes: Record<string, PDFObject | null> = {}): PDFDict {
		const dict = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: 10, Height: 10, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
		for (const [key, value] of Object.entries(changes)) {
			if (value === null) dict.delete(name(key));
			else dict.set(name(key), value);
		}
		return dict;
	}
	const read = (changes?: Record<string, PDFObject | null>) => readableImage(image(changes), ctx);
	const DCT = name('DCTDecode');
	const FLATE = name('FlateDecode');

	test('reads JPEGs and Flate or raw samples in grey and RGB', () => {
		assert.deepEqual(read({ Filter: DCT }), { kind: 'jpeg', width: 10, height: 10, comps: 3 });
		assert.deepEqual(read({ Filter: FLATE }), {
			kind: 'pixels', width: 10, height: 10, comps: 3, inflate: true, predictor: 1
		});
		assert.deepEqual(read({ ColorSpace: name('DeviceGray') }), {
			kind: 'pixels', width: 10, height: 10, comps: 1, inflate: false, predictor: 1
		});
		assert.equal(read({ Filter: FLATE, ColorSpace: icc(3) })?.comps, 3);
		assert.equal(read({ Filter: FLATE, ColorSpace: icc(1) })?.comps, 1);
		assert.equal(read({ Filter: DCT, Decode: ctx.obj([0, 1, 0, 1, 0, 1]) })?.kind, 'jpeg');
	});

	test('reads PNG and TIFF predictors when their row layout matches the image', () => {
		const parms = (p: number, colors = 3, columns = 10) => ctx.obj({ Predictor: p, Colors: colors, Columns: columns });
		assert.equal(read({ Filter: FLATE, DecodeParms: parms(15) })?.kind, 'pixels');
		assert.equal(read({ Filter: FLATE, DecodeParms: parms(2) })?.kind, 'pixels');
		const single = read({ Filter: ctx.obj([FLATE]), DecodeParms: ctx.obj([parms(12)]) });
		assert.ok(single?.kind === 'pixels' && single.predictor === 12);
		assert.equal(read({ Filter: FLATE, DecodeParms: parms(15, 1) }), null, 'colours differ');
		assert.equal(read({ Filter: FLATE, DecodeParms: parms(15, 3, 8) }), null, 'columns differ');
		assert.equal(read({ Filter: FLATE, DecodeParms: parms(5) }), null, 'unknown predictor');
	});

	test('leaves alone what the browser would change', () => {
		const cases: [string, Record<string, PDFObject | null>][] = [
			['CMYK', { Filter: DCT, ColorSpace: name('DeviceCMYK') }],
			['ICC CMYK', { Filter: DCT, ColorSpace: icc(4) }],
			['indexed', { Filter: FLATE, ColorSpace: ctx.obj([name('Indexed'), name('DeviceRGB'), 1, PDFString.of('abcdef')]) }],
			['JPEG decode parameters', { Filter: DCT, DecodeParms: ctx.obj({ ColorTransform: 0 }) }],
			['filter chain', { Filter: ctx.obj([name('ASCII85Decode'), FLATE]) }],
			['JPEG 2000', { Filter: name('JPXDecode') }],
			['1-bit', { Filter: FLATE, BitsPerComponent: ctx.obj(1) }],
			['stencil', { ImageMask: ctx.obj(true), ColorSpace: null }],
			['colour-key mask', { Mask: ctx.obj([0, 10, 0, 10, 0, 10]) }],
			['inverted', { Filter: FLATE, Decode: ctx.obj([1, 0, 1, 0, 1, 0]) }],
			['premultiplied mask', { SMask: ctx.register(ctx.stream('m', { Subtype: 'Image', Matte: [0, 0, 0] })) }],
			['huge', { Width: ctx.obj(10000), Height: ctx.obj(10000) }],
			['not an image', { Subtype: name('Form') }]
		];
		for (const [label, changes] of cases) assert.equal(read(changes), null, label);
	});
});

describe('unpredictPng', () => {
	// written out here rather than imported, so the test doesn't check the code against itself
	const paeth = (a: number, b: number, c: number) => {
		const p = a + b - c;
		const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
		return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
	};

	test('undoes all five row filters', () => {
		const [width, height, comps] = [6, 10, 3];
		const stride = width * comps;
		const pixels = Uint8Array.from({ length: stride * height }, (_, i) => (i * 37 + (i >> 4) * 101) & 0xff);
		const encoded = new Uint8Array((stride + 1) * height);
		for (let y = 0; y < height; y++) {
			const type = y % 5;
			encoded[y * (stride + 1)] = type;
			for (let x = 0; x < stride; x++) {
				const at = (dx: number, dy: number) =>
					x - dx >= 0 && y - dy >= 0 ? pixels[(y - dy) * stride + x - dx] : 0;
				const [left, up, upLeft] = [at(comps, 0), at(0, 1), at(comps, 1)];
				const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type];
				encoded[y * (stride + 1) + 1 + x] = (pixels[y * stride + x] - predicted) & 0xff;
			}
		}
		assert.deepEqual(unpredictPng(encoded, width, height, comps), pixels);
		assert.throws(() => unpredictPng(encoded.subarray(0, 40), width, height, comps), /truncated/);
	});
});
