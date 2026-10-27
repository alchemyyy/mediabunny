/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { expect, test, beforeAll } from 'vitest';
import { Input, Output } from '../../src/index.js';
import { BufferSource, BufferTarget, FilePathSource } from '../../src/index.js';
import { ALL_FORMATS, AVI, AviOutputFormat } from '../../src/index.js';
import { EncodedVideoPacketSource, EncodedAudioPacketSource, PacketCursor, PacketReader } from '../../src/index.js';
import { EncodedPacket } from '../../src/index.js';
import { registerMpeg4Decoder, registerMpeg4Encoder } from '../../packages/mpeg4/src/index.js';
import { aviWaveFormatToCodec, parseWaveFormatEx } from '../../src/avi/avi-misc.js';

beforeAll(() => {
	registerMpeg4Decoder();
	registerMpeg4Encoder();
});

test('Should be able to detect AVI format', async () => {
	const buffer = new ArrayBuffer(12);
	const view = new DataView(buffer);

	view.setUint8(0, 0x52);
	view.setUint8(1, 0x49);
	view.setUint8(2, 0x46);
	view.setUint8(3, 0x46);
	view.setUint32(4, 4, true);
	view.setUint8(8, 0x41);
	view.setUint8(9, 0x56);
	view.setUint8(10, 0x49);
	view.setUint8(11, 0x20);

	using input = new Input({
		source: new BufferSource(new Uint8Array(buffer)),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(AVI);
});

test('Should be able to create AVI output with video track', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new AviOutputFormat(),
	});

	const videoPacket = new EncodedPacket(
		new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67]),
		'key',
		0,
		0.033,
		0,
	);

	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	await videoSource.add(videoPacket, {
		decoderConfig: {
			codec: 'avc1.640028',
			codedWidth: 640,
			codedHeight: 480,
		},
	});

	await output.finalize();

	const result = target.buffer ? new Uint8Array(target.buffer) : new Uint8Array();
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.length).toBeGreaterThan(0);

	const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
	expect(resultView.getUint8(0)).toBe(0x52);
	expect(resultView.getUint8(1)).toBe(0x49);
	expect(resultView.getUint8(2)).toBe(0x46);
	expect(resultView.getUint8(3)).toBe(0x46);

	expect(resultView.getUint8(8)).toBe(0x41);
	expect(resultView.getUint8(9)).toBe(0x56);
	expect(resultView.getUint8(10)).toBe(0x49);
	expect(resultView.getUint8(11)).toBe(0x20);
});

test('Should be able to create AVI output with audio track', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new AviOutputFormat(),
	});

	const audioPacket = new EncodedPacket(
		new Uint8Array([0xFF, 0xFB, 0x90, 0x00]),
		'key',
		0,
		0.026,
		0,
	);

	const audioSource = new EncodedAudioPacketSource('mp3');
	output.addAudioTrack(audioSource);
	await output.start();

	await audioSource.add(audioPacket, {
		decoderConfig: {
			codec: 'mp3',
			sampleRate: 44100,
			numberOfChannels: 2,
		},
	});

	await output.finalize();

	const result = target.buffer ? new Uint8Array(target.buffer) : new Uint8Array();
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.length).toBeGreaterThan(0);

	const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
	const riff = String.fromCharCode(
		resultView.getUint8(0),
		resultView.getUint8(1),
		resultView.getUint8(2),
		resultView.getUint8(3),
	);
	expect(riff).toBe('RIFF');
	const aviType = String.fromCharCode(
		resultView.getUint8(8),
		resultView.getUint8(9),
		resultView.getUint8(10),
		resultView.getUint8(11),
	);
	expect(aviType).toBe('AVI ');
});

