/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, VideoCodec } from '../codec';

export interface AVIMainHeader {
	microSecPerFrame: number;
	maxBytesPerSec: number;
	paddingGranularity: number;
	flags: number;
	totalFrames: number;
	initialFrames: number;
	streams: number;
	suggestedBufferSize: number;
	width: number;
	height: number;
}

export interface AVIStreamHeader {
	fccType: string;
	fccHandler: string;
	flags: number;
	priority: number;
	language: number;
	initialFrames: number;
	scale: number;
	rate: number;
	start: number;
	length: number;
	suggestedBufferSize: number;
	quality: number;
	sampleSize: number;
	frame: {
		left: number;
		top: number;
		right: number;
		bottom: number;
	};
}

export interface AVIBitmapInfoHeader {
	size: number;
	width: number;
	height: number;
	planes: number;
	bitCount: number;
	compression: string;
	sizeImage: number;
	xPelsPerMeter: number;
	yPelsPerMeter: number;
	clrUsed: number;
	clrImportant: number;
	extraData?: Uint8Array;
}

export interface AVIWaveFormatEx {
	formatTag: number;
	channels: number;
	samplesPerSec: number;
	avgBytesPerSec: number;
	blockAlign: number;
	bitsPerSample: number;
	cbSize?: number;
	/** Codec extradata, after the WAVE_FORMAT_EXTENSIBLE fields when the format has them. */
	extraData?: Uint8Array;
	/** The WAVE_FORMAT_EXTENSIBLE fields, present when formatTag is WAVE_FORMAT_EXTENSIBLE. */
	extensible?: AVIWaveFormatExtensible;
}

export interface AVIWaveFormatExtensible {
	validBitsPerSample: number;
	/** The speakers the channels carry, in the order of their bits, as the WAVE channel mask. */
	channelMask: number;
	/** The format tag the SubFormat GUID carries, or null when the GUID names a codec instead. */
	subFormatTag: number | null;
	/** The codec a SubFormat GUID outside the tag-carrying bases names, or null. */
	subFormatCodec: AudioCodec | null;
}

export const WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
const WAVE_FORMAT_EXTENSIBLE_SIZE = 22;

// The last 12 bytes of the SubFormat GUIDs whose first 4 bytes are a format tag, as FFmpeg's riffdec reads them: the
// media subtype base, the ambisonic base, and a broken base some muxers write
const SUBFORMAT_TAG_BASE_GUIDS = [
	[0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71],
	[0x21, 0x07, 0xD3, 0x11, 0x86, 0x44, 0xC8, 0xC1, 0xCA, 0x00, 0x00, 0x00],
	[0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA],
];

// The SubFormat GUIDs FFmpeg's riff.c maps to a codec Mediabunny knows
const SUBFORMAT_GUID_TO_CODEC: { guid: number[]; codec: AudioCodec }[] = [
	{
		guid: [0x2C, 0x80, 0x6D, 0xE0, 0x46, 0xDB, 0xCF, 0x11, 0xB4, 0xD1, 0x00, 0x80, 0x5F, 0x6C, 0xBB, 0xEA],
		codec: 'ac3',
	},
	{
		guid: [0xAF, 0x87, 0xFB, 0xA7, 0x02, 0x2D, 0xFB, 0x42, 0xA4, 0xD4, 0x05, 0xCD, 0x93, 0x84, 0x3B, 0xDD],
		codec: 'eac3',
	},
];

const bytesEqual = (bytes: Uint8Array, expected: number[]) =>
	bytes.length === expected.length && expected.every((value, i) => bytes[i] === value);

const parseWaveFormatExtensible = (data: DataView, offset: number): AVIWaveFormatExtensible => {
	const subFormat = new Uint8Array(data.buffer, data.byteOffset + offset + 6, 16);
	const carriesTag = SUBFORMAT_TAG_BASE_GUIDS.some(base => bytesEqual(subFormat.subarray(4), base));

	return {
		validBitsPerSample: data.getUint16(offset, true),
		channelMask: data.getUint32(offset + 2, true),
		subFormatTag: carriesTag ? data.getUint32(offset + 6, true) : null,
		subFormatCodec: carriesTag
			? null
			: SUBFORMAT_GUID_TO_CODEC.find(entry => bytesEqual(subFormat, entry.guid))?.codec ?? null,
	};
};

