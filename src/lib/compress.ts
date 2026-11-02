// Compressing a PDF, entirely in the browser.
//
// The document is cleaned before it is shrunk. pdf-lib writes back every object it parsed,
// whether or not anything still uses it, so a page deleted in an earlier save, a superseded
// revision or an unlinked XMP packet would otherwise survive, invisible, inside the
// "compressed" file. So: hidden metadata is dropped, only what the document can still reach
// is kept, identical objects are merged (a merged file repeats every font and logo once per
// source), images are recompressed for the chosen level, and streams stored with no
// compression at all are deflated.

import {
	PDFArray,
	PDFDict,
	PDFHexString,
	PDFName,
	PDFNull,
	PDFNumber,
	PDFRawStream,
	PDFRef,
	PDFStream,
	type PDFContext,
	type PDFDocument,
	type PDFObject
} from 'pdf-lib';
import { openPdf } from './pdf';

export type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

type ImageOptions = { quality: number; maxDim: number };

// Per-level JPEG re-encoding settings. LOW is lossless (no image changes).
const LEVELS: Record<Level, ImageOptions | null> = {
	LOW: null,
	MEDIUM: { quality: 0.75, maxDim: 2000 },
	HIGH: { quality: 0.55, maxDim: 1500 },
	EXTREME: { quality: 0.35, maxDim: 1000 }
};

// Beyond this many pixels an image is left alone rather than risk running the tab out of memory.
const MAX_PIXELS = 50_000_000;

const name = (n: string) => PDFName.of(n);
const BITS = name('BitsPerComponent');
const CAL_GRAY = name('CalGray');
const CAL_RGB = name('CalRGB');
const COLORS = name('Colors');
const COLOR_SPACE = name('ColorSpace');
const COLUMNS = name('Columns');
const DCT = name('DCTDecode');
const DECODE = name('Decode');
const DECODE_PARMS = name('DecodeParms');
const DEVICE_GRAY = name('DeviceGray');
const DEVICE_RGB = name('DeviceRGB');
const FILTER = name('Filter');
const FLATE = name('FlateDecode');
const HEIGHT = name('Height');
const ICC_BASED = name('ICCBased');
const IMAGE = name('Image');
const IMAGE_MASK = name('ImageMask');
const LENGTH = name('Length');
const MASK = name('Mask');
const MATTE = name('Matte');
const METADATA = name('Metadata');
const N = name('N');
const PAGE = name('Page');
const PIECE_INFO = name('PieceInfo');
const PREDICTOR = name('Predictor');
const SMASK = name('SMask');
const SUBTYPE = name('Subtype');
const THUMB = name('Thumb');
const TYPE = name('Type');
const WIDTH = name('Width');

export async function compressPdf(file: File, level: Level): Promise<Uint8Array> {
	return compressBytes(new Uint8Array(await file.arrayBuffer()), level);
}

/**
 * `compressPdf` on bytes. The cleaned file comes back even when it is not smaller: handing
 * back the original would hand back its hidden data too.
 */
export async function compressBytes(bytes: Uint8Array, level: Level): Promise<Uint8Array> {
	// updateMetadata: false stops pdf-lib from stamping its own Producer/ModDate
	const doc = await openPdf(bytes, { updateMetadata: false });
	stripMetadata(doc);
	pruneUnreachable(doc.context);
	mergeDuplicates(doc.context);
	const imageOpts = LEVELS[level];
	if (imageOpts) await recompressImages(doc.context, imageOpts);
	await deflateRawStreams(doc.context);
	// A swapped-out image can leave its colour profile unused.
	pruneUnreachable(doc.context);
	// Left on, pdf-lib adds an empty form to every file it saves and redraws existing fields.
	return doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
}

/**
 * Remove what a PDF records about where it came from: the Info dictionary (author, title,
 * software, dates and any custom keys), XMP packets on the document and on its objects,
 * applications' private data and page thumbnails. The file identifier, which ties a copy to
 * the file it came from, is replaced with a new random one.
 */
