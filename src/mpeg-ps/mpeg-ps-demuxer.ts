/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, MediaCodec, VideoCodec } from '../codec';
import {
	MPEG_VIDEO_EXTENSION_START_CODE,
	MPEG_VIDEO_PICTURE_START_CODE,
	MPEG_VIDEO_SEQUENCE_HEADER_START_CODE,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input, InputDisposedError } from '../input';
import { InputAudioTrackBacking, InputTrackBacking, InputVideoTrackBacking } from '../input-track';
import { Logging } from '../logging';
import { TrackType } from '../output';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	assert,
	floorToMultiple,
	IDENTITY_MATRIX,
	MaybeRelevantPromise,
	ResultValue,
	roundIfAlmostInteger,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import {
	ElementaryStream,
	initializeElementaryStream,
	PacketBuffer,
	PacketReadingContext,
	PacketWithDuration,
	PesPacket,
	SuppliedPacket,
	TimestampedPesPacket,
} from '../mpeg-ts/mpeg-ts-demuxer';
import {
	createTimestampWrapInfo,
	MPEG_TS_TIMESCALE,
	normalizeWrappedTimestamp,
	TimestampWrapInfo,
} from '../mpeg-ts/mpeg-ts-misc';
import {
	EncodedPacket,
	PacketRetrievalOptions,
	PacketRetrievalResult,
	PacketType,
	PLACEHOLDER_DATA,
} from '../packet';
import { readBytes, Reader } from '../reader';
import {
	buildMpegPsMimeType,
	MPEG_AUDIO_STREAM_ID_MAXIMUM,
	MPEG_AUDIO_STREAM_ID_MINIMUM,
	MPEG_VIDEO_STREAM_ID_MAXIMUM,
	MPEG_VIDEO_STREAM_ID_MINIMUM,
	PACK_HEADER_CODE,
	PRIVATE_STREAM_1,
	PROGRAM_END_CODE,
} from './mpeg-ps-misc';

// Resources:
// ISO/IEC 11172-1 (MPEG-1 system streams)
// ISO/IEC 13818-1 (MPEG-2 program streams)
// FFmpeg's mpeg.c, for the DVD-Video substreams of private stream 1

// The DVD-Video substreams of private stream 1, by their substream IDs
const AC3_SUBSTREAM_MINIMUM = 0x80;
const AC3_SUBSTREAM_MAXIMUM = 0x87;
const DTS_SUBSTREAM_MINIMUM = 0x88;
const DTS_SUBSTREAM_MAXIMUM = 0x8f;
const LPCM_SUBSTREAM_MINIMUM = 0xa0;
const LPCM_SUBSTREAM_MAXIMUM = 0xa7;
// The frame count and first access unit pointer an AC-3, DTS, or LPCM substream packet begins with
const SUBSTREAM_FRAME_HEADER_SIZE = 3;
// The emphasis and frame number, the sample format, and the dynamic range an LPCM substream packet goes on with
const LPCM_HEADER_SIZE = 3;
// The LPCM header's sampling frequency codes
const LPCM_SAMPLE_RATES = [48000, 96000, 44100, 32000];
const LPCM_16_BIT_QUANTIZATION = 0;

const MPEG1_PACK_HEADER_SIZE = 12;
const MPEG2_PACK_HEADER_SIZE = 14;

// Streams are looked for in the file's first 5 MB or 5 seconds, as FFmpeg probes it
const STREAM_SCAN_BYTE_LIMIT = 5_000_000;
const STREAM_SCAN_DURATION_LIMIT = 5 * MPEG_TS_TIMESCALE;

const PACK_SEARCH_CHUNK_SIZE = 64 * 1024;
// A search by SCR aims this far before the time it looks for
const SEARCH_MARGIN = MPEG_TS_TIMESCALE;

const MPEG_VIDEO_B_PICTURE = 3;
const MPEG_VIDEO_USER_DATA_START_CODE = 0xb2;
const MPEG_VIDEO_SEQUENCE_EXTENSION_ID = 1;
const MPEG_VIDEO_PICTURE_CODING_EXTENSION_ID = 8;
// The frame rates of frame_rate_code 1 to 8
const MPEG_VIDEO_FRAME_RATES = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
const DEFAULT_MPEG_VIDEO_FRAME_RATE = 25;

/** What times an MPEG-1 or MPEG-2 video stream's pictures: its sequence header's and sequence extension's rates. */
type MpegVideoTiming = {
	frameRate: number;
	progressiveSequence: boolean;
};

type MpegPsElementaryStream = ElementaryStream<MpegPsDemuxer> & {
	/** The stream's first PES packet with a PTS, where its packets begin. */
	firstPesPacket: TimestampedPesPacket | null;
	/** The PTS of the stream's first PES packet less the SCR of its pack, which a search by SCR allows for. */
	scrToPtsOffset: number;
	/** An LPCM substream's sample format byte, from the header of its first packet. */
	lpcmFormat: number | null;
	/** The timing a reading context of an MPEG-1 or MPEG-2 video stream starts with, until a sequence header comes. */
	videoTiming: MpegVideoTiming;
};

type MpegPsVideoStream = MpegPsElementaryStream & { info: { type: 'video' } };
type MpegPsAudioStream = MpegPsElementaryStream & { info: { type: 'audio' } };

/** A pack header, an end code, a system header, or a PES packet, from its start code on. */
type ProgramStreamUnit = {
	pos: number;
	/** The start code's last byte: 0xba for a pack header, 0xb9 for an end code, else a stream ID. */
	code: number;
	size: number;
	/** A pack header's system clock reference, in 90 kHz units. */
	scr: number | null;
};

type ProgramStreamPesPacket = PesPacket & {
	/** 0x100 plus the stream ID, or the substream ID of a private stream 1 packet, as FFmpeg identifies streams. */
	streamKey: number;
	/** An LPCM substream packet's sample format byte: its quantization, sampling frequency, and channel count. */
	lpcmFormat: number | null;
};

type EncodedPacketMetadata = {
	buffer: PacketBuffer | null;
	sectionStartPos: number;
};

