/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from 'node:fs';
import { expect, test, beforeAll } from 'vitest';
import { Input, Output } from '../../src/index.js';
import { BufferSource, BufferTarget, FilePathSource } from '../../src/index.js';
import { ALL_FORMATS, AVI, AviOutputFormat } from '../../src/index.js';
import { EncodedVideoPacketSource, EncodedAudioPacketSource, PacketCursor, PacketReader } from '../../src/index.js';
import { EncodedPacket } from '../../src/index.js';
import { registerMpeg4Decoder, registerMpeg4Encoder } from '../../packages/mpeg4/src/index.js';

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

	// Video chunks take one frame each, and the first packet is a key packet
	using videoInput = new Input({
		source: new FilePathSource('test/public/avi/avc-aac.avi'),
		formats: ALL_FORMATS,
	});
	const videoTrack = (await videoInput.getVideoTracks())[0]!;
	const reader = new PacketReader(videoTrack);
	const firstPacket = (await reader.getFirst())!;
	expect(firstPacket.type).toBe('key');
	expect(firstPacket.timestamp).toBe(0);
	const secondPacket = (await reader.getNext(firstPacket))!;
	expect(secondPacket.timestamp).toBeCloseTo(firstPacket.duration, 9);
	expect(await reader.getAt(-1)).toBeNull();

	const decoderConfig = (await videoTrack.getDecoderConfig())!;
	expect(decoderConfig.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
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

const readVideoPackets = async (path: string) => {
	using input = new Input({
		source: new FilePathSource(path),
		formats: ALL_FORMATS,
	});
	const packets: EncodedPacket[] = [];
	for await (const packet of new PacketCursor((await input.getVideoTracks())[0]!)) {
		packets.push(packet);
	}

	return packets;
};

const USER_DATA_START_CODE = [0x00, 0x00, 0x01, 0xb2];

/** Returns a packet's bytes without its user data, which runs from its start code to the next start code. */
const withoutUserData = (data: Uint8Array) => {
	const bytes = [...data];
	const start = bytes.findIndex((_, i) => USER_DATA_START_CODE.every((byte, j) => bytes[i + j] === byte));
	if (start === -1) {
		return bytes;
	}

	let end = start + USER_DATA_START_CODE.length;
	while (end + 2 < bytes.length && !(bytes[end] === 0 && bytes[end + 1] === 0 && bytes[end + 2] === 1)) {
		end++;
	}
	return [...bytes.slice(0, start), ...bytes.slice(end)];
};

const latin1 = new TextDecoder('latin1');

test('AVI DivX packed B-frames are unpacked to one VOP per packet, as by FFmpeg\'s mpeg4_unpack_bframes', async () => {
	// mpeg4-bframes-mp3.avi is an FFmpeg encode with B-frames, in decode order; mpeg4-packed-bframes-mp3.avi is the
	// same encode packed as DivX 5 packs it: each first B-VOP joins its reference VOP's chunk, an N-VOP takes the slot
	// it leaves, and DivX user data ending in 'p' marks the key frames
	const unpackedPackets = await readVideoPackets('test/public/avi/mpeg4-packed-bframes-mp3.avi');
	const encodedPackets = await readVideoPackets('test/public/avi/mpeg4-bframes-mp3.avi');

	expect(unpackedPackets.map(packet => withoutUserData(packet.data)))
		.toEqual(encodedPackets.map(packet => withoutUserData(packet.data)));
	// Every packet keeps its chunk's slot, so the stream stays in decode order
	expect(unpackedPackets.map(packet => [packet.type, packet.timestamp, packet.duration]))
		.toEqual(encodedPackets.map(packet => [packet.type, packet.timestamp, packet.duration]));
	// The first key frame plays as itself, with the packed marker cleared
	expect(latin1.decode(unpackedPackets[0]!.data)).toContain('DivX503b1393\0');
});

test('AVI DivX packed B-frames unpack the same when read from a key frame or a B-VOP\'s slot', async () => {
	const sequentialPackets = await readVideoPackets('test/public/avi/mpeg4-packed-bframes-mp3.avi');

	for (const packetIndex of sequentialPackets.keys()) {
		using input = new Input({
			source: new FilePathSource('test/public/avi/mpeg4-packed-bframes-mp3.avi'),
			formats: ALL_FORMATS,
		});
		const reader = new PacketReader((await input.getVideoTracks())[0]!);
		const packet = (await reader.getAt(sequentialPackets[packetIndex]!.timestamp))!;
		expect([...packet.data]).toEqual([...sequentialPackets[packetIndex]!.data]);
	}
});

test('AVI MPEG-4 Part 2 without the packed marker keeps its chunks as they are', async () => {
	const bytes = new Uint8Array(fs.readFileSync('test/public/avi/mpeg4-packed-bframes-mp3.avi'));
	// Without its final 'p' the DivX user data no longer marks the stream as packed
	for (let position = Buffer.from(bytes).indexOf('1393p'); position !== -1;
		position = Buffer.from(bytes).indexOf('1393p', position)) {
		bytes[position + 4] = 'x'.charCodeAt(0);
	}

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});
	const reader = new PacketReader((await input.getVideoTracks())[0]!);
	const packedPacket = (await reader.getNext((await reader.getFirst())!))!;
	// The second chunk still holds a P-VOP and the B-VOP packed after it
	const vopStartCodes = [...packedPacket.data].filter((byte, i, data) =>
		byte === 0 && data[i + 1] === 0 && data[i + 2] === 1 && data[i + 3] === 0xb6,
	);
	expect(vopStartCodes).toHaveLength(2);
});
