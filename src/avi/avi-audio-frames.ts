/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AC3_SAMPLE_RATES, EAC3_REDUCED_SAMPLE_RATES } from '../../shared/ac3-misc';
import { decodeSynchsafe, getMp3ChannelCount, MP3_FRAME_HEADER_SIZE, readMp3FrameHeader } from '../../shared/mp3-misc';
import { AC3_FRAME_SIZES, EAC3_NUMBLKS_TABLE } from '../codec-data';
import { binarySearchLessOrEqual } from '../misc';
import { aviWaveFormatToCodec, AVIWaveFormatEx, getWaveFormatCodecTag } from './avi-misc';

/** A syncframe's header, as far as framing needs it. */
type SyncFrame = {
	size: number;
	sampleCount: number;
	sampleRate: number;
	/** What the frames of one stream share, which tells a frame from a false sync word. */
	signature: number;
	/** Whether the frame starts a packet: an E-AC-3 frame of any but independent substream 0 continues one. */
	startsPacket: boolean;
};

type SyncFrameParser = {
	/** The bytes the parser reads of a frame's header. */
	headerSize: number;
	/** The largest frame the format has. */
	maxFrameSize: number;
	/** Parses the frame header at an offset, which has headerSize bytes after it. */
	parse: (bytes: Uint8Array, offset: number) => SyncFrame | null;
};

const WAVE_FORMAT_MPEG = 0x0050;
const WAVE_FORMAT_MPEG_LAYER_3 = 0x0055;
// Layer II at 160 kbit/s and 8 kHz, plus a padding byte
const MAX_MPEG_AUDIO_FRAME_SIZE = 2881;
const AC3_HEADER_SIZE = 6;
// E-AC-3's 11-bit frame size counts 16-bit words
const MAX_AC3_FRAME_SIZE = 4096;
const AC3_BLOCK_SAMPLE_COUNT = 256;

const mpegAudioParser: SyncFrameParser = {
	headerSize: MP3_FRAME_HEADER_SIZE,
	maxFrameSize: MAX_MPEG_AUDIO_FRAME_SIZE,
	parse: (bytes, offset) => {
		const word = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8)
			| bytes[offset + 3]!) >>> 0;
		// The reserved sample rate index, which readMp3FrameHeader would read as 44.1 kHz
		if (((word >>> 10) & 0x3) === 3) {
			return null;
		}

		const { header } = readMp3FrameHeader(word, null);
		if (!header || header.totalSize <= MP3_FRAME_HEADER_SIZE) {
			return null;
		}

		return {
			size: header.totalSize,
			sampleCount: header.audioSamplesInFrame,
			sampleRate: header.sampleRate,
			// The fields that stay fixed through a stream, as Mediabunny's MP3 reader recovers malformed streams
			signature: ((header.sampleRate * 4 + header.mpegVersionId) * 4 + header.layer) * 4
				+ getMp3ChannelCount(header.channel),
			startsPacket: true,
		};
	},
};

/** Reads AC-3 syncinfo (bsid up to 10, which counts half and quarter sample rates) and E-AC-3's (bsid 11 to 16). */
const ac3Parser: SyncFrameParser = {
	headerSize: AC3_HEADER_SIZE,
	maxFrameSize: MAX_AC3_FRAME_SIZE,
	parse: (bytes, offset) => {
		if (bytes[offset] !== 0x0B || bytes[offset + 1] !== 0x77) {
			return null;
		}

		const bsid = bytes[offset + 5]! >> 3;
		if (bsid <= 10) {
			const fscod = bytes[offset + 4]! >> 6;
			const frmsizecod = bytes[offset + 4]! & 0x3F;
			if (fscod === 3 || frmsizecod >= AC3_FRAME_SIZES.length / 3) {
				return null;
			}

			const sampleRate = AC3_SAMPLE_RATES[fscod]! >> Math.max(bsid - 8, 0);
			return {
				size: AC3_FRAME_SIZES[3 * frmsizecod + fscod]!,
				sampleCount: 6 * AC3_BLOCK_SAMPLE_COUNT,
				sampleRate,
				signature: sampleRate,
				startsPacket: true,
			};
		}
		if (bsid > 16) {
			return null;
		}

		const strmtyp = bytes[offset + 2]! >> 6;
		const substreamId = (bytes[offset + 2]! >> 3) & 0x7;
		const frmsiz = ((bytes[offset + 2]! & 0x7) << 8) | bytes[offset + 3]!;
		const fscod = bytes[offset + 4]! >> 6;
		const fscod2OrNumblkscod = (bytes[offset + 4]! >> 4) & 0x3;
		if (strmtyp === 3 || (fscod === 3 && fscod2OrNumblkscod === 3)) {
			return null;
		}

		const sampleRate = fscod === 3
			? EAC3_REDUCED_SAMPLE_RATES[fscod2OrNumblkscod]!
			: AC3_SAMPLE_RATES[fscod]!;
		const blockCount = fscod === 3 ? 6 : EAC3_NUMBLKS_TABLE[fscod2OrNumblkscod]!;
		return {
			size: (frmsiz + 1) * 2,
			sampleCount: blockCount * AC3_BLOCK_SAMPLE_COUNT,
			sampleRate,
			signature: sampleRate,
			// A dependent substream adds channels to the independent one before it, which FFmpeg's parser keeps in
			// one packet
			startsPacket: strmtyp !== 1 && substreamId === 0,
		};
	},
};

