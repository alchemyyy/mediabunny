/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { VideoCodec } from '../codec';
import { aviVideoFourccToCodec } from '../avi/avi-misc';

// The object GUIDs of the ASF specification, in the byte order a file stores them, as FFmpeg's libavformat/asf_tags.c
// lists them
export const ASF_HEADER_OBJECT = [
	0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
export const ASF_DATA_OBJECT = [
	0x36, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
export const ASF_FILE_PROPERTIES_OBJECT = [
	0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11, 0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
export const ASF_STREAM_PROPERTIES_OBJECT = [
	0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
export const ASF_HEADER_EXTENSION_OBJECT = [
	0xB5, 0x03, 0xBF, 0x5F, 0x2E, 0xA9, 0xCF, 0x11, 0x8E, 0xE3, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
export const ASF_EXTENDED_STREAM_PROPERTIES_OBJECT = [
	0xCB, 0xA5, 0xE6, 0x14, 0x72, 0xC6, 0x32, 0x43, 0x83, 0x99, 0xA9, 0x69, 0x52, 0x06, 0x5B, 0x5A,
];
export const ASF_STREAM_BITRATE_PROPERTIES_OBJECT = [
	0xCE, 0x75, 0xF8, 0x7B, 0x8D, 0x46, 0xD1, 0x11, 0x8D, 0x82, 0x00, 0x60, 0x97, 0xC9, 0xA2, 0xB2,
];
export const ASF_CONTENT_DESCRIPTION_OBJECT = [
	0x33, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
export const ASF_EXTENDED_CONTENT_DESCRIPTION_OBJECT = [
	0x40, 0xA4, 0xD0, 0xD2, 0x07, 0xE3, 0xD2, 0x11, 0x97, 0xF0, 0x00, 0xA0, 0xC9, 0x5E, 0xA8, 0x50,
];
export const ASF_CODEC_LIST_OBJECT = [
	0x40, 0x52, 0xD1, 0x86, 0x1D, 0x31, 0xD0, 0x11, 0xA3, 0xA4, 0x00, 0xA0, 0xC9, 0x03, 0x48, 0xF6,
];
export const ASF_SIMPLE_INDEX_OBJECT = [
	0x90, 0x08, 0x00, 0x33, 0xB1, 0xE5, 0xCF, 0x11, 0x89, 0xF4, 0x00, 0xA0, 0xC9, 0x03, 0x49, 0xCB,
];
export const ASF_INDEX_OBJECT = [
	0xD3, 0x29, 0xE2, 0xD6, 0xDA, 0x35, 0xD1, 0x11, 0x90, 0x34, 0x00, 0xA0, 0xC9, 0x03, 0x49, 0xBE,
];
// The objects that mark protected content: Windows Media DRM 1, DRM 7 and later, and PlayReady
export const ASF_CONTENT_ENCRYPTION_OBJECT = [
	0xFB, 0xB3, 0x11, 0x22, 0x23, 0xBD, 0xD2, 0x11, 0xB4, 0xB7, 0x00, 0xA0, 0xC9, 0x55, 0xFC, 0x6E,
];
export const ASF_EXTENDED_CONTENT_ENCRYPTION_OBJECT = [
	0x14, 0xE6, 0x8A, 0x29, 0x22, 0x26, 0x17, 0x4C, 0xB9, 0x35, 0xDA, 0xE0, 0x7E, 0xE9, 0x28, 0x9C,
];
export const ASF_ADVANCED_CONTENT_ENCRYPTION_OBJECT = [
	0x33, 0x85, 0x05, 0x43, 0x81, 0x69, 0xE6, 0x49, 0x9B, 0x74, 0xAD, 0x12, 0xCB, 0x86, 0xD5, 0x8C,
];

// Stream types and error correction types of the Stream Properties Object
export const ASF_AUDIO_MEDIA = [
	0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
];
export const ASF_VIDEO_MEDIA = [
	0xC0, 0xEF, 0x19, 0xBC, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
];
export const ASF_AUDIO_SPREAD = [
	0x50, 0xCD, 0xC3, 0xBF, 0x8F, 0x61, 0xCF, 0x11, 0x8B, 0xB2, 0x00, 0xAA, 0x00, 0xB4, 0xE2, 0x20,
];

/** The size of an object's header: its GUID and its 64-bit size, which counts the header. */
export const ASF_OBJECT_HEADER_SIZE = 24;
/** The Header Object's fields after its object header: its object count and two reserved bytes. */
export const ASF_HEADER_OBJECT_FIELDS_SIZE = 6;
/** The Data Object's fields after its object header: its file ID, total data packets, and two reserved bytes. */
export const ASF_DATA_OBJECT_FIELDS_SIZE = 26;
/** The Header Extension Object's fields after its object header: a reserved GUID and word, and its data size. */
export const ASF_HEADER_EXTENSION_FIELDS_SIZE = 22;

/** The File Properties flag of a file being broadcast, whose sizes and durations are not yet known. */
export const ASF_BROADCAST_FLAG = 0x01;
/** The Stream Properties flag of a stream whose content is encrypted. */
export const ASF_ENCRYPTED_CONTENT_FLAG = 0x8000;

/** Returns whether bytes at an offset hold a GUID. */
export const guidEquals = (bytes: Uint8Array, offset: number, guid: number[]) => {
	if (offset + 16 > bytes.length) {
		return false;
	}
	for (let i = 0; i < 16; i++) {
		if (bytes[offset + i] !== guid[i]) {
			return false;
		}
	}
	return true;
};

const utf16Decoder = /* #__PURE__ */ new TextDecoder('utf-16le');

/** Decodes a UTF-16LE string, without the terminating null characters ASF strings carry. */
export const readUtf16Le = (bytes: Uint8Array) => {
	return utf16Decoder.decode(bytes.subarray(0, bytes.length - (bytes.length % 2))).replace(/\0+$/, '');
};

// FFmpeg's ff_codec_bmp_tags names these VC-1 Advanced profile, the pre-standard WMVA among them
const VC1_FOURCCS = ['WVC1', 'WMVA'];

/**
 * Returns the codec of an ASF video stream's FourCC: the AVI demuxer's FourCCs, and VC-1 Advanced profile's. WMV3,
 * the VC-1 Simple and Main profiles, has no Mediabunny codec, and stays codec-less like every other FourCC.
 */
export const asfVideoFourccToCodec = (fourcc: string): VideoCodec | null => {
	return VC1_FOURCCS.includes(fourcc) ? 'vc1' : aviVideoFourccToCodec(fourcc);
};

/** Reads a field whose size a 2-bit length type gives: none, a byte, a word, or a double word. */
export const readVariableField = (view: DataView, offset: number, lengthType: number) => {
	switch (lengthType & 3) {
		case 1: return { value: view.getUint8(offset), size: 1 };
		case 2: return { value: view.getUint16(offset, true), size: 2 };
		case 3: return { value: view.getUint32(offset, true), size: 4 };
		default: return { value: 0, size: 0 };
	}
};

/** Reads a little-endian 64-bit unsigned integer, exact up to 2^53. */
export const getUint64Le = (view: DataView, offset: number) => {
	return view.getUint32(offset + 4, true) * 0x100000000 + view.getUint32(offset, true);
};
