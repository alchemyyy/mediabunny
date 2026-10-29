/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	EncodedPacket,
	FilePathSource,
	Input,
	InputTrack,
	MPEG_PS,
	PacketReader,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';
import { MpegPsDemuxer } from '../../src/mpeg-ps/mpeg-ps-demuxer.js';

// The test media, which FFmpeg's muxers wrote: an MPEG-1 system stream (-f mpeg) of MPEG-1 video with B-frames and
// MP2 audio, and DVD-Video program streams (-f vob) of MPEG-2 video with B-frames and AC-3, LPCM, or DTS audio. The
// expected values are what ffprobe -show_packets -show_data_hash MD5 prints of each file.
const MPEG_PS_DIRECTORY = './test/public/mpeg-ps';
const TIMESCALE = 90_000;
const TIMESTAMP_MODULUS = 2 ** 33;

type ExpectedTrack = {
	type: 'video' | 'audio';
	codec: string;
	/** The stream's ID, as FFmpeg gives it. */
	id: number;
	decoderCodec: string;
	/** A video frame's duration, in 90 kHz units. */
	frameDuration?: number;
	keyIndices?: number[];
	numberOfChannels?: number;
	sampleRate?: number;
	/**
	 * Each packet's PTS, in 90 kHz units and decode order, or null where FFmpeg leaves it unset: some of the I and P
	 * pictures, which its decoder presents a frame after the pictures before them, and LPCM packets that begin in a PES
	 * packet without a PTS.
	 */
	timestamps: (number | null)[];
	/** The MD5 of the concatenated hexadecimal MD5s of the track's packets, FFmpeg's LPCM ones less their header. */
	dataHash: string;
};