export function stripMetadata(doc: PDFDocument): void {
	const ctx = doc.context;
	ctx.trailerInfo.Info = undefined;
	if (ctx.trailerInfo.ID) {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		const id = PDFHexString.of(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
		ctx.trailerInfo.ID = ctx.obj([id, id]);
	}
	for (const [, obj] of ctx.enumerateIndirectObjects()) {
		const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
		if (!dict) continue;
		dict.delete(METADATA);
		dict.delete(PIECE_INFO);
		if (dict.get(TYPE) === PAGE) dict.delete(THUMB);
	}
}

/** Drop every object the document can no longer reach from its trailer. Returns how many went. */
export function pruneUnreachable(ctx: PDFContext): number {
	// Without a catalog nothing is reachable, and pruning would empty the file.
	if (!(ctx.trailerInfo.Root instanceof PDFRef)) return 0;
	const reached = new Set<PDFRef>();
	const pending: (PDFObject | undefined)[] = [
		ctx.trailerInfo.Root,
		ctx.trailerInfo.Info,
		ctx.trailerInfo.Encrypt
	];
	while (pending.length) {
		const obj = pending.pop();
		if (obj instanceof PDFRef) {
			if (reached.has(obj)) continue;
			reached.add(obj);
			pending.push(ctx.lookup(obj));
		} else if (obj instanceof PDFDict) {
			for (const [, value] of obj.entries()) pending.push(value);
		} else if (obj instanceof PDFArray) {
			for (let i = 0; i < obj.size(); i++) pending.push(obj.get(i));
		} else if (obj instanceof PDFStream) {
			pending.push(obj.dict);
		}
	}
	let removed = 0;
	for (const [ref] of ctx.enumerateIndirectObjects()) {
		if (!reached.has(ref)) {
			ctx.delete(ref);
			removed++;
		}
	}
	return removed;
}

// Dictionaries that can be shared by everything that uses them. Pages, annotations and form
// fields have an identity of their own and are never merged.
const SHAREABLE = new Set([name('Font'), name('FontDescriptor'), name('ExtGState'), name('Encoding')]);

/**
 * Merge identical streams, arrays and shareable dictionaries into one object each. Returns how
 * many objects were merged away.
 */
export function mergeDuplicates(ctx: PDFContext): number {
	const hashes = new WeakMap<PDFRawStream, string>();
	let merged = 0;
	// Merging two fonts' programs makes their descriptors identical, which makes the fonts
	// identical: repeat until a pass finds nothing more.
	for (let pass = 0; pass < 8; pass++) {
		const groups = new Map<string, PDFRef[]>();
		const replace = new Map<PDFRef, PDFRef>();
		for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
			const key = shareKey(obj, hashes);
			if (key === null) continue;
			const group = groups.get(key);
			const twin = group?.find((other) => sameContents(ctx.lookup(other), obj));
			if (twin) replace.set(ref, twin);
			else if (group) group.push(ref);
			else groups.set(key, [ref]);
		}
		if (!replace.size) break;
		rewriteRefs(ctx, replace);
		for (const ref of replace.keys()) ctx.delete(ref);
		merged += replace.size;
	}
	return merged;
}

function shareKey(obj: PDFObject, hashes: WeakMap<PDFRawStream, string>): string | null {
	if (obj instanceof PDFRawStream) {
		let hash = hashes.get(obj);
		if (hash === undefined) {
			hash = `${obj.contents.length}:${fnv1a(obj.contents)}`;
			hashes.set(obj, hash);
		}
		let dict = '';
		for (const [key, value] of obj.dict.entries()) {
			if (key !== LENGTH) dict += `${key.toString()} ${value.toString()} `;
		}
		return `S${dict}|${hash}`;
	}
	if (obj instanceof PDFArray) return `A${obj.toString()}`;
	if (obj instanceof PDFDict) {
		const type = obj.get(TYPE);
		if (type instanceof PDFName && SHAREABLE.has(type)) return `D${obj.toString()}`;
	}
	return null;
}