test('Should properly handle AVI codec mappings', () => {
	const format = new AviOutputFormat();

	const supportedVideoCodecs = format.getSupportedVideoCodecs();
	expect(supportedVideoCodecs).toContain('avc');
	expect(supportedVideoCodecs).toContain('hevc');
	expect(supportedVideoCodecs).toContain('vp8');
	expect(supportedVideoCodecs).toContain('vp9');
	expect(supportedVideoCodecs).toContain('av1');
	expect(supportedVideoCodecs).toContain('mpeg4');

	const supportedAudioCodecs = format.getSupportedAudioCodecs();
	expect(supportedAudioCodecs).toContain('mp3');
	expect(supportedAudioCodecs).toContain('aac');
	expect(supportedAudioCodecs).toContain('vorbis');
	expect(supportedAudioCodecs).toContain('flac');
	expect(supportedAudioCodecs).toContain('pcm-s16');
	expect(supportedAudioCodecs).toContain('pcm-f32');
	expect(supportedAudioCodecs).toContain('ulaw');
	expect(supportedAudioCodecs).toContain('alaw');

	expect(format.fileExtension).toBe('.avi');
	expect(format.mimeType).toBe('video/x-msvideo');
});

test('Should be able to create AVI with both video and audio', async () => {
	const target = new BufferTarget();
	const output = new Output({
		target,
		format: new AviOutputFormat(),
	});

	const videoPackets = [];
	for (let i = 0; i < 3; i++) {
		videoPackets.push(new EncodedPacket(
			new Uint8Array([0x00, 0x00, 0x00, 0x01, i === 0 ? 0x67 : 0x41]),
			i === 0 ? 'key' : 'delta',
			i * 0.033,
			0.033,
			i,
		));
	}

	const audioPackets = [];
	for (let i = 0; i < 4; i++) {
		audioPackets.push(new EncodedPacket(
			new Uint8Array([0xFF, 0xFB, 0x90, 0x00]),
			'key',
			i * 0.026,
			0.026,
			i,
		));
	}

	const videoSource = new EncodedVideoPacketSource('avc');
	const audioSource = new EncodedAudioPacketSource('mp3');

	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);
	await output.start();

	for (let i = 0; i < videoPackets.length; i++) {
		await videoSource.add(videoPackets[i]!, i === 0
			? {
					decoderConfig: {
						codec: 'avc1.640028',
						codedWidth: 640,
						codedHeight: 480,
					},
				}
			: undefined);
	}

	for (let i = 0; i < audioPackets.length; i++) {
		await audioSource.add(audioPackets[i]!, i === 0
			? {
					decoderConfig: {
						codec: 'mp3',
						sampleRate: 44100,
						numberOfChannels: 2,
					},
				}
			: undefined);
	}

	await output.finalize();

	const result = target.buffer ? new Uint8Array(target.buffer) : new Uint8Array();
	expect(result).toBeInstanceOf(Uint8Array);
	expect(result.length).toBeGreaterThan(100);

	const resultView = new DataView(result.buffer, result.byteOffset, result.byteLength);
	expect(resultView.getUint8(0)).toBe(0x52);
	expect(resultView.getUint8(1)).toBe(0x49);
	expect(resultView.getUint8(2)).toBe(0x46);
	expect(resultView.getUint8(3)).toBe(0x46);
	expect(resultView.getUint8(8)).toBe(0x41);
	expect(resultView.getUint8(9)).toBe(0x56);
	expect(resultView.getUint8(10)).toBe(0x49);
	expect(resultView.getUint8(11)).toBe(0x20);
});