const EXPECTED: Record<string, ExpectedTrack[]> = {
	'mpeg1-mp2.mpg': [
		{
			type: 'video', codec: 'mpeg1', id: 0x1e0, decoderCodec: 'mp4v.6a',
			frameDuration: 3750, keyIndices: [0, 4, 10, 16, 22],
			timestamps: [
				48750, 60000, 52500, 56250, null, 63750, 67500, null, 75000, 78750, null, 86250, 90000, null,
				97500, 101250, null, 108750, 112500, null, 120000, 123750, 135000, 131250,
			],
			dataHash: 'edebb926673099baa97fb44d15d527ea',
		},
		{
			type: 'audio', codec: 'mp3', id: 0x1c0, decoderCodec: 'mp3',
			numberOfChannels: 1, sampleRate: 44100,
			timestamps: [
				47768, 50119, 52470, 54821, 57172, 59523, 61874, 64225, 66576, 68927, 71279, 73630, 75981,
				78332, 80683, 83034, 85385, 87736, 90087, 92438, 94789, 97140, 99491, 101842, 104193, 106544,
				108895, 111246, 113597, 115948, 118299, 120650, 123001, 125352, 127703, 130054, 132405, 134756,
				137107,
			],
			dataHash: '5bd98e3a54293203d7bf69817c6b4a2d',
		},
	],
	'mpeg2-ac3.vob': [
		{
			type: 'video', codec: 'mpeg2', id: 0x1e0, decoderCodec: 'mp4v.61',
			frameDuration: 3600, keyIndices: [0, 10, 22, 34, 46, 58, 70],
			timestamps: [
				48600, 59400, 52200, 55800, null, 63000, 66600, null, 73800, 77400, null, 84600, 88200, null,
				95400, 99000, 113400, 106200, 109800, null, 117000, 120600, null, 127800, 131400, null, 138600,
				142200, null, 149400, 153000, null, 160200, 163800, null, 171000, 174600, null, 181800, 185400,
				199800, 192600, 196200, null, 203400, 207000, null, 214200, 217800, 232200, 225000, 228600,
				null, 235800, 239400, 253800, 246600, 250200, null, 257400, 261000, null, 268200, 271800, null,
				279000, 282600, null, 289800, 293400, null, 300600, 304200, null, 311400,
			],
			dataHash: '841170f9d4d92fc6548d225c1d89754a',
		},
		{
			type: 'audio', codec: 'ac3', id: 0x80, decoderCodec: 'ac-3',
			numberOfChannels: 2, sampleRate: 48000,
			timestamps: [
				48120, 51000, 53880, 56760, 59640, 62520, 65400, 68280, 71160, 74040, 76920, 79800, 82680,
				85560, 88440, 91320, 94200, 97080, 99960, 102840, 105720, 108600, 111480, 114360, 117240,
				120120, 123000, 125880, 128760, 131640, 134520, 137400, 140280, 143160, 146040, 148920, 151800,
				154680, 157560, 160440, 163320, 166200, 169080, 171960, 174840, 177720, 180600, 183480, 186360,
				189240, 192120, 195000, 197880, 200760, 203640, 206520, 209400, 212280, 215160, 218040, 220920,
				223800, 226680, 229560, 232440, 235320, 238200, 241080, 243960, 246840, 249720, 252600, 255480,
				258360, 261240, 264120, 267000, 269880, 272760, 275640, 278520, 281400, 284280, 287160, 290040,
				292920, 295800, 298680, 301560, 304440, 307320, 310200, 313080, 315960,
			],
			dataHash: 'c32a96416fb45f7b67dc79d7bf71d71d',
		},
	],
	'mpeg2-lpcm.vob': [
		{
			type: 'video', codec: 'mpeg2', id: 0x1e0, decoderCodec: 'mp4v.61',
			frameDuration: 3600, keyIndices: [0],
			timestamps: [
				48600, 59400, 52200, 55800, null, 63000, 66600, null,
			],
			dataHash: '34b2795bfb33811514ac29b12ac344ec',
		},
		{
			type: 'audio', codec: 'pcm-s16be', id: 0xa0, decoderCodec: 'pcm-s16be',
			numberOfChannels: 2, sampleRate: 48000,
			timestamps: [
				48600, null, 50520, null, 52440, null, 54360, null, 56280, null, 58200, null, 60120, null,
				62040, null, 63960, null, 65880, null, 67800, null, 69720, null, 71640, null, 73560, null,
				75480,
			],
			dataHash: 'd8a4dc2f603a055b2e92ae4717764e16',
		},
	],
	'mpeg2-dts.vob': [
		{
			type: 'video', codec: 'mpeg2', id: 0x1e0, decoderCodec: 'mp4v.61',
			frameDuration: 3600, keyIndices: [0],
			timestamps: [
				48600, 59400, 52200, 55800, null, 63000, 66600, null,
			],
			dataHash: '34b2795bfb33811514ac29b12ac344ec',
		},
		{
			type: 'audio', codec: 'dts', id: 0x88, decoderCodec: 'dtsc',
			numberOfChannels: 2, sampleRate: 48000,
			timestamps: [
				48600, 49560, 50520, 51480, 52440, 53400, 54360, 55320, 56280, 57240, 58200, 59160, 60120,
				61080, 62040, 63000, 63960, 64920, 65880, 66840, 67800, 68760, 69720, 70680, 71640, 72600,
				73560, 74520, 75480,
			],
			dataHash: '376bf30fa52c1cd8780dce62b4fbae12',
		},
	],
};

const readMedia = (name: string) => new Uint8Array(readFileSync(`${MPEG_PS_DIRECTORY}/${name}`));

const openMedia = (name: string) => new Input({
	source: new FilePathSource(`${MPEG_PS_DIRECTORY}/${name}`),
	formats: ALL_FORMATS,
});

const readAllPackets = async (track: InputTrack) => {
	const reader = new PacketReader(track);
	const packets: EncodedPacket[] = [];
	for (let packet = await reader.getFirst(); packet; packet = await reader.getNext(packet)) {
		packets.push(packet);
	}
	return packets;
};

const toTicks = (seconds: number) => Math.round(seconds * TIMESCALE);

const hashPackets = (packets: EncodedPacket[]) => createHash('md5')
	.update(packets.map(packet => createHash('md5').update(packet.data).digest('hex')).join(''))
	.digest('hex');

/** Calls back with the offset and start code of each pack header and PES packet of a program stream. */
const forEachUnit = (bytes: Uint8Array, callback: (offset: number, code: number) => void) => {
	let offset = 0;
	while (offset + 6 <= bytes.length) {
		const code = bytes[offset + 3]!;
		callback(offset, code);
		if (code !== 0xba) {
			offset += 6 + ((bytes[offset + 4]! << 8) | bytes[offset + 5]!);
		} else if ((bytes[offset + 4]! & 0xf0) === 0x20) {
			offset += 12; // An MPEG-1 pack header
		} else {
			offset += 14 + (bytes[offset + 13]! & 0x07);
		}
	}
};