/**
 * Returns the parser that finds the syncframes of an audio stream whose chunks need not hold whole frames: MPEG audio
 * and AC-3 or E-AC-3. Null for any other format, whose chunks stay its packets.
 */
export const getAviSyncFrameParser = (format: AVIWaveFormatEx): SyncFrameParser | null => {
	const tag = getWaveFormatCodecTag(format);
	if (tag === WAVE_FORMAT_MPEG || tag === WAVE_FORMAT_MPEG_LAYER_3) {
		return mpegAudioParser;
	}

	const codec = aviWaveFormatToCodec(format);
	if (codec === 'ac3' || codec === 'eac3') {
		return ac3Parser;
	}

	return null;
};

/** What the framing needs of a stream's chunk. */
export type AviAudioChunk = {
	/** The file position of the chunk's data. */
	position: number;
	/** The start of the chunk's slot. */
	timestamp: number;
	entry: { size: number };
};

/** A packet of one syncframe, with the E-AC-3 dependent substream frames that follow it. */
export type AviAudioFrame = {
	/** The packet's offset in the stream's data, its chunks' data one after another; also its sequence number. */
	offset: number;
	size: number;
	timestamp: number;
	duration: number;
};

// The chunks whose frames are kept, enough for reading on from a few positions at once
const FRAME_CACHE_CHUNK_COUNT = 16;
const ID3_HEADER_SIZE = 10;
// The bytes at a stream's start that must hold a frame for the stream to be split into frames
const FRAME_PROBE_BYTE_COUNT = 64 * 1024;

/**
 * Splits an AVI audio stream into one packet per syncframe, as FFmpeg's demuxer runs a parser on AVI audio: a muxer
 * that times a stream by bytes cuts its chunks anywhere, so frames straddle chunks, and chunks hold several frames, a
 * part of one, or zeros.
 *
 * The chunks' data reads as one stream. A frame is found where the frame before it ends, or, when that is not a frame
 * header, by resyncing: a sync word counts only when the frame its header describes is followed by another header
 * of the same stream, or by the stream's end, which rejects sync words inside frame data. Bytes outside frames,
 * zero-filled chunks, and a leading ID3 tag, are dropped, and so is a frame cut short, inside which a resynced frame
 * starts.
 *
 * The packets that start in a chunk are found by resyncing a largest frame before the chunk, whatever was read
 * before, so they are the same in any reading order. A stream timed by bytes times each packet by its offset, as
 * FFmpeg does; a stream timed per chunk gives a chunk's first packet the chunk's time, and each next packet the end
 * of the one before.
 */
export class AviAudioFramer {
	/** The offset of each chunk's data in the stream. */
	private chunkOffsets: number[] = [];
	private size = 0;
	private framesByChunk = new Map<number, Promise<AviAudioFrame[]>>();
	private dataStartPromise: Promise<number> | null = null;
	private hasFramesPromise: Promise<boolean> | null = null;

	constructor(
		private parser: SyncFrameParser,
		private chunks: AviAudioChunk[],
		/** The seconds one byte takes in a stream timed by bytes, or null for a stream timed per chunk. */
		private secondsPerByte: number | null,
		private readBytes: (position: number, length: number) => Promise<Uint8Array | null>,
	) {
		for (const chunk of chunks) {
			this.chunkOffsets.push(this.size);
			this.size += chunk.entry.size;
		}
	}