test('Should read AVI files with various video codecs', async () => {
	const testFiles = [
		{ file: 'avc-aac.avi', expectedVideoCodec: 'avc', expectedAudioCodec: 'aac' },
		{ file: 'hevc-aac.avi', expectedVideoCodec: 'hevc', expectedAudioCodec: 'aac' },
		{ file: 'vp8-mp3.avi', expectedVideoCodec: 'vp8', expectedAudioCodec: 'mp3' },
		{ file: 'vp9-vorbis.avi', expectedVideoCodec: 'vp9', expectedAudioCodec: 'vorbis' },
		{ file: 'av1-aac.avi', expectedVideoCodec: 'av1', expectedAudioCodec: 'aac' },
		{ file: 'mpeg4-mp3.avi', expectedVideoCodec: 'mpeg4', expectedAudioCodec: 'mp3' },
	];

	for (const { file, expectedVideoCodec, expectedAudioCodec } of testFiles) {
		using input = new Input({
			source: new FilePathSource(`test/public/avi/${file}`),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(AVI);

		const videoTracks = await input.getVideoTracks();
		const audioTracks = await input.getAudioTracks();

		if (videoTracks.length === 0 && audioTracks.length === 0) {
			throw new Error(
				`No tracks found in ${file}. This indicates the AVI demuxer is not parsing streams correctly.`,
			);
		}

		expect(videoTracks.length).toBeGreaterThan(0);
		expect(await videoTracks[0]!.getCodec()).toBe(expectedVideoCodec);

		expect(audioTracks.length).toBeGreaterThan(0);
		expect(await audioTracks[0]!.getCodec()).toBe(expectedAudioCodec);
	}
});

test('Should read audio-only AVI files', async () => {
	const testFiles = [
		{ file: 'aac-only.avi', expectedCodec: 'aac' },
		{ file: 'mp3-only.avi', expectedCodec: 'mp3' },
		{ file: 'vorbis-only.avi', expectedCodec: 'vorbis' },
		{ file: 'flac-only.avi', expectedCodec: 'flac' },
		{ file: 'pcm-s16.avi', expectedCodec: 'pcm-s16' },
		{ file: 'pcm-f32.avi', expectedCodec: 'pcm-f32' },
		{ file: 'ulaw.avi', expectedCodec: 'ulaw' },
		{ file: 'alaw.avi', expectedCodec: 'alaw' },
	];

	for (const { file, expectedCodec } of testFiles) {
		using input = new Input({
			source: new FilePathSource(`test/public/avi/${file}`),
			formats: ALL_FORMATS,
		});

		expect(await input.getFormat()).toBe(AVI);

		const videoTracks = await input.getVideoTracks();
		expect(videoTracks.length).toBe(0);

		const audioTracks = await input.getAudioTracks();
		expect(audioTracks.length).toBeGreaterThan(0);
		expect(await audioTracks[0]!.getCodec()).toBe(expectedCodec);
		// Plain WAVEFORMATEX declares no speakers
		expect(await audioTracks[0]!.getChannelMask()).toBeNull();
	}
});

test('AVI packet timestamps follow each stream\'s rate, scale, and sample size', async () => {
	// PCM chunks hold many samples each, so their timestamps follow their byte counts
	using pcmInput = new Input({
		source: new FilePathSource('test/public/avi/pcm-s16.avi'),
		formats: ALL_FORMATS,
	});
	const pcmTrack = (await pcmInput.getAudioTracks())[0]!;
	const pcmSampleRate = await pcmTrack.getSampleRate();
	const pcmBytesPerFrame = 2 * await pcmTrack.getNumberOfChannels();

	let expectedTimestamp = 0;
	for await (const packet of new PacketCursor(pcmTrack)) {
		expect(packet.timestamp).toBeCloseTo(expectedTimestamp, 9);
		expect(packet.duration).toBeCloseTo(packet.byteLength / pcmBytesPerFrame / pcmSampleRate, 9);
		expectedTimestamp += packet.duration;
	}
	expect(expectedTimestamp).toBeGreaterThan(0);

	// Video chunks take one frame each, and the first packet is a key packet; VP8 presents in decode order, and the
	// empty chunk FFmpeg's muxer writes after the first frame takes a slot without a packet
	using videoInput = new Input({
		source: new FilePathSource('test/public/avi/vp8-mp3.avi'),
		formats: ALL_FORMATS,
	});
	const videoTrack = (await videoInput.getVideoTracks())[0]!;
	const reader = new PacketReader(videoTrack);
	const firstPacket = (await reader.getFirst())!;
	expect(firstPacket.type).toBe('key');
	expect(firstPacket.timestamp).toBe(0);
	const secondPacket = (await reader.getNext(firstPacket))!;
	expect(secondPacket.timestamp).toBeCloseTo(2 * firstPacket.duration, 9);
	const thirdPacket = (await reader.getNext(secondPacket))!;
	expect(thirdPacket.timestamp).toBeCloseTo(secondPacket.timestamp + secondPacket.duration, 9);
	expect(await reader.getAt(-1)).toBeNull();

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toBe('vp8');
});

test('AVI variable-bitrate MP3 is timed one frame per chunk, as FFmpeg reads it', async () => {
	// FFmpeg's muxer declares a block alignment of 1152 for VBR MP3, and writes empty chunks that take no time
	using input = new Input({
		source: new FilePathSource('test/public/avi/h264-mp3-vbr.avi'),
		formats: ALL_FORMATS,
	});
	const audioTrack = (await input.getAudioTracks())[0]!;
	const frameDuration = 1152 / await audioTrack.getSampleRate();

	let packetIndex = 0;
	for await (const packet of new PacketCursor(audioTrack)) {
		expect(packet.timestamp).toBeCloseTo(packetIndex * frameDuration, 9);
		expect(packet.duration).toBeCloseTo(frameDuration, 9);
		packetIndex++;
	}
	expect(packetIndex).toBeGreaterThan(1);
});

// Each packet's presentation timestamp in frames, in decode order, as FFprobe's best-effort timestamps give the same
// pictures: their order counts sorted, then delayed by the reorder depth each stream's sequence parameter set declares
const PRESENTATION_FRAMES = [
	{
		// H.264 without B-frames, whose order counts follow decode order, presents in its slots without delay
		file: 'avc-no-bframes.avi',
		frames: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
	},
	{
		// H.264 High with B-pyramids
		file: 'avc-aac.avi',
		frames: [2, 6, 4, 3, 5, 10, 8, 7, 9, 14, 12, 11, 13, 18, 16, 15, 17, 22, 20, 19, 21, 26, 24, 23, 25],
	},
	{
		// H.264 High in two groups, the second starting at packet 6
		file: 'h264-mp3-vbr.avi',
		frames: [2, 5, 3, 4, 7, 6, 8, 11, 9, 10, 13, 12],
	},
	{
		file: 'hevc-aac.avi',
		frames: [2, 6, 4, 3, 5, 10, 8, 7, 9, 14, 12, 11, 13, 18, 16, 15, 17, 22, 20, 19, 21, 26, 24, 23, 25],
	},
	{
		// HEVC in open groups: the CRA pictures at packets 22 and 32 have leading pictures, decoded after them and
		// presented before them
		file: 'hevc-open-gop.avi',
		frames: [
			2, 7, 5, 3, 4, 6, 10, 9, 8, 13, 12, 11, 14, 18, 16, 15, 17, 23, 21, 19, 20, 22, 26, 25, 24, 27, 31, 29, 28,
			30, 33, 32, 38, 36, 34, 35, 37, 40, 39, 45, 43, 41, 42, 44, 49, 47, 46, 48,
		],
	},
];

test('AVI H.264 and HEVC packets carry their pictures\' presentation timestamps, as FFmpeg gives them', async () => {
	for (const { file, frames } of PRESENTATION_FRAMES) {
		using input = new Input({
			source: new FilePathSource(`test/public/avi/${file}`),
			formats: ALL_FORMATS,
		});
		const track = (await input.getVideoTracks())[0]!;
		const frameRate = await track.getTimeResolution();

		const presentationFrames: number[] = [];
		for await (const packet of new PacketCursor(track)) {
			presentationFrames.push(Math.round(packet.timestamp * frameRate));
			expect(packet.duration).toBeCloseTo(1 / frameRate, 9);
		}
		expect(presentationFrames).toEqual(frames);

		// Read without the packets' data, the timestamps are the same
		const reader = new PacketReader(track);
		const lastPacket = (await reader.getAt(Infinity, { metadataOnly: true }))!;
		expect(Math.round(lastPacket.timestamp * frameRate)).toBe(Math.max(...frames));
		expect(await track.computeDuration()).toBeCloseTo((Math.max(...frames) + 1) / frameRate, 9);
	}
});

test('AVI H.264 and HEVC packets are found by presentation timestamp, whichever group is read first', async () => {
	using input = new Input({
		source: new FilePathSource('test/public/avi/hevc-open-gop.avi'),
		formats: ALL_FORMATS,
	});
	const track = (await input.getVideoTracks())[0]!;
	const frameDuration = 1 / await track.getTimeResolution();
	const reader = new PacketReader(track);
	const sequenceNumberAt = async (frames: number) => (await reader.getAt(frames * frameDuration))?.sequenceNumber;
	const keySequenceNumberAt = async (frames: number) => {
		return (await reader.getKeyAt(frames * frameDuration))?.sequenceNumber;
	};

	// The last group first: its leading pictures present at 34 to 37, before its CRA picture at 38
	expect(await sequenceNumberAt(40.5)).toBe(37);
	expect(await keySequenceNumberAt(37.5)).toBe(22);
	expect(await keySequenceNumberAt(38.5)).toBe(32);

	// The picture presenting at a timestamp is the one found, and seeking takes the last key packet that presents
	// before it, which a leading picture's own CRA picture does not
	expect(await sequenceNumberAt(24.5)).toBe(24);
	expect(await sequenceNumberAt(25.5)).toBe(23);
	expect(await keySequenceNumberAt(25.5)).toBe(12);
	expect(await keySequenceNumberAt(26.5)).toBe(22);
	expect(await sequenceNumberAt(13.5)).toBe(9);

	// Nothing presents before the first picture, two frames in, after the stream's reorder depth
	expect(await sequenceNumberAt(1.5)).toBeUndefined();
	expect(await keySequenceNumberAt(1.5)).toBeUndefined();
	expect(await sequenceNumberAt(2.25)).toBe(0);
	expect(await track.getFirstTimestamp()).toBeCloseTo(2 * frameDuration, 9);
});

test('AVI WAVE_FORMAT_EXTENSIBLE audio takes its codec from the SubFormat and its sample size', async () => {
	const testFiles = [
		{ file: 'pcm-s24-5.1-extensible.avi', expectedCodec: 'pcm-s24', bytesPerSample: 3 },
		{ file: 'pcm-f32-5.1-extensible.avi', expectedCodec: 'pcm-f32', bytesPerSample: 4 },
	];

	for (const { file, expectedCodec, bytesPerSample } of testFiles) {
		using input = new Input({
			source: new FilePathSource(`test/public/avi/${file}`),
			formats: ALL_FORMATS,
		});
		const track = (await input.getAudioTracks())[0]!;
		expect(await track.getCodec()).toBe(expectedCodec);
		expect(await track.getNumberOfChannels()).toBe(6);
		expect(await track.getSampleRate()).toBe(48000);
		// FFmpeg's 5.1 with back surrounds
		expect(await track.getChannelMask()).toBe(0x3F);

		// The chunks hold whole sample frames and are timed by their byte counts
		let totalDuration = 0;
		for await (const packet of new PacketCursor(track)) {
			expect(packet.byteLength % (6 * bytesPerSample)).toBe(0);
			expect(packet.timestamp).toBeCloseTo(totalDuration, 9);
			totalDuration += packet.duration;
		}
		expect(totalDuration).toBeCloseTo(0.25, 3);
	}
});

const makeExtensibleFormat = (subFormat: number[], extraData: number[] = []) => {
	const bytes = new Uint8Array(18 + 22 + extraData.length);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, 0xFFFE, true);
	view.setUint16(2, 6, true);
	view.setUint32(4, 48000, true);
	view.setUint16(12, 4, true);
	view.setUint16(14, 16, true);
	view.setUint16(16, 22 + extraData.length, true);
	view.setUint16(18, 16, true);
	view.setUint32(20, 0x60F, true);
	bytes.set(subFormat, 24);
	bytes.set(extraData, 40);
	return view;
};

test('AVI WAVE_FORMAT_EXTENSIBLE maps the SubFormat GUIDs FFmpeg maps and keeps the channel mask', () => {
	const mediaSubtypeBase = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71];
	const pcm = parseWaveFormatEx(makeExtensibleFormat([0x01, 0x00, 0x00, 0x00, ...mediaSubtypeBase], [0xAB]));
	expect(pcm.extensible).toEqual({
		validBitsPerSample: 16,
		channelMask: 0x60F,
		subFormatTag: 1,
		subFormatCodec: null,
	});
	expect(aviWaveFormatToCodec(pcm)).toBe('pcm-s16');
	// Extradata follows the extensible fields
	expect([...pcm.extraData!]).toEqual([0xAB]);

	const ac3Guid = [0x2C, 0x80, 0x6D, 0xE0, 0x46, 0xDB, 0xCF, 0x11, 0xB4, 0xD1, 0x00, 0x80, 0x5F, 0x6C, 0xBB, 0xEA];
	expect(aviWaveFormatToCodec(parseWaveFormatEx(makeExtensibleFormat(ac3Guid)))).toBe('ac3');
	const eac3Guid = [0xAF, 0x87, 0xFB, 0xA7, 0x02, 0x2D, 0xFB, 0x42, 0xA4, 0xD4, 0x05, 0xCD, 0x93, 0x84, 0x3B, 0xDD];
	expect(aviWaveFormatToCodec(parseWaveFormatEx(makeExtensibleFormat(eac3Guid)))).toBe('eac3');

	const unknownGuid = new Array<number>(16).fill(0x11);
	expect(aviWaveFormatToCodec(parseWaveFormatEx(makeExtensibleFormat(unknownGuid)))).toBeNull();

	// A header cut short of the extensible fields names no codec
	const truncated = makeExtensibleFormat([0x01, 0x00, 0x00, 0x00, ...mediaSubtypeBase]);
	expect(aviWaveFormatToCodec(parseWaveFormatEx(new DataView(truncated.buffer, 0, 30)))).toBeNull();
});