const getUnitEnd = (bytes: Uint8Array, offset: number) => offset + 6 + ((bytes[offset + 4]! << 8) | bytes[offset + 5]!);

const hasPts = (bytes: Uint8Array, offset: number) => (bytes[offset + 7]! & 0x80) !== 0;

const readTimestamp = (bytes: Uint8Array, offset: number) => ((bytes[offset]! >> 1) & 0x07) * 2 ** 30
	+ ((bytes[offset + 1]! << 7) | (bytes[offset + 2]! >> 1)) * 2 ** 15
	+ ((bytes[offset + 3]! << 7) | (bytes[offset + 4]! >> 1));

const writeTimestamp = (bytes: Uint8Array, offset: number, value: number) => {
	const middle = Math.floor(value / 2 ** 15) % 2 ** 15;
	const low = value % 2 ** 15;
	bytes[offset] = (bytes[offset]! & 0xf0) | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 1;
	bytes[offset + 1] = middle >> 7;
	bytes[offset + 2] = ((middle & 0x7f) << 1) | 1;
	bytes[offset + 3] = low >> 7;
	bytes[offset + 4] = ((low & 0x7f) << 1) | 1;
};

// An MPEG-2 pack header's SCR base, around the marker bits; its extension is left alone
const readScr = (bytes: Uint8Array, offset: number) => ((bytes[offset]! >> 3) & 0x07) * 2 ** 30
	+ (bytes[offset]! & 0x03) * 2 ** 28
	+ bytes[offset + 1]! * 2 ** 20
	+ (bytes[offset + 2]! >> 3) * 2 ** 15
	+ (bytes[offset + 2]! & 0x03) * 2 ** 13
	+ bytes[offset + 3]! * 2 ** 5
	+ (bytes[offset + 4]! >> 3);

const writeScr = (bytes: Uint8Array, offset: number, value: number) => {
	const low = value % 2 ** 30;
	bytes[offset] = 0x44 | ((Math.floor(value / 2 ** 30) & 0x07) << 3) | ((low >>> 28) & 0x03);
	bytes[offset + 1] = (low >>> 20) & 0xff;
	bytes[offset + 2] = (((low >>> 15) & 0x1f) << 3) | 0x04 | ((low >>> 13) & 0x03);
	bytes[offset + 3] = (low >>> 5) & 0xff;
	bytes[offset + 4] = ((low & 0x1f) << 3) | 0x04 | (bytes[offset + 4]! & 0x03);
};

test('Should detect MPEG program streams by their pack header', async () => {
	for (const name of ['mpeg1-mp2.mpg', 'mpeg2-ac3.vob']) {
		using input = openMedia(name);
		expect(await input.getFormat()).toBe(MPEG_PS);
	}

	expect(MPEG_PS.name).toBe('MPEG Program Stream');
	expect(MPEG_PS.mimeType).toBe('video/MP2P');

	// A pack header whose SCR begins with neither MPEG-1's nor MPEG-2's marker bits
	const bytes = readMedia('mpeg2-ac3.vob');
	bytes[4] = 0x00;
	using input = new Input({ source: new BufferSource(bytes), formats: [MPEG_PS] });
	await expect(input.getFormat()).rejects.toThrow();
});