	/**
	 * Returns whether a frame starts in the stream's first 64 KiB after a leading ID3 tag. A stream without one, such
	 * as free-format MPEG audio, whose headers give no frame size, keeps its chunks as its packets, which a bounded
	 * read decides.
	 */
	hasFrames(): Promise<boolean> {
		return this.hasFramesPromise ??= (async () => {
			const probeEnd = await this.getDataStart() + FRAME_PROBE_BYTE_COUNT;
			for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex++) {
				if (this.chunkOffsets[chunkIndex]! >= probeEnd) {
					break;
				}
				if ((await this.getChunkFrames(chunkIndex)).length > 0) {
					return true;
				}
			}

			return false;
		})();
	}

	async getFirstFrame(): Promise<AviAudioFrame | null> {
		for (let chunkIndex = 0; chunkIndex < this.chunks.length; chunkIndex++) {
			const frames = await this.getChunkFrames(chunkIndex);
			if (frames.length > 0) {
				return frames[0]!;
			}
		}

		return null;
	}

	/** Returns the last frame whose time is at or before a timestamp. */
	async getFrameAt(timestamp: number): Promise<AviAudioFrame | null> {
		// A frame's time is at least its chunk's, so the frame starts in the last chunk at or before the timestamp, or
		// in one before it
		const lastChunkIndex = binarySearchLessOrEqual(this.chunks, timestamp, chunk => chunk.timestamp);
		for (let chunkIndex = lastChunkIndex; chunkIndex >= 0; chunkIndex--) {
			const frames = await this.getChunkFrames(chunkIndex);
			const index = binarySearchLessOrEqual(frames, timestamp, frame => frame.timestamp);
			if (index >= 0) {
				return frames[index]!;
			}
		}

		return null;
	}

	/** Returns the frame after the one at an offset. */
	async getNextFrame(offset: number): Promise<AviAudioFrame | null> {
		if (!Number.isInteger(offset) || offset < 0 || offset >= this.size) {
			throw new Error('Packet was not created from this track.');
		}

		const firstChunkIndex = binarySearchLessOrEqual(this.chunkOffsets, offset, x => x);
		for (let chunkIndex = firstChunkIndex; chunkIndex < this.chunks.length; chunkIndex++) {
			const frames = await this.getChunkFrames(chunkIndex);
			const next = frames.find(frame => frame.offset > offset);
			if (next) {
				return next;
			}
		}

		return null;
	}

	/** Reads a frame's data, or null when the file ends before it does. */
	async readFrame(frame: AviAudioFrame): Promise<Uint8Array | null> {
		const data = await this.readStreamBytes(frame.offset, frame.size);
		return data.byteLength === frame.size ? data : null;
	}

	/** Reads the stream's bytes from an offset, fewer when the stream or the file ends first. */
	private async readStreamBytes(offset: number, length: number): Promise<Uint8Array> {
		const end = Math.min(offset + length, this.size);
		const parts: Uint8Array[] = [];
		let position = offset;
		let chunkIndex = binarySearchLessOrEqual(this.chunkOffsets, offset, x => x);
		while (position < end) {
			const chunk = this.chunks[chunkIndex]!;
			const start = position - this.chunkOffsets[chunkIndex]!;
			const byteCount = Math.min(chunk.entry.size - start, end - position);
			const bytes = await this.readBytes(chunk.position + start, byteCount);
			if (!bytes) {
				break;
			}

			parts.push(bytes);
			position += byteCount;
			chunkIndex++;
		}

		if (parts.length === 1) {
			return parts[0]!;
		}

		const joined = new Uint8Array(position - offset);
		let joinedPosition = 0;
		for (const part of parts) {
			joined.set(part, joinedPosition);
			joinedPosition += part.byteLength;
		}

		return joined;
	}

	/** Returns the offset where the stream's frames start: after an ID3v2 tag that leads it, else 0. */
	private getDataStart(): Promise<number> {
		return this.dataStartPromise ??= (async () => {
			const header = await this.readStreamBytes(0, ID3_HEADER_SIZE);
			const isId3 = header.byteLength === ID3_HEADER_SIZE
				&& header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33 // 'ID3'
				&& header[3] !== 0xFF && header[4] !== 0xFF
				&& (header[6]! | header[7]! | header[8]! | header[9]!) < 0x80;
			if (!isId3) {
				return 0;
			}

			const tagSize = decodeSynchsafe(
				((header[6]! << 24) | (header[7]! << 16) | (header[8]! << 8) | header[9]!) >>> 0,
			);
			const hasFooter = (header[5]! & 0x10) !== 0;
			return Math.min(ID3_HEADER_SIZE + tagSize + (hasFooter ? ID3_HEADER_SIZE : 0), this.size);
		})();
	}

	/** Returns the packets that start in a chunk, in order. */
	private getChunkFrames(chunkIndex: number): Promise<AviAudioFrame[]> {
		let promise = this.framesByChunk.get(chunkIndex);
		if (!promise) {
			promise = this.findChunkFrames(chunkIndex);
			promise.catch(() => this.framesByChunk.delete(chunkIndex));
			if (this.framesByChunk.size >= FRAME_CACHE_CHUNK_COUNT) {
				this.framesByChunk.delete(this.framesByChunk.keys().next().value!);
			}
			this.framesByChunk.set(chunkIndex, promise);
		}

		return promise;
	}

	private async findChunkFrames(chunkIndex: number): Promise<AviAudioFrame[]> {
		const { parser } = this;
		const chunk = this.chunks[chunkIndex]!;
		const chunkStart = this.chunkOffsets[chunkIndex]!;
		const chunkEnd = chunkStart + chunk.entry.size;
		const dataStart = await this.getDataStart();
		if (chunkEnd <= dataStart) {
			return [];
		}

		// A frame that runs into the chunk starts at most a largest frame before it, so the walk is in sync by the
		// chunk's start wherever the stream is whole
		const scanStart = Math.max(dataStart, chunkStart - parser.maxFrameSize);
		// A frame and the header after it
		const lookahead = parser.maxFrameSize + parser.headerSize;
		let bytes = await this.readStreamBytes(scanStart, chunkEnd - scanStart + lookahead);
		let bytesEnd = scanStart + bytes.byteLength;
		/** Whether the bytes reach the stream's end, or the file's. */
		let bytesExhausted = bytesEnd >= this.size;

		/**
		 * Returns the frame at an offset when it lies in full within the bytes and matches the frame the walk follows,
		 * or, out of sync, when the next header of the same stream, or the stream's end, follows it.
		 */
		const acceptFrame = (offset: number, previous: SyncFrame | null) => {
			if (offset + parser.headerSize > bytesEnd) {
				return null;
			}
			const frame = parser.parse(bytes, offset - scanStart);
			const nextOffset = offset + (frame?.size ?? 0);
			if (!frame || nextOffset > bytesEnd) {
				return null;
			}
			if (previous) {
				return frame.signature === previous.signature ? frame : null;
			}
			if (nextOffset === this.size) {
				return frame;
			}

			const next = nextOffset + parser.headerSize <= bytesEnd
				? parser.parse(bytes, nextOffset - scanStart)
				: null;
			return next?.signature === frame.signature ? frame : null;
		};

		type Packet = { offset: number; size: number; frame: SyncFrame };
		const packets: Packet[] = [];
		/** The packet the walk is in, while it is in sync. */
		let packet: Packet | null = null;
		/** The frame the walk follows, and its offset, while it is in sync. */
		let previous: SyncFrame | null = null;
		let previousOffset = -1;
		let offset = scanStart;
		while (true) {
			// Past the chunk, the walk only checks where the last frame ends, which may complete the last packet
			if (offset >= chunkEnd && !previous) {
				break;
			}

			if (offset + lookahead > bytesEnd && !bytesExhausted) {
				const more = await this.readStreamBytes(bytesEnd, Math.max(lookahead, chunkEnd - bytesEnd));
				const joined = new Uint8Array(bytes.byteLength + more.byteLength);
				joined.set(bytes);
				joined.set(more, bytes.byteLength);
				bytes = joined;
				bytesEnd += more.byteLength;
				bytesExhausted = more.byteLength === 0 || bytesEnd >= this.size;
			}

			const frame = acceptFrame(offset, previous);
			if (!frame && previous) {
				// Out of sync where the previous frame ends. A frame that resyncs inside the previous one shows that
				// a muxer cut the previous frame short, so its packet is dropped and the walk goes on from there
				let resyncOffset = previousOffset + 1;
				while (resyncOffset < offset && !acceptFrame(resyncOffset, null)) {
					resyncOffset++;
				}
				if (resyncOffset < offset && packet && packets[packets.length - 1] === packet) {
					packets.pop();
				}

				previous = null;
				packet = null;
				offset = resyncOffset;
				continue;
			}
			if (!frame) {
				offset++;
				continue;
			}
			if (offset >= chunkEnd && frame.startsPacket) {
				break;
			}

			if (frame.startsPacket) {
				packet = { offset, size: frame.size, frame };
				if (offset >= chunkStart) {
					packets.push(packet);
				}
			} else if (packet) {
				packet.size += frame.size;
			}

			previous = frame;
			previousOffset = offset;
			offset += frame.size;
		}

		const frames: AviAudioFrame[] = [];
		for (const { offset, size, frame } of packets) {
			const duration = frame.sampleCount / frame.sampleRate;
			let timestamp: number;
			if (this.secondsPerByte !== null) {
				timestamp = chunk.timestamp + (offset - chunkStart) * this.secondsPerByte;
			} else if (frames.length === 0) {
				// FFmpeg moves a chunk's time by the bytes before the frame, at the frame's own rate
				timestamp = chunk.timestamp + (offset - chunkStart) * duration / size;
			} else {
				const previousFrame = frames[frames.length - 1]!;
				timestamp = previousFrame.timestamp + previousFrame.duration;
			}

			frames.push({ offset, size, timestamp, duration });
		}

		return frames;
	}
}
