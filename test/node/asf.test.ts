/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ALL_FORMATS, ASF, BufferSource, FilePathSource, Input, InputTrack, PacketReader } from '../../src/index.js';
import { ASF_DRM_ERROR_MESSAGE } from '../../src/asf/asf-demuxer.js';
import {
	ASF_AUDIO_SPREAD,
	ASF_CONTENT_ENCRYPTION_OBJECT,
	ASF_HEADER_EXTENSION_OBJECT,
	ASF_STREAM_PROPERTIES_OBJECT,
} from '../../src/asf/asf-misc.js';

// The test media: FFmpeg's ASF muxer stream-copying a WMV3 Main profile stream with B-frames (FATE's
// vc1/SMM0005.rcv) and a VC-1 Advanced profile stream (vc1.mp4), with WMA v2 and v1 it encoded; FATE's
// wmv8/wmv8_x8intra.wmv and wmavoice/streaming_CBR-7K.wma, from Microsoft's encoders; and FFmpeg's MPEG-4 Part 2 with
// B-VOPs and its PCM. The expected values are what ffprobe -show_packets -show_data_hash MD5 prints of each file.
const ASF_DIRECTORY = './test/public/asf';

type ExpectedTrack = {
	type: 'video' | 'audio';
	codec: string | null;
	internalCodecId: string;
	packetCount: number;
	keyPacketCount: number;
	/** The first packets' timestamps, in milliseconds, and sizes. */
	firstPackets: [number, number][];
	lastTimestamp: number;
	/** The MD5 of the concatenated hexadecimal MD5s of the track's packets, in order. */
	dataHash: string;
};

const EXPECTED: Record<string, ExpectedTrack[]> = {
	'wmv3-b-frames.wmv': [
		{
			type: 'video', codec: null, internalCodecId: 'WMV3', packetCount: 4, keyPacketCount: 1,
			firstPackets: [[46, 147829], [86, 38038], [126, 31338], [166, 40765]], lastTimestamp: 166,
			dataHash: 'f6e445166e119c1511690c900d9fa9f5',
		},
		{
			type: 'audio', codec: null, internalCodecId: '353', packetCount: 4, keyPacketCount: 4,
			firstPackets: [[0, 371], [46, 371], [92, 371], [139, 371]], lastTimestamp: 139,
			dataHash: '7614ac83cd1930da19634cef7e8d2034',
		},
	],
	'vc1-wmav1.wmv': [
		{
			type: 'video', codec: 'vc1', internalCodecId: 'WVC1', packetCount: 3, keyPacketCount: 1,
			firstPackets: [[46, 85851], [88, 11273], [129, 34767]], lastTimestamp: 129,
			dataHash: '6d91fbaed4f7f84b11853b702cb8d359',
		},
		{
			type: 'audio', codec: null, internalCodecId: '352', packetCount: 4, keyPacketCount: 4,
			firstPackets: [[0, 743], [46, 743], [92, 743], [139, 743]], lastTimestamp: 139,
			dataHash: 'bc782d56cfeb0a475e9213bf87d39254',
		},
	],
	// Multiple payloads, compressed payloads, and padding, from Windows Media Encoder
	'wmv8_x8intra.wmv': [
		{
			type: 'audio', codec: null, internalCodecId: '353', packetCount: 110, keyPacketCount: 110,
			firstPackets: [[0, 640], [288, 640], [608, 640], [928, 640]], lastTimestamp: 34848,
			dataHash: '6bbe204c83cc77a9590dcfccea357e43',
		},
		{
			type: 'video', codec: null, internalCodecId: 'WMV2', packetCount: 474, keyPacketCount: 9,
			firstPackets: [[0, 2389], [200, 212], [266, 599], [333, 16]], lastTimestamp: 34133,
			dataHash: '12c873526b2770aa46ad9d132a716992',
		},
	],
	'streaming_CBR-7K.wma': [
		{
			type: 'audio', codec: null, internalCodecId: '10', packetCount: 32, keyPacketCount: 32,
			firstPackets: [[0, 300], [420, 300], [780, 300], [1080, 300]], lastTimestamp: 16079,
			dataHash: 'c24f0467c3d21d2bb7d9a975e4a93b1e',
		},
	],
	'mpeg4-b.asf': [
		{
			type: 'video', codec: null, internalCodecId: 'M4S2', packetCount: 25, keyPacketCount: 3,
			firstPackets: [[0, 2415], [40, 460], [80, 64], [120, 95]], lastTimestamp: 960,
			dataHash: '9b7a53a8f4bb7dbea9d0ba34fc0967ba',
		},
	],
	'pcm.asf': [
		{
			type: 'audio', codec: 'pcm-s16', internalCodecId: '1', packetCount: 8, keyPacketCount: 8,
			firstPackets: [[0, 2048], [128, 2048], [256, 2048], [384, 2048]], lastTimestamp: 896,
			dataHash: '0cee53fd27943e7df25cb64edc9f8a18',
		},
	],
};

