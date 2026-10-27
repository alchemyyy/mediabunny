/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// DivX 5 and Xvid's packed bitstream puts each B-VOP after its reference VOP in one AVI chunk, so that a decoder
// without B-frame delay shows one frame per chunk, and holds the slot the B-VOP leaves with an N-VOP (a VOP that is
// not coded). These helpers follow FFmpeg's mpeg4_unpack_bframes bitstream filter and its MPEG-4 Part 2 decoder.

const USER_DATA_START_CODE = 0xb2;
const VOP_START_CODE = 0xb6;
/** The largest chunk FFmpeg takes for an N-VOP, whose slot a packed B-VOP fills. */
export const MPEG4_MAX_NVOP_SIZE = 19;
// How far past a user data start code FFmpeg looks for the packed marker, and the most user data its decoder reads
const MAX_USER_DATA_LENGTH = 255;
const P_CHARACTER = 0x70;
// The user data DivX writes, as FFmpeg's decoder reads it with "DivX%dBuild%d%c" or "DivX%db%d%c"; a final 'p' marks
// a packed bitstream
const DIVX_PACKED_USER_DATA_PATTERN = /^DivX\d+(?:Build|b)\d+p/;
const latin1Decoder = new TextDecoder('latin1');

export type Mpeg4ChunkScan = {
	/** The position of the 'p' that ends DivX user data, as FFmpeg's bitstream filter finds it, or -1. */
	packedMarkerPosition: number;
	vopCount: number;
	/** The position of the second VOP's start code, or -1. */
	secondVopPosition: number;
};

/** Returns the start code byte positions after each 00 00 01 prefix, as FFmpeg's avpriv_find_start_code finds them. */
const findStartCodes = function* (data: Uint8Array) {
	for (let i = 0; i + 3 < data.length; i++) {
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
			yield i + 3;
			i += 3;
		}
	}
};

/** Scans a chunk for its VOPs and the packed marker, as FFmpeg's mpeg4_unpack_bframes does. */
export const scanMpeg4Chunk = (data: Uint8Array): Mpeg4ChunkScan => {
	const scan: Mpeg4ChunkScan = { packedMarkerPosition: -1, vopCount: 0, secondVopPosition: -1 };

	for (const codePosition of findStartCodes(data)) {
		const code = data[codePosition];
		const payloadPosition = codePosition + 1;
		if (code === USER_DATA_START_CODE) {
			for (let i = 0; i < MAX_USER_DATA_LENGTH && payloadPosition + i + 1 < data.length; i++) {
				if (data[payloadPosition + i] === P_CHARACTER && data[payloadPosition + i + 1] === 0) {
					scan.packedMarkerPosition = payloadPosition + i;
					break;
				}
			}
		} else if (code === VOP_START_CODE) {
			scan.vopCount++;
			if (scan.vopCount === 2) {
				scan.secondVopPosition = codePosition - 3;
			}
		}
	}

	return scan;
};

/** Returns whether data holds the DivX user data that marks a packed bitstream, as FFmpeg's decoder reads it. */
export const hasDivXPackedUserData = (data: Uint8Array) => {
	for (const codePosition of findStartCodes(data)) {
		if (data[codePosition] !== USER_DATA_START_CODE) {
			continue;
		}

		// The user data runs to the next start code
		const start = codePosition + 1;
		let end = start;
		while (end < data.length && end - start < MAX_USER_DATA_LENGTH && data[end] !== 0) {
			end++;
		}
		if (DIVX_PACKED_USER_DATA_PATTERN.test(latin1Decoder.decode(data.subarray(start, end)))) {
			return true;
		}
	}

	return false;
};

/** Returns a copy of data whose packed marker is cleared, as FFmpeg's bitstream filter writes an unpacked stream. */
export const clearPackedMarker = (data: Uint8Array, packedMarkerPosition: number) => {
	const copy = data.slice();
	copy[packedMarkerPosition] = 0;
	return copy;
};