test('AVI FLAC and Vorbis tracks carry the decoder description their strf extradata holds', async () => {
	using flacInput = new Input({
		source: new FilePathSource('test/public/avi/flac-only.avi'),
		formats: ALL_FORMATS,
	});
	const flacTrack = (await flacInput.getAudioTracks())[0]!;
	const flacConfig = (await flacTrack.getDecoderConfig())!;
	const flacDescription = new Uint8Array(flacConfig.description as ArrayBuffer);
	// 'fLaC', then the last metadata block, a 34-byte STREAMINFO
	expect([...flacDescription.subarray(0, 8)]).toEqual([0x66, 0x4C, 0x61, 0x43, 0x80, 0x00, 0x00, 34]);
	expect(flacDescription.byteLength).toBe(42);
	// STREAMINFO's sample rate is the stream's
	expect((flacDescription[18]! << 12) | (flacDescription[19]! << 4) | (flacDescription[20]! >> 4))
		.toBe(await flacTrack.getSampleRate());

	using vorbisInput = new Input({
		source: new FilePathSource('test/public/avi/vorbis-only.avi'),
		formats: ALL_FORMATS,
	});
	const vorbisConfig = (await (await vorbisInput.getAudioTracks())[0]!.getDecoderConfig())!;
	const vorbisDescription = new Uint8Array(vorbisConfig.description as ArrayBuffer);
	// Three Xiph-laced headers, the first the 30-byte identification header
	expect([...vorbisDescription.subarray(0, 2)]).toEqual([2, 30]);
	expect(new TextDecoder().decode(vorbisDescription.subarray(4, 10))).toBe('vorbis');
});

