import { expect, test } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert, toUint8Array } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const readDecoderConfig = async (fileName: string) => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/av1', fileName))),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const decoderConfig = await videoTrack.getDecoderConfig();
	assert(decoderConfig);
	return decoderConfig;
};

// Each file's AV1CodecConfigurationRecord as FFmpeg's demuxers read it, its extradata: the Matroska and WebM
// CodecPrivate, or the MP4 av1C box payload, each the 4-byte av1C header followed by the sequence header OBU
test.each([
	// libaom, 10-bit 4:2:0 with a BT.2100 PQ color description
	['aom-420-10-pq.mkv', '81004c000a0d00000002afff9b5f2a12201208'],
	['aom-420-10-pq.webm', '81004c000a0d00000002afff9b5f2a12201208'],
	['aom-420-10-pq.mp4', '81004c000a0d00000002afff9b5f2a12201208'],
	// libaom, 8-bit 4:4:4 (High profile)
	['aom-444-8.mkv', '812000000a0a20000002afff9b5f2040'],
	['aom-444-8.mp4', '812000000a0a20000002afff9b5f2040'],
	// libaom, 10-bit monochrome
	['aom-gray-10.mkv', '81005c000a0a00000002afff9b5f2d40'],
	// SVT-AV1, 10-bit 4:2:0
	['svt-420-10.mkv', '81004c000a0a00000002afff805f0808'],
])('AV1 configuration record of %s is the decoder description', async (fileName, expectedRecord) => {
	const decoderConfig = await readDecoderConfig(fileName);

	assert(decoderConfig.description);
	expect(Buffer.from(toUint8Array(decoderConfig.description)).toString('hex')).toBe(expectedRecord);
});

test('Matroska AV1 without sequence headers in its blocks reads its codec string from CodecPrivate', async () => {
	// libaom, 10-bit 4:2:2 (Professional profile), with every sequence header OBU removed from the blocks
	const decoderConfig = await readDecoderConfig('aom-422-10-codec-private-only.mkv');

	assert(decoderConfig.description);
	expect(Buffer.from(toUint8Array(decoderConfig.description)).toString('hex'))
		.toBe('814048000a0a40000002afff9b5f2810');
	expect(decoderConfig.codec).toBe('av01.2.00M.10.0.100.01.01.01.0');
});
