import { afterEach, expect, test, vi } from 'vitest';

// Annex B NAL units. The recovery point SEI has recovery_frame_cnt 0 and the given exact_match_flag; the slices'
// headers start with first_mb_in_slice 0 and slice_type 7 (I) or 5 (P).
const START_CODE = [0, 0, 0, 1];
const recoveryPointSei = (exactMatchFlag: number) => {
	return [...START_CODE, 0x06, 0x06, 0x01, 0x84 | (exactMatchFlag << 6), 0x80];
};
const I_SLICE = [...START_CODE, 0x41, 0x88, 0x80, 0xff, 0xff];
const P_SLICE = [...START_CODE, 0x41, 0x9a, 0xff, 0xff, 0xff];
const IDR_SLICE = [...START_CODE, 0x65, 0x88, 0x80, 0xff, 0xff];

const CHROME_144 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0';
const CHROME_145 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';

/** Determines the packet type as the browser with the given user agent would, with fresh browser detection. */
const determineTypeIn = async (userAgent: string, nalUnits: number[]) => {
	vi.stubGlobal('navigator', { userAgent, vendor: userAgent === FIREFOX ? '' : 'Google Inc.' });
	// The browser detection is cached per module instance, so each browser needs its own
	vi.resetModules();
	const { determineVideoPacketType } = await import('../../src/codec-data.js');
	return determineVideoPacketType('avc', { codec: 'avc1.64001f' }, new Uint8Array(nalUnits));
};

afterEach(() => {
	vi.unstubAllGlobals();
});

test('Chromium 145 takes an I picture with a recovery point as a key packet, whatever exact_match_flag', async () => {
	expect(await determineTypeIn(CHROME_145, [...recoveryPointSei(0), ...I_SLICE])).toBe('key');
	expect(await determineTypeIn(CHROME_145, [...recoveryPointSei(1), ...I_SLICE])).toBe('key');
});

test('Chromium 145 does not take a P picture with a recovery point as a key packet', async () => {
	expect(await determineTypeIn(CHROME_145, [...recoveryPointSei(1), ...P_SLICE])).toBe('delta');
});

test('Chromium 144 does not take recovery points as key packets', async () => {
	expect(await determineTypeIn(CHROME_144, [...recoveryPointSei(1), ...I_SLICE])).toBe('delta');
	expect(await determineTypeIn(CHROME_144, IDR_SLICE)).toBe('key');
});

test('Other browsers take a recovery point as a key packet only when its exact_match_flag is set', async () => {
	expect(await determineTypeIn(FIREFOX, [...recoveryPointSei(0), ...I_SLICE])).toBe('delta');
	expect(await determineTypeIn(FIREFOX, [...recoveryPointSei(1), ...P_SLICE])).toBe('key');
});

test('An I picture without a recovery point is not a key packet', async () => {
	expect(await determineTypeIn(CHROME_145, I_SLICE)).toBe('delta');
	expect(await determineTypeIn(FIREFOX, I_SLICE)).toBe('delta');
});