const readTimestamp = (bytes: Uint8Array, offset: number) => ((bytes[offset]! >> 1) & 0x07) * 2 ** 30
	+ ((bytes[offset + 1]! << 7) | (bytes[offset + 2]! >> 1)) * 2 ** 15
	+ ((bytes[offset + 3]! << 7) | (bytes[offset + 4]! >> 1));

const isAc3Substream = (key: number) => key >= AC3_SUBSTREAM_MINIMUM && key <= AC3_SUBSTREAM_MAXIMUM;
const isDtsSubstream = (key: number) => key >= DTS_SUBSTREAM_MINIMUM && key <= DTS_SUBSTREAM_MAXIMUM;
const isLpcmSubstream = (key: number) => key >= LPCM_SUBSTREAM_MINIMUM && key <= LPCM_SUBSTREAM_MAXIMUM;

// An MPEG-2 pack header's SCR, around its marker bits; an MPEG-1 one's lies as a PTS does
const readMpeg2Scr = (bytes: Uint8Array, offset: number) => ((bytes[offset]! >> 3) & 0x07) * 2 ** 30
	+ (bytes[offset]! & 0x03) * 2 ** 28
	+ bytes[offset + 1]! * 2 ** 20
	+ (bytes[offset + 2]! >> 3) * 2 ** 15
	+ (bytes[offset + 2]! & 0x03) * 2 ** 13
	+ bytes[offset + 3]! * 2 ** 5
	+ (bytes[offset + 4]! >> 3);

/** Returns the offset of the first start code of an MPEG video start code value in data, or -1. */
const findMpegVideoStartCode = (data: Uint8Array, code: number) => {
	for (let i = 0; i + 3 < data.length; i++) {
		if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01 && data[i + 3] === code) {
			return i;
		}
	}

	return -1;
};

/**
 * Reads the header of a PES packet of a stream ID that carries media: its PTS, the stream it belongs to, and where its
 * data begins, past an AC-3, DTS, or LPCM substream's header. Reads MPEG-2 PES headers and MPEG-1 packet headers alike.
 * Returns null when the header is malformed or doesn't fit in the bytes.
 */
const parsePesHeader = (bytes: Uint8Array) => {
	const streamId = bytes[3]!;
	let offset = 6;
	let pts: number | null = null;

	if (offset >= bytes.length) {
		return null;
	}

	if ((bytes[offset]! & 0xc0) === 0x80) {
		// MPEG-2 PES header
		if (bytes.length < 9) {
			return null;
		}

		const ptsDtsFlags = bytes[7]! >> 6;
		if (ptsDtsFlags & 0b10) {
			if (bytes.length < 14) {
				return null;
			}

			pts = readTimestamp(bytes, 9);
		}

		offset = 9 + bytes[8]!;
	} else {
		// MPEG-1 packet header: stuffing, an optional STD buffer size, then the timestamps
		while (offset < bytes.length && bytes[offset] === 0xff) {
			offset++;
		}
		if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x40) {
			offset += 2;
		}
		if (offset >= bytes.length) {
			return null;
		}

		const marker = bytes[offset]! >> 4;
		if (marker === 0b0010 || marker === 0b0011) {
			if (offset + 5 > bytes.length) {
				return null;
			}

			pts = readTimestamp(bytes, offset);
			offset += marker === 0b0010 ? 5 : 10;
		} else if (bytes[offset] === 0x0f) {
			offset++;
		} else {
			return null;
		}
	}

	let streamKey = 0x100 | streamId;
	let lpcmFormat: number | null = null;

	if (streamId === PRIVATE_STREAM_1) {
		if (offset >= bytes.length) {
			return null;
		}

		streamKey = bytes[offset]!;
		offset++;

		if (isAc3Substream(streamKey) || isDtsSubstream(streamKey) || isLpcmSubstream(streamKey)) {
			offset += SUBSTREAM_FRAME_HEADER_SIZE;
		}
		if (isLpcmSubstream(streamKey)) {
			lpcmFormat = bytes[offset + 1] ?? null;
			offset += LPCM_HEADER_SIZE;
		}
	}

	if (offset > bytes.length) {
		return null;
	}

	return { streamKey, pts, dataStart: offset, lpcmFormat };
};

type MpegVideoPicture = {
	/** Where the frame's first picture start code begins in its data. */
	pictureOffset: number;
	isBPicture: boolean;
	/** How many fields the picture is displayed for. */
	fieldCount: number;
};

/**
 * Reads a frame of MPEG-1 or MPEG-2 video for its first picture's coding type and display length, as FFmpeg's MPEG
 * video parser reads repeat_first_field, and updates the timing with the sequence headers and extensions before it.
 * Returns null for data without a picture, such as the tail of a frame that a reading context starts in.
 */
const readMpegVideoPicture = (data: Uint8Array, timing: MpegVideoTiming): MpegVideoPicture | null => {
	let picture: MpegVideoPicture | null = null;

	for (let i = 0; i + 4 < data.length; i++) {
		if (data[i] !== 0x00 || data[i + 1] !== 0x00 || data[i + 2] !== 0x01) {
			continue;
		}

		const code = data[i + 3]!;

		if (code === MPEG_VIDEO_SEQUENCE_HEADER_START_CODE && !picture && i + 8 <= data.length) {
			const frameRateCode = data[i + 7]! & 0x0f;
			if (frameRateCode >= 1 && frameRateCode <= MPEG_VIDEO_FRAME_RATES.length) {
				timing.frameRate = MPEG_VIDEO_FRAME_RATES[frameRateCode - 1]!;
			}
		} else if (code === MPEG_VIDEO_EXTENSION_START_CODE && i + 9 <= data.length) {
			const extensionId = data[i + 4]! >> 4;

			if (extensionId === MPEG_VIDEO_SEQUENCE_EXTENSION_ID && !picture && i + 10 <= data.length) {
				timing.progressiveSequence = ((data[i + 5]! >> 3) & 1) === 1;
				const frameRateExtensionN = (data[i + 9]! >> 5) & 0x03;
				const frameRateExtensionD = data[i + 9]! & 0x1f;
				timing.frameRate *= (frameRateExtensionN + 1) / (frameRateExtensionD + 1);
			} else if (extensionId === MPEG_VIDEO_PICTURE_CODING_EXTENSION_ID && picture) {
				const topFieldFirst = (data[i + 7]! >> 7) === 1;
				const repeatFirstField = ((data[i + 7]! >> 1) & 1) === 1;
				const progressiveFrame = (data[i + 8]! >> 7) === 1;

				if (repeatFirstField) {
					if (timing.progressiveSequence) {
						// The frame is shown two or three times over
						picture.fieldCount = topFieldFirst ? 6 : 4;
					} else if (progressiveFrame) {
						picture.fieldCount = 3;
					}
				}

				return picture;
			}
		} else if (code === MPEG_VIDEO_PICTURE_START_CODE) {
			if (picture) {
				// The frame's second field, which a picture coding extension would have come before
				return picture;
			}

			picture = {
				pictureOffset: i,
				isBPicture: ((data[i + 5]! >> 3) & 0x07) === MPEG_VIDEO_B_PICTURE,
				fieldCount: 2,
			};
		} else if (picture && code !== MPEG_VIDEO_USER_DATA_START_CODE) {
			// The picture's slices, without a picture coding extension before them: MPEG-1
			return picture;
		}
	}

	return picture;
};

