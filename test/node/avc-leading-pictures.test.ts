/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	CustomVideoDecoder,
	EncodedPacket,
	FilePathSource,
	Input,
	PacketReader,
	registerDecoder,
	VideoCodec,
	VideoSample,
	VideoSampleCursor,
} from '../../src/index.js';

const decodedTimestamps: number[] = [];

/** Records the packets it is given and outputs a blank picture for each, at the packet's timestamp. */
class RecordingAvcDecoder extends CustomVideoDecoder {
	static override supports(codec: VideoCodec) {
		return codec === 'avc';
	}

	init() {}

	decode(packet: EncodedPacket) {
		decodedTimestamps.push(packet.timestamp);
		const { codedWidth, codedHeight } = this.config;
		this.onSample(new VideoSample(new Uint8Array(codedWidth! * codedHeight! * 3 / 2), {
			format: 'I420',
			codedWidth: codedWidth!,
			codedHeight: codedHeight!,
			timestamp: packet.timestamp,
			duration: packet.duration,
		}));
	}

	flush() {}

	close() {}
}

registerDecoder(RecordingAvcDecoder);

test('H.264 decoding from an open group\'s key packet skips the leading pictures that present before it', async () => {
	// x264 with open groups every 12 frames: the key packet at frame 12 is a non-IDR I picture whose three leading
	// B pictures, 9 to 11, follow it in decode order and reference the group before it
	using input = new Input({ source: new FilePathSource('test/public/avc-open-gop.mp4'), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	const frameDuration = 1 / 24;
	const keyPacket = (await new PacketReader(track).getKeyAt(13 * frameDuration))!;
	expect(keyPacket.timestamp).toBeCloseTo(12 * frameDuration, 6);

	const cursor = new VideoSampleCursor(track);
	// The recording decoder outputs in decode order, so the sample found is not checked, only what was decoded
	(await cursor.seekTo(13 * frameDuration))?.close();

	// Decoders cannot decode those, so a decoder that drops them would leave their timestamps to later frames
	expect(decodedTimestamps[0]).toBe(keyPacket.timestamp);
	expect(decodedTimestamps.every(timestamp => timestamp >= keyPacket.timestamp)).toBe(true);
	expect(decodedTimestamps.length).toBeGreaterThan(1);

	await cursor.close();
});

test('H.264 decoding from the first packet, an IDR picture, skips nothing', async () => {
	decodedTimestamps.length = 0;
	using input = new Input({ source: new FilePathSource('test/public/avc-open-gop.mp4'), formats: ALL_FORMATS });
	const track = (await input.getVideoTracks())[0]!;
	const packetCount = (await track.computePacketStats()).packetCount;

	const cursor = new VideoSampleCursor(track);
	for await (const sample of cursor) {
		sample.close();
	}

	expect(decodedTimestamps).toHaveLength(packetCount);
});
