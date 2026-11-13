import { expect, test, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ALL_FORMATS,
	AudioCodec,
	AudioSample,
	AudioSampleCursor,
	BufferSource,
	BufferTarget,
	CustomAudioDecoder,
	CustomVideoDecoder,
	EncodedAudioPacketSource,
	EncodedPacket,
	FilePathSource,
	Input,
	InputAudioTrack,
	MkvOutputFormat,
	Output,
	PacketCursor,
	registerDecoder,
	VideoCodec,
	VideoSample,
	VideoSampleCursor,
} from '../../src/index.js';
import { assert, last, MaybePromise } from '../../src/misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const decoders: (FakeVideoDecoder | FailingAudioDecoder | FakeAudioDecoder)[] = [];

class FakeVideoDecoder extends CustomVideoDecoder {
	static failing = false;

	decodedCount = 0;
	closed = false;

	static override supports(codec: VideoCodec) {
		return codec === 'vp9';
	}

	init() {
		decoders.push(this);
	}

	decode(packet: EncodedPacket) {
		if (FakeVideoDecoder.failing) {
			throw new Error('Decode failed');
		}

		this.decodedCount++;
		this.onSample(new VideoSample(new Uint8Array(4), {
			format: 'RGBA',
			codedWidth: 1,
			codedHeight: 1,
			timestamp: packet.timestamp,
			duration: packet.duration,
		}));
	}

	flush() {}

	close() {
		this.closed = true;
	}
}

class FailingAudioDecoder extends CustomAudioDecoder {
	closed = false;

	static override supports(codec: AudioCodec) {
		return codec === 'mp3';
	}

	init() {
		decoders.push(this);
	}

	decode() {
		throw new Error('Decode failed');
	}

	flush() {}

	close() {
		this.closed = true;
	}
}

class FakeAudioDecoder extends CustomAudioDecoder {
	samples: AudioSample[] = [];
	closed = false;

	static override supports(codec: AudioCodec) {
		return codec === 'flac';
	}

	init() {
		decoders.push(this);
	}

	decode(packet: EncodedPacket) {
		const { numberOfChannels, sampleRate } = this.config;
		const sample = new AudioSample({
			data: new Float32Array(numberOfChannels * Math.round(sampleRate * packet.duration)),
			format: 'f32',
			numberOfChannels,
			sampleRate,
			timestamp: packet.timestamp,
		});
		this.samples.push(sample);
		this.onSample(sample);
	}

	flush() {}

	close() {
		this.closed = true;
	}
}

registerDecoder(FakeVideoDecoder);
registerDecoder(FailingAudioDecoder);
registerDecoder(FakeAudioDecoder);

// Main's sink iterator cases map to a cursor that is stepped with next() (range iteration) or seekTo() (timestamp
// queries), stalled with a full sample queue, and then ended by input disposal, a decoder error or a throw() into its
// iterator.

test('Cursor stepped with next() closes its decoder on disposal', async () => {
	await testDecoderClosedAfterThrow(cursor => cursor.next(), 'dispose');
});

test('Cursor stepped with next() closes its decoder after a decoder error', async () => {
	await testDecoderClosedAfterThrow(cursor => cursor.next(), 'decoderError');
});

test('Cursor stepped with seekTo() closes its decoder on disposal', async () => {
	await testDecoderClosedAfterThrow(cursor => cursor.seekTo(0), 'dispose');
});

test('Cursor stepped with seekTo() closes its decoder after a decoder error', async () => {
	await testDecoderClosedAfterThrow(cursor => cursor.seekTo(0), 'decoderError');
});

test('Cursor stepped with next() closes its decoder after its iterator is thrown into', async () => {
	await testDecoderClosedAfterThrow(cursor => cursor.next(), 'throw');
});

test('Cursor stepped with seekTo() closes its decoder after its iterator is thrown into', async () => {
	await testDecoderClosedAfterThrow(cursor => cursor.seekTo(0), 'throw');
});

const testDecoderClosedAfterThrow = async (
	step: (cursor: VideoSampleCursor) => MaybePromise<VideoSample | null>,
	cause: 'dispose' | 'decoderError' | 'throw',
) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/frames.webm')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	await using cursor = new VideoSampleCursor(track);
	const sample = await step(cursor);
	assert(sample);

	// Let the pump fill up the sample queue until it stalls, waiting for the consumer
	const decoder = last(decoders);
	assert(decoder instanceof FakeVideoDecoder);
	let decodedCount = -1;
	while (decoder.decodedCount !== decodedCount) {
		decodedCount = decoder.decodedCount;
		await new Promise(resolve => setTimeout(resolve, 50));
	}

	if (cause === 'dispose') {
		input.dispose();
		// Disposing the input closes its cursors, so they report being closed rather than an InputDisposedError
		await expect((async () => cursor.next())()).rejects.toThrow('This cursor has been closed');
	} else if (cause === 'decoderError') {
		decoder.onError(new Error('Decoding failed'));
		await expect((async () => cursor.next())()).rejects.toThrow('Decoding failed');
	} else {
		// A cursor outlives its iterators; ending the iteration leaves closing to the cursor's owner
		const iterator = cursor[Symbol.asyncIterator]();
		expect((await iterator.next()).done).toBe(false);
		await expect(iterator.throw(new Error('Stopped'))).rejects.toThrow('Stopped');
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
		await cursor.close();
	}

	await vi.waitFor(() => expect(decoder.closed).toBe(true));
};

