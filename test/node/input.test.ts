import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Input, InputDisposedError, UnsupportedInputFormatError } from '../../src/input.js';
import { ALL_FORMATS, HLS, MP4, QTFF } from '../../src/input-format.js';
import { BufferSource, CustomPathedSource, FilePathSource } from '../../src/source.js';
import { Output } from '../../src/output.js';
import { CmafOutputFormat, HlsOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { BufferTarget, PathedTarget } from '../../src/target.js';
import { EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket, PacketReader } from '../../src/packet.js';
import { PacketCursor } from '../../src/cursors.js';
import { assert } from '../../src/misc.js';
import { Logging, LogLevel } from '../../src/logging.js';

test('Disposing after failed format detection does not emit an unhandled rejection', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow(UnsupportedInputFormatError);

	const unhandledRejections: unknown[] = [];
	const onUnhandledRejection = (reason: unknown) => {
		unhandledRejections.push(reason);
	};

	process.on('unhandledRejection', onUnhandledRejection);
	try {
		input.dispose();
		await new Promise(resolve => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', onUnhandledRejection);
	}

	expect(unhandledRejections).toEqual([]);
});

const makeBox = (name: string, data: Uint8Array) => {
	const bytes = new Uint8Array(8 + data.length);
	new DataView(bytes.buffer).setUint32(0, bytes.length);
	bytes.set(new TextEncoder().encode(name), 4);
	bytes.set(data, 8);
	return bytes;
};

type Edit = { mediaTime: number; rate: number };

const makeEditList = (edits: Edit[], version: number) => {
	const data = new Uint8Array(8 + edits.length * (version === 1 ? 20 : 12));
	const view = new DataView(data.buffer);
	view.setUint8(0, version);
	view.setUint32(4, edits.length);
	let offset = 8;
	for (const edit of edits) {
		if (version === 1) {
			view.setBigUint64(offset, 1000n);
			view.setBigInt64(offset + 8, BigInt(edit.mediaTime));
			offset += 16;
		} else {
			view.setUint32(offset, 1000);
			view.setInt32(offset + 4, edit.mediaTime);
			offset += 8;
		}
		view.setInt32(offset, edit.rate * 65536);
		offset += 4;
	}
	return makeBox('edts', makeBox('elst', data));
};

const createEditFixture = async (trackEdits: Edit[][], version = 0) => {
	using source = new Input({
		source: new FilePathSource(fileURLToPath(new URL('../public/frames.webm', import.meta.url))),
		formats: ALL_FORMATS,
	});
	const track = await source.getPrimaryVideoTrack();
	assert(track);
	const packet = await new PacketReader(track).getFirst();
	assert(packet);
	const config = await track.getDecoderConfig();
	assert(config);
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new BufferTarget() });
	const codec = await track.getCodec();
	assert(codec);
	const sources = trackEdits.map(() => {
		const video = new EncodedVideoPacketSource(codec);
		output.addVideoTrack(video);
		return video;
	});
	await output.start();
	for (const video of sources) {
		await video.add(new EncodedPacket(packet.data, 'key', 0, 1), { decoderConfig: config });
	}
	await output.finalize();

	// The moov box follows mdat, so adding edit lists leaves all packet byte offsets intact.
	let trackIndex = 0;
	const insertEdits = (bytes: Uint8Array): Uint8Array => {
		const boxes: Uint8Array[] = [];
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let pos = 0; pos < bytes.length;) {
			const size = view.getUint32(pos);
			assert(size >= 8 && pos + size <= bytes.length);
			const name = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8));
			const contents = bytes.subarray(pos + 8, pos + size);
			if (name === 'moov') {
				boxes.push(makeBox(name, insertEdits(contents)));
			} else if (name === 'trak') {
				const edits = makeEditList(trackEdits[trackIndex++]!, version);
				boxes.push(makeBox(name, new Uint8Array([...contents, ...edits])));
			} else {
				boxes.push(bytes.subarray(pos, pos + size));
			}
			pos += size;
		}
		return new Uint8Array(boxes.flatMap(box => [...box]));
	};
	return insertEdits(new Uint8Array(output.target.buffer!));
};