/** Returns the format tag that identifies a format's codec: its SubFormat's for WAVE_FORMAT_EXTENSIBLE. */
export const getWaveFormatCodecTag = (format: AVIWaveFormatEx): number | null => {
	if (format.formatTag !== WAVE_FORMAT_EXTENSIBLE) {
		return format.formatTag;
	}
	return format.extensible?.subFormatTag ?? null;
};

/** Returns the codec a WAVEFORMATEX or WAVE_FORMAT_EXTENSIBLE header declares, or null when Mediabunny lacks it. */
export const aviWaveFormatToCodec = (format: AVIWaveFormatEx): AudioCodec | null => {
	const tag = getWaveFormatCodecTag(format);
	if (tag === null) {
		return format.extensible?.subFormatCodec ?? null;
	}
	// The container sample size, not the valid bits, lays out the samples
	return aviAudioFormatTagToCodec(tag, format.bitsPerSample);
};

export interface AVIIndexEntry {
	ckid: string;
	flags: number;
	offset: number;
	size: number;
}

/** The header an OpenDML index chunk, a super index (indx) or a standard index (ix##), starts with. */
export interface AVIOpenDMLIndexHeader {
	longsPerEntry: number;
	indexSubType: number;
	indexType: number;
	entriesInUse: number;
	/** The chunk ID of the chunks the index lists, such as 00dc. */
	chunkId: string;
	/** A standard index's qwBaseOffset, from which its entries' offsets count; reserved, so zero, in a super index. */
	baseOffset: number;
}

export const AVIIF_KEYFRAME = 0x00000010;
export const AVIIF_LIST = 0x00000001;
export const AVIIF_NO_TIME = 0x00000100;

/** bIndexType of an OpenDML super index, whose entries locate standard indexes. */
export const AVI_INDEX_OF_INDEXES = 0x00;
/** bIndexType of an OpenDML standard index, whose entries locate chunks. */
export const AVI_INDEX_OF_CHUNKS = 0x01;
export const AVI_OPENDML_INDEX_HEADER_SIZE = 24;
export const AVI_SUPER_INDEX_ENTRY_SIZE = 16;
export const AVI_STANDARD_INDEX_ENTRY_SIZE = 8;
/** The bit of a standard index entry's dwSize that marks a chunk that is not a key frame. */
export const AVI_STANDARD_INDEX_DELTA_FRAME = 0x80000000;

const VIDEO_FOURCC_TO_CODEC: Record<string, VideoCodec> = {
	'H264': 'avc',
	'h264': 'avc',
	'AVC1': 'avc',
	'avc1': 'avc',
	'H265': 'hevc',
	'h265': 'hevc',
	'HEVC': 'hevc',
	'hevc': 'hevc',
	'hev1': 'hevc',
	'hvc1': 'hevc',
	'VP80': 'vp8',
	'VP8 ': 'vp8',
	'VP90': 'vp9',
	'VP9 ': 'vp9',
	'AV01': 'av1',
	'av01': 'av1',
	'XVID': 'mpeg4',
	'xvid': 'mpeg4',
	'DIVX': 'mpeg4',
	'DX50': 'mpeg4',
	'FMP4': 'mpeg4',
	'MP4V': 'mpeg4',
};

const AUDIO_FORMAT_TAG_TO_CODEC: Record<number, AudioCodec> = {
	0x0001: 'pcm-s16',
	0x0003: 'pcm-f32',
	0x0006: 'alaw',
	0x0007: 'ulaw',
	0x0055: 'mp3',
	0x0092: 'ac3',
	0x00FF: 'aac',
	0x2000: 'ac3', // WAVE_FORMAT_DVM, which FFmpeg and most muxers write for AC-3
	0x566F: 'vorbis',
	0x674F: 'vorbis',
	0xF1AC: 'flac',
};

