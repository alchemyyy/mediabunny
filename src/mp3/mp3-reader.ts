/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	MP3_FRAME_HEADER_SIZE,
	getMp3ChannelCount,
	getXingOffset,
	INFO,
	Mp3FrameHeader,
	readMp3FrameHeader,
	XING,
} from '../../shared/mp3-misc';
import { ID3_V1_TAG_SIZE } from '../id3';
import { isThenable, MaybePromise, MaybeRelevantPromise, ResultValue } from '../misc';
import { readAscii, Reader, readU32Be } from '../reader';

export type Mp3FrameHeaderResult = {
	header: Mp3FrameHeader;
	startPos: number;
};

const readConfirmedMp3FrameHeaderInto = async (
	res: ResultValue<Mp3FrameHeaderResult | null>,
	reader: Reader,
	startPos: number,
	searchLength: number,
	ref: Mp3FrameHeader | null,
): MaybeRelevantPromise => {
	const next = new ResultValue<Mp3FrameHeaderResult | null>();
	let currentPos = startPos;

	// Loop because the first frame we find may not actually be a frame (it's confirmed with what follows it)
	while (true) {
		next.reset();
		let promise = readNextMp3FrameHeader(next, reader, currentPos, startPos + searchLength, ref);
		if (next.pending) await promise;

		const result = next.value;
		if (!result) {
			return res.set(null);
		}

		const { header } = result;
		const xingOffset = getXingOffset(header.mpegVersionId, header.channel);

		let xingSlice = reader.requestSlice(result.startPos + xingOffset, 4);
		if (isThenable(xingSlice)) xingSlice = await xingSlice;
		if (xingSlice) {
			const word = readU32Be(xingSlice);
			if (word === XING || word === INFO) {
				return res.set(result);
			}
		}

		const frameEndPos = result.startPos + header.totalSize;
		if (frameEndPos === reader.fileSize) {
			// The frame ends the file
			return res.set(result);
		}

		if (frameEndPos + ID3_V1_TAG_SIZE === reader.fileSize) {
			// The frame is followed by nothing but an ID3v1 tag
			let tagSlice = reader.requestSlice(frameEndPos, 3);
			if (isThenable(tagSlice)) tagSlice = await tagSlice;
			if (tagSlice && readAscii(tagSlice, 3) === 'TAG') {
				return res.set(result);
			}
		}

		next.reset();
		promise = readNextMp3FrameHeader(next, reader, frameEndPos, frameEndPos + MP3_FRAME_HEADER_SIZE);
		if (next.pending) await promise;

		const nextResult = next.value;
		if (
			nextResult
			&& nextResult.header.channel === header.channel
			&& nextResult.header.sampleRate === header.sampleRate
		) {
			return res.set(result);
		}

		currentPos = result.startPos + 1;
	}
};

/**
 * Finds the first MP3 frame header within a search length from a position that the next frame confirms,
 * synchronously when the reader has the data at hand.
 */
export const readConfirmedMp3FrameHeader = (
	reader: Reader,
	startPos: number,
	searchLength: number,
	ref: Mp3FrameHeader | null,
): MaybePromise<Mp3FrameHeaderResult | null> => {
	const res = new ResultValue<Mp3FrameHeaderResult | null>();
	const promise = readConfirmedMp3FrameHeaderInto(res, reader, startPos, searchLength, ref);
	return res.pending ? promise.then(() => res.value) : res.value;
};

export const readNextMp3FrameHeader = async (
	res: ResultValue<Mp3FrameHeaderResult | null>,
	reader: Reader,
	startPos: number,
	until: number | null,
	ref: Mp3FrameHeader | null = null,
): MaybeRelevantPromise => {
	const CHUNK_SIZE = 2 ** 16; // So we don't need to grab thousands of slices
	let currentPos = startPos;

	while (until === null || currentPos < until) {
		const maxLength = until !== null
			? Math.min(CHUNK_SIZE, until - currentPos)
			: CHUNK_SIZE;

		let slice = reader.requestSliceRange(currentPos, MP3_FRAME_HEADER_SIZE, maxLength);
		if (isThenable(slice)) slice = await slice;
		if (!slice || slice.length < MP3_FRAME_HEADER_SIZE) break;

		while (slice.remainingLength >= MP3_FRAME_HEADER_SIZE) {
			const posBeforeRead = slice.filePos;
			const word = readU32Be(slice);
			const remainingBytes = reader.fileSize !== null
				? reader.fileSize - currentPos
				: null;

			const result = readMp3FrameHeader(word, remainingBytes);
			if (
				result.header
				&& (!ref || (
					// This condition helps us recover malformed streams
					// https://stackoverflow.com/a/20884944
					result.header.sampleRate === ref.sampleRate
					&& result.header.mpegVersionId === ref.mpegVersionId
					&& result.header.layer === ref.layer
					&& getMp3ChannelCount(result.header.channel) === getMp3ChannelCount(ref.channel)
				))
			) {
				return res.set({ header: result.header, startPos: currentPos });
			}

			slice.filePos = posBeforeRead + result.bytesAdvanced;
			currentPos = slice.filePos;
		}
	}

	return res.set(null);
};