/** A picture split from the stream, waiting for its presentation timestamp. */
type PendingPicture = {
	packet: SuppliedPacket;
	isBPicture: boolean;
	/** The PTS of the PES packet the picture begins in, unless an earlier picture took it. */
	ownPts: number | null;
	/** How long the picture is displayed, in 90 kHz units. */
	duration: number;
	pts: number | null;
	/** Whether its timestamp can no longer be worked out. */
	untimed: boolean;
};

/**
 * Reads the packets of a program stream's elementary stream. Its frames are split as in a transport stream, while
 * timestamps follow the program stream's packets: a PES packet may leave out the PTS of a frame that begins in it, and
 * a video PES packet carrying a PTS may hold several pictures, the PTS belonging to the first that begins in it. Video
 * pictures without a PTS of their own are timed by the display order of MPEG video: a B picture is shown when it's
 * decoded, and an I or P picture after the B pictures that follow it in decode order.
 */
class MpegPsPacketReadingContext extends PacketReadingContext {
	declare elementaryStream: MpegPsElementaryStream;

	videoTiming: MpegVideoTiming;
	/** PES packets whose PTS a picture took. */
	timestampedPesPackets = new WeakSet<PesPacket>();
	/** Pictures split from the stream, in decode order, that haven't been supplied. */
	pendingPictures: PendingPicture[] = [];
	/** Where the next picture in display order begins, when known. */
	displayClock: number | null = null;
	/** The I or P picture whose display waits on the B pictures after it, and those B pictures. */
	segmentAnchor: PendingPicture | null = null;
	segmentBPictures: PendingPicture[] = [];
	reachedEnd = false;
	/** Whether the last supplied packet is a B picture. */
	suppliedBPicture = false;
	/** How long each supplied packet is displayed for, in 90 kHz units. */
	displayDurations = new WeakMap<SuppliedPacket, number>();
	/** Whether a frame was split off since the flag was cleared. */
	splitFrame = false;

	constructor(elementaryStream: MpegPsElementaryStream, startingPesPacket: TimestampedPesPacket) {
		super(elementaryStream, startingPesPacket);

		this.videoTiming = { ...elementaryStream.videoTiming };
	}

	override async markNextPacket(res: ResultValue<void>): MaybeRelevantPromise {
		if (this.elementaryStream.lpcmFormat !== null) {
			return this.markNextLpcmPacket(res);
		}

		if (this.elementaryStream.info.type === 'video') {
			return this.markNextPicture(res);
		}

		return super.markNextPacket(res);
	}

	override supplyPacket(packetLength: number, intrinsicDuration: number, timestampOverride: number | null = null) {
		if (this.elementaryStream.info.type === 'video') {
			this.supplyPicture(packetLength);
			return;
		}

		const currentPesPacket = this.getCurrentPesPacket();
		const isFrameStartWithoutPts = currentPesPacket.pts === null && this.lastSuppliedPesPacket !== currentPesPacket;
		if (timestampOverride === null && isFrameStartWithoutPts) {
			// The frame begins in a PES packet without a PTS, so it follows on from the frame before it
			timestampOverride = this.nextPts;
		}

		super.supplyPacket(packetLength, intrinsicDuration, timestampOverride);
		if (this.suppliedPacket) {
			this.displayDurations.set(this.suppliedPacket, intrinsicDuration);
		}
	}

	/** Splits off the frame at the current position and queues its picture for timing. */
	supplyPicture(packetLength: number) {
		const pesPackets = this.pesPackets.slice(this.currentPesPacketIndex);
		const startOffset = this.currentPos - this.currentPesPacketPos;

		// The timestamp is worked out when the picture is timed
		super.supplyPacket(packetLength, 0, 0);
		const packet = this.suppliedPacket;
		assert(packet);
		this.suppliedPacket = null;
		this.splitFrame = true;

		const picture = readMpegVideoPicture(packet.data, this.videoTiming);
		if (!picture) {
			return;
		}

		// The PTS of the PES packet the picture's start code begins in, or else of an earlier PES packet the frame
		// begins in, whose PTS a muxer may give the frame its header begins
		let ownPts: number | null = null;
		let remaining = startOffset + picture.pictureOffset;
		for (const pesPacket of pesPackets) {
			if (pesPacket.pts !== null && !this.timestampedPesPackets.has(pesPacket)) {
				ownPts = pesPacket.pts;
				this.timestampedPesPackets.add(pesPacket);
			}

			remaining -= pesPacket.data.byteLength;
			if (remaining < 0) {
				break;
			}
		}

		this.addPicture({
			packet,
			isBPicture: picture.isBPicture,
			ownPts,
			duration: picture.fieldCount * MPEG_TS_TIMESCALE / (2 * this.videoTiming.frameRate),
			pts: null,
			untimed: false,
		});
	}

	addPicture(picture: PendingPicture) {
		this.pendingPictures.push(picture);

		if (picture.isBPicture) {
			this.segmentBPictures.push(picture);

			if (picture.ownPts !== null) {
				picture.pts = picture.ownPts;
				this.displayClock = picture.ownPts + picture.duration;
			} else if (this.displayClock !== null && (!this.segmentAnchor || this.segmentAnchor.ownPts === null)) {
				// Unless the anchor has a PTS to count back from, the picture follows on from the one shown before it
				picture.pts = this.displayClock;
				this.displayClock += picture.duration;
			}

			return;
		}

		this.closeSegment();

		this.segmentAnchor = picture;
		this.segmentBPictures = [];
		if (picture.ownPts !== null) {
			picture.pts = picture.ownPts;
		}
	}

