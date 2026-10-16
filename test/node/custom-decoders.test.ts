import { afterEach, beforeEach, expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { FilePathSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { AudioSampleSink, VideoSampleSink } from '../../src/media-sink.js';
import { CustomAudioDecoder, CustomVideoDecoder, registerDecoder } from '../../src/custom-coder.js';
import { AudioCodec, VideoCodec } from '../../src/codec.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const decodeError = new Error('Custom decoder failure');
const closeTimeout = 1000;

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

/** Resolves once the custom decoder is closed, or after a timeout so a decoder that is never closed fails the test. */
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
	const sink = new VideoSampleSink(track);

	const closed = expectClosedWithoutUnhandledRejection();
	await expect(async () => {
		for await (using sample of sink.samples()) {
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
	const sink = new AudioSampleSink(track);

	const closed = expectClosedWithoutUnhandledRejection();
	await expect(async () => {
		for await (using sample of sink.samples()) {
			void sample;
		}
	}).rejects.toBe(decodeError);
	await closed;
});
