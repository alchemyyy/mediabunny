import { expect, test } from 'vitest';
import { Input } from '../../src/input.js';
import { BufferSource, UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { assert } from '../../src/misc.js';
import { AudioSampleCursor, VideoSampleCursor } from '../../src/cursors.js';
import { PacketReader } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { MpegTsOutputFormat } from '../../src/output-format.js';
import { BufferTarget } from '../../src/target.js';
import { Conversion } from '../../src/conversion.js';
import { AudioSample, AudioSampleCopyToOptions } from '../../src/sample.js';
import { OPUS_PRE_ROLL_DURATION } from '../../src/codec.js';
import { InputAudioTrack } from '../../src/input-track.js';

// https://github.com/Vanilagy/mediabunny/issues/370
test('Negative audio timestamps are preserved', async () => {
	using input = new Input({
		source: new UrlSource('/edts.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getFirstTimestamp()).toBeLessThan(0);

	await using cursor = new AudioSampleCursor(track);

	for await (const sample of cursor) {
		expect(sample.timestamp).toBe(await track.getFirstTimestamp());
		break;
	}
});

test('No B-frames are skipped when software-decoding AVC', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	await using cursor = new VideoSampleCursor(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const sample of cursor) {
		count++;
	}

	expect(count).toBe(48);
});

test('No B-frames are skipped when software-decoding AVC, Annex B edition', async () => {
	using input = new Input({
		source: new UrlSource('/missing-reorder-metadata-v1.mp4'),
		formats: ALL_FORMATS,
	});

	// Force Annex B by converting to MPEG-TS
	const output = new Output({
		format: new MpegTsOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, copy: { mode: 'forced' } });
	await conversion.execute();

	using newInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await newInput.getPrimaryVideoTrack();
	assert(track);

	await using cursor = new VideoSampleCursor(track, {
		hardwareAcceleration: 'prefer-software',
	});
	let count = 0;

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	for await (const sample of cursor) {
		count++;
	}

	expect(count).toBe(48);
});

test('Fallback sample past the end survives cursor close', async () => {
	using input = new Input({
		source: new UrlSource('/video.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);

	const cursor = new VideoSampleCursor(track, { closeSamples: false });
	const sample = await cursor.seekTo(await track.computeDuration() + 0.5);
	assert(sample);
	await cursor.close();

	expect(sample._closed).toBe(false);
	sample.close();
});

test('Audio decoder pre-roll (AAC)', async () => {
	using input = new Input({
		source: new UrlSource('/demo.mp4'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('aac');
	expect(await track.getPreRollDuration()).toBe(1024 / await track.getSampleRate());

	await testAudioDecoderPreRoll(track, -90);
});

test('Audio decoder pre-roll (Opus)', async () => {
	using input = new Input({
		source: new UrlSource('/preroll-test.opus'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('opus');
	expect(await track.getPreRollDuration()).toBe(OPUS_PRE_ROLL_DURATION);

	await testAudioDecoderPreRoll(track, -90);
});

const testAudioDecoderPreRoll = async (track: InputAudioTrack, maxErrorDb: number) => {
	// Decoding straight through from the start gives us a reference sample with fully converged decoder state
	let referenceTimestamp: number | null = null;
	let referenceData: Float32Array | null = null;
	{
		await using cursor = new AudioSampleCursor(track);
		for await (const sample of cursor) {
			if (sample.timestamp >= 1) {
				referenceTimestamp = sample.timestamp;
				referenceData = getSampleData(sample);
				break;
			}
		}
	}
	assert(referenceTimestamp !== null);
	assert(referenceData);

	// A seek starts a new decode run, which must begin early enough for the decoder to converge
	await using cursor = new AudioSampleCursor(track);
	let sample = await cursor.seekTo(referenceTimestamp);
	assert(sample);
	expect(sample.timestamp).toBe(referenceTimestamp);
	expectSimilarData(getSampleData(sample), referenceData, maxErrorDb);

	// Same after the cursor went elsewhere first
	await cursor.seekTo(0);
	sample = await cursor.seekTo(referenceTimestamp);
	assert(sample);
	expect(sample.timestamp).toBe(referenceTimestamp);
	expectSimilarData(getSampleData(sample), referenceData, maxErrorDb);
};

const getSampleData = (sample: AudioSample) => {
	const options: AudioSampleCopyToOptions = {
		planeIndex: 0,
		format: 'f32',
	};

	const data = new Float32Array(sample.allocationSize(options) / Float32Array.BYTES_PER_ELEMENT);
	sample.copyTo(data, options);

	return data;
};

const expectSimilarData = (actual: Float32Array, expected: Float32Array, maxErrorDb: number) => {
	expect(actual.length).toBe(expected.length);

	let maxDifference = 0;
	for (let i = 0; i < actual.length; i++) {
		maxDifference = Math.max(maxDifference, Math.abs(actual[i]! - expected[i]!));
	}

	expect(20 * Math.log10(maxDifference)).toBeLessThan(maxErrorDb);
};

test('Sample retrieval within Opus pre-skip', async () => {
	using input = new Input({
		source: new UrlSource('/demo.webm'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	expect(await track.getCodec()).toBe('opus');
	expect(await track.getPreRollDuration()).toBe(OPUS_PRE_ROLL_DURATION);

	const firstPacket = await new PacketReader(track).getFirst();
	assert(firstPacket);

	await using cursor = new AudioSampleCursor(track);

	// The decoder trims the pre-skip off the first packet, so the first sample starts after it
	const firstSample = await cursor.seekToFirst();
	assert(firstSample);
	const firstSampleTimestamp = firstSample.timestamp;
	expect(firstSampleTimestamp).toBeGreaterThan(firstPacket.timestamp);

	const timestamps = [
		firstPacket.timestamp,
		(firstPacket.timestamp + firstSampleTimestamp) / 2,
		firstSampleTimestamp,
		1,
	];
	const results: { timestamp: number; duration: number }[] = [];
	for (const timestamp of timestamps) {
		const sample = await cursor.seekTo(timestamp);
		assert(sample);
		results.push({
			timestamp: sample.timestamp,
			duration: sample.duration,
		});
	}

	// No sample starts at or before these, so the first sample after them is the answer
	expect(results[0]!.timestamp).toBe(firstSampleTimestamp);
	expect(results[1]!.timestamp).toBe(firstSampleTimestamp);

	expect(results[2]!.timestamp).toBe(firstSampleTimestamp);

	expect(results[3]!.timestamp).toBeLessThanOrEqual(1);
	expect(results[3]!.timestamp + results[3]!.duration).toBeGreaterThan(1);
});

test('Consecutive seeks resolve while later timestamps are still unknown', async () => {
	using input = new Input({
		source: new UrlSource('/glitch-hop-is-dead.wav'),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	assert(track);

	const packetReader = new PacketReader(track);
	const firstPacket = await packetReader.getFirst();
	assert(firstPacket);
	const secondPacket = await packetReader.getNext(firstPacket);
	assert(secondPacket);

	// Each seek must resolve on its own, without the cursor waiting for the next one to come in
	await using cursor = new AudioSampleCursor(track);
	const sampleTimestamps: number[] = [];
	for (const timestamp of [firstPacket.timestamp, secondPacket.timestamp]) {
		const sample = await cursor.seekTo(timestamp);
		assert(sample);
		sampleTimestamps.push(sample.timestamp);
	}

	expect(sampleTimestamps).toEqual([firstPacket.timestamp, secondPacket.timestamp]);
});
