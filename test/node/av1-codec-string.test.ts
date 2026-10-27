import { expect, test } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Files encoded by FFmpeg with libaom or SVT-AV1, whose codec strings follow Section 5 of the AV1 ISOBMFF binding:
// monochrome, chroma, and range from the sequence header, and the color fields from its color description, else 01
test.each([
	// SVT-AV1, 10-bit 4:2:0 without a color description: every optional field takes its default
	['svt-420-10.webm', 'av01.0.00M.10'],
	['svt-420-10.mp4', 'av01.0.00M.10'],
	// libaom, 8-bit 4:2:0, full range without a color description
	['aom-420-8-full.mkv', 'av01.0.00M.08.0.110.01.01.01.1'],
	['aom-420-8-full.mp4', 'av01.0.00M.08.0.110.01.01.01.1'],
	// libaom, 10-bit 4:2:2 (Professional profile)
	['aom-422-10.mkv', 'av01.2.00M.10.0.100.01.01.01.0'],
	['aom-422-10.mp4', 'av01.2.00M.10.0.100.01.01.01.0'],
	// libaom, 8-bit 4:4:4 (High profile)
	['aom-444-8.webm', 'av01.1.00M.08.0.000.01.01.01.0'],
	// libaom, 10-bit monochrome, which libaom codes as full range
	['aom-gray-10.webm', 'av01.0.00M.10.1.110.01.01.01.1'],
	['aom-gray-10.mp4', 'av01.0.00M.10.1.110.01.01.01.1'],
	// The 4:4:4 stream with an explicit color description of 2/2/2 (unspecified), which the string repeats
	['aom-444-8-unspecified.mkv', 'av01.1.00M.08.0.000.02.02.02.0'],
	['aom-444-8-unspecified.mp4', 'av01.1.00M.08.0.000.02.02.02.0'],
	// The 4:4:4 stream with reserved color primaries 200, which no two-digit field holds
	['aom-444-8-reserved-primaries.mkv', 'av01.1.00M.08'],
	['aom-444-8-reserved-primaries.mp4', 'av01.1.00M.08'],
])('AV1 codec string of %s follows its sequence header', async (fileName, expectedCodec) => {
	using input = new Input({
		source: new BufferSource(fs.readFileSync(path.join(__dirname, '../public/av1', fileName))),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	expect(await videoTrack.getCodecParameterString()).toBe(expectedCodec);
	expect((await videoTrack.getDecoderConfig())?.codec).toBe(expectedCodec);
});
