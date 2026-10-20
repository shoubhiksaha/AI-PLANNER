/**
 * C8: HEIC/HEIF validation by ftyp brand and in-memory conversion to JPEG.
 * Uses a real 664-byte HEIC fixture (generated with macOS `sips`).
 */
// firebase-admin/auth and /app-check load ESM-only jose, which Jest cannot require; not needed here.
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
jest.mock('firebase-admin/app-check', () => ({ getAppCheck: jest.fn() }));
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { isHeifContainer, parseImageDataUrl, parseImageDataArray } = require('../utils');
const {
    convertHeicImages,
    convertHeicToJpeg,
    downscaleJpegIfNeeded,
    HEIC_ERROR_MESSAGE,
    DOWNSCALE_MAX_WIDTH,
} = require('../sync/images');
const { parseSyncRequest } = require('../sync/request');
const { SyncError } = require('../sync/errors');

const HEIC = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.heic'));
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

/** ftyp box with the given major brand and compatible brands, followed by junk. */
function ftyp(major, compatible = [], tail = Buffer.alloc(32, 7)) {
    const size = 16 + compatible.length * 4;
    const box = Buffer.alloc(size);
    box.writeUInt32BE(size, 0);
    box.write('ftyp', 4, 'latin1');
    box.write(major, 8, 'latin1');
    compatible.forEach((brand, i) => box.write(brand, 16 + i * 4, 'latin1'));
    return Buffer.concat([box, tail]);
}

describe('isHeifContainer (ftyp brand check)', () => {
    test('accepts the real HEIC fixture', () => {
        expect(HEIC.length).toBeLessThan(50 * 1024);
        expect(isHeifContainer(HEIC)).toBe(true);
    });

    test.each(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])('accepts major brand %s', (brand) => {
        expect(isHeifContainer(ftyp(brand))).toBe(true);
    });

    test('accepts a HEIF compatible brand under another major brand', () => {
        expect(isHeifContainer(ftyp('abcd', ['isom', 'mif1']))).toBe(true);
    });

    test('rejects fake brands (an MP4 renamed to .heic)', () => {
        expect(isHeifContainer(ftyp('isom', ['iso2', 'mp41']))).toBe(false);
        expect(isHeifContainer(ftyp('qt  '))).toBe(false);
    });

    test('rejects non-ftyp data, JPEGs, truncated and malformed boxes', () => {
        expect(isHeifContainer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
        expect(isHeifContainer(HEIC.subarray(0, 12))).toBe(false);
        const badSize = Buffer.from(ftyp('heic'));
        badSize.writeUInt32BE(8, 0);
        expect(isHeifContainer(badSize)).toBe(false);
        const oversize = Buffer.from(ftyp('heic'));
        oversize.writeUInt32BE(oversize.length + 100, 0);
        expect(isHeifContainer(oversize)).toBe(false);
        expect(isHeifContainer('not a buffer')).toBe(false);
    });
});

describe('parseImageDataUrl with image/heic and image/heif', () => {
    test('accepts a real HEIC as image/heic and image/heif', () => {
        expect(parseImageDataUrl(dataUrl('image/heic', HEIC))).toEqual(expect.objectContaining({ mimeType: 'image/heic', decodedBytes: HEIC.length }));
        expect(parseImageDataUrl(dataUrl('image/heif', HEIC))).toEqual(expect.objectContaining({ mimeType: 'image/heif' }));
    });

    test('rejects a fake-brand file claiming to be HEIC', () => {
        expect(parseImageDataUrl(dataUrl('image/heic', ftyp('isom', ['mp42'])))).toBeNull();
    });

    test('a fake-brand HEIC gets the HEIC-specific 400 INVALID_IMAGE message', () => {
        expect(() => parseSyncRequest({ images: [dataUrl('image/heic', ftyp('isom'))] }, 'journal'))
            .toThrow(expect.objectContaining({ status: 400, errorCode: 'INVALID_IMAGE', message: HEIC_ERROR_MESSAGE }));
    });
});

describe('convertHeicImages', () => {
    test('converts a real HEIC to JPEG and leaves other images untouched', async () => {
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer();
        const images = parseImageDataArray([dataUrl('image/heic', HEIC), dataUrl('image/jpeg', jpeg)]);
        const out = await convertHeicImages(images, { requestId: 'r', uid: 'u' });

        expect(out).toHaveLength(2);
        expect(out[0].mimeType).toBe('image/jpeg');
        const converted = Buffer.from(out[0].base64Data, 'base64');
        expect(converted.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        expect(out[0].decodedBytes).toBe(converted.length);
        const meta = await sharp(converted).metadata();
        expect(meta).toEqual(expect.objectContaining({ format: 'jpeg', width: 96, height: 64 }));
        expect(out[1]).toBe(images[1]);
    });

    test('returns the same array when there is nothing to convert', async () => {
        const images = [{ mimeType: 'image/png', base64Data: 'AA==', decodedBytes: 1 }];
        await expect(convertHeicImages(images)).resolves.toBe(images);
    });

    test('a HEIF container that cannot be decoded throws 400 INVALID_IMAGE', async () => {
        jest.spyOn(console, 'log').mockImplementation(() => {}); // libheif logs decode errors
        const broken = ftyp('heic', ['mif1'], Buffer.alloc(256, 1));
        const images = [{ mimeType: 'image/heic', base64Data: broken.toString('base64'), decodedBytes: broken.length }];
        const err = await convertHeicImages(images).catch(e => e);
        expect(err).toBeInstanceOf(SyncError);
        expect(err).toEqual(expect.objectContaining({ status: 400, errorCode: 'INVALID_IMAGE', message: HEIC_ERROR_MESSAGE }));
        console.log.mockRestore();
    });

    test('convertHeicToJpeg refuses non-HEIF bytes before decoding', async () => {
        await expect(convertHeicToJpeg(Buffer.from('not heic at all, definitely not'))).rejects.toThrow('Not a HEIF container');
    });
});

describe('downscaleJpegIfNeeded', () => {
    test('downscales a JPEG wider than 2560 px', async () => {
        const wide = await sharp({ create: { width: 3000, height: 10, channels: 3, background: '#888' } }).jpeg().toBuffer();
        const out = await downscaleJpegIfNeeded(wide);
        expect((await sharp(out).metadata()).width).toBe(DOWNSCALE_MAX_WIDTH);
    });

    test('leaves a small JPEG unchanged', async () => {
        const small = await sharp({ create: { width: 100, height: 10, channels: 3, background: '#888' } }).jpeg().toBuffer();
        await expect(downscaleJpegIfNeeded(small)).resolves.toBe(small);
    });

    test('is a no-op when sharp is unavailable', async () => {
        const buf = Buffer.from([0xff, 0xd8, 0xff]);
        await expect(downscaleJpegIfNeeded(buf, { sharp: null })).resolves.toBe(buf);
    });
});
