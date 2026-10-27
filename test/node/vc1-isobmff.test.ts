import { expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, BufferSource, FilePathSource, Input, MP4, PacketCursor } from '../../src/index.js';
import { assert, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// The first three frames of vc1.m2ts, remuxed by FFmpeg into MP4 with a vc-1 sample entry and its dvc1 box
const VC1_MP4_PATH = path.join(__dirname, '../public/vc1.mp4');
// The sequence header and entry point after the dvc1 box's VC1DecSpecStruc, the extradata FFmpeg reads
const DVC1_EXTRADATA = '0000010fdb7e3bf21b8a3bf886e80450935b8d44a9c00000010e1a47f840';

test('MP4 with VC-1 video takes its description from the dvc1 box', async () => {
	using input = new Input({ source: new FilePathSource(VC1_MP4_PATH), formats: ALL_FORMATS });

	expect(await input.getFormat()).toBe(MP4);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('vc1');
	expect(await videoTrack.getInternalCodecId()).toBe('vc-1');

	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.codec).toBe('vc-1');
	expect(decoderConfig.codedWidth).toBe(1920);
	expect(decoderConfig.codedHeight).toBe(1080);
	assert(decoderConfig.description);
	expect(Buffer.from(toUint8Array(decoderConfig.description)).toString('hex')).toBe(DVC1_EXTRADATA);

	// The samples are the M2TS packets FFmpeg's VC-1 parser splits
	const sizes: number[] = [];
	for await (const packet of new PacketCursor(videoTrack)) {
		sizes.push(packet.data.byteLength);
	}
	expect(sizes).toEqual([85851, 11273, 34767]);
});

test('MP4 with VC-1 video outside the Advanced profile has no description, as in FFmpeg', async () => {
	const bytes = new Uint8Array(await fs.readFile(VC1_MP4_PATH));
	const dvc1Offset = Buffer.from(bytes).indexOf('dvc1');
	expect(dvc1Offset).toBeGreaterThan(0);
	// Main profile, whose dvc1 box carries no sequence header
	bytes[dvc1Offset + 4] = (4 << 4) | (bytes[dvc1Offset + 4]! & 0x0f);

	using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('vc1');

	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig);
	expect(decoderConfig.description).toBeUndefined();
});