test('AVI FLAC chunks are timed one frame each, whatever block alignment the format declares', async () => {
	using input = new Input({
		source: new FilePathSource('test/public/avi/flac-only.avi'),
		formats: ALL_FORMATS,
	});
	const track = (await input.getAudioTracks())[0]!;
	const duration = await input.computeDuration();

	let packetCount = 0;
	let lastEnd = 0;
	for await (const packet of new PacketCursor(track)) {
		expect(packet.timestamp).toBeCloseTo(lastEnd, 9);
		lastEnd = packet.timestamp + packet.duration;
		packetCount++;
	}
	expect(packetCount).toBeGreaterThan(1);
	// FFmpeg's encoder writes 4608-sample frames, and the file lasts its frames
	expect(lastEnd).toBeCloseTo(packetCount * 4608 / await track.getSampleRate(), 6);
	expect(duration).toBeCloseTo(lastEnd, 6);
});

test('AVI multichannel FLAC, written as WAVE_FORMAT_EXTENSIBLE, keeps its description and frame timing', async () => {
	using input = new Input({
		source: new FilePathSource('test/public/avi/flac-5.1-extensible.avi'),
		formats: ALL_FORMATS,
	});
	const track = (await input.getAudioTracks())[0]!;
	expect(await track.getCodec()).toBe('flac');
	expect(await track.getNumberOfChannels()).toBe(6);

	// The STREAMINFO follows the extensible fields, and its channel count is the stream's
	const description = new Uint8Array((await track.getDecoderConfig())!.description as ArrayBuffer);
	expect([...description.subarray(0, 8)]).toEqual([0x66, 0x4C, 0x61, 0x43, 0x80, 0x00, 0x00, 34]);
	expect(((description[20]! >> 1) & 0x07) + 1).toBe(6);

	// The declared block alignment of 12 would stretch each frame over seconds
	let lastEnd = 0;
	for await (const packet of new PacketCursor(track)) {
		expect(packet.timestamp).toBeCloseTo(lastEnd, 9);
		lastEnd = packet.timestamp + packet.duration;
	}
	expect(lastEnd).toBeGreaterThanOrEqual(0.25);
	expect(lastEnd).toBeLessThan(0.25 + 4608 / 48000);
});