// A key holds an array's or dictionary's whole text, but only a hash of a stream's bytes.
function sameContents(a: PDFObject | undefined, b: PDFObject): boolean {
	if (!(a instanceof PDFRawStream) || !(b instanceof PDFRawStream)) return true;
	if (a.contents.length !== b.contents.length) return false;
	for (let i = 0; i < a.contents.length; i++) if (a.contents[i] !== b.contents[i]) return false;
	return true;
}

function fnv1a(bytes: Uint8Array): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		hash ^= bytes[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function rewriteRefs(ctx: PDFContext, replace: Map<PDFRef, PDFRef>): void {
	const swap = (value: PDFObject | undefined) =>
		value instanceof PDFRef ? replace.get(value) : undefined;
	const visit = (obj: PDFObject | undefined): void => {
		if (obj instanceof PDFDict) {
			for (const [key, value] of obj.entries()) {
				const to = swap(value);
				if (to) obj.set(key, to);
				else visit(value);
			}
		} else if (obj instanceof PDFArray) {
			for (let i = 0; i < obj.size(); i++) {
				const to = swap(obj.get(i));
				if (to) obj.set(i, to);
				else visit(obj.get(i));
			}
		} else if (obj instanceof PDFStream) {
			visit(obj.dict);
		}
	};
	for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);
	for (const key of ['Root', 'Info', 'Encrypt'] as const) {
		const to = swap(ctx.trailerInfo[key]);
		if (to) ctx.trailerInfo[key] = to;
	}
}

/* ------------------------------------------------------------------ images */

export type ImageSource = { width: number; height: number; comps: 1 | 3 } & (
	| { kind: 'jpeg' }
	| { kind: 'pixels'; inflate: boolean; predictor: number }
);

/**
 * How to read an image that can be recompressed without changing how it looks, or null to
 * leave it alone. The browser decodes and encodes only 8-bit grey and RGB faithfully: a CMYK,
 * indexed, spot-colour or Lab image would come back in different colours, and stencils,
 * colour-key masks and inverted decode ranges need their exact pixel values.
 */
export function readableImage(dict: PDFDict, ctx: PDFContext): ImageSource | null {
	if (dict.get(SUBTYPE) !== IMAGE || dict.get(IMAGE_MASK) || dict.get(MASK) instanceof PDFArray) {
		return null;
	}
	// A soft mask with /Matte (premultiplied alpha) must keep the image's exact dimensions.
	const softMask = dict.lookup(SMASK);
	if (softMask instanceof PDFStream && softMask.dict.has(MATTE)) return null;
	const width = numberOf(dict.get(WIDTH));
	const height = numberOf(dict.get(HEIGHT));
	if (!width || !height || width * height > MAX_PIXELS) return null;
	const comps = colourComponents(dict.get(COLOR_SPACE), ctx);
	if (!comps || !isDefaultDecode(dict.get(DECODE), comps)) return null;

	const filter = soleFilter(dict.get(FILTER));
	let parms = dict.lookup(DECODE_PARMS);
	if (parms instanceof PDFArray && parms.size() === 1) parms = parms.lookup(0);
	if (parms === PDFNull) parms = undefined;
	// A JPEG's /ColorTransform can disagree with what the browser's decoder assumes.
	if (filter === DCT) return parms === undefined ? { kind: 'jpeg', width, height, comps } : null;
	if (filter === null || (filter !== undefined && filter !== FLATE)) return null;
	if (numberOf(dict.get(BITS)) !== 8) return null;

	let predictor = 1;
	if (filter === FLATE && parms !== undefined) {
		if (!(parms instanceof PDFDict)) return null;
		predictor = numberOf(parms.get(PREDICTOR)) ?? 1;
		// The predictor's own idea of the row layout has to match the image's.
		const layoutMatches =
			(numberOf(parms.get(COLORS)) ?? 1) === comps &&
			(numberOf(parms.get(BITS)) ?? 8) === 8 &&
			(numberOf(parms.get(COLUMNS)) ?? 1) === width;
		if (predictor > 1 && !layoutMatches) return null;
	}
	if (predictor !== 1 && predictor !== 2 && predictor < 10) return null;
	return { kind: 'pixels', width, height, comps, inflate: filter === FLATE, predictor };
}