export function aviVideoFourccToCodec(fourccStr: string): VideoCodec | null {
	const codec = VIDEO_FOURCC_TO_CODEC[fourccStr];
	return codec as VideoCodec || null;
}

export function aviAudioFormatTagToCodec(formatTag: number, bitsPerSample: number): AudioCodec | null {
	// The PCM tags cover every sample size, which bitsPerSample tells apart
	if (formatTag === 0x0001) {
		switch (bitsPerSample) {
			case 8: return 'pcm-u8';
			case 16: return 'pcm-s16';
			case 24: return 'pcm-s24';
			case 32: return 'pcm-s32';
			default: return null;
		}
	}
	if (formatTag === 0x0003) {
		switch (bitsPerSample) {
			case 32: return 'pcm-f32';
			case 64: return 'pcm-f64';
			default: return null;
		}
	}

	const codec = AUDIO_FORMAT_TAG_TO_CODEC[formatTag];
	return codec as AudioCodec || null;
}

const CODEC_TO_PREFERRED_FOURCC: Partial<Record<VideoCodec, string>> = {
	avc: 'H264',
	hevc: 'H265',
	vp8: 'VP80',
	vp9: 'VP90',
	av1: 'AV01',
	mpeg4: 'XVID',
};

export function aviVideoCodecToFourcc(codec: VideoCodec): string | null {
	const preferred = CODEC_TO_PREFERRED_FOURCC[codec];
	if (preferred) return preferred;

	for (const [fourccStr, codecId] of Object.entries(VIDEO_FOURCC_TO_CODEC)) {
		if (codecId === codec) {
			return fourccStr;
		}
	}
	return null;
}

export function aviAudioCodecToFormatTag(codec: AudioCodec): number | null {
	switch (codec) {
		case 'pcm-u8':
		case 'pcm-s16':
		case 'pcm-s24':
		case 'pcm-s32':
			return 0x0001;
		case 'pcm-f32':
		case 'pcm-f64':
			return 0x0003;
	}

	for (const [tag, codecId] of Object.entries(AUDIO_FORMAT_TAG_TO_CODEC)) {
		if (codecId === codec) {
			return Number(tag);
		}
	}
	return null;
}

export function parseMainHeader(data: DataView): AVIMainHeader {
	return {
		microSecPerFrame: data.getUint32(0, true),
		maxBytesPerSec: data.getUint32(4, true),
		paddingGranularity: data.getUint32(8, true),
		flags: data.getUint32(12, true),
		totalFrames: data.getUint32(16, true),
		initialFrames: data.getUint32(20, true),
		streams: data.getUint32(24, true),
		suggestedBufferSize: data.getUint32(28, true),
		width: data.getUint32(32, true),
		height: data.getUint32(36, true),
	};
}

export function parseStreamHeader(data: DataView): AVIStreamHeader {
	const decoder = new TextDecoder('latin1');
	return {
		fccType: decoder.decode(new Uint8Array(data.buffer, data.byteOffset, 4)),
		fccHandler: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + 4, 4)),
		flags: data.getUint32(8, true),
		priority: data.getUint16(12, true),
		language: data.getUint16(14, true),
		initialFrames: data.getUint32(16, true),
		scale: data.getUint32(20, true),
		rate: data.getUint32(24, true),
		start: data.getUint32(28, true),
		length: data.getUint32(32, true),
		suggestedBufferSize: data.getUint32(36, true),
		quality: data.getUint32(40, true),
		sampleSize: data.getUint32(44, true),
		frame: {
			left: data.getUint16(48, true),
			top: data.getUint16(50, true),
			right: data.getUint16(52, true),
			bottom: data.getUint16(54, true),
		},
	};
}

const BITMAP_INFO_HEADER_SIZE = 40;