describe('MPEG program stream packets match ffprobe', () => {
	for (const [name, expectedTracks] of Object.entries(EXPECTED)) {
		test(name, async () => {
			using input = openMedia(name);
			const tracks = await input.getTracks();
			expect(tracks.map(track => track.type)).toEqual(expectedTracks.map(track => track.type));

			for (const [index, expected] of expectedTracks.entries()) {
				const track = tracks[index]!;
				expect(await track.getCodec()).toBe(expected.codec);
				expect(track.id).toBe(expected.id);
				expect(await track.getInternalCodecId()).toBe(expected.id);

				const packets = await readAllPackets(track);
				const timestamps = packets.map(packet => toTicks(packet.timestamp));
				expect(packets).toHaveLength(expected.timestamps.length);
				expect(hashPackets(packets)).toBe(expected.dataHash);

				for (const [i, timestamp] of expected.timestamps.entries()) {
					if (timestamp !== null) {
						expect(timestamps[i]).toBe(timestamp);
					}
				}

				if (track.isVideoTrack()) {
					expect((await track.getDecoderConfig())?.codec).toBe(expected.decoderCodec);
					expect(await track.getCodedWidth()).toBe(192);
					expect(await track.getCodedHeight()).toBe(192);
					const keyIndices = packets.flatMap((packet, i) => packet.type === 'key' ? [i] : []);
					expect(keyIndices).toEqual(expected.keyIndices);

					// Presented in order, the pictures follow one another a frame apart
					const frameDuration = expected.frameDuration!;
					const presentationTimestamps = [...timestamps].sort((a, b) => a - b);
					expect(presentationTimestamps).toEqual(
						presentationTimestamps.map((_, i) => presentationTimestamps[0]! + i * frameDuration),
					);
				} else {
					assert(track.isAudioTrack());
					expect((await track.getDecoderConfig())?.codec).toBe(expected.decoderCodec);
					expect(await track.getNumberOfChannels()).toBe(expected.numberOfChannels);
					expect(await track.getSampleRate()).toBe(expected.sampleRate);
					expect(packets.every(packet => packet.type === 'key')).toBe(true);

					// An LPCM packet without a PTS of its own follows on from the samples of the one before it
					for (const [i, timestamp] of expected.timestamps.entries()) {
						if (timestamp === null) {
							const previous = packets[i - 1]!;
							const sampleCount = previous.byteLength / (2 * expected.numberOfChannels!);
							const duration = Math.round(sampleCount * TIMESCALE / expected.sampleRate!);
							expect(timestamps[i]).toBe(timestamps[i - 1]! + duration);
						}
					}
				}
			}
		});
	}
});

test('Should time MPEG video pictures by display order where their PES packets carry no PTS', async () => {
	using original = openMedia('mpeg2-ac3.vob');
	const originalPackets = await readAllPackets((await original.getPrimaryVideoTrack())!);

	// As DVD-Video often has it, only the PES packets beginning a group of pictures keep their PTS; then only the first
	const keepsGroupStart = (bytes: Uint8Array, offset: number) => {
		const end = offset + 6 + ((bytes[offset + 4]! << 8) | bytes[offset + 5]!);
		const payload = bytes.subarray(offset + 9 + bytes[offset + 8]!, end);
		return payload.some((byte, i) => byte === 0xb3 && payload[i - 1] === 0x01 && payload[i - 2] === 0x00);
	};
	let isFirst = true;
	const keepsFirst = () => {
		const keep = isFirst;
		isFirst = false;
		return keep;
	};

	for (const keepsPts of [keepsGroupStart, keepsFirst]) {
		const bytes = readMedia('mpeg2-ac3.vob');
		let strippedCount = 0;
		forEachUnit(bytes, (offset, code) => {
			if (code === 0xe0 && hasPts(bytes, offset) && !keepsPts(bytes, offset)) {
				// PTS_DTS_flags, leaving the timestamps as header stuffing
				bytes[offset + 7]! &= 0x3f;
				strippedCount++;
			}
		});
		expect(strippedCount).toBeGreaterThan(5);

		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const packets = await readAllPackets((await input.getPrimaryVideoTrack())!);
		const describePacket = (packet: EncodedPacket) => [
			packet.timestamp,
			packet.duration,
			packet.type,
			packet.sequenceNumber,
		];
		expect(packets.map(describePacket)).toEqual(originalPackets.map(describePacket));
	}
});

