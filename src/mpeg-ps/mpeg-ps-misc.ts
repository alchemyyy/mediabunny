/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// The last byte of each program stream start code, after its 0x000001 prefix
export const PROGRAM_END_CODE = 0xb9;
export const PACK_HEADER_CODE = 0xba;
export const PRIVATE_STREAM_1 = 0xbd;
export const MPEG_AUDIO_STREAM_ID_MINIMUM = 0xc0;
export const MPEG_AUDIO_STREAM_ID_MAXIMUM = 0xdf;
export const MPEG_VIDEO_STREAM_ID_MINIMUM = 0xe0;
export const MPEG_VIDEO_STREAM_ID_MAXIMUM = 0xef;

/** Whether bytes begin with a pack header, of MPEG-1 or MPEG-2, as every program stream begins. */
export const isPackHeaderStart = (bytes: Uint8Array) => {
	if (bytes.length < 5 || bytes[0] !== 0x00 || bytes[1] !== 0x00 || bytes[2] !== 0x01) {
		return false;
	}

	// An MPEG-2 pack header's SCR begins with '01', an MPEG-1 one's with '0010'
	return bytes[3] === PACK_HEADER_CODE && ((bytes[4]! & 0xc0) === 0x40 || (bytes[4]! & 0xf0) === 0x20);
};

export const buildMpegPsMimeType = (codecStrings: (string | null)[]) => {
	let string = 'video/MP2P';

	const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
	if (uniqueCodecStrings.length > 0) {
		string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
	}

	return string;
};