export function parseBitmapInfoHeader(data: DataView): AVIBitmapInfoHeader {
	const decoder = new TextDecoder('latin1');
	const size = data.getUint32(0, true);

	// Codec extradata, such as an MPEG-4 Part 2 VOL header or an avcC record, follows the 40-byte header. FFmpeg's
	// demuxer takes the rest of the chunk whatever biSize says, since its muxer counts the extradata in biSize, except
	// a byte that pads an odd biSize to the chunk's end
	let extraData: Uint8Array | undefined;
	const extraDataSize = size === data.byteLength - 1 && size % 2 === 1
		? size - BITMAP_INFO_HEADER_SIZE
		: data.byteLength - BITMAP_INFO_HEADER_SIZE;
	if (extraDataSize > 0) {
		extraData = new Uint8Array(data.buffer, data.byteOffset + BITMAP_INFO_HEADER_SIZE, extraDataSize);
	}

	return {
		size,
		width: data.getInt32(4, true),
		height: data.getInt32(8, true),
		planes: data.getUint16(12, true),
		bitCount: data.getUint16(14, true),
		compression: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + 16, 4)),
		sizeImage: data.getUint32(20, true),
		xPelsPerMeter: data.getInt32(24, true),
		yPelsPerMeter: data.getInt32(28, true),
		clrUsed: data.getUint32(32, true),
		clrImportant: data.getUint32(36, true),
		extraData,
	};
}

export function parseWaveFormatEx(data: DataView): AVIWaveFormatEx {
	const formatTag = data.getUint16(0, true);
	const channels = data.getUint16(2, true);
	const samplesPerSec = data.getUint32(4, true);
	const avgBytesPerSec = data.getUint32(8, true);
	const blockAlign = data.getUint16(12, true);
	const bitsPerSample = data.getUint16(14, true);

	let cbSize = 0;
	let extraData: Uint8Array | undefined;
	let extensible: AVIWaveFormatExtensible | undefined;

	if (data.byteLength >= 18) {
		// Like FFmpeg, read only as much of the extension as the chunk holds
		cbSize = Math.min(data.getUint16(16, true), data.byteLength - 18);
		let extraDataStart = 18;
		if (formatTag === WAVE_FORMAT_EXTENSIBLE && cbSize >= WAVE_FORMAT_EXTENSIBLE_SIZE) {
			extensible = parseWaveFormatExtensible(data, 18);
			extraDataStart += WAVE_FORMAT_EXTENSIBLE_SIZE;
		}
		const extraDataSize = cbSize - (extraDataStart - 18);
		if (extraDataSize > 0) {
			extraData = new Uint8Array(data.buffer, data.byteOffset + extraDataStart, extraDataSize);
		}
	}

	return {
		formatTag,
		channels,
		samplesPerSec,
		avgBytesPerSec,
		blockAlign,
		bitsPerSample,
		cbSize,
		extraData,
		extensible,
	};
}

export function parseIndexEntry(data: DataView, offset: number): AVIIndexEntry {
	const decoder = new TextDecoder('latin1');
	return {
		ckid: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + offset, 4)),
		flags: data.getUint32(offset + 4, true),
		offset: data.getUint32(offset + 8, true),
		size: data.getUint32(offset + 12, true),
	};
}

export function getUint64Le(data: DataView, offset: number): number {
	return data.getUint32(offset + 4, true) * 0x100000000 + data.getUint32(offset, true);
}

export function parseOpenDMLIndexHeader(data: DataView): AVIOpenDMLIndexHeader {
	const decoder = new TextDecoder('latin1');
	return {
		longsPerEntry: data.getUint16(0, true),
		indexSubType: data.getUint8(2),
		indexType: data.getUint8(3),
		entriesInUse: data.getUint32(4, true),
		chunkId: decoder.decode(new Uint8Array(data.buffer, data.byteOffset + 8, 4)),
		baseOffset: getUint64Le(data, 12),
	};
}

export function makeStreamChunkId(streamNumber: number, type: 'db' | 'dc' | 'wb' | 'pc'): string {
	const streamStr = streamNumber.toString().padStart(2, '0');
	return streamStr + type;
}

export function parseStreamChunkId(ckid: string): { streamNumber: number; type: string } | null {
	if (ckid.length !== 4) return null;

	const streamStr = ckid.substring(0, 2);
	const type = ckid.substring(2);
	const streamNumber = parseInt(streamStr, 10);

	if (isNaN(streamNumber)) return null;

	return { streamNumber, type };
}