	/** Times the pictures of the segment that the next I or P picture, or the end of the stream, closes. */
	closeSegment() {
		const anchor = this.segmentAnchor;

		if (anchor && anchor.ownPts !== null) {
			// The B pictures that follow the anchor in decode order are shown right before it
			let time = anchor.ownPts;
			for (let i = this.segmentBPictures.length - 1; i >= 0; i--) {
				const picture = this.segmentBPictures[i]!;
				picture.pts ??= time - picture.duration;
				time = picture.pts;
			}

			this.displayClock = anchor.ownPts + anchor.duration;
		} else if (this.displayClock !== null) {
			if (anchor) {
				anchor.pts = this.displayClock;
				this.displayClock += anchor.duration;
			} else {
				// The anchor of the B pictures came before the context's start, so it's shown for a frame
				this.displayClock += MPEG_TS_TIMESCALE / this.videoTiming.frameRate;
			}
		}

		for (const picture of [...this.segmentBPictures, ...(anchor ? [anchor] : [])]) {
			picture.untimed = picture.pts === null;
		}
	}

	async markNextPicture(res: ResultValue<void>): MaybeRelevantPromise {
		const markResult = new ResultValue<void>();

		while (true) {
			const picture = this.pendingPictures[0];

			if (picture && (picture.pts !== null || picture.untimed)) {
				this.pendingPictures.shift();

				if (picture.untimed) {
					continue;
				}

				picture.packet.pts = Math.round(picture.pts!);
				this.suppliedPacket = picture.packet;
				this.suppliedBPicture = picture.isBPicture;
				this.displayDurations.set(picture.packet, Math.round(picture.duration));
				return res.set();
			}

			if (this.reachedEnd) {
				assert(this.pendingPictures.length === 0);
				return res.set();
			}

			this.splitFrame = false;
			markResult.reset();
			const markPromise = super.markNextPacket(markResult);
			if (markResult.pending) await markPromise;

			if (!this.splitFrame) {
				// Nothing more could be split off
				this.reachedEnd = true;
				this.closeSegment();
				this.segmentAnchor = null;
				this.segmentBPictures = [];
				for (const pendingPicture of this.pendingPictures) {
					pendingPicture.untimed = pendingPicture.pts === null;
				}
			}
		}
	}

	/**
	 * Splits an LPCM substream into a packet for each of its PES packets, as FFmpeg reads them, starting on a sample
	 * boundary and running on into the next PES packet to end on one.
	 */
	async markNextLpcmPacket(res: ResultValue<void>): MaybeRelevantPromise {
		const info = this.elementaryStream.info;
		assert(info.type === 'audio');

		const blockAlign = 2 * info.numberOfChannels;
		const bufferedResult = new ResultValue<number>();

		bufferedResult.reset();
		const bufferedPromise = this.ensureBuffered(bufferedResult, 1);
		if (bufferedResult.pending) await bufferedPromise;
		if (bufferedResult.value === 0) {
			return res.set();
		}

		while (this.currentPos >= this.currentPesPacketPos + this.getCurrentPesPacket().data.byteLength) {
			this.advanceCurrentPacket();
		}

		const pesPacket = this.getCurrentPesPacket();
		const offset = this.currentPos - this.currentPesPacketPos;
		const length = Math.ceil((pesPacket.data.byteLength - offset) / blockAlign) * blockAlign;

		bufferedResult.reset();
		const lengthPromise = this.ensureBuffered(bufferedResult, length);
		if (bufferedResult.pending) await lengthPromise;

		const packetLength = floorToMultiple(bufferedResult.value, blockAlign);
		if (packetLength === 0) {
			return res.set();
		}

		const pts = offset === 0 && pesPacket.pts !== null ? pesPacket.pts : this.nextPts ?? pesPacket.pts;
		assert(pts !== null);

		const duration = Math.round(packetLength / blockAlign * MPEG_TS_TIMESCALE / info.sampleRate);
		super.supplyPacket(packetLength, duration, pts);
		this.displayDurations.set(this.suppliedPacket!, duration);
		return res.set();
	}
}

/**
 * A packet buffer that gives the last packet presented the time it's displayed for, as no later packet tells it, the
 * same however far into the stream the reading began.
 */
class MpegPsPacketBuffer extends PacketBuffer {
	declare context: MpegPsPacketReadingContext;
	latestPts = -Infinity;

	override async readNext(res: ResultValue<PacketWithDuration | null>): MaybeRelevantPromise {
		const promise = super.readNext(res);
		if (res.pending) await promise;

		const result = res.value;
		if (!result) {
			return res.set(null);
		}

		const pts = result.packet.pts;
		const isLastPresented = this.reachedEnd
			&& pts >= this.latestPts
			&& !this.decodeOrderPackets.some(packet => packet.pts > pts)
			&& !this.presentationOrderPackets.some(packet => packet.pts > pts);
		this.latestPts = Math.max(this.latestPts, pts);

		if (isLastPresented) {
			result.duration = this.context.displayDurations.get(result.packet) ?? result.duration;
		}

		return res.set(result);
	}
}

/**
 * Demuxes MPEG program streams: MPEG-1 system streams (.mpg) and MPEG-2 program streams (.mpg, .vob), with MPEG-1
 * and MPEG-2 video, MPEG audio, and DVD-Video's AC-3, DTS, and LPCM audio in private stream 1. Streams become tracks in
 * the order their first PES packets come, as FFmpeg creates them. Packets are split as in MPEG-TS and keep the PTS of
 * the PES packets they begin in. A search bisects the file by the packs' SCRs, then reads forward.
 */
