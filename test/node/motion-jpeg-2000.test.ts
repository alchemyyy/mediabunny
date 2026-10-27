import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, FilePathSource, Input, MP4, PacketCursor } from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Opens a Motion JPEG 2000 file, whose signature box precedes its ftyp box', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/motion-jpeg-2000.mj2')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(MP4);

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	expect(await track.getInternalCodecId()).toBe('mjp2');
	expect(await track.getCodedWidth()).toBe(144);
	expect(await track.getCodedHeight()).toBe(81);

	// The sample sizes FFprobe reports
	const sizes: number[] = [];
	for await (const packet of new PacketCursor(track)) {
		sizes.push(packet.data.byteLength);
	}
	expect(sizes).toEqual([6568, 6507, 6523]);
});

test('Leaves a JPEG 2000 still image, which opens the same way but has no movie, unrecognized', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/jpeg-2000-still.jp2')),
		formats: ALL_FORMATS,
	});

	await expect(input.getFormat()).rejects.toThrow();
});