test('AVI HEVC is identified under its tags, and under the zero tag FFmpeg\'s muxer writes by default', async () => {
	const untagged = new Uint8Array(readFileSync('test/public/avi/hevc-untagged.avi'));
	// The video strf chunk's BITMAPINFOHEADER holds the compression 16 bytes in
	const strfOffset = Buffer.from(untagged).indexOf('strf');
	const compressionOffset = strfOffset + 8 + 16;
	expect([...untagged.subarray(compressionOffset, compressionOffset + 4)]).toEqual([0, 0, 0, 0]);

	for (const tag of ['\0\0\0\0', 'HEVC', 'H265', 'hvc1', 'hev1']) {
		const bytes = untagged.slice();
		bytes.set(new TextEncoder().encode(tag), compressionOffset);
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });

		const track = (await input.getVideoTracks())[0]!;
		expect(await track.getCodec()).toBe('hevc');
		expect((await track.getDecoderConfig())!.codec).toMatch(/^hev1\.1\.6\.L\d+\.[0-9A-F.]+$/);
		expect((await new PacketReader(track).getFirst())!.type).toBe('key');
	}

	// Uncompressed RGB under the same zero tag stays unidentified
	using rgbInput = new Input({
		source: new FilePathSource('test/public/avi/rgb-uncompressed.avi'),
		formats: ALL_FORMATS,
	});
	expect(await rgbInput.getVideoTracks()).toHaveLength(0);
});
