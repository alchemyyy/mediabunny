import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { VideoFieldOrder } from '../../src/input-track.js';

const FLAG_INTERLACED_ID = 0x9a;
const FIELD_ORDER_ID = 0x9d;
const MUXING_APP_ID = 0x4d80;

const textEncoder = new TextEncoder();

const concat = (...parts: Uint8Array[]) => {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
};

const bigEndian = (value: number, byteLength: number) => {
	const bytes = new Uint8Array(byteLength);
	for (let i = byteLength - 1; i >= 0; i--) {
		bytes[i] = value % 256;
		value = Math.floor(value / 256);
	}
	return bytes;
};

const minimalByteLength = (value: number) => {
	let byteLength = 1;
	while (value >= 256 ** byteLength) {
		byteLength++;
	}
	return byteLength;
};

// The ID keeps its marker bits; the size is always written as an 8-byte variable-length integer
const element = (id: number, ...payload: Uint8Array[]) => {
	const data = concat(...payload);
	return concat(bigEndian(id, minimalByteLength(id)), Uint8Array.of(0x01), bigEndian(data.length, 7), data);
};

const uintElement = (id: number, value: number, byteLength = minimalByteLength(value)) =>
	element(id, bigEndian(value, byteLength));

const stringElement = (id: number, value: string) => element(id, textEncoder.encode(value));

const createFile = (options: {
	videoElements?: Uint8Array[];
	infoElements?: Uint8Array[];
	trackType?: number;
}) => {
	const trackType = options.trackType ?? 1;
	// The field elements go into the Video element, or into the Audio element of an audio track
	const mediaElement = trackType === 1
		? element(0xe0, // Video
				uintElement(0xb0, 64), // PixelWidth
				uintElement(0xba, 48), // PixelHeight
				...(options.videoElements ?? []),
			)
		: element(0xe1, // Audio
				uintElement(0x9f, 2), // Channels
				...(options.videoElements ?? []),
			);

	return concat(
		element(0x1a45dfa3, // EBML
			uintElement(0x4286, 1), // EBMLVersion
			uintElement(0x42f7, 1), // EBMLReadVersion
			stringElement(0x4282, 'matroska'), // DocType
			uintElement(0x4287, 4), // DocTypeVersion
			uintElement(0x4285, 2), // DocTypeReadVersion
		),
		element(0x18538067, // Segment
			element(0x1549a966, // Info
				uintElement(0x2ad7b1, 1_000_000), // TimestampScale
				...(options.infoElements ?? []),
			),
			element(0x1654ae6b, // Tracks
				element(0xae, // TrackEntry
					uintElement(0xd7, 1), // TrackNumber
					uintElement(0x73c5, 1), // TrackUID
					uintElement(0x83, trackType), // TrackType
					stringElement(0x86, trackType === 1 ? 'V_VP9' : 'A_OPUS'), // CodecID
					mediaElement,
				),
			),
			element(0x1f43b675, // Cluster
				uintElement(0xe7, 0), // Timestamp
				element(0xa3, Uint8Array.of(0x81, 0x00, 0x00, 0x80, 0x00)), // SimpleBlock: track 1, keyframe
			),
		),
	);
};

const readFieldOrder = async (file: Uint8Array) => {
	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	expect(track).not.toBeNull();
	return track!.getFieldOrder();
};

const fieldElements = (flagInterlaced: number | null, fieldOrder: number | null) => [
	...(flagInterlaced === null ? [] : [uintElement(FLAG_INTERLACED_ID, flagInterlaced)]),
	...(fieldOrder === null ? [] : [uintElement(FIELD_ORDER_ID, fieldOrder)]),
];

test.each<[string, number | null, number | null, VideoFieldOrder | null]>([
	['neither element', null, null, null],
	['FlagInterlaced undetermined', 0, 1, null],
	['FlagInterlaced out of range', 3, 1, null],
	['FieldOrder without FlagInterlaced', null, 1, null],
	['progressive', 2, null, 'progressive'],
	['progressive, whatever its FieldOrder', 2, 1, 'progressive'],
	['interlaced without FieldOrder', 1, null, 'interlaced'],
	['interlaced, FieldOrder 0 (progressive)', 1, 0, 'progressive'],
	['interlaced, FieldOrder 1 (top field first)', 1, 1, 'top-first'],
	['interlaced, FieldOrder 2 (undetermined)', 1, 2, 'interlaced'],
	['interlaced, FieldOrder 6 (bottom field first)', 1, 6, 'bottom-first'],
	['interlaced, FieldOrder 9 (top coded, bottom displayed first)', 1, 9, 'top-coded-bottom-first'],
	['interlaced, FieldOrder 14 (bottom coded, top displayed first)', 1, 14, 'bottom-coded-top-first'],
	['interlaced, an unassigned FieldOrder', 1, 3, 'interlaced'],
])('Matroska field order: %s', async (_, flagInterlaced, fieldOrder, expected) => {
	expect(await readFieldOrder(createFile({ videoElements: fieldElements(flagInterlaced, fieldOrder) })))
		.toBe(expected);
});

test('Matroska field order reads an unsigned integer padded beyond its value', async () => {
	const file = createFile({
		videoElements: [uintElement(FLAG_INTERLACED_ID, 1, 4), uintElement(FIELD_ORDER_ID, 6, 2)],
	});

	expect(await readFieldOrder(file)).toBe('bottom-first');
});

test.each<[string | Uint8Array, boolean]>([
	['Lavf57.36.100', true],
	['Lavf57.41.100', true],
	['Lavf57.51.100', true],
	['Lavf57.41.101', true],
	['Lavf57. +40. 100 (patched)', true],
	[concat(textEncoder.encode('Lavf57.41.100'), Uint8Array.of(0, 0)), true],
	['Lavf57.35.100', false],
	['Lavf57.52.100', false],
	['Lavf57.41.99', false],
	['Lavf58.41.100', false],
	['Lavf57.41', false],
	['libebml v1.4.5 + libmatroska v1.7.1', false],
])('Matroska FieldOrder 9 and 14 from MuxingApp %s are swapped: %s', async (muxingApp, swapped) => {
	const muxingAppElement = typeof muxingApp === 'string'
		? stringElement(MUXING_APP_ID, muxingApp)
		: element(MUXING_APP_ID, muxingApp);
	const readWith = (fieldOrder: number) => readFieldOrder(createFile({
		videoElements: fieldElements(1, fieldOrder),
		infoElements: [muxingAppElement],
	}));

	expect(await readWith(9)).toBe(swapped ? 'bottom-coded-top-first' : 'top-coded-bottom-first');
	expect(await readWith(14)).toBe(swapped ? 'top-coded-bottom-first' : 'bottom-coded-top-first');
	// The other orders are never swapped
	expect(await readWith(1)).toBe('top-first');
	expect(await readWith(6)).toBe('bottom-first');
});

test('Matroska field order without a MuxingApp keeps FieldOrder 9 and 14', async () => {
	const file = createFile({ videoElements: fieldElements(1, 9) });

	expect(await readFieldOrder(file)).toBe('top-coded-bottom-first');
});

test('Matroska field elements outside a video track are ignored', async () => {
	const file = createFile({ trackType: 2, videoElements: fieldElements(1, 1) });

	using input = new Input({
		source: new BufferSource(file),
		formats: ALL_FORMATS,
	});

	expect(await input.getPrimaryVideoTrack()).toBeNull();
	expect(await input.getPrimaryAudioTrack()).not.toBeNull();
});
