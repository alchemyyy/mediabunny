import { expect, test } from 'vitest';
import { deserializeAvcDecoderConfigurationRecord } from '../../src/codec-data.js';
import { extractColorSpace } from '../../src/codec.js';
import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedPacket,
	EncodedVideoPacketSource,
	Input,
	MkvOutputFormat,
	Output,
} from '../../src/index.js';

// x264, High 10, 64x48, SMPTE 170M primaries and transfer, BT.470BG matrix, limited range
const SPS = [...Buffer.from('676e000aa6cd9447b016a0c0c0a80000030008000003019078912cb0', 'hex')];
const PPS = [...Buffer.from('68ebe3cb22c0', 'hex')];
const SPS_COLOR_SPACE = { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'bt470bg', fullRange: false };

/** An avcC record with the SPS and PPS, followed by the given bytes. */
const createRecord = (tail: number[]) => new Uint8Array([
	0x01, 0x6e, 0x00, 0x0a, 0xff, 0xe1, 0x00, SPS.length, ...SPS, 0x01, 0x00, PPS.length, ...PPS, ...tail,
]);

test('avcC whose PPS is followed by junk keeps its parameter sets and ignores the junk', () => {
	for (const junk of [[0x69, 0x73, 0x61, 0x74], [0x73, 0x74, 0x61, 0x67]]) {
		const record = deserializeAvcDecoderConfigurationRecord(createRecord(junk));

		expect(record).not.toBeNull();
		expect([...record!.sequenceParameterSets[0]!]).toEqual(SPS);
		expect([...record!.pictureParameterSets[0]!]).toEqual(PPS);
		expect(record!.chromaFormat).toBeNull();
		expect(record!.sequenceParameterSetExt).toBeNull();
	}
});

test('avcC High-profile extension whose SPS extensions overrun the record is ignored', () => {
	// Reserved bits set, one SPS extension of 16 bytes, of which only one is there
	const record = deserializeAvcDecoderConfigurationRecord(createRecord([0xfd, 0xfa, 0xfa, 0x01, 0x00, 0x10, 0xaa]));

	expect(record).not.toBeNull();
	expect(record!.sequenceParameterSets).toHaveLength(1);
	expect(record!.chromaFormat).toBeNull();
});

test('avcC High-profile extension with its reserved bits set is read', () => {
	const record = deserializeAvcDecoderConfigurationRecord(createRecord([0xfd, 0xfa, 0xfa, 0x00]));

	expect(record).not.toBeNull();
	expect(record!.chromaFormat).toBe(1);
	expect(record!.bitDepthLumaMinus8).toBe(2);
	expect(record!.bitDepthChromaMinus8).toBe(2);
	expect(record!.sequenceParameterSetExt).toEqual([]);
});

test('Color space of an avcC whose PPS is followed by junk comes from its SPS', async () => {
	const description = createRecord([0x69, 0x73, 0x61, 0x74]);
	expect(extractColorSpace({
		codec: 'avc',
		codecDescription: description,
		avcCodecInfo: null,
		hevcCodecInfo: null,
		vp9CodecInfo: null,
		av1CodecInfo: null,
		proresCodecInfo: null,
	})).toEqual(SPS_COLOR_SPACE);

	// Matroska without a Colour element, so the decoder config's color space comes from the CodecPrivate's SPS
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	const source = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(source);
	await output.start();
	await source.add(
		new EncodedPacket(new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]), 'key', 0, 0.04),
		{ decoderConfig: { codec: 'avc1.6e000a', codedWidth: 64, codedHeight: 48, description } },
	);
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const decoderConfig = await (await input.getPrimaryVideoTrack())!.getDecoderConfig();
	expect(decoderConfig!.colorSpace).toEqual(SPS_COLOR_SPACE);
});
