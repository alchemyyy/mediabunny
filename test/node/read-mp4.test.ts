import { expect, test } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CustomSource,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedVideoPacketSource,
	FilePathSource,
	Input,
	MP4,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
	PacketCursor,
	PacketReader,
	QTFF,
	ReadableStreamSource,
	UrlSource,
} from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should be able to get packets from a .MP4 file', async () => {
	const filePath = path.join(__dirname, '..', 'public/video.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);
	expect(await input.getMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
	expect(await input.computeDuration()).toBe(5.056);

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const cursor = new PacketCursor(track);

	let samples = 0;
	const timestamps: number[] = [];

	for await (const packet of cursor) {
		timestamps.push(packet.timestamp);
		samples++;
	}

	expect(samples).toBe(125);
	expect(timestamps.slice(0, 10)).toEqual([
		0, 0.16, 0.08, 0.04, 0.12, 0.32, 0.24, 0.2, 0.28, 0.48,
	]);
});

test('MP4 nclx color information', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(false);
	expect(str.includes('nclx')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: false,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

test('QuickTime nclc color information', async () => {
	const output = new Output({
		format: new MovOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1),
		{
			decoderConfig: {
				codec: 'vp8',
				codedWidth: 1280,
				codedHeight: 720,
				colorSpace: {
					primaries: 'bt2020' as VideoColorPrimaries,
					transfer: 'pq' as VideoTransferCharacteristics,
					matrix: 'bt2020-ncl' as VideoMatrixCoefficients,
					fullRange: false,
				},
			},
		},
	);
	await output.finalize();

	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('nclc')).toBe(true);
	expect(str.includes('nclx')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	expect(await track.getColorSpace()).toEqual({
		primaries: 'bt2020',
		transfer: 'pq',
		matrix: 'bt2020-ncl',
		fullRange: undefined,
	});
	expect(await track.hasHighDynamicRange()).toBe(true);
});

// Annex B isn't supposed to exist in MP4, but some files have it anyway, with an empty avcC box
test('Annex B', async () => {
	const filePath = path.join(__dirname, '..', 'public/annex-b.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error('No video track found');

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('avc1.424028');
	expect(decoderConfig.description).toBeUndefined();

	const packetReader = new PacketReader(track);
	const firstPacket = (await packetReader.getFirst())!;
	expect([...firstPacket.data.slice(0, 4)]).toEqual([0, 0, 0, 1]);
});

test('HE-AAC v2 audio config is parsed correctly', async () => {
	const filePath = path.join(__dirname, '..', 'public/he-aac-v2.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getSampleRate()).toBe(44100);
	expect(await track.getNumberOfChannels()).toBe(2);

	const decoderConfig = (await track.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('mp4a.40.29');
	expect(decoderConfig.sampleRate).toBe(44100);
	expect(decoderConfig.numberOfChannels).toBe(2);
	expect([...toUint8Array(decoderConfig.description!)]).toEqual([0xeb, 0x8a, 0x08, 0x00]);
});

test('PCM track with stsc not starting at the first chunk', async () => {
	// The stsc box's first entry starts at the second chunk, leaving three chunks of PCM audio
	const filePath = path.join(__dirname, '..', 'public/pcm-stsc-not-first-chunk.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	let packetCount = 0;
	for await (const packet of new PacketCursor(track, { options: { metadataOnly: true } })) {
		void packet;
		packetCount++;
	}

	expect(packetCount).toBe(3);
});

test('Missing tfdt and tfra entries referencing non-first samples', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/578
	const filePath = path.join(__dirname, '..', 'public/missing-tfdt.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const timestamps: number[] = [];
	for await (const packet of new PacketCursor(track)) {
		timestamps.push(Number(packet.timestamp.toFixed(6)));
	}

	// Taken from ffprobe
	expect(timestamps).toEqual([
		0, 0.016667, 0.033333, 0.05, 0.066667, 0.083333, 0.1, 0.116667, 0.133333, 0.15,
		0.166667, 0.183333, 0.2, 0.216667, 0.233333, 0.25, 0.266667, 0.283333, 0.3, 0.316667,
		0.333333, 0.35, 0.366667, 0.383333, 0.4, 0.416667, 0.433333, 0.45, 0.466667, 0.483333,
		0.5, 0.516667, 0.533333, 0.55, 0.566667, 0.583333, 0.6, 0.616667, 0.633333, 0.65,
		0.666667, 0.683333, 0.7, 0.716667, 0.733333, 0.75, 0.766667, 0.783333, 0.8, 0.816667,
		0.833333, 0.85, 0.866667, 0.883333, 0.9, 0.916667, 0.933333, 0.95, 0.966667, 0.983333,
		1, 1.016667, 1.033333, 1.05, 1.066667, 1.083333, 1.1, 1.116667, 1.133333, 1.15,
		1.166667, 1.183333, 1.2, 1.216667, 1.233333, 1.25, 1.266667, 1.283333, 1.3, 1.316667,
		1.333333, 1.35, 1.366667, 1.383333, 1.4, 1.416667, 1.433333, 1.45, 1.466667, 1.483333,
		1.5, 1.516667, 1.533333, 1.55, 1.566667, 1.583333, 1.6, 1.616667, 1.633333, 1.65,
		1.666667, 1.683333, 1.7, 1.716667, 1.733333, 1.75, 1.766667, 1.783333, 1.8, 1.816667,
		1.833333, 1.85, 1.866667, 1.883333, 1.9, 1.916667, 1.933333, 1.95, 1.966667, 1.983333,
		2, 2.016667, 2.033333, 2.05, 2.066667, 2.083333, 2.1, 2.116667, 2.133333, 2.15,
		2.166667, 2.183333, 2.2, 2.216667, 2.233333, 2.25, 2.266667, 2.283333, 2.3, 2.316667,
		2.333333, 2.35, 2.366667, 2.383333, 2.4, 2.416667, 2.433333, 2.45, 2.466667, 2.483333,
		2.5, 2.516667, 2.533333, 2.55, 2.566667, 2.583333, 2.6, 2.616667, 2.633333, 2.65,
		2.666667, 2.683333, 2.7, 2.716667, 2.733333, 2.75, 2.766667, 2.783333, 2.8, 2.816667,
		2.833333, 2.85, 2.866667, 2.883333, 2.9, 2.916667, 2.933333, 2.95, 2.966667, 2.983333,
		3, 3.016667, 3.033333, 3.05, 3.066667, 3.083333, 3.1, 3.116667, 3.133333, 3.15,
		3.166667, 3.183333, 3.2, 3.216667, 3.233333, 3.25, 3.266667, 3.283333, 3.3, 3.316667,
		3.333333, 3.35, 3.366667, 3.383333, 3.4, 3.416667, 3.433333, 3.45, 3.466667, 3.483333,
		3.5, 3.516667, 3.533333, 3.55, 3.566667, 3.583333, 3.6, 3.616667, 3.633333, 3.65,
		3.666667, 3.683333, 3.7, 3.716667, 3.733333, 3.75, 3.766667, 3.783333, 3.8, 3.816667,
		3.833333, 3.85, 3.866667, 3.883333, 3.9, 3.916667, 3.933333, 3.95, 3.966667, 3.983333,
	]);
});

test('Key packet lookup after reading fragments without key frames', async () => {
	// See https://github.com/Vanilagy/mediabunny/issues/584
	const filePath = path.join(__dirname, '..', 'public/fragments-without-keyframes.mp4');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const reader = new PacketReader(track);
	expect((await reader.getKeyAt(1.2))?.timestamp).toBe(1);

	for await (const packet of new PacketCursor(track)) {
		void packet;
	}

	expect((await reader.getKeyAt(1.2))?.timestamp).toBe(1);
});

/** A crafted track of 4-byte samples, each holding the track's index in its top byte and its own index below. */
type CraftedTrack = {
	handler: 'vide' | 'soun';
	sampleCount: number;
	/** Where its edit list starts it in its media, in milliseconds, if it has one */
	editMediaTime?: number;
};

// Enough samples that the track's box is larger than what the movie box's read takes in one piece
const LARGE_TRACK_SAMPLE_COUNT = 300_000;
const VIDEO_SAMPLE_DURATION = 40;
const AUDIO_SAMPLE_DURATION = 20;
const KEY_FRAME_INTERVAL = 25;
const IDENTITY_MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

const concatBytes = (parts: Uint8Array[]) => {
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}

	return bytes;
};

const asciiBytes = (text: string) => new Uint8Array([...text].map(char => char.charCodeAt(0)));
const zeroBytes = (length: number) => new Uint8Array(length);
const u16Bytes = (value: number) => new Uint8Array([value >> 8, value & 0xff]);

/** Writes a big-endian 32-bit value for each index. */
const u32Table = (count: number, valueAt: (index: number) => number) => {
	const bytes = new Uint8Array(4 * count);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < count; i++) {
		view.setUint32(4 * i, valueAt(i));
	}

	return bytes;
};

const u32Bytes = (...values: number[]) => u32Table(values.length, index => values[index]!);

const craftBox = (name: string, ...parts: Uint8Array[]) => {
	const content = concatBytes(parts);
	return concatBytes([u32Bytes(8 + content.length), asciiBytes(name), content]);
};

const craftFullBox = (name: string, version: number, flags: number, ...parts: Uint8Array[]) => {
	return craftBox(name, u32Bytes((version << 24) | flags), ...parts);
};

const craftTrak = (track: CraftedTrack, trackIndex: number, dataOffset: number) => {
	const isVideo = track.handler === 'vide';
	const sampleDuration = isVideo ? VIDEO_SAMPLE_DURATION : AUDIO_SAMPLE_DURATION;
	const duration = track.sampleCount * sampleDuration;
	const keyFrameCount = Math.ceil(track.sampleCount / KEY_FRAME_INTERVAL);

	const videoSampleEntry = craftBox('avc1', zeroBytes(6), u16Bytes(1), zeroBytes(16), u16Bytes(64), u16Bytes(64),
		u32Bytes(0x480000, 0x480000, 0), u16Bytes(1), zeroBytes(32), u16Bytes(24), u16Bytes(0xffff));
	const audioSampleEntry = craftBox('mp4a', zeroBytes(6), u16Bytes(1), zeroBytes(8), u16Bytes(2), u16Bytes(16),
		zeroBytes(4), u32Bytes(48000 * 0x10000));
	const keyFrameTable = craftFullBox('stss', 0, 0, u32Bytes(keyFrameCount),
		u32Table(keyFrameCount, index => index * KEY_FRAME_INTERVAL + 1));
	const stbl = craftBox('stbl',
		craftFullBox('stsd', 0, 0, u32Bytes(1), isVideo ? videoSampleEntry : audioSampleEntry),
		craftFullBox('stts', 0, 0, u32Bytes(1, track.sampleCount, sampleDuration)),
		...(isVideo ? [keyFrameTable] : []),
		craftFullBox('stsc', 0, 0, u32Bytes(1, 1, track.sampleCount, 1)),
		craftFullBox('stsz', 0, 0, u32Bytes(0, track.sampleCount), u32Table(track.sampleCount, () => 4)),
		craftFullBox('stco', 0, 0, u32Bytes(1, dataOffset)),
	);
	const elst = craftFullBox('elst', 0, 0, u32Bytes(1, duration - (track.editMediaTime ?? 0), track.editMediaTime ?? 0,
		0x10000));
	const editList = track.editMediaTime === undefined ? [] : [craftBox('edts', elst)];

	return craftBox('trak',
		craftFullBox('tkhd', 0, 1, u32Bytes(0, 0, trackIndex + 1, 0, duration), zeroBytes(16),
			u32Bytes(...IDENTITY_MATRIX, 0, 0)),
		...editList,
		craftBox('mdia',
			craftFullBox('mdhd', 0, 0, u32Bytes(0, 0, 1000, duration), u16Bytes(0x55c4), u16Bytes(0)),
			craftFullBox('hdlr', 0, 0, u32Bytes(0), asciiBytes(track.handler), zeroBytes(13)),
			craftBox('minf', stbl),
		),
	);
};

/** Crafts a file of the given tracks with one chunk each, its movie box before or after its media data box. */
const craftMovie = (tracks: CraftedTrack[], options: { brand: string; moovLast: boolean }) => {
	const ftyp = craftBox('ftyp', asciiBytes(options.brand), u32Bytes(0), asciiBytes(options.brand));
	const mdat = craftBox('mdat', ...tracks.map(
		(track, trackIndex) => u32Table(track.sampleCount, index => (trackIndex << 24) | index),
	));
	const craftMoov = (dataStart: number) => {
		const mvhd = craftFullBox('mvhd', 0, 0, u32Bytes(0, 0, 1000, 0, 0x10000), u16Bytes(0x100), zeroBytes(10),
			u32Bytes(...IDENTITY_MATRIX), zeroBytes(24), u32Bytes(tracks.length + 1));

		let dataOffset = dataStart;
		return craftBox('moov', mvhd, ...tracks.map((track, trackIndex) => {
			const trak = craftTrak(track, trackIndex, dataOffset);
			dataOffset += 4 * track.sampleCount;
			return trak;
		}));
	};

	if (options.moovLast) {
		return concatBytes([ftyp, mdat, craftMoov(ftyp.length + 8)]);
	}

	const moovSize = craftMoov(0).length;
	return concatBytes([ftyp, craftMoov(ftyp.length + moovSize + 8), mdat]);
};

type BoxRange = { name: string; start: number; contentStart: number; end: number };

const listBoxes = (bytes: Uint8Array, start: number, end: number) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset);
	const boxes: BoxRange[] = [];
	for (let pos = start; pos < end; pos += view.getUint32(pos)) {
		const name = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
		boxes.push({ name, start: pos, contentStart: pos + 8, end: pos + view.getUint32(pos) });
	}

	return boxes;
};

const findBox = (bytes: Uint8Array, parent: BoxRange, name: string) => {
	const box = listBoxes(bytes, parent.contentStart, parent.end).find(child => child.name === name);
	assert(box);
	return box;
};

/**
 * Returns the file's movie box, each track's stsd box, and where each track's sample tables lie: in its stbl box,
 * after its stsd box.
 */
const findSampleTables = (bytes: Uint8Array) => {
	const moov = findBox(bytes, { name: '', start: 0, contentStart: 0, end: bytes.length }, 'moov');
	const sampleTableBoxes = listBoxes(bytes, moov.contentStart, moov.end)
		.filter(box => box.name === 'trak')
		.map(trak => findBox(bytes, findBox(bytes, findBox(bytes, trak, 'mdia'), 'minf'), 'stbl'));
	const sampleDescriptions = sampleTableBoxes.map(stbl => findBox(bytes, stbl, 'stsd'));
	const sampleTables = sampleTableBoxes.map(
		(stbl, index) => ({ start: sampleDescriptions[index]!.end, end: stbl.end }),
	);

	return { moov, sampleDescriptions, sampleTables };
};

/** Opens the bytes through a synchronous or asynchronous source that records the ranges it reads. */
const openRecordingReads = (bytes: Uint8Array, asynchronous: boolean) => {
	const reads: { start: number; end: number }[] = [];
	const input = new Input({
		source: new CustomSource({
			getSize: () => bytes.length,
			read: (start, end) => {
				reads.push({ start, end });
				const data = bytes.subarray(start, end);
				return asynchronous ? Promise.resolve(data) : data;
			},
		}),
		formats: ALL_FORMATS,
	});
	const readsInto = (range: { start: number; end: number }) => {
		return reads.some(read => read.start < range.end && range.start < read.end);
	};

	return { input, readsInto };
};

const getSampleValue = (packet: EncodedPacket | null) => {
	assert(packet);
	return new DataView(packet.data.buffer, packet.data.byteOffset).getUint32(0);
};

test.each([
	{ brand: 'isom', moovLast: false, asynchronous: false },
	{ brand: 'isom', moovLast: false, asynchronous: true },
	{ brand: 'isom', moovLast: true, asynchronous: false },
	{ brand: 'isom', moovLast: true, asynchronous: true },
	{ brand: 'qt  ', moovLast: true, asynchronous: true },
])(
	'ISOBMFF reads the sample tables of a later track at its first lookup (brand \'$brand\', moov last: $moovLast,'
	+ ' asynchronous source: $asynchronous)',
	async ({ brand, moovLast, asynchronous }) => {
		const bytes = craftMovie([
			{ handler: 'vide', sampleCount: LARGE_TRACK_SAMPLE_COUNT, editMediaTime: 2 * VIDEO_SAMPLE_DURATION },
			{ handler: 'soun', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
			{ handler: 'soun', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
			{ handler: 'soun', sampleCount: 1000 },
		], { brand, moovLast });
		const { sampleDescriptions, sampleTables } = findSampleTables(bytes);
		const { input, readsInto } = openRecordingReads(bytes, asynchronous);
		using _ = input;

		expect(await input.getFormat()).toBe(brand === 'qt  ' ? QTFF : MP4);
		const videoTrack = (await input.getVideoTracks())[0];
		assert(videoTrack);
		const audioTracks = await input.getAudioTracks();
		expect(audioTracks).toHaveLength(3);

		// Every track keeps a copy of its stsd box for hosts, whether its sample tables were left for later or not
		type BackedTrack = { _backing: { internalTrack: { sampleDescriptionBytes: Uint8Array | null } } };
		expect([videoTrack, ...audioTracks].map(
			track => (track as unknown as BackedTrack)._backing.internalTrack.sampleDescriptionBytes,
		)).toEqual(sampleDescriptions.map(box => bytes.slice(box.start, box.end)));

		// The edit list starts the video two samples into its media
		const videoReader = new PacketReader(videoTrack);
		const firstVideoPacket = await videoReader.getFirst();
		expect(firstVideoPacket?.timestamp).toBeCloseTo(-0.08);
		expect(getSampleValue(firstVideoPacket)).toBe(0);
		expect(await videoTrack.getFirstTimestamp()).toBeCloseTo(-0.08);

		const keyPacket = await videoReader.getKeyAt(6000);
		expect(keyPacket?.timestamp).toBeCloseTo(6000 - 0.08);
		expect(getSampleValue(keyPacket)).toBe(150_000);
		expect(getSampleValue(await videoReader.getNext(keyPacket!))).toBe(150_001);

		// The first audio track's tables came with the movie box, the next one's wait for its first lookup
		expect(getSampleValue(await new PacketReader(audioTracks[0]!).getAt(3000))).toBe((1 << 24) | 150_000);
		expect(readsInto(sampleTables[2]!)).toBe(false);

		const laterTrackReader = new PacketReader(audioTracks[1]!);
		expect(getSampleValue(await laterTrackReader.getAt(3000))).toBe((2 << 24) | 150_000);
		expect(readsInto(sampleTables[2]!)).toBe(true);
		expect(getSampleValue(await laterTrackReader.getFirst())).toBe(2 << 24);

		// A small track box was read in one piece
		expect(getSampleValue(await new PacketReader(audioTracks[2]!).getAt(10))).toBe((3 << 24) | 500);
	},
);

test.each([false, true])('ISOBMFF reads a fragmented file\'s tracks (asynchronous source: %s)', async (isAsync) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(videoSource);
	const audioSources = [new EncodedAudioPacketSource('opus'), new EncodedAudioPacketSource('opus')];
	for (const audioSource of audioSources) {
		output.addAudioTrack(audioSource);
	}

	await output.start();
	for (let i = 0; i < 100; i++) {
		await videoSource.add(
			new EncodedPacket(new Uint8Array(64).fill(i), i % KEY_FRAME_INTERVAL ? 'delta' : 'key', i * 0.04, 0.04),
			i === 0 ? { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 240 } } : undefined,
		);
		for (const [index, audioSource] of audioSources.entries()) {
			await audioSource.add(
				new EncodedPacket(new Uint8Array(16).fill(index), 'key', i * 0.04, 0.04),
				i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 } } : undefined,
			);
		}
	}
	await output.finalize();

	const { input } = openRecordingReads(new Uint8Array(output.target.buffer!), isAsync);
	using _ = input;

	const videoTrack = (await input.getVideoTracks())[0];
	assert(videoTrack);
	const audioTracks = await input.getAudioTracks();
	expect(audioTracks).toHaveLength(2);

	const keyPacket = await new PacketReader(videoTrack).getKeyAt(2.1);
	expect(keyPacket?.timestamp).toBeCloseTo(2);
	expect(keyPacket?.data[0]).toBe(50);
	expect((await new PacketReader(audioTracks[1]!).getAt(2))?.data[0]).toBe(1);

	let videoPacketCount = 0;
	for await (const packet of new PacketCursor(videoTrack)) {
		expect(packet.data[0]).toBe(videoPacketCount);
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(100);
});

/**
 * Serves the bytes over HTTP, recording where each request starts; with range support, or answering every request
 * with the whole file like a server that ignores ranges.
 */
const serveBytes = async (bytes: Uint8Array, options: { ignoreRanges?: boolean } = {}) => {
	const requestStarts: number[] = [];

	const server = http.createServer((req, res) => {
		const range = options.ignoreRanges ? null : /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
		const start = range ? Number(range[1]) : 0;
		const end = range && range[2] ? Number(range[2]) + 1 : bytes.byteLength;
		requestStarts.push(start);

		res.on('error', () => {}); // The client may abort the connection at any time
		res.writeHead(range ? 206 : 200, {
			'Content-Type': 'video/mp4',
			'Content-Length': end - start,
			...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.byteLength}` } : {}),
		});
		res.end(bytes.subarray(start, end));
	});

	await new Promise<void>(resolve => server.listen(0, resolve));

	const address = server.address();
	assert(address && typeof address !== 'string');

	return {
		url: `http://localhost:${address.port}/file.mp4`,
		requestStarts: () => requestStarts,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
};

test('ISOBMFF sample tables read at a later lookup stay cached for later inputs over a pinned source', async () => {
	const bytes = craftMovie([
		{ handler: 'vide', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
		{ handler: 'soun', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
		{ handler: 'soun', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
	], { brand: 'isom', moovLast: true });
	const { moov } = findSampleTables(bytes);
	const server = await serveBytes(bytes);

	try {
		// Like a player that opens an input per seek over one source, and pins what its first input read
		const source = new UrlSource(server.url, { readAhead: 2 ** 20 });
		using ref = source.ref();

		{
			using input = new Input({ source: ref.source, formats: ALL_FORMATS });
			const videoReader = new PacketReader((await input.getVideoTracks())[0]!);
			expect(getSampleValue(await videoReader.getFirst())).toBe(0);
			// The cache holds the tables of one large track, but not all of the media data read below
			ref.source.pinCache();
			ref.source.setMaxCacheSize(2 ** 21);

			// The later audio track's tables come at its first lookup, after the pin
			const audioTracks = await input.getAudioTracks();
			const laterTrackReader = new PacketReader(audioTracks[1]!);
			expect(getSampleValue(await laterTrackReader.getAt(600))).toBe((2 << 24) | 30_000);

			// Reading the media data evicts whatever isn't pinned; the reads stay clear of the movie box after it
			const firstTrackReader = new PacketReader(audioTracks[0]!);
			for (let time = 0; time < 5000; time += 500) {
				expect(await videoReader.getKeyAt(2 * time)).not.toBeNull();
				expect(await firstTrackReader.getAt(time)).not.toBeNull();
				expect(await laterTrackReader.getAt(time)).not.toBeNull();
			}
		}

		const requestCountBeforeSecondInput = server.requestStarts().length;

		{
			using input = new Input({ source: ref.source, formats: ALL_FORMATS });
			const laterTrackReader = new PacketReader((await input.getAudioTracks())[1]!);
			expect(getSampleValue(await laterTrackReader.getAt(600))).toBe((2 << 24) | 30_000);
			const videoReader = new PacketReader((await input.getVideoTracks())[0]!);
			expect(getSampleValue(await videoReader.getKeyAt(6000))).toBe(150_000);
		}

		// Its lookups need only media data; a request for the movie box would start at most two 64 KiB steps before it,
		// where reads round their start down to
		const laterRequestStarts = server.requestStarts().slice(requestCountBeforeSecondInput);
		expect(laterRequestStarts.every(start => start < moov.start - 2 ** 17)).toBe(true);
	} finally {
		server.close();
	}
});

test.each(['ReadableStreamSource', 'UrlSource of a server that ignores ranges'])(
	'ISOBMFF reads every sample table with the movie box from a source that reads only forward (%s)',
	async (sourceKind) => {
		const bytes = craftMovie([
			{ handler: 'vide', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
			{ handler: 'soun', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
			{ handler: 'soun', sampleCount: LARGE_TRACK_SAMPLE_COUNT },
		], { brand: 'isom', moovLast: false });
		const server = sourceKind === 'ReadableStreamSource' ? null : await serveBytes(bytes, { ignoreRanges: true });

		try {
			// The cache holds less than the movie box, which the reads below leave far behind
			let streamPos = 0;
			const source = server
				? new UrlSource(server.url, { maxCacheSize: 2 ** 20 })
				: new ReadableStreamSource(new ReadableStream({
					pull: (controller) => {
						if (streamPos >= bytes.length) {
							controller.close();
							return;
						}

						controller.enqueue(bytes.slice(streamPos, streamPos += 2 ** 16));
					},
				}), { maxCacheSize: 2 ** 20 });
			using input = new Input({ source, formats: ALL_FORMATS });

			const videoReader = new PacketReader((await input.getVideoTracks())[0]!);
			const audioTracks = await input.getAudioTracks();

			// Each read lies after the one before it
			expect(getSampleValue(await videoReader.getFirst())).toBe(0);
			expect(getSampleValue(await videoReader.getKeyAt(11_000))).toBe(275_000);
			expect(getSampleValue(await new PacketReader(audioTracks[0]!).getAt(5900))).toBe((1 << 24) | 295_000);

			// The later audio track is first looked up long after the movie box left the cache
			expect(getSampleValue(await new PacketReader(audioTracks[1]!).getAt(3000))).toBe((2 << 24) | 150_000);
		} finally {
			server?.close();
		}
	},
);
