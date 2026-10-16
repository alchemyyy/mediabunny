import { afterEach, beforeEach, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleCursor, VideoSampleCursor } from '../../src/cursors.js';
import { AudioSampleSource, VideoSampleSource } from '../../src/media-source.js';
import {
	CustomAudioDecoder,
	CustomAudioEncoder,
	CustomVideoDecoder,
	CustomVideoEncoder,
	registerDecoder,
	registerEncoder,
} from '../../src/custom-coder.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';
import { Output } from '../../src/output.js';
import { WebMOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { AudioSample, VideoSample } from '../../src/sample.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const decodeError = new Error('Custom decoder failure');
const encodeError = new Error('Custom encoder failure');
const closeTimeout = 1000;
const videoSize = 16;
const audioSampleRate = 48000;
const audioChannelCount = 2;

let closeCount = 0;
let onClose = () => {};
let unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
	unhandledRejections.push(reason);
};

beforeEach(() => {
	closeCount = 0;
	unhandledRejections = [];
	process.on('unhandledRejection', recordUnhandledRejection);
});

afterEach(() => {
	process.off('unhandledRejection', recordUnhandledRejection);
});

class FailingVideoDecoder extends CustomVideoDecoder {
	static override supports(codec: VideoCodec) {
		return codec === 'avc';
	}

	init() {}

	decode() {
		throw decodeError;
	}

	flush() {}

	close() {
		closeCount++;
		onClose();
	}
}

class FailingAudioDecoder extends CustomAudioDecoder {
	static override supports(codec: AudioCodec) {
		return codec === 'ac3';
	}

	init() {}

	async decode() {
		throw decodeError;
	}

	flush() {}

	close() {
		closeCount++;
		onClose();
	}
}

registerDecoder(FailingVideoDecoder);
registerDecoder(FailingAudioDecoder);

type EncoderCall = 'encode' | 'flush';

// The call the failing encoders reject, which each encoder test sets
let failingEncoderCall: EncoderCall = 'encode';

const runEncoderCall = (call: EncoderCall) => {
	if (call === failingEncoderCall) {
		throw encodeError;
	}
};

class FailingVideoEncoder extends CustomVideoEncoder {
	static override supports(codec: VideoCodec) {
		return codec === 'vp9';
	}

	init() {}

	async encode() {
		runEncoderCall('encode');
	}

	async flush() {
		runEncoderCall('flush');
	}

	close() {
		closeCount++;
		onClose();
	}
}

class FailingAudioEncoder extends CustomAudioEncoder {
	static override supports(codec: AudioCodec) {
		return codec === 'opus';
	}

	init() {}

	async encode() {
		runEncoderCall('encode');
	}

	async flush() {
		runEncoderCall('flush');
	}

	close() {
		closeCount++;
		onClose();
	}
}

registerEncoder(FailingVideoEncoder);
registerEncoder(FailingAudioEncoder);

/** Resolves once the custom coder is closed, or after a timeout so a coder that is never closed fails the test. */
const waitForClose = () => new Promise<void>((resolve) => {
	onClose = resolve;
	setTimeout(resolve, closeTimeout);
});

const expectClosedWithoutUnhandledRejection = async () => {
	await waitForClose();
	// Let a rejection that has no handler surface
	await new Promise(resolve => setTimeout(resolve, 0));

	expect(closeCount).toBe(1);
	expect(unhandledRejections).toEqual([]);
};

test('Custom video decoder is closed after its decode fails', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryVideoTrack())!;
	await using cursor = new VideoSampleCursor(track);

	const closed = expectClosedWithoutUnhandledRejection();
	await expect(async () => {
		for await (const sample of cursor) {
			void sample;
		}
	}).rejects.toBe(decodeError);
	await closed;
});

test('Custom audio decoder is closed after its decode fails', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '..', 'public/ac3.mp4')),
		formats: ALL_FORMATS,
	});

	const track = (await input.getPrimaryAudioTrack())!;
	await using cursor = new AudioSampleCursor(track);

	const closed = expectClosedWithoutUnhandledRejection();
	await expect(async () => {
		for await (const sample of cursor) {
			void sample;
		}
	}).rejects.toBe(decodeError);
	await closed;
});

test.each(['encode', 'flush'] as const)('Custom video encoder is closed after its %s fails', async (call) => {
	failingEncoderCall = call;
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const videoSource = new VideoSampleSource({ codec: 'vp9', bitrate: 1e6 });
	output.addVideoTrack(videoSource);
	await output.start();

	const closed = expectClosedWithoutUnhandledRejection();
	const sample = new VideoSample(new Uint8Array(videoSize * videoSize * 4), {
		codedWidth: videoSize,
		codedHeight: videoSize,
		format: 'RGBA',
		timestamp: 0,
	});
	await videoSource.add(sample);
	sample.close();
	videoSource.close();

	await expect(output.finalize()).rejects.toBe(encodeError);
	await closed;
});

test.each(['encode', 'flush'] as const)('Custom audio encoder is closed after its %s fails', async (call) => {
	failingEncoderCall = call;
	const output = new Output({
		format: new WebMOutputFormat(),
		target: new BufferTarget(),
	});
	const audioSource = new AudioSampleSource({ codec: 'opus', bitrate: 128e3 });
	output.addAudioTrack(audioSource);
	await output.start();

	const closed = expectClosedWithoutUnhandledRejection();
	const sample = new AudioSample({
		data: new Float32Array(audioSampleRate * audioChannelCount),
		format: 'f32',
		numberOfChannels: audioChannelCount,
		sampleRate: audioSampleRate,
		timestamp: 0,
	});
	await audioSource.add(sample);
	sample.close();
	audioSource.close();

	await expect(output.finalize()).rejects.toBe(encodeError);
	await closed;
});