test.each([0, 1])('Edit-list diagnostics are local to each track (version %i)', async (version) => {
	const bytes = await createEditFixture([
		[{ mediaTime: 0, rate: 1 }, { mediaTime: 0, rate: 1 }],
		[{ mediaTime: 0, rate: 0.5 }],
		[{ mediaTime: -1, rate: 1 }, { mediaTime: 0, rate: 1 }],
	], version);
	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const tracks = await input.getVideoTracks();
	expect(await Promise.all(tracks.map(track => track.getUnsupportedFeatures()))).toEqual([
		['multiple_edits'], ['non_unit_playback_rate'], [],
	]);
	const features = await tracks[0]!.getUnsupportedFeatures();
	features.length = 0;
	expect(await tracks[0]!.getUnsupportedFeatures()).toEqual(['multiple_edits']);
	// Warnings still allow the original packet to be read with the existing timestamp and duration.
	for (const track of tracks.slice(0, 2)) {
		const packet = await new PacketReader(track).getFirst();
		expect(packet?.timestamp).toBe(0);
		expect(packet?.duration).toBe(1);
		expect(packet?.data.length).toBeGreaterThan(0);
	}
});

test('Unsupported rates are reported independently across concurrent inputs with logging disabled', async () => {
	const fixtures = await Promise.all([0, -1, 2].map(rate => createEditFixture([[{ mediaTime: 0, rate }]])));
	const previousLevel = Logging.level;
	Logging.level = LogLevel.Silent;
	try {
		await Promise.all(fixtures.map(async (bytes) => {
			using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
			const track = await input.getPrimaryVideoTrack();
			expect(await track!.getUnsupportedFeatures()).toEqual(['non_unit_playback_rate']);
		}));
	} finally {
		Logging.level = previousLevel;
	}
});

test('Segment inputs inherit edit-list diagnostics from their initialization input', async () => {
	const bytes = await createEditFixture([[{ mediaTime: 0, rate: 2 }]]);
	using initInput = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const segment = makeBox('styp', new Uint8Array([105, 115, 111, 109, 0, 0, 0, 0]));
	using input = new Input({ source: new BufferSource(segment), formats: ALL_FORMATS, initInput });
	const track = await input.getPrimaryVideoTrack();
	expect(await track!.getUnsupportedFeatures()).toEqual(['non_unit_playback_rate']);
});

test('Tracks without detected unsupported features return an empty array', async () => {
	for (const file of ['frames.webm', 'rotate-buck-bunny.mp4']) {
		using input = new Input({
			source: new FilePathSource(fileURLToPath(new URL(`../public/${file}`, import.meta.url))),
			formats: ALL_FORMATS,
		});
		const track = await input.getPrimaryVideoTrack();
		expect(await track!.getUnsupportedFeatures()).toEqual([]);
	}
});