function numberOf(value: PDFObject | undefined): number | undefined {
	return value instanceof PDFNumber ? value.asNumber() : undefined;
}

// undefined: no filter. null: a chain of filters, or one this code does not read.
function soleFilter(value: PDFObject | undefined): PDFName | undefined | null {
	if (value === undefined) return undefined;
	if (value instanceof PDFName) return value;
	if (value instanceof PDFArray && value.size() === 1 && value.get(0) instanceof PDFName) {
		return value.get(0) as PDFName;
	}
	return null;
}

function colourComponents(value: PDFObject | undefined, ctx: PDFContext): 0 | 1 | 3 {
	const space = value instanceof PDFRef ? ctx.lookup(value) : value;
	if (space === DEVICE_GRAY) return 1;
	if (space === DEVICE_RGB) return 3;
	if (space instanceof PDFArray) {
		const family = space.get(0);
		if (family === CAL_GRAY) return 1;
		if (family === CAL_RGB) return 3;
		if (family === ICC_BASED) {
			const profile = ctx.lookup(space.get(1));
			const n = profile instanceof PDFStream ? numberOf(profile.dict.lookup(N)) : undefined;
			if (n === 1 || n === 3) return n;
		}
	}
	return 0;
}

function isDefaultDecode(value: PDFObject | undefined, comps: number): boolean {
	if (value === undefined) return true;
	if (!(value instanceof PDFArray) || value.size() !== comps * 2) return false;
	for (let i = 0; i < value.size(); i++) {
		if (numberOf(value.get(i)) !== (i % 2 === 0 ? 0 : 1)) return false;
	}
	return true;
}

async function recompressImages(ctx: PDFContext, opts: ImageOptions): Promise<void> {
	for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFRawStream)) continue;
		const source = readableImage(obj.dict, ctx);
		if (!source) continue;
		try {
			const encoded =
				source.kind === 'jpeg'
					? await reencodeJpeg(obj.contents, opts)
					: await encodePixels(obj.contents, source, opts);
			if (!encoded) continue;
			// A lossless original only gives way to a much smaller JPEG: a modest win usually
			// means line art or text, which JPEG smears. Raw samples are measured as deflated,
			// which is what they become if they stay lossless.
			const limit =
				source.kind === 'jpeg'
					? obj.contents.length
					: (source.inflate ? obj.contents.length : (await deflate(obj.contents)).length) / 2;
			// only swap in the re-encoded image if it's actually smaller
			if (encoded.data.length >= limit) continue;
			// the re-encoded image must keep the original aspect ratio, otherwise the
			// page's transform would distort it. If a decoder ever rotates or reshapes
			// the pixels, skip the swap rather than corrupt the image.
			const origAspect = source.width / source.height;
			const newAspect = encoded.width / encoded.height;
			if (Math.abs(origAspect - newAspect) > 0.01 * origAspect) continue;
			const dict = obj.dict.clone(ctx);
			dict.set(WIDTH, ctx.obj(encoded.width));
			dict.set(HEIGHT, ctx.obj(encoded.height));
			dict.set(FILTER, DCT);
			// canvas always outputs 8-bit RGB JPEGs. The pixels were decoded without colour
			// conversion, so an RGB image keeps its own colour space (and ICC profile) and only
			// a grey one changes to plain RGB.
			if (source.comps === 1) dict.set(COLOR_SPACE, DEVICE_RGB);
			dict.set(BITS, ctx.obj(8));
			dict.set(LENGTH, ctx.obj(encoded.data.length));
			dict.delete(DECODE_PARMS);
			dict.delete(DECODE);
			ctx.assign(ref, PDFRawStream.of(dict, encoded.data));
		} catch {
			// leave this image untouched rather than failing the whole document
		}
	}
}