test('Should order MPEG program stream tracks by their first PES packets and skip subpictures', async () => {
	const bytes = readMedia('mpeg2-ac3.vob');
	let firstVideoOffset = -1;
	let firstAudio: Uint8Array | null = null;
	forEachUnit(bytes, (offset, code) => {
		const end = offset + 6 + ((bytes[offset + 4]! << 8) | bytes[offset + 5]!);
		if (code === 0xe0 && firstVideoOffset === -1) {
			firstVideoOffset = offset;
		} else if (code === 0xbd && !firstAudio) {
			firstAudio = bytes.slice(offset, end);
		}
	});
	assert(firstAudio);

	// A subpicture packet and a copy of the first AC-3 packet as substream 0x81, both ahead of the video
	const audio: Uint8Array = firstAudio;
	audio[9 + audio[8]!] = 0x81;
	const subpicture = [
		0x00, 0x00, 0x01, 0xbd, 0x00, 0x0d, 0x81, 0x80, 0x05, 0x21, 0x00, 0x05, 0x7b, 0x0d, 0x20, 1, 2, 3, 4,
	];
	const edited = new Uint8Array([
		...bytes.subarray(0, firstVideoOffset),
		...subpicture,
		...audio,
		...bytes.subarray(firstVideoOffset),
	]);

	using input = new Input({ source: new BufferSource(edited), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	expect(tracks.map(track => [track.type, track.id])).toEqual([['audio', 0x81], ['video', 0x1e0], ['audio', 0x80]]);
	const [copiedPacket] = await readAllPackets(tracks[0]!);
	const [originalPacket] = await readAllPackets(tracks[2]!);
	expect([copiedPacket!.timestamp, copiedPacket!.data]).toEqual([originalPacket!.timestamp, originalPacket!.data]);
});

test('Should leave out MPEG program stream LPCM of more than 16 bits per sample', async () => {
	const bytes = readMedia('mpeg2-lpcm.vob');
	forEachUnit(bytes, (offset, code) => {
		if (code === 0xbd) {
			// The LPCM header's quantization, after the substream ID, frame count, first access unit pointer, and
			// emphasis byte: 24 bits
			bytes[offset + 9 + bytes[offset + 8]! + 5] = (bytes[offset + 9 + bytes[offset + 8]! + 5]! & 0x3f) | 0x80;
		}
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect((await input.getTracks()).map(track => track.type)).toEqual(['video']);
});

describe('MPEG program stream seeking', () => {
	for (const seekChunkSize of [null, 2048]) {
		test(`with ${seekChunkSize === null ? 'the default' : 'a small'} seek chunk size`, async () => {
			for (const name of ['mpeg2-ac3.vob', 'mpeg1-mp2.mpg']) {
				using input = openMedia(name);
				const tracks = await input.getTracks();
				if (seekChunkSize !== null) {
					// Bisect the file down to a few packs before reading forward
					(await input._demuxerPromise as MpegPsDemuxer).seekChunkSize = seekChunkSize;
				}

				for (const track of tracks) {
					const packets = await readAllPackets(track);
					const reader = new PacketReader(track);
					const lastPresented = packets.reduce(
						(last, packet) => packet.timestamp > last.timestamp ? packet : last,
					);

					const firstTimestamp = Math.min(...packets.map(packet => packet.timestamp));
					expect(await reader.getAt(firstTimestamp - 0.001)).toBeNull();
					expect(await reader.getKeyAt(-1)).toBeNull();
					expect((await reader.getAt(Infinity))?.sequenceNumber).toBe(lastPresented.sequenceNumber);
					expect(await track.computeDuration()).toBeCloseTo(lastPresented.timestamp + lastPresented.duration);

					for (const [index, packet] of packets.entries()) {
						const found = await reader.getAt(packet.timestamp);
						assert(found);
						expect([found.sequenceNumber, found.timestamp, found.duration])
							.toEqual([packet.sequenceNumber, packet.timestamp, packet.duration]);
						expect((await reader.getNext(found))?.sequenceNumber).toBe(packets[index + 1]?.sequenceNumber);

						// The last key packet presented by then
						const key = packets
							.filter(candidate => candidate.type === 'key' && candidate.timestamp <= packet.timestamp)
							.reduce((last, candidate) => candidate.timestamp > last.timestamp ? candidate : last);
						const foundKey = await reader.getKeyAt(packet.timestamp + 0.001);
						expect(foundKey?.sequenceNumber).toBe(key.sequenceNumber);
					}
				}
			}
		});
	}

	test('reads on from a packet whose reading moved on', async () => {
		using input = openMedia('mpeg2-ac3.vob');
		const tracks = await input.getTracks();
		(await input._demuxerPromise as MpegPsDemuxer).seekChunkSize = 2048;

		for (const track of tracks) {
			const packets = await readAllPackets(track);
			const reader = new PacketReader(track);
			for (const [index, packet] of packets.entries()) {
				const next = await reader.getNext(packet);
				expect([next?.sequenceNumber, next?.timestamp])
					.toEqual([packets[index + 1]?.sequenceNumber, packets[index + 1]?.timestamp]);
			}
		}
	});
});

test('Should read MPEG program stream timestamps across their wraparound', async () => {
	using original = openMedia('mpeg2-ac3.vob');
	const originalTracks = await original.getTracks();

	// Two seconds earlier, which puts the start just short of the 33-bit modulus and wraps a second and a half in
	const shift = TIMESTAMP_MODULUS - 2 * TIMESCALE;
	const bytes = readMedia('mpeg2-ac3.vob');
	forEachUnit(bytes, (offset, code) => {
		if (code === 0xba) {
			writeScr(bytes, offset + 4, (readScr(bytes, offset + 4) + shift) % TIMESTAMP_MODULUS);
		} else if ((code === 0xe0 || code === 0xbd) && hasPts(bytes, offset)) {
			const timestampCount = bytes[offset + 7]! >> 6 === 0b11 ? 2 : 1;
			for (let i = 0; i < timestampCount; i++) {
				const timestampOffset = offset + 9 + 5 * i;
				const timestamp = (readTimestamp(bytes, timestampOffset) + shift) % TIMESTAMP_MODULUS;
				writeTimestamp(bytes, timestampOffset, timestamp);
			}
		}
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	(await input._demuxerPromise as MpegPsDemuxer).seekChunkSize = 2048;

	for (const [index, track] of tracks.entries()) {
		const originalPackets = await readAllPackets(originalTracks[index]!);
		const packets = await readAllPackets(track);
		expect(packets.map(packet => toTicks(packet.timestamp)))
			.toEqual(originalPackets.map(packet => toTicks(packet.timestamp) - 2 * TIMESCALE));

		const reader = new PacketReader(track);
		const lastKey = originalPackets.filter(packet => packet.type === 'key').at(-1)!;
		expect((await reader.getKeyAt(lastKey.timestamp - 2))?.sequenceNumber).toBe(lastKey.sequenceNumber);
	}
});

test('Should detect a program stream whose first pack holds MPEG audio frames as MPEG-PS, not MP3', async () => {
	// The first audio packet moved ahead of the first video packet, so the first 4 KB hold consecutive MP2 frames, as
	// an MPEG-1 system stream may start
	const bytes = readMedia('mpeg1-mp2.mpg');
	let firstVideoOffset = -1;
	let audioOffset = -1;
	forEachUnit(bytes, (offset, code) => {
		if (code === 0xe0 && firstVideoOffset === -1) {
			firstVideoOffset = offset;
		} else if (code === 0xc0 && audioOffset === -1) {
			audioOffset = offset;
		}
	});
	expect(audioOffset).toBeGreaterThan(firstVideoOffset);
	const audioEnd = getUnitEnd(bytes, audioOffset);
	const edited = new Uint8Array([
		...bytes.subarray(0, firstVideoOffset),
		...bytes.subarray(audioOffset, audioEnd),
		...bytes.subarray(firstVideoOffset, audioOffset),
		...bytes.subarray(audioEnd),
	]);

	using input = new Input({ source: new BufferSource(edited), formats: ALL_FORMATS });
	expect(await input.getFormat()).toBe(MPEG_PS);
	// Its tracks come in the order of their first packets
	expect((await input.getTracks()).map(track => track.type)).toEqual(['audio', 'video']);
});

test('Should leave out a program stream track whose packets cannot be read', async () => {
	// MP2 PES packets emptied of their frames, as audio of another codec in an MPEG audio stream ID would read
	const bytes = readMedia('mpeg1-mp2.mpg');
	forEachUnit(bytes, (offset, code) => {
		if (code === 0xc0) {
			let dataOffset = offset + 6;
			while (bytes[dataOffset] === 0xff) {
				dataOffset++;
			}
			const marker = bytes[dataOffset]! >> 4;
			dataOffset += marker === 0b0010 ? 5 : marker === 0b0011 ? 10 : 1;
			bytes.fill(0, dataOffset, getUnitEnd(bytes, offset));
		}
	});

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	expect(tracks.map(track => track.type)).toEqual(['video']);
	expect(await readAllPackets(tracks[0]!)).toHaveLength(24);
});