const readMedia = (name: string) => new Uint8Array(readFileSync(`${ASF_DIRECTORY}/${name}`));

const readAllPackets = async (track: InputTrack) => {
	const reader = new PacketReader(track);
	const packets = [];
	for (let packet = await reader.getFirst(); packet; packet = await reader.getNext(packet)) {
		packets.push(packet);
	}
	return packets;
};

/** Returns a track's stream format, the fields the AVI demuxer's streams carry too, as a caller reads it. */
const getStreamFormat = (track: InputTrack) =>
	(track._backing as unknown as { streamInfo: { format: Record<string, unknown> } }).streamInfo.format;

/** Returns the offset of a GUID in a file's bytes. */
const findGuid = (bytes: Uint8Array, guid: number[]) => {
	for (let i = 0; i + 16 <= bytes.length; i++) {
		if (guid.every((byte, j) => bytes[i + j] === byte)) {
			return i;
		}
	}
	throw new Error('GUID not found');
};

test('Should detect ASF by its Header Object GUID', async () => {
	using input = new Input({ source: new FilePathSource(`${ASF_DIRECTORY}/pcm.asf`), formats: ALL_FORMATS });
	expect(await input.getFormat()).toBe(ASF);
	expect(await input.getMimeType()).toBe('audio/x-ms-wma');
});

describe('ASF packets match ffprobe', () => {
	for (const [name, expectedTracks] of Object.entries(EXPECTED)) {
		test(name, async () => {
			using input = new Input({ source: new FilePathSource(`${ASF_DIRECTORY}/${name}`), formats: ALL_FORMATS });
			const tracks = await input.getTracks();
			expect(tracks.map(track => track.type)).toEqual(expectedTracks.map(track => track.type));

			for (const [index, expected] of expectedTracks.entries()) {
				const track = tracks[index]!;
				expect(await track.getCodec()).toBe(expected.codec);
				expect(await track.getInternalCodecId()).toBe(expected.internalCodecId);

				const packets = await readAllPackets(track);
				expect(packets).toHaveLength(expected.packetCount);
				expect(packets.filter(packet => packet.type === 'key')).toHaveLength(expected.keyPacketCount);
				expect(packets.slice(0, expected.firstPackets.length).map(packet => [
					Math.round(packet.timestamp * 1000),
					packet.data.byteLength,
				])).toEqual(expected.firstPackets);
				expect(Math.round(packets.at(-1)!.timestamp * 1000)).toBe(expected.lastTimestamp);
				const hashes = packets.map(packet => createHash('md5').update(packet.data).digest('hex')).join('');
				expect(createHash('md5').update(hashes).digest('hex')).toBe(expected.dataHash);
			}
		});
	}
});