type Encoded = { data: Uint8Array; width: number; height: number };

async function reencodeJpeg(data: Uint8Array, opts: ImageOptions): Promise<Encoded | null> {
	let bitmap: ImageBitmap;
	try {
		const jpeg = stripJpegExif(data);
		// PDF viewers ignore a profile embedded in the JPEG and use the image's /ColorSpace;
		// decoding without conversion keeps the values they show.
		bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }), {
			colorSpaceConversion: 'none'
		});
	} catch {
		return null; // browser couldn't decode this JPEG variant
	}
	try {
		return await encodeJpeg(bitmap, opts);
	} finally {
		bitmap.close();
	}
}

async function encodePixels(
	data: Uint8Array,
	source: Extract<ImageSource, { kind: 'pixels' }>,
	opts: ImageOptions
): Promise<Encoded | null> {
	const { width, height, comps } = source;
	let samples = source.inflate ? await inflate(data) : data;
	if (source.predictor >= 10) samples = unpredictPng(samples, width, height, comps);
	else if (source.predictor === 2) unpredictTiff(samples, width, height, comps);
	if (samples.length < width * height * comps) return null;
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let p = 0, s = 0; p < rgba.length; p += 4, s += comps) {
		rgba[p] = samples[s];
		rgba[p + 1] = samples[comps === 3 ? s + 1 : s];
		rgba[p + 2] = samples[comps === 3 ? s + 2 : s];
		rgba[p + 3] = 255;
	}
	const bitmap = await createImageBitmap(new ImageData(rgba, width, height));
	try {
		return await encodeJpeg(bitmap, opts);
	} finally {
		bitmap.close();
	}
}

async function encodeJpeg(bitmap: ImageBitmap, opts: ImageOptions): Promise<Encoded | null> {
	const scale = Math.min(1, opts.maxDim / Math.max(bitmap.width, bitmap.height));
	const width = Math.max(1, Math.round(bitmap.width * scale));
	const height = Math.max(1, Math.round(bitmap.height * scale));
	let blob: Blob;
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.imageSmoothingQuality = 'high'; // the default 'low' aliases when shrinking a scan
		ctx.drawImage(bitmap, 0, 0, width, height);
		blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: opts.quality });
	} else {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, 0, 0, width, height);
		blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))),
				'image/jpeg',
				opts.quality
			)
		);
	}
	return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/** Undo PNG row filters (Flate predictors 10 to 15) on 8-bit samples. */
export function unpredictPng(
	data: Uint8Array,
	width: number,
	height: number,
	comps: number
): Uint8Array {
	const stride = width * comps;
	if (data.length < (stride + 1) * height) throw new Error('truncated image data');
	const out = new Uint8Array(stride * height);
	let prev = new Uint8Array(stride);
	let i = 0;
	for (let y = 0; y < height; y++) {
		const type = data[i++];
		const row = out.subarray(y * stride, (y + 1) * stride);
		for (let x = 0; x < stride; x++) {
			const left = x >= comps ? row[x - comps] : 0;
			const up = prev[x];
			const upLeft = x >= comps ? prev[x - comps] : 0;
			let predicted: number;
			if (type === 0) predicted = 0;
			else if (type === 1) predicted = left;
			else if (type === 2) predicted = up;
			else if (type === 3) predicted = (left + up) >> 1;
			else if (type === 4) predicted = paeth(left, up, upLeft);
			else throw new Error(`unknown PNG row filter ${type}`);
			row[x] = (data[i++] + predicted) & 0xff;
		}
		prev = row;
	}
	return out;
}

