import { expect, test } from 'vitest';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	CustomVideoDecoder,
	EncodedPacket,
	EncodedVideoPacketSource,
	Input,
	Mp4OutputFormat,
	Output,
	PacketType,
	registerDecoder,
	VideoCodec,
	VideoSample,
	VideoSampleCursor,
} from '../../src/index.js';

/**
 * Outputs a blank picture at each packet's timestamp, and drops the pictures that present before the key packet
 * decoding started at, as decoders do with leading pictures whose references precede that key packet.
 */
class LeadingPictureDroppingDecoder extends CustomVideoDecoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp8';
	}

	private startTimestamp = -Infinity;

	init() {}

	decode(packet: EncodedPacket) {
		if (packet.type === 'key') {
			this.startTimestamp = packet.timestamp;
		} else if (packet.timestamp < this.startTimestamp) {
			return;
		}

		this.onSample(new VideoSample(new Uint8Array(64 * 64 * 3 / 2), {
			format: 'I420',
			codedWidth: 64,
			codedHeight: 64,
			timestamp: packet.timestamp,
			duration: packet.duration,
		}));
	}

	flush() {}

	close() {}
}

registerDecoder(LeadingPictureDroppingDecoder);

type PacketSpec = {
	/** The type the container declares. */
	type: PacketType;
	/** The type the bitstream says, when it differs from the declared one. */
	actualType?: PacketType;
	timestamp: number;
};

/** Writes VP8 packets in the given decode order to an MP4 file. */
const createFile = async (packets: PacketSpec[]) => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 64 } });
	await output.start();

	for (const spec of packets) {
		// The VP8 frame tag's first bit is 0 for a key frame
		const data = new Uint8Array([(spec.actualType ?? spec.type) === 'key' ? 0 : 1, 0, 0, 0]);
		await source.add(new EncodedPacket(data, spec.type, spec.timestamp, 0.04));
	}

	await output.finalize();
	return output.target.buffer!;
};

const openCursor = async (file: ArrayBuffer) => {
	const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
	const track = (await input.getPrimaryVideoTrack())!;
	return { input, cursor: new VideoSampleCursor(track) };
};

test('Seeking to leading pictures that present before every key packet resolves to the first key packet', async () => {
	// A track cut mid-group: the first packet in decode order is a key packet whose two leading pictures, which
	// present before it, follow it
	const file = await createFile([
		{ type: 'key', timestamp: 0.08 },
		{ type: 'delta', timestamp: 0 },
		{ type: 'delta', timestamp: 0.04 },
		{ type: 'delta', timestamp: 0.12 },
		{ type: 'delta', timestamp: 0.16 },
	]);
	const { input, cursor } = await openCursor(file);

	// An unhandled rejection from the pump would fail the test run
	const sample = await cursor.seekTo(0);
	expect(sample?.timestamp).toBeCloseTo(0.08, 6);

	expect((await cursor.seekTo(0.05))?.timestamp).toBeCloseTo(0.08, 6);
	expect((await cursor.next())?.timestamp).toBeCloseTo(0.12, 6);

	await cursor.close();
	input.dispose();
});

test('Seeking before the first key packet skips key packets whose bitstream is not a key frame', async () => {
	// The container's first key packet is really a delta frame, so decoding can only start at the second one
	const file = await createFile([
		{ type: 'key', actualType: 'delta', timestamp: 0.08 },
		{ type: 'delta', timestamp: 0 },
		{ type: 'delta', timestamp: 0.04 },
		{ type: 'delta', timestamp: 0.12 },
		{ type: 'delta', timestamp: 0.16 },
		{ type: 'key', timestamp: 0.2 },
		{ type: 'delta', timestamp: 0.24 },
	]);
	const { input, cursor } = await openCursor(file);

	expect((await cursor.seekTo(0))?.timestamp).toBeCloseTo(0.2, 6);
	expect((await cursor.next())?.timestamp).toBeCloseTo(0.24, 6);

	await cursor.close();
	input.dispose();
});

test('Seeking in a track without a key packet decoding can start at rejects', async () => {
	const file = await createFile([
		{ type: 'key', actualType: 'delta', timestamp: 0.04 },
		{ type: 'delta', timestamp: 0 },
		{ type: 'delta', timestamp: 0.08 },
	]);
	const { input, cursor } = await openCursor(file);

	await expect(cursor.seekTo(0)).rejects.toThrow('The track has no key packet that decoding can start at.');

	input.dispose();
});
