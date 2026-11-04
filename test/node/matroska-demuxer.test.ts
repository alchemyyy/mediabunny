import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {
	ALL_FORMATS,
	CustomSource,
	FilePathSource,
	Input,
	PacketReader,
} from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Zero-width unsigned integers', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-width-uint.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	expect(await input.getTracks()).toHaveLength(1);
});

test('Zero timestamp scale', async () => {
	const filePath = path.join(__dirname, '..', 'public/zero-timestamp-scale.webm');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	await expect(input.getTracks()).rejects.toThrow(/TimestampScale/);
});

test('Concurrent metadata tag reads', async () => {
	const filePath = path.join(__dirname, '..', 'public/tags-after-clusters.webm');
	const buffer = await fs.promises.readFile(filePath);

	// Async reads, so that both calls are in the middle of loading the tags at the same time
	using input = new Input({
		source: new CustomSource({
			getSize: async () => buffer.byteLength,
			read: async (start, end) => buffer.subarray(start, end),
		}),
		formats: ALL_FORMATS,
	});

	const [first, second] = await Promise.all([input.getMetadataTags(), input.getMetadataTags()]);
	expect(first.title).toBe('Hi');
	expect(second.title).toBe('Hi');
});

// Groups of pictures 4 s long in clusters 1 s long, with a cue point at the start of each group
const GROUPS_SPLIT_INTO_CLUSTERS_PATH = path.join(__dirname, '..', 'public/groups-split-into-clusters.mkv');

/** Opens a file without a source cache, which would hide reads, recording where each read starts. */
const createRecordingInput = (buffer: Buffer, readPositions: number[]) => new Input({
	source: new CustomSource({
		getSize: async () => buffer.byteLength,
		read: async (start, end) => {
			readPositions.push(start);
			return buffer.subarray(start, end);
		},
		maxCacheSize: 0,
	}),
	formats: ALL_FORMATS,
});

test('Key packet lookup after reading later clusters of the same group', async () => {
	const buffer = await fs.promises.readFile(GROUPS_SPLIT_INTO_CLUSTERS_PATH);
	const readPositions: number[] = [];
	using input = createRecordingInput(buffer, readPositions);
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	readPositions.length = 0;

	// Reads the group's first clusters from its cue point, which puts them in the cluster position cache
	expect((await new PacketReader(track).getKeyAt(40.9))?.timestamp).toBe(40);
	const groupStart = Math.min(...readPositions);
	readPositions.length = 0;

	// Cached clusters after the key packet hold no key frame, so the lookup starts no later than the group's start; it
	// must not rescan the file from its start either
	expect((await new PacketReader(track).getKeyAt(42.1))?.timestamp).toBe(40);
	expect(Math.min(...readPositions)).toBeGreaterThanOrEqual(groupStart);
});

test('Key packet lookup after reading later clusters of the same group and an earlier group', async () => {
	const buffer = await fs.promises.readFile(GROUPS_SPLIT_INTO_CLUSTERS_PATH);
	const readPositions: number[] = [];

	// Where the group starts, as a lookup finds it before any cluster was read
	let groupStart: number;
	{
		using input = createRecordingInput(buffer, readPositions);
		const track = await input.getPrimaryVideoTrack();
		assert(track);
		readPositions.length = 0;
		expect((await new PacketReader(track).getKeyAt(40.9))?.timestamp).toBe(40);
		groupStart = Math.min(...readPositions);
	}

	using input = createRecordingInput(buffer, readPositions);
	const track = await input.getPrimaryVideoTrack();
	assert(track);
	// Puts an earlier group's clusters, then the group's first clusters, in the cluster position cache
	await new PacketReader(track).getKeyAt(10.9);
	await new PacketReader(track).getKeyAt(40.9);
	readPositions.length = 0;

	// Cached clusters after the key packet hold no key frame, and the earlier group's cached clusters lie before the
	// group's cue point, so the lookup must start at the group's start
	expect((await new PacketReader(track).getKeyAt(42.1))?.timestamp).toBe(40);
	expect(Math.min(...readPositions)).toBeGreaterThanOrEqual(groupStart);
});

test('Key packet lookup past position cache entries', async () => {
	// 0.5 s clusters with a key frame (and cue point) only every 10 s
	const filePath = path.join(__dirname, '..', 'public/sparse-keyframes-dense-clusters.mkv');
	const buffer = await fs.promises.readFile(filePath);

	let bytesRead = 0;
	using input = new Input({
		source: new CustomSource({
			getSize: () => buffer.byteLength,
			read: (start, end) => {
				bytesRead += end - start;
				return buffer.subarray(start, end);
			},
			maxCacheSize: Infinity,
		}),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const reader = new PacketReader(track);

	// Leaves the position cache with an entry at the start and dense entries from the cue point at 50 s up to 55.3 s
	await reader.getFirst();
	await reader.getAt(55.3);

	bytesRead = 0;
	const keyPacket = await reader.getKeyAt(55.29);
	expect(keyPacket?.timestamp).toBe(50);
	expect(bytesRead).toBeLessThan(0.05 * buffer.byteLength);
});