function paeth(left: number, up: number, upLeft: number): number {
	const p = left + up - upLeft;
	const pa = Math.abs(p - left);
	const pb = Math.abs(p - up);
	const pc = Math.abs(p - upLeft);
	return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
}

// TIFF predictor 2: each sample is stored as the difference from the one to its left.
function unpredictTiff(data: Uint8Array, width: number, height: number, comps: number): void {
	const stride = width * comps;
	for (let y = 0; y < height; y++) {
		for (let x = comps; x < stride; x++) {
			data[y * stride + x] = (data[y * stride + x] + data[y * stride + x - comps]) & 0xff;
		}
	}
}

// Remove the Exif (APP1) segment from a JPEG. createImageBitmap honors the Exif
// orientation tag and rotates the decoded pixels — but PDF viewers ignore Exif on
// embedded images and use the raw coded grid. Decoding the rotated pixels would
// distort the image against the page's transform, so we strip Exif first to get
// the coded orientation the PDF expects. (The imageOrientation: 'none' option does
// not suppress this in Chrome.)
function stripJpegExif(data: Uint8Array): Uint8Array {
	if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return data;
	const keep: Uint8Array[] = [data.subarray(0, 2)]; // SOI
	let i = 2;
	let stripped = false;
	while (i + 4 <= data.length) {
		if (data[i] !== 0xff) break; // not a marker — bail before scan data
		const marker = data[i + 1];
		if (marker === 0xda) {
			keep.push(data.subarray(i)); // SOS: rest is compressed scan data
			i = data.length;
			break;
		}
		const len = (data[i + 2] << 8) | data[i + 3]; // segment length incl. these 2 bytes
		const segEnd = i + 2 + len;
		if (len < 2 || segEnd > data.length) {
			keep.push(data.subarray(i)); // malformed — keep the remainder untouched
			break;
		}
		const isExif =
			marker === 0xe1 &&
			data[i + 4] === 0x45 && // 'E'
			data[i + 5] === 0x78 && // 'x'
			data[i + 6] === 0x69 && // 'i'
			data[i + 7] === 0x66; // 'f'
		if (isExif) stripped = true;
		else keep.push(data.subarray(i, segEnd));
		i = segEnd;
	}
	if (!stripped) return data;
	const total = keep.reduce((n, k) => n + k.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const k of keep) {
		out.set(k, off);
		off += k.length;
	}
	return out;
}

/* ------------------------------------------------------------------ streams */

async function deflateRawStreams(ctx: PDFContext): Promise<void> {
	if (typeof CompressionStream === 'undefined') return;
	for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
		if (!(obj instanceof PDFRawStream) || obj.contents.length < 64) continue;
		const dict = obj.dict;
		// XMP stays readable to tools that don't parse PDF, as the specification recommends.
		if (dict.has(FILTER) || dict.has(DECODE_PARMS) || dict.get(TYPE) === METADATA) continue;
		const deflated = await deflate(obj.contents);
		if (deflated.length >= obj.contents.length * 0.9) continue;
		const out = dict.clone(ctx);
		out.set(FILTER, FLATE);
		out.set(LENGTH, ctx.obj(deflated.length));
		ctx.assign(ref, PDFRawStream.of(out, deflated));
	}
}

// PDF's FlateDecode is zlib, which is what the browser calls 'deflate'.
const deflate = (bytes: Uint8Array) => pipeThrough(bytes, new CompressionStream('deflate'));
const inflate = (bytes: Uint8Array) => pipeThrough(bytes, new DecompressionStream('deflate'));

async function pipeThrough(
	bytes: Uint8Array,
	stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
	const writer = stream.writable.getWriter();
	// A corrupt input rejects these too; the readable side reports it.
	writer.write(bytes as BufferSource).catch(() => {});
	writer.close().catch(() => {});
	return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
