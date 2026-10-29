import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { CustomSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { PacketCursor } from '../../src/cursors.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { assert } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket, PacketReader } from '../../src/packet.js';

const PACKET_COUNT = 200;

const SEGMENT_ID = 0x18538067;
const SEEK_HEAD_ID = 0x114d9b74;
const INFO_ID = 0x1549a966;
const CUES_ID = 0x1c53bb6b;
const DURATION_ID = 0x4489;
const CLUSTER_ID = 0x1f43b675;

/** Muxes a file with one VP8 and one Opus track, with a cluster per second. */
const muxFile = async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(videoSource, { frameRate: 1 });
	const audioSource = new EncodedAudioPacketSource('opus');
	output.addAudioTrack(audioSource);

	await output.start();

	for (let i = 0; i < PACKET_COUNT; i++) {
		await videoSource.add(
			new EncodedPacket(new Uint8Array(1024).fill(i), 'key', i, 1),
			i === 0 ? { decoderConfig: { codec: 'vp8', codedWidth: 320, codedHeight: 240 } } : undefined,
		);
		await audioSource.add(
			new EncodedPacket(new Uint8Array(100).fill(i), 'key', i + 0.5, 0.02),
			i === 0 ? { decoderConfig: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 } } : undefined,
		);
	}

	await output.finalize();

	return new Uint8Array(output.target.buffer!);
};

const readVint = (bytes: Uint8Array, pos: number, keepMarker: boolean) => {
	const first = bytes[pos]!;
	let length = 1;
	while (length <= 8 && !(first & (0x80 >> (length - 1)))) {
		length++;
	}

	let value = keepMarker ? first : first & (0xff >> length);
	for (let i = 1; i < length; i++) {
		value = value * 256 + bytes[pos + i]!;
	}

	return { value, length };
};

const readHeader = (bytes: Uint8Array, pos: number) => {
	const id = readVint(bytes, pos, true);
	const size = readVint(bytes, pos + id.length, false);

	return {
		id: id.value,
		sizePos: pos + id.length,
		sizeLength: size.length,
		dataStart: pos + id.length + size.length,
		size: size.value,
	};
};

/** Overwrites the element at `pos` spanning `length` bytes with a Void element of the same length. */
const voidElement = (bytes: Uint8Array, pos: number, length: number) => {
	assert(length >= 9);
	bytes.fill(0, pos, pos + length);
	bytes[pos] = 0xec;
	bytes[pos + 1] = 0x01; // 8-byte size
	let size = length - 9;
	for (let i = 8; i >= 2; i--) {
		bytes[pos + i] = size % 256;
		size = Math.floor(size / 256);
	}
};

/**
 * Reproduces the layout of an unfinalized mkvmerge file: a Segment size of 0, a Void where the SeekHead was, an Info
 * Duration of 0.0, and no Cues.
 */
const makeUnfinalized = (original: Uint8Array) => {
	const bytes = original.slice();

	const ebml = readHeader(bytes, 0);
	const segmentPos = ebml.dataStart + ebml.size;
	const segment = readHeader(bytes, segmentPos);
	assert(segment.id === SEGMENT_ID);

	bytes.fill(0, segment.sizePos, segment.dataStart);
	bytes[segment.sizePos] = 0x80 >> (segment.sizeLength - 1);

	let pos = segment.dataStart;
	while (pos < bytes.length) {
		const header = readHeader(bytes, pos);
		const end = header.dataStart + header.size;

		if (header.id === SEEK_HEAD_ID || header.id === CUES_ID) {
			voidElement(bytes, pos, end - pos);
		} else if (header.id === INFO_ID) {
			let childPos = header.dataStart;
			while (childPos < end) {
				const child = readHeader(bytes, childPos);
				if (child.id === DURATION_ID) {
					bytes.fill(0, child.dataStart, child.dataStart + child.size); // 0.0
				}
				childPos = child.dataStart + child.size;
			}
		}

		pos = end;
	}

	return bytes;
};