export class MpegPsDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	elementaryStreams: MpegPsElementaryStream[] = [];
	trackBackingEntries: (MpegPsVideoTrackBacking | MpegPsAudioTrackBacking)[] = [];
	// Searches bisect the file rather than keeping reference points
	minReferencePointByteDistance = Infinity;
	/**
	 * How far a search by SCR narrows the file down, and how far back it first reads from there when the packet it
	 * looks for lies further back, which each further try doubles.
	 */
	seekChunkSize = 256 * 1024;
	timestampWrapInfo: TimestampWrapInfo | null = null;

	/**
	 * Per stream, the position from which the file holds none of its PES packets, or none with a PTS, as a search that
	 * read to the end found.
	 */
	pesPacketEnds = new Map<number, number>();
	timestampedPesPacketEnds = new Map<number, number>();

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			const streamsByKey = new Map<number, MpegPsElementaryStream>();
			let lastScr: number | null = null;
			let firstPts: number | null = null;
			let pos = 0;

			while (pos < STREAM_SCAN_BYTE_LIMIT) {
				const unit = await this.readUnit(pos);
				if (!unit) {
					break;
				}

				pos = unit.pos + unit.size;

				if (unit.code === PACK_HEADER_CODE) {
					lastScr = unit.scr;
					continue;
				}

				const isMediaStream = unit.code === PRIVATE_STREAM_1
					|| (unit.code >= MPEG_AUDIO_STREAM_ID_MINIMUM && unit.code <= MPEG_VIDEO_STREAM_ID_MAXIMUM);
				if (!isMediaStream) {
					continue;
				}

				const pesPacket = await this.readPesPacket(unit);
				if (!pesPacket) {
					continue;
				}

				let stream = streamsByKey.get(pesPacket.streamKey);
				if (!stream) {
					const info = this.getStreamInfo(pesPacket);
					if (!info) {
						continue;
					}

					stream = {
						demuxer: this,
						pid: pesPacket.streamKey,
						streamType: pesPacket.streamKey,
						initialized: false,
						firstSection: null,
						canBeTrustedWithKeyPackets: false,
						info,
						referencePesPackets: [],
						firstPesPacket: null,
						scrToPtsOffset: 0,
						lpcmFormat: pesPacket.lpcmFormat,
						videoTiming: { frameRate: DEFAULT_MPEG_VIDEO_FRAME_RATE, progressiveSequence: false },
					};
					streamsByKey.set(pesPacket.streamKey, stream);
					this.elementaryStreams.push(stream);
				}

				if (pesPacket.pts === null) {
					continue;
				}

				if (!stream.firstPesPacket) {
					stream.firstPesPacket = pesPacket as TimestampedPesPacket;
					stream.scrToPtsOffset = lastScr !== null ? pesPacket.pts - lastScr : 0;
				}

				firstPts ??= pesPacket.pts;
				if (pesPacket.pts - firstPts > STREAM_SCAN_DURATION_LIMIT) {
					break;
				}
			}

			for (const stream of this.elementaryStreams) {
				await this.initializeStream(stream);

				if (!stream.initialized) {
					continue;
				}

				if (stream.info.type === 'video') {
					this.trackBackingEntries.push(new MpegPsVideoTrackBacking(stream as MpegPsVideoStream));
				} else {
					this.trackBackingEntries.push(new MpegPsAudioTrackBacking(stream as MpegPsAudioStream));
				}
			}
		})();
	}

	/** Returns the track info of a stream by its first PES packet, or null for a stream that isn't read. */
	getStreamInfo(pesPacket: ProgramStreamPesPacket): MpegPsElementaryStream['info'] | null {
		const key = pesPacket.streamKey;
		const streamId = key & 0xff;

		if (key > 0xff && streamId >= MPEG_VIDEO_STREAM_ID_MINIMUM && streamId <= MPEG_VIDEO_STREAM_ID_MAXIMUM) {
			return {
				type: 'video',
				// The sequence header settles whether it's MPEG-1 or MPEG-2
				codec: 'mpeg2',
				decoderConfig: null,
				avcCodecInfo: null,
				hevcCodecInfo: null,
				colorSpace: {
					primaries: null,
					transfer: null,
					matrix: null,
					fullRange: null,
				},
				width: -1,
				height: -1,
				squarePixelWidth: -1,
				squarePixelHeight: -1,
				reorderSize: -1,
			};
		}

		let codec: AudioCodec;
		if (key > 0xff && streamId >= MPEG_AUDIO_STREAM_ID_MINIMUM && streamId <= MPEG_AUDIO_STREAM_ID_MAXIMUM) {
			codec = 'mp3';
		} else if (isAc3Substream(key)) {
			codec = 'ac3';
		} else if (isDtsSubstream(key)) {
			codec = 'dts';
		} else if (isLpcmSubstream(key)) {
			codec = 'pcm-s16be';
		} else {
			// Subpictures, and the substreams DVD-Video doesn't define
			return null;
		}

		return {
			type: 'audio',
			codec,
			decoderConfig: null,
			aacCodecInfo: null,
			dtsFormat: null,
			numberOfChannels: -1,
			sampleRate: -1,
		};
	}

	/** Reads a stream's codec parameters from its first packets, leaving it uninitialized if it isn't readable. */
	async initializeStream(stream: MpegPsElementaryStream) {
		const firstPesPacket = stream.firstPesPacket;
		if (!firstPesPacket) {
			return;
		}

		if (stream.lpcmFormat !== null) {
			assert(stream.info.type === 'audio');

			const quantization = stream.lpcmFormat >> 6;
			if (quantization !== LPCM_16_BIT_QUANTIZATION) {
				Logging._warn('Note: MPEG program stream LPCM above 16 bits per sample is not currently supported.');
				return;
			}

			stream.info.sampleRate = LPCM_SAMPLE_RATES[(stream.lpcmFormat >> 4) & 0x03]!;
			stream.info.numberOfChannels = (stream.lpcmFormat & 0x07) + 1;
			stream.info.decoderConfig = {
				codec: 'pcm-s16be',
				numberOfChannels: stream.info.numberOfChannels,
				sampleRate: stream.info.sampleRate,
			};
			stream.initialized = true;
			return;
		}

		const holdsMpegVideo = findMpegVideoStartCode(firstPesPacket.data, MPEG_VIDEO_SEQUENCE_HEADER_START_CODE) !== -1
			|| findMpegVideoStartCode(firstPesPacket.data, MPEG_VIDEO_PICTURE_START_CODE) !== -1;
		if (stream.info.type === 'video' && !holdsMpegVideo) {
			// Program streams may carry other video in these stream IDs, which only a program stream map would name
			Logging._warn('Note: MPEG program stream video other than MPEG-1 and MPEG-2 is not currently supported.');
			return;
		}

		const context = new MpegPsPacketReadingContext(stream, firstPesPacket);
		try {
			await initializeElementaryStream(stream, context);
		} catch (error) {
			if (error instanceof InputDisposedError) {
				throw error;
			}

			// A stream whose packets can't be read, such as other audio in an MPEG audio stream ID, is left out
			Logging._warn(
				`Note: MPEG program stream 0x${stream.pid.toString(16)} could not be read and is skipped.`,
				error,
			);
			return;
		}

		// Contexts starting anywhere in the stream time pictures by its first sequence header until one comes
		stream.videoTiming = { ...context.videoTiming };
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackingEntries;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		return {};
	}

	async getMimeType(): Promise<string> {
		await this.readMetadata();

		const codecStrings = await Promise.all(this.trackBackingEntries.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));

		return buildMpegPsMimeType(codecStrings);
	}

	/**
	 * Reads the unit at a position: a pack header, an end code, or a PES packet or system header. Data that doesn't
	 * begin with a start code is skipped up to the next pack header. Returns null at the end of the file.
	 */
	async readUnit(pos: number): Promise<ProgramStreamUnit | null> {
		while (true) {
			let slice = this.reader.requestSliceRange(pos, 0, MPEG2_PACK_HEADER_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice || slice.length < 4) {
				return null;
			}

			const bytes = readBytes(slice, slice.length);
			if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3]! >= PROGRAM_END_CODE) {
				const code = bytes[3]!;

				if (code === PROGRAM_END_CODE) {
					return { pos, code, size: 4, scr: null };
				}

				if (code === PACK_HEADER_CODE && bytes.length >= 5) {
					if ((bytes[4]! & 0xc0) === 0x40 && bytes.length === MPEG2_PACK_HEADER_SIZE) {
						const stuffingLength = bytes[13]! & 0x07;
						const scr = this.normalizeTimestamp(readMpeg2Scr(bytes, 4));
						return { pos, code, size: MPEG2_PACK_HEADER_SIZE + stuffingLength, scr };
					}

					if ((bytes[4]! & 0xf0) === 0x20 && bytes.length >= MPEG1_PACK_HEADER_SIZE) {
						const scr = this.normalizeTimestamp(readTimestamp(bytes, 4));
						return { pos, code, size: MPEG1_PACK_HEADER_SIZE, scr };
					}
				} else if (code !== PACK_HEADER_CODE && bytes.length >= 6) {
					return { pos, code, size: 6 + ((bytes[4]! << 8) | bytes[5]!), scr: null };
				}
			}

			const packHeaderPos = await this.findPackHeader(pos + 1);
			if (packHeaderPos === null) {
				return null;
			}

			pos = packHeaderPos;
		}
	}

	/** Returns the position of the first pack header at or after a position, or null when none comes. */
	async findPackHeader(pos: number): Promise<number | null> {
		while (true) {
			let slice = this.reader.requestSliceRange(pos, 0, PACK_SEARCH_CHUNK_SIZE);
			if (slice instanceof Promise) slice = await slice;
			if (!slice || slice.length < 4) {
				return null;
			}

			const bytes = readBytes(slice, slice.length);
			for (let i = 0; i + 3 < bytes.length; i++) {
				const isStartCode = bytes[i] === 0x00 && bytes[i + 1] === 0x00 && bytes[i + 2] === 0x01;
				if (isStartCode && bytes[i + 3] === PACK_HEADER_CODE) {
					return pos + i;
				}
			}

			pos += bytes.length - 3;
		}
	}

	/** Reads a PES packet of a stream ID that carries media, or returns null when its header is malformed. */
	async readPesPacket(unit: ProgramStreamUnit): Promise<ProgramStreamPesPacket | null> {
		let slice = this.reader.requestSliceRange(unit.pos, 0, unit.size);
		if (slice instanceof Promise) slice = await slice;
		if (!slice) {
			return null;
		}

		const bytes = readBytes(slice, slice.length);
		const header = parsePesHeader(bytes);
		if (!header) {
			return null;
		}

		return {
			sectionStartPos: unit.pos,
			sectionEndPos: unit.pos + unit.size,
			pts: header.pts !== null ? this.normalizeTimestamp(header.pts) : null,
			randomAccessIndicator: 0,
			data: bytes.subarray(header.dataStart),
			streamKey: header.streamKey,
			lpcmFormat: header.lpcmFormat,
		};
	}

	/**
	 * Returns the first PES packet of a stream at or after a position, or only one with a PTS; null when none comes
	 * before the end position. A search that reads to the end of the file records where the stream's packets ran out,
	 * and later searches stop there.
	 */
	async findPesPacket(
		streamKey: number,
		pos: number,
		timestampedOnly: boolean,
		endPos = Infinity,
	): Promise<ProgramStreamPesPacket | null> {
		const packetEnds = timestampedOnly ? this.timestampedPesPacketEnds : this.pesPacketEnds;
		const boundedEndPos = Math.min(
			endPos,
			packetEnds.get(streamKey) ?? Infinity,
			this.pesPacketEnds.get(streamKey) ?? Infinity,
		);
		const startPos = pos;

		while (pos < boundedEndPos) {
			const unit = await this.readUnit(pos);
			if (!unit) {
				packetEnds.set(streamKey, Math.min(packetEnds.get(streamKey) ?? Infinity, startPos));
				return null;
			}
			if (unit.pos >= boundedEndPos) {
				return null;
			}

			pos = unit.pos + unit.size;

			// A stream ID alone tells most streams apart, but private stream 1 needs its substream ID
			const isCandidate = streamKey > 0xff ? unit.code === (streamKey & 0xff) : unit.code === PRIVATE_STREAM_1;
			if (!isCandidate) {
				continue;
			}

			const pesPacket = await this.readPesPacket(unit);
			if (pesPacket && pesPacket.streamKey === streamKey && (!timestampedOnly || pesPacket.pts !== null)) {
				return pesPacket;
			}
		}

		return null;
	}

	async readNextPesPacket(
		res: ResultValue<PesPacket | null>,
		pid: number,
		pesPacket: PesPacket,
	): MaybeRelevantPromise {
		assert(pesPacket.sectionEndPos !== null);
		return res.set(await this.findPesPacket(pid, pesPacket.sectionEndPos, false));
	}

	/**
	 * Bisects the packs by their SCRs for the last one whose SCR is at most a time, as SCRs rise through the file,
	 * from a position on. Returns that position when no later pack qualifies, or the file's size is unknown.
	 */
	async findLastPackBefore(time: number, startPos: number) {
		const fileSize = this.reader.fileSize;
		if (fileSize === null) {
			return startPos;
		}

		let low = startPos;
		let high = fileSize;

		while (high - low > this.seekChunkSize) {
			const middle = Math.floor((low + high) / 2);
			const packHeaderPos = await this.findPackHeader(middle);
			const unit = packHeaderPos !== null && packHeaderPos < high ? await this.readUnit(packHeaderPos) : null;

			if (unit && unit.scr !== null && unit.scr <= time) {
				low = unit.pos;
			} else {
				high = middle;
			}
		}

		return low;
	}

	normalizeTimestamp(timestamp: number) {
		// Anchored on the first timestamp of the file, as the MPEG-TS demuxer anchors it
		this.timestampWrapInfo ??= createTimestampWrapInfo(timestamp);
		return normalizeWrappedTimestamp(timestamp, this.timestampWrapInfo);
	}
}

