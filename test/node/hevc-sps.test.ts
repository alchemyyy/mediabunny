import { expect, test } from 'vitest';
import { parseHevcSps } from '../../src/codec-data.js';

test('HEVC SPS with predicted short-term reference picture sets parses', () => {
	// 38 short-term reference picture sets, 30 of them predicted from another set, where a predicted set counts
	// the pictures whose used_by_curr_pic_flag or use_delta_flag is set, not its reference set's count
	const sps = parseHevcSps(Buffer.from(
		'420101022000000300900000030000030096a001e020021c4d9e62e490a4404ee10ac2262797dfe8f3672fe8e65325efe8e6ccbf46'
		+ '1421388ac4997bfa39b32fd1851139ab126fd997e8c29a7256537e8c292b016a1220136c200000030020000003031f4ddef7e00bd0'
		+ '017a8017a002f510',
		'hex',
	));

	expect(sps).not.toBeNull();
	expect(sps!.displayWidth).toBe(3840);
	expect(sps!.displayHeight).toBe(2160);
	expect(sps!.colourPrimaries).toBe(9);
	expect(sps!.transferCharacteristics).toBe(16);
	expect(sps!.matrixCoefficients).toBe(9);
});

test('HEVC SPS without short-term reference picture sets parses', () => {
	// x265, Main, 320x240, BT.709
	const sps = parseHevcSps(Buffer.from(
		'42010101600000030090000003000003003ca00a080f165959a4932bc05a808080820000030002000003003210',
		'hex',
	));

	expect(sps).not.toBeNull();
	expect(sps!.displayWidth).toBe(320);
	expect(sps!.displayHeight).toBe(240);
	expect(sps!.colourPrimaries).toBe(1);
	expect(sps!.transferCharacteristics).toBe(1);
	expect(sps!.matrixCoefficients).toBe(1);
});