test('HLS forwards diagnostics from its backing track', async () => {
	const bytes = await createEditFixture([[{ mediaTime: 0, rate: 2 }]]);
	const playlist = new TextEncoder().encode([
		'#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXTINF:1,', 'segment.mp4', '#EXT-X-ENDLIST',
	].join('\n'));
	using input = new Input({
		source: new CustomPathedSource('playlist.m3u8', ({ isRoot }) => new BufferSource(
			isRoot ? playlist : bytes,
		)),
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(HLS);
	const track = await input.getPrimaryVideoTrack();
	expect(await track!.getUnsupportedFeatures()).toEqual(['non_unit_playback_rate']);
});

test('Disposed input', async () => {
	const input = new Input({
		source: new BufferSource(new Uint8Array(1024)),
		formats: ALL_FORMATS,
	});
	input.dispose();

	await expect(input.getFormat()).rejects.toThrow(InputDisposedError);
	await expect(input.canRead()).rejects.toThrow(InputDisposedError);
	await expect(input.getTracks()).rejects.toThrow(InputDisposedError);
});

test('Source request after disposal', async () => {
	const input = new Input({
		source: new CustomPathedSource('root.m3u8', () => new BufferSource(new Uint8Array(4))),
		formats: ALL_FORMATS,
	});
	const request = {
		path: 'segment.ts',
		isRoot: false,
	};
	(await input._getSourceCached(request)).free();
	input.dispose();

	await expect(input._getSourceCached(request)).rejects.toThrow(InputDisposedError);
});

test('Failed source request retry', async () => {
	let requestCount = 0;
	using input = new Input({
		source: new CustomPathedSource('root.m3u8', () => {
			if (requestCount++ === 0) {
				throw new Error('Transient failure');
			}

			return new BufferSource(new Uint8Array(4));
		}),
		formats: ALL_FORMATS,
	});
	const request = {
		path: 'segment.ts',
		isRoot: false,
	};

	await expect(input._getSourceCached(request)).rejects.toThrow('Transient failure');
	using ref = await input._getSourceCached(request);
	expect(ref.source).toBeInstanceOf(BufferSource);
});

test('QuickTime file with a 64-bit ftyp box size', async () => {
	const bytes = new Uint8Array(28);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 1);
	bytes.set(ascii('ftyp'), 4);
	view.setUint32(12, bytes.length); // Lower half of the 64-bit size
	bytes.set(ascii('qt  '), 16);
	bytes.set(ascii('qt  '), 24);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	expect(await input.getFormat()).toBe(QTFF);
});

test('ISOBMFF without ftyp box', async () => {
	// Sample offsets are absolute, so instead of removing the ftyp box, we turn it into padding
	const moovLast = await createMp4File(false); // ftyp mdat moov
	const freeFirst = moovLast.slice();
	freeFirst.set(ascii('free'), 4);

	const moovFirst = await createMp4File('in-memory'); // ftyp moov mdat
	const ftypSize = readU32(moovFirst, 0);
	const moovSize = readU32(moovFirst, ftypSize);
	const padding = moovFirst.slice(0, ftypSize);
	padding.set(ascii('free'), 4);
	moovFirst.copyWithin(0, ftypSize, ftypSize + moovSize);
	moovFirst.set(padding, moovSize);

	for (const file of [freeFirst, moovFirst]) {
		using input = new Input({
			source: new BufferSource(file),
			formats: ALL_FORMATS,
		});
		expect(await input.getFormat()).toBe(MP4);

		const cursor = new PacketCursor((await input.getVideoTracks())[0]!);
		let packetCount = 0;
		for await (const packet of cursor) {
			expect(packet.data).toEqual(new Uint8Array(100).fill(packetCount));
			packetCount++;
		}
		expect(packetCount).toBe(5);
	}
});

const createMp4File = async (fastStart: false | 'in-memory') => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart }),
		target: new BufferTarget(),
	});
	const source = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(source);
	await output.start();

	for (let i = 0; i < 5; i++) {
		await source.add(new EncodedPacket(new Uint8Array(100).fill(i), i === 0 ? 'key' : 'delta', i / 10, 1 / 10), {
			decoderConfig: {
				codec: 'vp09.00.10.08',
				codedWidth: 64,
				codedHeight: 64,
			},
		});
	}

	await output.finalize();
	return new Uint8Array(output.target.buffer!);
};

const readU32 = (bytes: Uint8Array, pos: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(pos);

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

test('Source cache eviction order', async () => {
	const requestedPaths: string[] = [];
	using input = new Input({
		source: new CustomPathedSource('root.m3u8', ({ path }) => {
			requestedPaths.push(path);
			return new BufferSource(new Uint8Array(4));
		}),
		formats: ALL_FORMATS,
	});

	// The cache holds four sources, and using 'a' again makes 'b' the one to go once 'e' comes in
	for (const path of ['a', 'b', 'c', 'd', 'a', 'e', 'a']) {
		(await input._getSourceCached({
			path,
			isRoot: false,
		})).free();
	}
	expect(requestedPaths).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('Disposal while waiting for a live HLS stream', async () => {
	const files = new Map<string, BufferTarget>();
	const output = new Output({
		format: new HlsOutputFormat({
			segmentFormat: new CmafOutputFormat(),
			targetDuration: 1,
		}),
		target: new PathedTarget('master.m3u8', (request) => {
			const target = new BufferTarget();
			files.set(request.path, target);
			return target;
		}),
	});
	const videoSource = new EncodedVideoPacketSource('vp9');
	output.addVideoTrack(videoSource);
	await output.start();
	await videoSource.add(new EncodedPacket(new Uint8Array(100), 'key', 0, 1), {
		decoderConfig: {
			codec: 'vp09.00.10.08',
			codedWidth: 64,
			codedHeight: 64,
		},
	});
	await output.finalize();

	// No #EXT-X-ENDLIST, so the stream is live
	const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MAP:URI="init-1.m4s"\n#EXTINF:1,\nsegment-1-1.m4s\n';
	const input = new Input({
		source: new CustomPathedSource('live.m3u8', ({ path }) => new BufferSource(
			path === 'live.m3u8' ? new TextEncoder().encode(playlist) : files.get(path)!.buffer!,
		)),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const durationPromise = track.computeDuration();
	await new Promise(resolve => setTimeout(resolve, 100));
	input.dispose();

	await expect(durationPromise).rejects.toThrow(InputDisposedError);
});