test('Should keep WMV3 codec-less, with its BITMAPINFOHEADER and STRUCT_C extradata in its stream format', async () => {
	using input = new Input({ source: new FilePathSource(`${ASF_DIRECTORY}/wmv3-b-frames.wmv`), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	expect(await track.getCodedWidth()).toBe(720);
	expect(await track.getCodedHeight()).toBe(480);
	expect(await track.getDecoderConfig()).toBe(null);
	const format = getStreamFormat(track);
	expect(format['compression']).toBe('WMV3');
	expect((format['extraData'] as Uint8Array).byteLength).toBe(4);
});

test('Should give VC-1 Advanced profile its sequence header and entry point as its description', async () => {
	using input = new Input({ source: new FilePathSource(`${ASF_DIRECTORY}/vc1-wmav1.wmv`), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	const config = await track.getDecoderConfig();
	expect(config?.codec).toBe('vc-1');
	expect([config?.codedWidth, config?.codedHeight]).toEqual([1920, 1080]);
	const description = new Uint8Array(config!.description as Uint8Array);
	expect(description.byteLength).toBe(30);
	expect(createHash('md5').update(description).digest('hex')).toBe(
		createHash('md5').update(getStreamFormat(track)['extraData'] as Uint8Array).digest('hex'),
	);
});

test('Should keep WMA codec-less, with its WAVEFORMATEX in its stream format', async () => {
	using input = new Input({ source: new FilePathSource(`${ASF_DIRECTORY}/wmv8_x8intra.wmv`), formats: ALL_FORMATS });
	const track = (await input.getAudioTracks())[0]!;
	expect(await track.getNumberOfChannels()).toBe(1);
	expect(await track.getSampleRate()).toBe(16000);
	expect(await track.getDecoderConfig()).toBe(null);
	const format = getStreamFormat(track);
	expect(format['formatTag']).toBe(0x0161);
	expect((format['extraData'] as Uint8Array).byteLength).toBe(10);
});

test('Should read the Content Description and Extended Content Description metadata', async () => {
	const source = new FilePathSource(`${ASF_DIRECTORY}/streaming_CBR-7K.wma`);
	using input = new Input({ source, formats: ALL_FORMATS });
	const tags = await input.getMetadataTags();
	expect(tags.title).toBe('tyu');
	expect(tags.artist).toBe('yuty');
	expect(tags.comment).toBe('ctyjtyj');
	expect(tags.raw?.['Copyright']).toBe('yu');
	expect(tags.raw?.['WMFSDKVersion']).toBe('9.00.00.2980');
	// The File Properties play duration less the preroll, as ffprobe gives it
	expect(await input.getDurationFromMetadata()).toBeCloseTo(16.499, 3);
});

/** Checks every key and timestamp lookup of a track against its packets in order. */
const expectLookupsMatchPackets = async (track: InputTrack) => {
	const packets = await readAllPackets(track);
	const times = [
		-1,
		...packets.flatMap(packet => [packet.timestamp - 0.0005, packet.timestamp, packet.timestamp + 0.0005]),
		1e9,
	];
	for (const time of times) {
		const last = packets.filter(packet => packet.timestamp <= time).at(-1) ?? null;
		const lastKey = packets.filter(packet => packet.timestamp <= time && packet.type === 'key').at(-1) ?? null;
		expect((await new PacketReader(track).getAt(time))?.sequenceNumber ?? null).toBe(last?.sequenceNumber ?? null);
		expect((await new PacketReader(track).getKeyAt(time))?.sequenceNumber ?? null)
			.toBe(lastKey?.sequenceNumber ?? null);
	}
	for (const packet of packets) {
		const nextKey = packets.find(other => other.sequenceNumber > packet.sequenceNumber && other.type === 'key');
		expect((await new PacketReader(track).getNextKey(packet))?.sequenceNumber ?? null)
			.toBe(nextKey?.sequenceNumber ?? null);
	}
	return packets;
};

test('Should seek to key frames by the Simple Index Object', async () => {
	using input = new Input({ source: new FilePathSource(`${ASF_DIRECTORY}/wmv8_x8intra.wmv`), formats: ALL_FORMATS });
	for (const track of await input.getTracks()) {
		await expectLookupsMatchPackets(track);
	}
	const video = (await input.getVideoTracks())[0]!;
	const index = (video._backing as unknown as { streamInfo: { keyFrameIndex: { packetIndices: number[] } } })
		.streamInfo.keyFrameIndex;
	expect(index.packetIndices).toHaveLength(41);
});

test('Should seek by bisecting send times in a file cut short of its index, and end at the cut', async () => {
	const bytes = readMedia('wmv8_x8intra.wmv').subarray(0, 300_000);
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const [audio, video] = await input.getTracks();
	expect(await expectLookupsMatchPackets(audio!)).toHaveLength(74);
	const videoPackets = await expectLookupsMatchPackets(video!);
	// FFmpeg hands out the media object the cut ends in, up to the cut
	expect(videoPackets).toHaveLength(306);
});

test('Should descramble audio spread as FFmpeg does', async () => {
	const bytes = readMedia('pcm.asf');
	using plainInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const plainPackets = await readAllPackets((await plainInput.getAudioTracks())[0]!);

	// FFmpeg's muxer writes a span of 1; a span of 2 over 1024-byte virtual packets of 512-byte chunks scrambles
	// each 2048-byte object's chunks in the order 0, 2, 1, 3
	const scrambled = bytes.slice();
	const streamProperties = findGuid(scrambled, ASF_AUDIO_SPREAD) - 40;
	const view = new DataView(scrambled.buffer);
	const errorCorrection = streamProperties + 78 + view.getUint32(streamProperties + 64, true);
	view.setUint8(errorCorrection, 2);
	view.setUint16(errorCorrection + 1, 1024, true);
	view.setUint16(errorCorrection + 3, 512, true);
	using scrambledInput = new Input({ source: new BufferSource(scrambled), formats: ALL_FORMATS });
	const packets = await readAllPackets((await scrambledInput.getAudioTracks())[0]!);

	expect(packets).toHaveLength(plainPackets.length);
	for (const [index, packet] of packets.entries()) {
		const plain = plainPackets[index]!.data;
		const expected = new Uint8Array(plain.length);
		[0, 2, 1, 3].forEach((source, target) => {
			expected.set(plain.subarray(source * 512, source * 512 + 512), target * 512);
		});
		expect(packet.data).toEqual(plain.length === 2048 ? expected : plain);
	}
});

describe('Should refuse DRM-protected files', () => {
	test('with a Content Encryption Object', async () => {
		const bytes = readMedia('mpeg4-b.asf').slice();
		bytes.set(ASF_CONTENT_ENCRYPTION_OBJECT, findGuid(bytes, ASF_HEADER_EXTENSION_OBJECT));
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		await expect(input.getTracks()).rejects.toThrow(ASF_DRM_ERROR_MESSAGE);
	});

	test('with a stream flagged as encrypted', async () => {
		const bytes = readMedia('mpeg4-b.asf').slice();
		const streamProperties = findGuid(bytes, ASF_STREAM_PROPERTIES_OBJECT);
		const view = new DataView(bytes.buffer);
		view.setUint16(streamProperties + 72, view.getUint16(streamProperties + 72, true) | 0x8000, true);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		await expect(input.getTracks()).rejects.toThrow(ASF_DRM_ERROR_MESSAGE);
	});
});

// A crafted ASF file: a Header Object of File Properties and the given header objects, then data packets of a fixed
// size, each of one payload described field by field, so a test can state what a malformed file claims
type CraftedPayload = {
	streamNumber: number;
	objectNumber: number;
	/** The offset into the media object, or a compressed payload's presentation time. */
	offset: number;
	/** The media object size the replicated data claims; null makes a compressed payload. */
	objectSize: number | null;
	presentationTime: number;
	data: Uint8Array;
};

const PCM_WAVE_FORMAT = (() => {
	const waveFormat = new Uint8Array(18);
	const view = new DataView(waveFormat.buffer);
	view.setUint16(0, 1, true); // PCM
	view.setUint16(2, 1, true);
	view.setUint32(4, 8000, true);
	view.setUint32(8, 16000, true);
	view.setUint16(12, 2, true);
	view.setUint16(14, 16, true);
	return waveFormat;
})();

const writeObject = (guid: number[], body: Uint8Array) => {
	const object = new Uint8Array(24 + body.length);
	object.set(guid);
	new DataView(object.buffer).setBigUint64(16, BigInt(object.length), true);
	object.set(body, 24);
	return object;
};

const concatenateBytes = (parts: Uint8Array[]) => {
	const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
};

const FILE_PROPERTIES_GUID = [
	0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11, 0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
const AUDIO_MEDIA_GUID = [
	0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
];
const DATA_OBJECT_GUID = [
	0x36, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
const HEADER_OBJECT_GUID = [
	0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
const EXTENDED_STREAM_PROPERTIES_GUID = [
	0xCB, 0xA5, 0xE6, 0x14, 0x72, 0xC6, 0x32, 0x43, 0x83, 0x99, 0xA9, 0x69, 0x52, 0x06, 0x5B, 0x5A,
];
const INDEX_OBJECT_GUID = [
	0xD3, 0x29, 0xE2, 0xD6, 0xDA, 0x35, 0xD1, 0x11, 0x90, 0x34, 0x00, 0xA0, 0xC9, 0x03, 0x49, 0xBE,
];

/** A Stream Properties Object of a PCM audio stream. */
const createAudioStreamProperties = (streamNumber: number) => {
	const fields = new Uint8Array(54 + PCM_WAVE_FORMAT.length);
	fields.set(AUDIO_MEDIA_GUID);
	const view = new DataView(fields.buffer);
	view.setUint32(40, PCM_WAVE_FORMAT.length, true);
	view.setUint16(48, streamNumber, true);
	fields.set(PCM_WAVE_FORMAT, 54);
	return writeObject(ASF_STREAM_PROPERTIES_OBJECT, fields);
};

/** A Header Extension Object holding an Extended Stream Properties Object with the stream's properties embedded. */
const createHeaderExtensionWithEmbeddedStream = (streamNumber: number) => {
	const espFields = new Uint8Array(64);
	new DataView(espFields.buffer).setUint16(48, streamNumber, true);
	const espBody = concatenateBytes([espFields, createAudioStreamProperties(streamNumber)]);
	const esp = writeObject(EXTENDED_STREAM_PROPERTIES_GUID, espBody);
	const extensionFields = new Uint8Array(22);
	new DataView(extensionFields.buffer).setUint32(18, esp.length, true);
	return writeObject(ASF_HEADER_EXTENSION_OBJECT, concatenateBytes([extensionFields, esp]));
};

/** Writes a data packet of one payload: a word of padding length, then byte stream and object numbers, a double
 * word offset, and a byte replicated data length. */
const createDataPacket = (payload: CraftedPayload, packetSize: number) => {
	const compressed = payload.objectSize === null;
	const replicatedLength = compressed ? 1 : 8;
	const headerSize = 10 + 7 + replicatedLength;
	const packet = new Uint8Array(packetSize);
	const view = new DataView(packet.buffer);
	view.setUint8(0, 0x10);
	view.setUint8(1, 0x5D);
	view.setUint16(2, packetSize - headerSize - payload.data.length, true);
	view.setUint8(10, payload.streamNumber | 0x80);
	view.setUint8(11, payload.objectNumber);
	view.setUint32(12, payload.offset, true);
	view.setUint8(16, replicatedLength);
	if (compressed) {
		view.setUint8(17, 1); // The time step between sub-payloads
	} else {
		view.setUint32(17, payload.objectSize!, true);
		view.setUint32(21, payload.presentationTime, true);
	}
	packet.set(payload.data, headerSize);
	return packet;
};

const createCraftedASF = (
	headerObjects: Uint8Array[],
	payloads: CraftedPayload[],
	packetSize: number,
	trailingObjects: Uint8Array[] = [],
) => {
	const fileProperties = new Uint8Array(80);
	const view = new DataView(fileProperties.buffer);
	view.setBigUint64(32, BigInt(payloads.length), true);
	view.setUint32(68, packetSize, true);
	view.setUint32(72, packetSize, true);
	const children = [writeObject(FILE_PROPERTIES_GUID, fileProperties), ...headerObjects];
	const headerFields = new Uint8Array(6);
	new DataView(headerFields.buffer).setUint32(0, children.length, true);
	const header = writeObject(HEADER_OBJECT_GUID, concatenateBytes([headerFields, ...children]));
	const dataFields = new Uint8Array(26);
	new DataView(dataFields.buffer).setBigUint64(16, BigInt(payloads.length), true);
	const data = writeObject(
		DATA_OBJECT_GUID,
		concatenateBytes([dataFields, ...payloads.map(payload => createDataPacket(payload, packetSize))]),
	);
	return concatenateBytes([header, data, ...trailingObjects]);
};

describe('Crafted ASF files', () => {
	test('Should keep the tracks in header order, an embedded stream at its Header Extension\'s place', async () => {
		// FFmpeg's asf_read_header creates a stream for each Stream Properties Object as its header walk meets it,
		// descending into the Header Extension where it stands
		const bytes = createCraftedASF(
			[
				createAudioStreamProperties(2),
				createHeaderExtensionWithEmbeddedStream(3),
				createAudioStreamProperties(1),
			],
			[1, 2, 3].map(streamNumber => ({
				streamNumber, objectNumber: 0, offset: 0, objectSize: 2, presentationTime: 0, data: new Uint8Array(2),
			})),
			64,
		);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		expect((await input.getAudioTracks()).map(track => track.id)).toEqual([2, 3, 1]);
	});

	/** Reads the sizes of the packets of a crafted file of objects of one stream, cut within its last packet so its
	 * fragment holds 16 of its 32 bytes. */
	const readCutObjectSizes = async (payloads: CraftedPayload[]) => {
		const whole = createCraftedASF([createAudioStreamProperties(1)], payloads, 80);
		// Past the last packet's 25-byte packet and payload header
		const bytes = whole.subarray(0, whole.length - 80 + 25 + 16);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const packets = await readAllPackets((await input.getAudioTracks())[0]!);
		return packets.map(packet => packet.data.byteLength);
	};

	test('Should refuse a media object of 16 MiB or more, whatever its cut fragment claims', async () => {
		const huge = 0xFFFFFFFF;
		// Without the refusal, the cut fragment's offset would size the object at almost 4 GiB
		expect(await readCutObjectSizes([
			{
				streamNumber: 1, objectNumber: 0, offset: 0, objectSize: huge, presentationTime: 0,
				data: new Uint8Array(32),
			},
			{
				streamNumber: 1, objectNumber: 0, offset: 0xFFFF0000, objectSize: huge, presentationTime: 0,
				data: new Uint8Array(32),
			},
		])).toEqual([]);
	});

	test('Should end a cut object at the bytes read, and refuse a fragment that leaves a gap', async () => {
		const first = {
			streamNumber: 1, objectNumber: 0, offset: 0, objectSize: 64, presentationTime: 0, data: new Uint8Array(32),
		};
		expect(await readCutObjectSizes([first, { ...first, offset: 32 }])).toEqual([48]);
		expect(await readCutObjectSizes([first, { ...first, offset: 40 }])).toEqual([]);
	});

	test('Should hand out no more than 65536 sub-payloads of a compressed payload', async () => {
		// 100000 one-byte sub-payloads, each its own media object
		const subPayloads = new Uint8Array(200_000);
		for (let i = 0; i < subPayloads.length; i += 2) {
			subPayloads[i] = 1;
		}
		const bytes = createCraftedASF(
			[createAudioStreamProperties(1)],
			[{ streamNumber: 1, objectNumber: 0, offset: 0, objectSize: null, presentationTime: 0, data: subPayloads }],
			200_100,
		);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const track = (await input.getAudioTracks())[0]!;
		const reader = new PacketReader(track);
		let count = 0;
		const options = { metadataOnly: true };
		for (let packet = await reader.getFirst(options); packet; packet = await reader.getNext(packet, options)) {
			count++;
		}
		expect(count).toBe(0x10000);
	});

	test('Should pass over an Index Object of no specifiers, or of more entries than it holds', async () => {
		const zeroSpecifiers = new Uint8Array(14);
		const view = new DataView(zeroSpecifiers.buffer);
		view.setUint32(0, 1000, true);
		view.setUint16(4, 0, true);
		view.setUint32(6, 0xFFFFFFFF, true);
		view.setUint32(10, 0xFFFFFFFF, true);
		const oneSpecifier = new Uint8Array(30);
		const oneView = new DataView(oneSpecifier.buffer);
		oneView.setUint32(0, 1000, true);
		oneView.setUint16(4, 1, true);
		oneView.setUint16(6, 1, true);
		oneView.setUint32(10, 1, true);
		oneView.setUint32(14, 0xFFFFFFFF, true);
		const media = readMedia('mpeg4-b.asf');
		for (const index of [zeroSpecifiers, oneSpecifier]) {
			const bytes = concatenateBytes([media, writeObject(INDEX_OBJECT_GUID, index)]);
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const track = (await input.getVideoTracks())[0]!;
			expect((await new PacketReader(track).getKeyAt(0.5))?.timestamp).toBe(0.4);
		}
	});
});