abstract class MpegPsTrackBacking implements InputTrackBacking {
	constructor(public elementaryStream: MpegPsElementaryStream) {}

	abstract getType(): TrackType;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	abstract allPacketsAreKeyPackets(): boolean;
	abstract getReorderSize(): number;

	getId() {
		return this.elementaryStream.pid;
	}

	getNumber() {
		const trackType = this.getType();

		let number = 0;
		for (const backing of this.elementaryStream.demuxer.trackBackingEntries) {
			if (backing.getType() === trackType) {
				number++;
			}

			if ((backing as MpegPsTrackBacking) === this) {
				break;
			}
		}

		return number;
	}

	getCodec(): MediaCodec | null {
		return this.elementaryStream.info.codec;
	}

	/** The stream's ID, as FFmpeg gives it: 0x100 plus its stream ID, or its private stream 1 substream ID. */
	getInternalCodecId() {
		return this.elementaryStream.streamType;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getDisposition(): TrackDisposition {
		return {
			...DEFAULT_TRACK_DISPOSITION,
			primary: false,
		};
	}

	getTimeResolution() {
		return MPEG_TS_TIMESCALE;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		return null;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	createEncodedPacket(
		suppliedPacket: SuppliedPacket,
		duration: number,
		buffer: PacketBuffer,
		options: PacketRetrievalOptions,
	) {
		let packetType: PacketType;
		if (this.allPacketsAreKeyPackets()) {
			packetType = 'key';
		} else {
			packetType = suppliedPacket.randomAccessIndicator === 1 ? 'key' : 'delta';
		}

		const packet = new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : suppliedPacket.data,
			packetType,
			suppliedPacket.pts / MPEG_TS_TIMESCALE,
			Math.max(duration / MPEG_TS_TIMESCALE, 0),
			suppliedPacket.sequenceNumber,
			suppliedPacket.data.byteLength,
		);
		packet._internal = {
			buffer,
			sectionStartPos: suppliedPacket.sectionStartPos,
		} satisfies EncodedPacketMetadata;

		return packet;
	}

	/** Reads the stream from a PES packet on, through a packet buffer, until a packet passes a test. */
	async readPacketFrom(
		res: ResultValue<PacketRetrievalResult>,
		startPesPacket: TimestampedPesPacket,
		isTarget: (packet: SuppliedPacket) => boolean,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const context = new MpegPsPacketReadingContext(this.elementaryStream, startPesPacket);
		const buffer = new MpegPsPacketBuffer(this, context);
		const readResult = new ResultValue<PacketWithDuration | null>();

		while (true) {
			readResult.reset();
			const promise = buffer.readNext(readResult);
			if (readResult.pending) await promise;

			const result = readResult.value;
			if (!result) {
				return res.set(new PacketRetrievalResult(null));
			}

			if (isTarget(result.packet)) {
				const packet = this.createEncodedPacket(result.packet, result.duration, buffer, options);
				return res.set(new PacketRetrievalResult(packet));
			}
		}
	}

	async getFirstPacket(
		res: ResultValue<PacketRetrievalResult>,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const firstPesPacket = this.elementaryStream.firstPesPacket;
		assert(firstPesPacket);

		return this.readPacketFrom(res, firstPesPacket, () => true, options);
	}

	async getNextPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const metadata = packet._internal as EncodedPacketMetadata | undefined;
		assert(metadata);

		if (metadata.buffer) {
			// Fast path
			const buffer = metadata.buffer;
			const readResult = new ResultValue<PacketWithDuration | null>();
			const promise = buffer.readNext(readResult);
			if (readResult.pending) await promise;

			const result = readResult.value;
			if (!result) {
				return res.set(new PacketRetrievalResult(null));
			}

			// The buffer belongs to the next packet now
			metadata.buffer = null;

			const newPacket = this.createEncodedPacket(result.packet, result.duration, buffer, options);
			return res.set(new PacketRetrievalResult(newPacket));
		}

		// Read again from a PES packet with a PTS at or before the one the packet begins in, looking further back until
		// one comes
		const demuxer = this.elementaryStream.demuxer;
		const firstPesPacket = this.elementaryStream.firstPesPacket;
		assert(firstPesPacket);

		const isTarget = (suppliedPacket: SuppliedPacket) => suppliedPacket.sequenceNumber > packet.sequenceNumber;
		let window = demuxer.seekChunkSize;

		while (true) {
			const startPos = metadata.sectionStartPos - window;
			if (startPos <= firstPesPacket.sectionStartPos) {
				return this.readPacketFrom(res, firstPesPacket, isTarget, options);
			}

			const packHeaderPos = await demuxer.findPackHeader(startPos);
			const startPesPacket = packHeaderPos !== null
				? await demuxer.findPesPacket(
					this.elementaryStream.pid,
					packHeaderPos,
					true,
					metadata.sectionStartPos + 1,
				)
				: null;
			if (startPesPacket) {
				return this.readPacketFrom(res, startPesPacket as TimestampedPesPacket, isTarget, options);
			}

			window *= 2;
		}
	}

