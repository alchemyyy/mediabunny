import { expect, test } from 'vitest';
import { extractVideoCodecString } from '../../src/codec.js';

// An avcC record of one SPS and one PPS. Only the record's framing is read, so the parameter sets are just their
// leading bytes: the SPS's NAL header, then profile_idc 100 (High), its constraint flags, and level_idc 41
const createAvcRecord = (profile: number, compatibility: number, level: number) => new Uint8Array([
	0x01, profile, compatibility, level, 0xff,
	0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x29,
	0x01, 0x00, 0x02, 0x68, 0xee,
]);

const getCodecString = (codecDescription: Uint8Array) => extractVideoCodecString({
	width: 1920,
	height: 1080,
	codec: 'avc',
	codecDescription,
	colorSpace: null,
	avcType: 1,
	avcCodecInfo: null,
	hevcCodecInfo: null,
	vp9CodecInfo: null,
	av1CodecInfo: null,
	proresFormat: null,
});

test('AVC codec string comes from the decoder configuration record', () => {
	expect(getCodecString(createAvcRecord(0x4d, 0x40, 0x1f))).toBe('avc1.4d401f');
});

test('AVC codec string comes from the first SPS when the record leaves its profile bytes zero', () => {
	expect(getCodecString(createAvcRecord(0x00, 0x00, 0x00))).toBe('avc1.640029');
});

test('AVC codec string keeps a zero profile when the record holds no SPS to take one from', () => {
	expect(getCodecString(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0xff, 0xe0, 0x00]))).toBe('avc1.000000');
});