const openCounting = (bytes: Uint8Array) => {
	const stats = { reads: 0, maxEnd: 0 };
	const input = new Input({
		source: new CustomSource({
			getSize: () => bytes.byteLength,
			read: (start, end) => {
				stats.reads++;
				stats.maxEnd = Math.max(stats.maxEnd, end);
				return bytes.subarray(start, end);
			},
		}),
		formats: ALL_FORMATS,
	});

	return { input, stats };
};

test('Matroska with an unfinalized Segment of size 0 reads its tracks in a bounded number of reads', async () => {
	const original = await muxFile();
	const bytes = makeUnfinalized(original);

	const { input, stats } = openCounting(bytes);
	using _ = input;

	const videoTracks = await input.getVideoTracks();
	const audioTracks = await input.getAudioTracks();
	expect(videoTracks).toHaveLength(1);
	expect(audioTracks).toHaveLength(1);
	expect(await videoTracks[0]!.getCodec()).toBe('vp8');
	expect(await audioTracks[0]!.getCodec()).toBe('opus');

	// Only the head of the file was needed, not a read per cluster
	expect(stats.reads).toBeLessThan(20);
	expect(stats.maxEnd).toBeLessThan(bytes.byteLength / 4);

	const firstVideo = await new PacketReader(videoTracks[0]!).getFirst();
	assert(firstVideo);
	expect(firstVideo.type).toBe('key');
	expect(firstVideo.timestamp).toBe(0);
	expect(firstVideo.data).toEqual(new Uint8Array(1024).fill(0));

	const firstAudio = await new PacketReader(audioTracks[0]!).getFirst();
	assert(firstAudio);
	expect(firstAudio.timestamp).toBe(0.5);
	expect(firstAudio.data).toEqual(new Uint8Array(100).fill(0));

	// A Duration of 0.0 is no duration
	expect(await input.getDurationFromMetadata()).toBeNull();

	// The segment runs to the end of the file
	let videoPacketCount = 0;
	for await (const packet of new PacketCursor(videoTracks[0]!)) {
		expect(packet.timestamp).toBe(videoPacketCount);
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(PACKET_COUNT);
});

test('Matroska with a finalized Segment is read as before', async () => {
	const bytes = await muxFile();

	const { input } = openCounting(bytes);
	using _ = input;

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks).toHaveLength(1);
	expect(await input.getAudioTracks()).toHaveLength(1);
	expect(await input.getDurationFromMetadata()).toBe(PACKET_COUNT);

	let videoPacketCount = 0;
	for await (const packet of new PacketCursor(videoTracks[0]!)) {
		expect(packet.timestamp).toBe(videoPacketCount);
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(PACKET_COUNT);
});

test('Matroska clusters after the end of their Segment are attributed to it without a read per cluster', async () => {
	const bytes = (await muxFile()).slice();

	// Shrink the Segment so that it ends at its first Cluster, leaving every cluster at the top level
	const ebml = readHeader(bytes, 0);
	const segment = readHeader(bytes, ebml.dataStart + ebml.size);
	assert(segment.id === SEGMENT_ID);

	let pos = segment.dataStart;
	while (readHeader(bytes, pos).id !== CLUSTER_ID) {
		const header = readHeader(bytes, pos);
		pos = header.dataStart + header.size;
	}

	let size = pos - segment.dataStart;
	for (let i = segment.sizeLength - 1; i >= 1; i--) {
		bytes[segment.sizePos + i] = size % 256;
		size = Math.floor(size / 256);
	}
	bytes[segment.sizePos] = 0x80 >> (segment.sizeLength - 1);

	const { input, stats } = openCounting(bytes);
	using _ = input;

	const videoTracks = await input.getVideoTracks();
	expect(videoTracks).toHaveLength(1);
	expect(await input.getAudioTracks()).toHaveLength(1);
	expect(stats.reads).toBeLessThan(20);

	let videoPacketCount = 0;
	for await (const packet of new PacketCursor(videoTracks[0]!)) {
		expect(packet.timestamp).toBe(videoPacketCount);
		videoPacketCount++;
	}
	expect(videoPacketCount).toBe(PACKET_COUNT);
});