	async getNextKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		packet: EncodedPacket,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		let currentPacket: EncodedPacket | null = packet;
		const nextResult = new ResultValue<PacketRetrievalResult>();

		while (true) {
			nextResult.reset();
			const promise = this.getNextPacket(nextResult, currentPacket, options);
			if (nextResult.pending) await promise;

			currentPacket = nextResult.value.packet;
			if (!currentPacket || currentPacket.type === 'key') {
				return res.set(nextResult.value);
			}
		}
	}

	getPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this.doPacketLookup(res, timestamp, false, options);
	}

	getKeyPacket(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		return this.doPacketLookup(res, timestamp, true, options);
	}

	/**
	 * Finds the packet presented last at or before a time, or the last such key packet: bisects the file by SCR for a
	 * pack shortly before the time, reads the stream forward from its first PES packet with a PTS after there, and
	 * starts further back, in growing windows, when nothing qualifies.
	 */
	async doPacketLookup(
		res: ResultValue<PacketRetrievalResult>,
		timestamp: number,
		keyPacketsOnly: boolean,
		options: PacketRetrievalOptions,
	): MaybeRelevantPromise {
		const searchPts = roundIfAlmostInteger(timestamp * MPEG_TS_TIMESCALE);
		const keyOnly = keyPacketsOnly && !this.allPacketsAreKeyPackets();
		const stream = this.elementaryStream;
		const demuxer = stream.demuxer;
		const firstPesPacket = stream.firstPesPacket;
		assert(firstPesPacket);

		let startPos = await demuxer.findLastPackBefore(
			searchPts - stream.scrToPtsOffset - SEARCH_MARGIN,
			firstPesPacket.sectionStartPos,
		);
		let window = demuxer.seekChunkSize;

		// Each try looks for its starting PES packet only before where the previous one started looking
		let searchedPos = Infinity;

		while (true) {
			let startPesPacket: TimestampedPesPacket | null = firstPesPacket;
			if (startPos > firstPesPacket.sectionStartPos) {
				const packHeaderPos = await demuxer.findPackHeader(startPos);
				startPesPacket = packHeaderPos !== null && packHeaderPos < searchedPos
					? await demuxer.findPesPacket(stream.pid, packHeaderPos, true, searchedPos) as
						TimestampedPesPacket | null
					: null;
				searchedPos = Math.min(searchedPos, packHeaderPos ?? Infinity);
			}

			if (startPesPacket) {
				const sequenceNumber = await this.findPacketFrom(startPesPacket, searchPts, keyOnly);
				if (sequenceNumber !== null) {
					return this.readPacketFrom(
						res,
						startPesPacket,
						packet => packet.sequenceNumber === sequenceNumber,
						options,
					);
				}
			}

			if (startPesPacket === firstPesPacket) {
				return res.set(new PacketRetrievalResult(null));
			}

			startPos = Math.max(startPos - window, firstPesPacket.sectionStartPos);
			window *= 2;
		}
	}

	/**
	 * Reads the stream from a PES packet on for the sequence number of the packet presented last at or before a time,
	 * or of the last such key packet; null when none is. Reading stops once no later packet can qualify: after a key
	 * packet past the time, or the second I or P picture past it, since a B picture is shown before the I or P picture
	 * it follows.
	 */
	async findPacketFrom(startPesPacket: TimestampedPesPacket, searchPts: number, keyOnly: boolean) {
		const context = new MpegPsPacketReadingContext(this.elementaryStream, startPesPacket);
		const markResult = new ResultValue<void>();
		const isVideo = this.elementaryStream.info.type === 'video';
		let best: SuppliedPacket | null = null;
		let laterAnchorCount = 0;

		while (true) {
			context.suppliedPacket = null;
			markResult.reset();
			const markPromise = context.markNextPacket(markResult);
			if (markResult.pending) await markPromise;

			const packet = context.suppliedPacket as SuppliedPacket | null;
			if (!packet) {
				break;
			}

			const isKey = !isVideo || packet.randomAccessIndicator === 1;
			if (packet.pts <= searchPts) {
				if ((!keyOnly || isKey) && (!best || packet.pts >= best.pts)) {
					best = packet;
				}
				continue;
			}

			if (!isVideo || (keyOnly && isKey)) {
				break;
			}
			if (!context.suppliedBPicture && ++laterAnchorCount === 2) {
				break;
			}
		}

		return best?.sequenceNumber ?? null;
	}
}