test('PCM ranges split at packet boundaries', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetTimestamps = await getPacketTimestamps(track);
	await using cursor = new AudioSampleCursor(track);

	for (let i = 1; i < 30; i++) {
		const end = packetTimestamps[i]!;
		const timestamps: number[] = [];
		let sample = await cursor.seekTo(0);
		while (sample && sample.timestamp < end) {
			timestamps.push(sample.timestamp);
			sample = await cursor.next();
		}

		expect(timestamps).toEqual(packetTimestamps.slice(0, i));
	}
});

test('PCM seeks going back within a packet', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/glitch-hop-is-dead.wav')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetTimestamps = await getPacketTimestamps(track);
	await using cursor = new AudioSampleCursor(track);

	for (const timestamp of packetTimestamps.slice(0, 60)) {
		const timestamps: (number | null)[] = [];
		for (const queryTimestamp of [timestamp + 0.001, timestamp + 0.0005]) {
			const sample = await cursor.seekTo(queryTimestamp);
			timestamps.push(sample?.timestamp ?? null);
		}

		expect(timestamps).toEqual([timestamp, timestamp]);
	}
});

const getPacketTimestamps = async (track: InputAudioTrack) => {
	const timestamps: number[] = [];
	for await (const packet of new PacketCursor(track, { options: { metadataOnly: true } })) {
		timestamps.push(packet.timestamp);
	}

	return timestamps;
};

test('Failing custom audio decoder', async () => {
	await testFailingCustomDecoder('Toothsome-Meme.VBRv2.mp3', async (input): Promise<AudioSampleCursor> => {
		const track = await input.getPrimaryAudioTrack();
		assert(track);

		return new AudioSampleCursor(track);
	});
});

test('Failing custom video decoder', async () => {
	// Decoders stay registered for the whole file, so we make the fake one fail instead of registering another one
	FakeVideoDecoder.failing = true;

	try {
		await testFailingCustomDecoder('frames.webm', async (input): Promise<VideoSampleCursor> => {
			const track = await input.getPrimaryVideoTrack();
			assert(track);

			return new VideoSampleCursor(track);
		});
	} finally {
		FakeVideoDecoder.failing = false;
	}
});

const testFailingCustomDecoder = async (
	fileName: string,
	createCursor: (input: Input) => Promise<AudioSampleCursor | VideoSampleCursor>,
) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public', fileName)),
		formats: ALL_FORMATS,
	});

	await expect(async () => {
		await using cursor = await createCursor(input);
		for await (const sample of cursor) {
			void sample;
		}
	}).rejects.toThrow('Decode failed');

	const decoder = last(decoders);
	assert(decoder);
	await vi.waitFor(() => expect(decoder.closed).toBe(true));
};

test('Cursor closes its decoder when closed while a seek is still decoding', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/frames.webm')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	// Main's case closed a timestamp iterator while it waited for timestamps; cursors take no timestamp source, so
	// the closest hazard is closing the cursor while a seek is still pending
	const cursor = new VideoSampleCursor(track);
	const seekPromise = cursor.seekTo(2.9);
	await cursor.close();
	await seekPromise;

	const decoder = last(decoders);
	assert(decoder instanceof FakeVideoDecoder);
	await vi.waitFor(() => expect(decoder.closed).toBe(true));
});

test('Cursor closes its decoder and samples when its transform throws', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample.flac')),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	// AudioBuffer doesn't exist in Node, so converting the first sample throws
	await using cursor = new AudioSampleCursor(track, {
		transform: sample => ({
			buffer: sample.toAudioBuffer(),
			timestamp: sample.timestamp,
			duration: sample.duration,
		}),
	});
	await expect((async () => cursor.next())()).rejects.toThrow('AudioBuffer is not defined');

	const decoder = last(decoders);
	assert(decoder instanceof FakeAudioDecoder);
	await vi.waitFor(() => expect(decoder.closed).toBe(true));
	expect(decoder.samples.length).toBeGreaterThan(0);
	expect(decoder.samples.every(x => x._closed)).toBe(true);
});

test('PCM packets smaller than a frame', async () => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});
	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);
	await output.start();

	const meta = {
		decoderConfig: {
			codec: 'pcm-s16',
			numberOfChannels: 2,
			sampleRate: 48000,
		},
	};
	await source.add(new EncodedPacket(new Uint8Array(4 * 480), 'key', 0, 0.01), meta);
	await source.add(new EncodedPacket(new Uint8Array(0), 'key', 0.01, 0));
	await source.add(new EncodedPacket(new Uint8Array(4 * 480), 'key', 0.01, 0.01));
	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	assert(track);

	await using cursor = new AudioSampleCursor(track);
	const frameCounts: number[] = [];
	for await (const sample of cursor) {
		frameCounts.push(sample.numberOfFrames);
	}

	expect(frameCounts).toEqual([480, 480]);
});
