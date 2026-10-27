import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, FilePathSource, Input, PacketCursor } from '../../src/index.js';
import { assert } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// FFmpeg-made streams under each Dolby Vision sample entry, and a Profile 10 AV1 stream with its dvvC box. Each reads
// with the codec string Mediabunny derives from the configuration box of the entry's base layer, as for its base entry.
const SAMPLE_ENTRIES = [
	{ file: 'dvh1.mp4', sampleEntry: 'dvh1', codec: 'hevc', codecString: 'hev1.2.4.L30.90' },
	{ file: 'dvhe.mp4', sampleEntry: 'dvhe', codec: 'hevc', codecString: 'hev1.2.4.L30.90' },
	{ file: 'dva1.mp4', sampleEntry: 'dva1', codec: 'avc', codecString: 'avc1.64000a' },
	{ file: 'dvav.mp4', sampleEntry: 'dvav', codec: 'avc', codecString: 'avc3.64000a' },
	{ file: 'dav1.mp4', sampleEntry: 'dav1', codec: 'av1', codecString: 'av01.0.00M.10.0.110.01.01.01.1' },
] as const;

test.each(SAMPLE_ENTRIES)(
	'Reads the $sampleEntry sample entry as $codec, its base layer\'s codec',
	async ({ file, sampleEntry, codec, codecString }) => {
		using input = new Input({
			source: new FilePathSource(path.join(__dirname, '..', 'public/dolby-vision', file)),
			formats: ALL_FORMATS,
		});

		const track = await input.getPrimaryVideoTrack();
		assert(track);
		expect(await track.getInternalCodecId()).toBe(sampleEntry);
		expect(await track.getCodec()).toBe(codec);

		const decoderConfig = await track.getDecoderConfig();
		assert(decoderConfig);
		expect(decoderConfig.codec).toBe(codecString);
		// Mediabunny hands the avcC, hvcC, and av1C records on as the description
		expect(decoderConfig.description).toBeDefined();

		// Each file holds four frames, FFprobe counts
		const packetTypes: string[] = [];
		for await (const packet of new PacketCursor(track)) {
			packetTypes.push(packet.type);
		}
		expect(packetTypes).toHaveLength(4);
		expect(packetTypes[0]).toBe('key');
	},
);