class MpegPsVideoTrackBacking extends MpegPsTrackBacking implements InputVideoTrackBacking {
	declare elementaryStream: MpegPsVideoStream;

	getType() {
		return 'video' as const;
	}

	override getCodec(): VideoCodec {
		return this.elementaryStream.info.codec;
	}

	getCodedWidth() {
		return this.elementaryStream.info.width;
	}

	getCodedHeight() {
		return this.elementaryStream.info.height;
	}

	getSquarePixelWidth() {
		return this.elementaryStream.info.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return this.elementaryStream.info.squarePixelHeight;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.elementaryStream.info.colorSpace;
	}

	async canBeTransparent() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		assert(this.elementaryStream.info.decoderConfig);
		return this.elementaryStream.info.decoderConfig;
	}

	allPacketsAreKeyPackets() {
		return false;
	}

	getReorderSize() {
		return this.elementaryStream.info.reorderSize;
	}
}

class MpegPsAudioTrackBacking extends MpegPsTrackBacking implements InputAudioTrackBacking {
	declare elementaryStream: MpegPsAudioStream;

	getType() {
		return 'audio' as const;
	}

	override getCodec(): AudioCodec {
		return this.elementaryStream.info.codec;
	}

	getNumberOfChannels() {
		return this.elementaryStream.info.numberOfChannels;
	}

	getSampleRate() {
		return this.elementaryStream.info.sampleRate;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.elementaryStream.info.decoderConfig);
		return this.elementaryStream.info.decoderConfig;
	}

	allPacketsAreKeyPackets() {
		return true;
	}

	getReorderSize() {
		return 0;
	}
}
